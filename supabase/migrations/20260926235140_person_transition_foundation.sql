-- PREPARED ONLY. Disabled controller and durable admission primitives.
-- No source-table triggers/callers are activated by this migration. Full writer
-- coverage, queue budget reservations and maintenance runtime remain release gates.
set local lock_timeout='2s';
set local statement_timeout='30s';
create schema if not exists person_private;

create table person_private.transition_control (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 phase text not null default 'open' check(phase in ('open','draining','held')),
 generation bigint not null default 1 check(generation>0),
 revision bigint not null default 1 check(revision>0),
 check(enabled or phase='open')
);
insert into person_private.transition_control default values;
create table person_private.transition_work (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 scope text not null check(scope in ('tt_person','tenant_application')),
 family text not null check(family in ('application','refresh','directory','derivative','recruiter','maintenance')),
 resource_key text not null check(resource_key ~ '^[a-zA-Z0-9:_-]{1,160}$'),
 input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
 token_hash text not null,
 generation bigint not null,
 status text not null default 'active' check(status in ('active','completed','uncertain')),
 lease_until timestamptz not null,
 created_at timestamptz not null default clock_timestamp(),
 finished_at timestamptz,
 unique(organization_id,scope,family,resource_key),
 check((scope='tt_person' and organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a') or
 (scope='tenant_application' and organization_id<>'801865a7-6533-41d2-9c45-e4a90e6ad51a' and family='application'))
);
create index transition_unresolved on person_private.transition_work(scope,status,lease_until) where status<>'completed';
create table person_private.transition_events (
 id bigint generated always as identity primary key,
 revision bigint not null unique,
 generation bigint not null,
 action text not null,
 reason_code text not null,
 occurred_at timestamptz not null default clock_timestamp()
);
alter table person_private.transition_control enable row level security;
alter table person_private.transition_work enable row level security;
alter table person_private.transition_events enable row level security;
revoke all on person_private.transition_control,person_private.transition_work,person_private.transition_events from public,anon,authenticated,service_role;
revoke all on sequence person_private.transition_events_id_seq from public,anon,authenticated,service_role;

create function person_private.transition_scope(p_scope text,p_org uuid,p_family text,p_resource text) returns void
language plpgsql set search_path='' as $$
begin
 if p_scope is null or p_org is null or p_family is null or p_resource is null or
 p_resource !~ '^[a-zA-Z0-9:_-]{1,160}$' or
 p_family not in ('application','refresh','directory','derivative','recruiter','maintenance') or
 not ((p_scope='tt_person' and p_org='801865a7-6533-41d2-9c45-e4a90e6ad51a') or
 (p_scope='tenant_application' and p_org<>'801865a7-6533-41d2-9c45-e4a90e6ad51a' and p_family='application')) then
  raise exception 'transition_scope';
 end if;
end$$;
-- TT callers take this before any work/family/business row lock. FOR SHARE makes
-- old repeatable-read snapshots fail on a committed controller change.
create function person_private.transition_lock() returns person_private.transition_control
language plpgsql set search_path='' as $$
declare c person_private.transition_control;
begin
 perform pg_advisory_xact_lock_shared(72005,0);
 select * into strict c from person_private.transition_control where singleton for share;
 return c;
end$$;
create function person_private.transition_status() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('enabled',c.enabled,'phase',c.phase,'generation',c.generation,'revision',c.revision,
 'active',(select count(*) from person_private.transition_work where scope='tt_person' and status='active' and lease_until>statement_timestamp()),
 'expired',(select count(*) from person_private.transition_work where scope='tt_person' and status='active' and lease_until<=statement_timestamp()),
 'uncertain',(select count(*) from person_private.transition_work where scope='tt_person' and status='uncertain'))
 from person_private.transition_control c where singleton
$$;
-- Operator-only. Service-role applications cannot toggle the controller.
create function person_private.transition_set(p_action text,p_revision bigint,p_generation bigint,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c person_private.transition_control; next_phase text; next_enabled boolean; next_generation bigint;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'transition_isolation';end if;
 if p_action is null or p_action not in ('arm','drain','seal','reopen','disarm') or p_reason is null or p_reason !~ '^[a-z0-9_]{1,80}$' then raise exception 'transition_input';end if;
 perform pg_advisory_xact_lock(72005,0);
 select * into strict c from person_private.transition_control where singleton for update;
 if p_revision is distinct from c.revision or p_generation is distinct from c.generation then raise exception 'transition_stale';end if;
 next_phase:=c.phase;next_enabled:=c.enabled;next_generation:=c.generation;
 if p_action='arm' and not c.enabled and c.phase='open' then next_enabled:=true;next_generation:=c.generation+1;
 elsif p_action='drain' and c.enabled and c.phase='open' then next_phase:='draining';
 elsif p_action='seal' and c.enabled and c.phase='draining' then next_phase:='held';next_generation:=c.generation+1;
 elsif p_action='reopen' and c.enabled and c.phase in ('held','draining') then next_phase:='open';next_generation:=c.generation+1;
 elsif p_action='disarm' and c.enabled and c.phase='held' then next_phase:='open';next_enabled:=false;next_generation:=c.generation+1;
 else raise exception 'transition_state';end if;
 if p_action<>'drain' and exists(select 1 from person_private.transition_work where scope='tt_person' and status<>'completed') then raise exception 'transition_unresolved';end if;
 update person_private.transition_control set enabled=next_enabled,phase=next_phase,generation=next_generation,revision=c.revision+1 where singleton;
 insert into person_private.transition_events(revision,generation,action,reason_code) values(c.revision+1,next_generation,p_action,p_reason);
 return person_private.transition_status();
end$$;

create function person_private.transition_claim(p_scope text,p_org uuid,p_family text,p_resource text,p_hash text,p_token uuid,p_lease integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c person_private.transition_control; w person_private.transition_work; gen bigint:=0;
begin
 perform person_private.transition_scope(p_scope,p_org,p_family,p_resource);
 if p_hash is null or p_hash !~ '^[a-f0-9]{64}$' or p_token is null or p_lease is null or p_lease not between 1 and 900 then raise exception 'transition_input';end if;
 if p_scope='tt_person' then c:=person_private.transition_lock();gen:=c.generation;end if;
 -- Existing work is immutable even during a drain; the owning admitted process
 -- can recover its lost claim response without creating another allowance claim.
 select * into w from person_private.transition_work where organization_id=p_org and scope=p_scope and family=p_family and resource_key=p_resource for update;
 if not found then
  if p_scope='tt_person' and c.enabled and c.phase<>'open' then return jsonb_build_object('status',c.phase);end if;
  insert into person_private.transition_work(organization_id,scope,family,resource_key,input_hash,token_hash,generation,lease_until)
   values(p_org,p_scope,p_family,p_resource,p_hash,md5(p_token::text),gen,clock_timestamp()+make_interval(secs=>p_lease))
   on conflict(organization_id,scope,family,resource_key) do nothing;
  select * into strict w from person_private.transition_work where organization_id=p_org and scope=p_scope and family=p_family and resource_key=p_resource for update;
 end if;
 if w.input_hash<>p_hash then raise exception 'transition_input_changed';end if;
 if w.status='completed' then return jsonb_build_object('status','completed','work_id',w.id);end if;
 if w.status='uncertain' or w.lease_until<=clock_timestamp() or w.generation<>gen then return jsonb_build_object('status','unresolved','work_id',w.id);end if;
 if w.token_hash<>md5(p_token::text) then return jsonb_build_object('status','busy','work_id',w.id);end if;
 if p_scope='tt_person' and c.enabled and c.phase='held' then raise exception 'transition_held';end if;
 return jsonb_build_object('status','admitted','work_id',w.id,'generation',w.generation,'lease_until',w.lease_until);
end$$;

create function person_private.transition_owned(p_id uuid,p_token uuid) returns person_private.transition_work
language plpgsql set search_path='' as $$
declare w person_private.transition_work; c person_private.transition_control;
begin
 -- Immutable scope lookup precedes the controller, with no row lock yet.
 select * into w from person_private.transition_work where id=p_id;
 if not found or p_token is null then raise exception 'transition_admission';end if;
 if w.scope='tt_person' then c:=person_private.transition_lock();end if;
 select * into strict w from person_private.transition_work where id=p_id for update;
 if w.token_hash<>md5(p_token::text) then raise exception 'transition_admission';end if;
 if w.status='completed' then return w;end if;
 if w.status='uncertain' then raise exception 'transition_unresolved';end if;
 if w.lease_until<=clock_timestamp() then raise exception 'transition_expired';end if;
 if w.scope='tt_person' and (w.generation<>c.generation or (c.enabled and c.phase='held')) then raise exception 'transition_admission';end if;
 return w;
end$$;
create function person_private.transition_finish(p_id uuid,p_token uuid,p_outcome text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w person_private.transition_work;
begin
 if p_outcome is null or p_outcome not in ('completed','uncertain') then raise exception 'transition_input';end if;
 w:=person_private.transition_owned(p_id,p_token);
 if w.status='completed' then
  if p_outcome<>'completed' then raise exception 'transition_state';end if;
 else update person_private.transition_work set status=p_outcome,finished_at=clock_timestamp() where id=w.id;end if;
 return jsonb_build_object('status',p_outcome,'work_id',w.id);
end$$;
create function person_private.transition_renew(p_id uuid,p_token uuid,p_lease integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w person_private.transition_work;
begin
 if p_lease is null or p_lease not between 1 and 900 then raise exception 'transition_input';end if;
 w:=person_private.transition_owned(p_id,p_token);
 if w.status<>'active' then raise exception 'transition_admission';end if;
 update person_private.transition_work set lease_until=clock_timestamp()+make_interval(secs=>p_lease) where id=w.id returning * into w;
 return jsonb_build_object('status','admitted','work_id',w.id,'lease_until',w.lease_until);
end$$;

-- Explicit assertion for future short transactions/triggers; not attached to any
-- production source table in this slice. Call before existing family/business locks.
create function person_private.transition_assert(p_scope text,p_org uuid,p_family text,p_resource text) returns text
language plpgsql security definer set search_path='' as $$
declare c person_private.transition_control; w person_private.transition_work; h jsonb; wid text; tok text;
begin
 perform person_private.transition_scope(p_scope,p_org,p_family,p_resource);
 if p_scope='tt_person' then
  c:=person_private.transition_lock();
  if c.enabled and c.phase='held' then raise exception 'transition_held';end if;
 end if;
 h:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}');
 wid:=coalesce(nullif(current_setting('person.work_id',true),''),h->>'x-person-work-id');
 tok:=coalesce(nullif(current_setting('person.work_token',true),''),h->>'x-person-work-token');
 if p_scope='tt_person' and not c.enabled and wid is null and tok is null then return 'disabled';end if;
 if wid is null or tok is null or wid !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' or tok !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then raise exception 'transition_admission';end if;
 select * into w from person_private.transition_work where id=wid::uuid for share;
 if not found or w.token_hash<>md5((tok::uuid)::text) or w.scope<>p_scope or w.organization_id<>p_org or w.family<>p_family or w.resource_key<>p_resource or
 w.status<>'active' or w.lease_until<=clock_timestamp() or (p_scope='tt_person' and w.generation<>c.generation) then raise exception 'transition_admission';end if;
 return 'admitted';
end$$;

-- Public invoker RPC shims; all privileged logic and ledger tables stay private.
create function public.person_transition_status() returns jsonb language sql stable set search_path='' as $$select person_private.transition_status()$$;
create function public.person_transition_claim(p_scope text,p_org uuid,p_family text,p_resource text,p_hash text,p_token uuid,p_lease integer default 300) returns jsonb
language sql set search_path='' as $$select person_private.transition_claim(p_scope,p_org,p_family,p_resource,p_hash,p_token,p_lease)$$;
create function public.person_transition_finish(p_id uuid,p_token uuid,p_outcome text) returns jsonb language sql set search_path='' as $$select person_private.transition_finish(p_id,p_token,p_outcome)$$;
create function public.person_transition_renew(p_id uuid,p_token uuid,p_lease integer) returns jsonb language sql set search_path='' as $$select person_private.transition_renew(p_id,p_token,p_lease)$$;
create function public.person_transition_assert(p_scope text,p_org uuid,p_family text,p_resource text) returns text language sql set search_path='' as $$select person_private.transition_assert(p_scope,p_org,p_family,p_resource)$$;

revoke all on function person_private.transition_scope(text,uuid,text,text),person_private.transition_lock(),person_private.transition_owned(uuid,uuid),person_private.transition_set(text,bigint,bigint,text) from public,anon,authenticated,service_role;
revoke all on function person_private.transition_status(),person_private.transition_claim(text,uuid,text,text,text,uuid,integer),person_private.transition_finish(uuid,uuid,text),person_private.transition_renew(uuid,uuid,integer),person_private.transition_assert(text,uuid,text,text) from public,anon,authenticated,service_role;
revoke all on function public.person_transition_status(),public.person_transition_claim(text,uuid,text,text,text,uuid,integer),public.person_transition_finish(uuid,uuid,text),public.person_transition_renew(uuid,uuid,integer),public.person_transition_assert(text,uuid,text,text) from public,anon,authenticated,service_role;
grant usage on schema person_private to service_role;
grant execute on function person_private.transition_status(),person_private.transition_claim(text,uuid,text,text,text,uuid,integer),person_private.transition_finish(uuid,uuid,text),person_private.transition_renew(uuid,uuid,integer),person_private.transition_assert(text,uuid,text,text) to service_role;
grant execute on function public.person_transition_status(),public.person_transition_claim(text,uuid,text,text,text,uuid,integer),public.person_transition_finish(uuid,uuid,text),public.person_transition_renew(uuid,uuid,integer),public.person_transition_assert(text,uuid,text,text) to service_role;
