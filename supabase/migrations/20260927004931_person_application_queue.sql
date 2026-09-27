-- PREPARED ONLY. Application processing lifecycle and queue integration.
-- No production flag or source-table guard is activated by this migration.
set local lock_timeout='2s';
set local statement_timeout='30s';
-- New acceptance explicitly witnesses that no pre-transition processing ran.
-- Historical queued rows (including those without files) require review.
alter table public.website_applications add column person_processing_version integer check(person_processing_version=1);
alter table person_private.application_work add column input_review_reason text check(input_review_reason in ('resume_content_mismatch','resume_input_invalid'));
alter table person_private.transition_work drop constraint transition_work_status_check;
alter table person_private.transition_work add constraint transition_work_status_check
 check(status in ('active','completed','uncertain','deferred'));
alter table person_private.transition_work add constraint transition_deferred_application
 check(status<>'deferred' or family='application');
alter table person_private.application_work add column effects_started_at timestamptz,
 add column retry_after timestamptz;
-- Never reuse a retired owner token, even several attempts later. Status/lease
-- invalidate a deferred owner; this private history prevents its resurrection.
create table person_private.application_work_owners (
 work_id uuid not null references person_private.application_work(work_id),
 token_hash text not null,
 primary key(work_id,token_hash)
);
alter table person_private.application_work_owners enable row level security;
revoke all on person_private.application_work_owners from public,anon,authenticated,service_role;

-- Internal only. Scope discovery is unlocked; controller precedes work locks.
create function person_private.application_work_recover(p_application uuid,p_org uuid,p_token uuid,p_lease integer,p_hash text) returns void
language plpgsql security definer set search_path='' as $$
declare a person_private.application_work;w person_private.transition_work;c person_private.transition_control;gen bigint:=0;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'application_isolation';end if;
 if p_token is null or p_lease is null or p_lease not between 1 and 900 then raise exception 'transition_input';end if;
 select * into a from person_private.application_work where application_id=p_application;
 if not found then return;end if;
 if p_org='801865a7-6533-41d2-9c45-e4a90e6ad51a' then c:=person_private.transition_lock();gen:=c.generation;end if;
 select * into strict w from person_private.transition_work where id=a.work_id for update;
 select * into strict a from person_private.application_work where work_id=w.id for update;
 if a.organization_id is distinct from p_org or a.application_id is distinct from p_application or a.input_hash is distinct from p_hash or
 w.organization_id is distinct from p_org or w.family<>'application' or w.resource_key<>p_application::text or w.input_hash<>p_hash then raise exception 'application_work_proof';end if;
 insert into person_private.application_work_owners(work_id,token_hash) values(w.id,w.token_hash) on conflict do nothing;
 if a.input_review_reason is not null or a.effects_started_at is not null or w.status not in ('active','deferred') or (w.status='active' and w.lease_until>clock_timestamp()) then return;end if;
 -- Retire expired pre-effects work even during draining; this is not permission
 -- to process. Invalidating the old token is serialized with effects-start.
 update person_private.transition_work set status='deferred',lease_until=clock_timestamp(),finished_at=clock_timestamp() where id=w.id;
 if (w.scope='tt_person' and c.enabled and c.phase<>'open') or a.retry_after>clock_timestamp() then return;end if;
 if exists(select 1 from person_private.application_work_owners where work_id=w.id and token_hash=md5(p_token::text)) then return;end if;
 insert into person_private.application_work_owners(work_id,token_hash) values(w.id,md5(p_token::text));
 update person_private.transition_work set status='active',token_hash=md5(p_token::text),generation=gen,lease_until=clock_timestamp()+make_interval(secs=>p_lease),finished_at=null where id=w.id;
 update person_private.application_work set retry_after=null where work_id=w.id;
end$$;
revoke all on function person_private.application_work_recover(uuid,uuid,uuid,integer,text) from public,anon,authenticated,service_role;

create or replace function person_private.application_work_claim(p_application uuid,p_org uuid,p_token uuid,p_lease integer,p_expected_hash text) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare a jsonb; snapshot jsonb; h text; scope_name text; result jsonb;
 reservation person_private.application_work; event_id bigint; allowance integer;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'application_isolation';end if;
 if p_expected_hash is not null and p_expected_hash !~ '^[a-f0-9]{64}$' then raise exception 'application_input_changed';end if;
 select to_jsonb(x) into a from public.website_applications x where x.id=p_application and x.organization_id=p_org;
 if not found then raise exception 'application_scope';end if;
 scope_name:=case when p_org='801865a7-6533-41d2-9c45-e4a90e6ad51a' then 'tt_person' else 'tenant_application' end;
 -- A completed/partial application's outputs can change its live row. The first
 -- retained input snapshot is the retry authority, not a fresh reconstruction.
 select * into reservation from person_private.application_work where application_id=p_application;
 if found then
  if reservation.input_review_reason is not null then return jsonb_build_object('status','input_review');end if;
  snapshot:=reservation.input_snapshot;h:=reservation.input_hash;
 else
  if a->>'person_processing_version' is distinct from '1' then return jsonb_build_object('status','input_review');end if;
  snapshot:=person_private.application_work_input(a);h:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');end if;
 if octet_length(snapshot::text)>262144 then raise exception 'application_input_limit';end if;
 if p_expected_hash is not null and p_expected_hash<>h then raise exception 'application_input_changed';end if;
 -- A stored object without its content witness (or a witness without an object)
 -- needs explicit verification, not a paid reservation or an active lease.
 if (nullif(snapshot->>'resume_path','') is null)<>(snapshot->>'person_resume_sha256' is null) then
  return jsonb_build_object('status','input_review');
 end if;
 begin
  -- This serializes concurrent first claims before a snapshot/reservation exists.
  -- TT order:72005/controller -> work -> org allowance72013 -> application row.
  perform person_private.application_work_recover(p_application,p_org,p_token,p_lease,h);
  result:=person_private.transition_claim(scope_name,p_org,'application',p_application::text,h,p_token,p_lease);
  select * into reservation from person_private.application_work where work_id=(result->>'work_id')::uuid;
  if reservation.input_review_reason is not null then return jsonb_build_object('status','input_review');end if;
  if result->>'status'<>'admitted' then
   if result ? 'work_id' and (reservation.work_id is null or reservation.application_id<>p_application or reservation.organization_id<>p_org or reservation.input_hash<>h) then raise exception 'application_work_proof';end if;
   return result;
  end if;
  if not found then
   perform pg_advisory_xact_lock(72013,hashtext(p_org::text));
  end if;
  select to_jsonb(x) into a from public.website_applications x where x.id=p_application and x.organization_id=p_org for share;
  if not found then raise exception 'application_scope';end if;
  if reservation.work_id is not null then
   if reservation.application_id<>p_application or reservation.organization_id<>p_org or reservation.input_hash<>h then raise exception 'application_work_proof';end if;
   return result||jsonb_build_object('input_hash',h,'snapshot',reservation.input_snapshot,'review_reserved',true);
  end if;
  if a->>'person_processing_version' is distinct from '1' then raise exception 'application_input_changed';end if;
  if a->>'status'<>'queued' then raise exception using errcode='P7001',message='application_ineligible';end if;
  -- If first inputs changed while we waited for the work lock, never freeze a
  -- stale application read. Outputs are excluded by the explicit input fields.
  if person_private.application_work_input(a)<>snapshot then raise exception 'application_input_changed';end if;
  select greatest(0,coalesce(daily_review_limit,300)) into strict allowance from public.organizations where id=p_org for share;
  if (select count(*) from public.rate_limit_events where bucket='review:'||p_org::text and created_at>clock_timestamp()-interval '24 hours')>=allowance then
   raise exception using errcode='P7002',message='application_budget';
  end if;
  insert into public.rate_limit_events(bucket,created_at) values('review:'||p_org::text,clock_timestamp()) returning id into event_id;
  insert into person_private.application_work(work_id,application_id,organization_id,input_hash,input_snapshot,review_event_id)
   values((result->>'work_id')::uuid,p_application,p_org,h,snapshot,event_id);
  return result||jsonb_build_object('input_hash',h,'snapshot',snapshot,'review_reserved',true);
 exception
  -- Roll back the provisional admission as well: allowance-denied queued input
  -- must not appear as in-flight work or prevent a controller drain.
  when sqlstate 'P7001' then return jsonb_build_object('status','ineligible');
  when sqlstate 'P7002' then return jsonb_build_object('status','budget');
 end;
end$$;

create or replace function person_private.transition_assert(p_scope text,p_org uuid,p_family text,p_resource text) returns text
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
 if p_family='application' and not exists(select 1 from person_private.application_work a where a.work_id=w.id and a.application_id::text=p_resource and a.organization_id=p_org and a.input_hash=w.input_hash and a.effects_started_at is not null) then raise exception 'application_effects_required';end if;
 return 'admitted';
end$$;

create or replace function person_private.transition_finish(p_id uuid,p_token uuid,p_outcome text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w person_private.transition_work;
begin
 if p_outcome is null or p_outcome not in ('completed','uncertain') then raise exception 'transition_input';end if;
 w:=person_private.transition_owned(p_id,p_token);
 if w.family='application' then raise exception 'application_work_required';end if;
 if w.status='completed' then
  if p_outcome<>'completed' then raise exception 'transition_state';end if;
 else update person_private.transition_work set status=p_outcome,finished_at=clock_timestamp() where id=w.id;end if;
 return jsonb_build_object('status',p_outcome,'work_id',w.id);
end$$;

create function person_private.application_work_owned(p_id uuid,p_token uuid) returns person_private.application_work
language plpgsql security definer set search_path='' as $$
declare w person_private.transition_work;a person_private.application_work;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'application_isolation';end if;
 w:=person_private.transition_owned(p_id,p_token);
 select * into a from person_private.application_work where work_id=w.id for update;
 if not found or w.family<>'application' or a.organization_id<>w.organization_id or a.application_id::text<>w.resource_key or a.input_hash<>w.input_hash then raise exception 'application_work_proof';end if;
 perform 1 from public.website_applications where id=a.application_id and organization_id=a.organization_id for share;
 if not found then raise exception 'application_scope';end if;
 if w.status='active' and w.lease_until<=clock_timestamp() then raise exception 'transition_expired';end if;
 insert into person_private.application_work_owners(work_id,token_hash) values(w.id,w.token_hash) on conflict do nothing;
 return a;
end$$;
revoke all on function person_private.application_work_owned(uuid,uuid) from public,anon,authenticated,service_role;

-- Only NULL -> timestamp grants launch permission. A lost response cannot be
-- retried into permission to repeat a paid stage.
create function person_private.application_work_start(p_id uuid,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a person_private.application_work;
begin
 a:=person_private.application_work_owned(p_id,p_token);
 if (select status from person_private.transition_work where id=p_id)<>'active' then raise exception 'transition_admission';end if;
 if a.input_review_reason is not null then raise exception 'application_input_review';end if;
 if a.effects_started_at is not null then return jsonb_build_object('status','already_started','work_id',p_id);end if;
 update person_private.application_work set effects_started_at=clock_timestamp() where work_id=p_id;
 return jsonb_build_object('status','started','work_id',p_id);
end$$;
create function person_private.application_work_defer(p_id uuid,p_token uuid,p_delay integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a person_private.application_work;
begin
 if p_delay is null or p_delay not between 1 and 3600 then raise exception 'application_retry_delay';end if;
 a:=person_private.application_work_owned(p_id,p_token);
 if (select status from person_private.transition_work where id=p_id)<>'active' then raise exception 'transition_admission';end if;
 if a.effects_started_at is not null then raise exception 'application_effects_started';end if;
 update person_private.application_work set retry_after=clock_timestamp()+make_interval(secs=>p_delay) where work_id=p_id;
 update person_private.transition_work set status='deferred',lease_until=clock_timestamp(),finished_at=clock_timestamp() where id=p_id;
 return jsonb_build_object('status','deferred','work_id',p_id);
end$$;
create function public.person_application_work_start(p_id uuid,p_token uuid) returns jsonb
language sql set search_path='' as $$select person_private.application_work_start(p_id,p_token)$$;
create function public.person_application_work_defer(p_id uuid,p_token uuid,p_delay integer default 60) returns jsonb
language sql set search_path='' as $$select person_private.application_work_defer(p_id,p_token,p_delay)$$;
revoke all on function person_private.application_work_start(uuid,uuid),person_private.application_work_defer(uuid,uuid,integer),public.person_application_work_start(uuid,uuid),public.person_application_work_defer(uuid,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function person_private.application_work_start(uuid,uuid),person_private.application_work_defer(uuid,uuid,integer),public.person_application_work_start(uuid,uuid),public.person_application_work_defer(uuid,uuid,integer) to service_role;

-- The generic core remains callable by the application definer, never directly
-- by service clients. No caller-controlled GUC grants the bypass.
revoke all on function person_private.transition_claim(text,uuid,text,text,text,uuid,integer) from public,anon,authenticated,service_role;
create function person_private.transition_claim_generic(p_scope text,p_org uuid,p_family text,p_resource text,p_hash text,p_token uuid,p_lease integer) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if p_family='application' then raise exception 'application_work_required';end if;
 return person_private.transition_claim(p_scope,p_org,p_family,p_resource,p_hash,p_token,p_lease);
end$$;
revoke all on function person_private.transition_claim_generic(text,uuid,text,text,text,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function person_private.transition_claim_generic(text,uuid,text,text,text,uuid,integer) to service_role;
create or replace function public.person_transition_claim(p_scope text,p_org uuid,p_family text,p_resource text,p_hash text,p_token uuid,p_lease integer default 300) returns jsonb
language sql set search_path='' as $$select person_private.transition_claim_generic(p_scope,p_org,p_family,p_resource,p_hash,p_token,p_lease)$$;

create or replace function person_private.transition_set(p_action text,p_revision bigint,p_generation bigint,p_reason text) returns jsonb
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
 if p_action<>'drain' and exists(select 1 from person_private.transition_work where scope='tt_person' and status not in ('completed','deferred')) then raise exception 'transition_unresolved';end if;
 update person_private.transition_control set enabled=next_enabled,phase=next_phase,generation=next_generation,revision=c.revision+1 where singleton;
 insert into person_private.transition_events(revision,generation,action,reason_code) values(c.revision+1,next_generation,p_action,p_reason);
 return person_private.transition_status();
end$$;

create function person_private.application_work_finish(p_id uuid,p_token uuid,p_outcome text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a person_private.application_work;app public.website_applications;state text;
begin
 if p_outcome is null or p_outcome not in ('completed','uncertain') then raise exception 'transition_input';end if;
 a:=person_private.application_work_owned(p_id,p_token);
 select status into strict state from person_private.transition_work where id=p_id;
 if state='completed' then
  if p_outcome<>'completed' then raise exception 'transition_state';end if;
  return jsonb_build_object('status','completed','work_id',p_id);
 end if;
 if a.effects_started_at is null then raise exception 'application_effects_required';end if;
 if p_outcome='completed' then
  select * into strict app from public.website_applications where id=a.application_id and organization_id=a.organization_id for share;
  if app.status is distinct from 'processed' then raise exception 'application_completion_required';end if;
  if a.organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a' and not exists(
   select 1 from public.person_application_receipts r where r.application_id=app.id and r.candidate_id=app.candidate_id
  ) then raise exception 'application_receipt_required';end if;
 end if;
 update person_private.transition_work set status=p_outcome,finished_at=clock_timestamp() where id=p_id;
 return jsonb_build_object('status',p_outcome,'work_id',p_id);
end$$;
create function public.person_application_work_finish(p_id uuid,p_token uuid,p_outcome text) returns jsonb
language sql set search_path='' as $$select person_private.application_work_finish(p_id,p_token,p_outcome)$$;
revoke all on function person_private.application_work_finish(uuid,uuid,text),public.person_application_work_finish(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function person_private.application_work_finish(uuid,uuid,text),public.person_application_work_finish(uuid,uuid,text) to service_role;

-- Queue discovery reads work state, not only mutable application status. Work
-- with uncertain effects or an unverified file remains visible in accounting
-- without starving eligible applicants at the front of a fixed row window.
create function person_private.application_work_queue(p_limit integer,p_orgs uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if p_limit is null or p_limit not between 1 and 1000 or coalesce(cardinality(p_orgs),0)>100 then raise exception 'application_queue_limit';end if;
 with waiting as materialized (
  select x.id,x.organization_id,x.created_at,w.id work_id,w.status,w.lease_until,a.effects_started_at,a.retry_after,a.input_review_reason,x.person_processing_version,
   (w.id is null or (a.organization_id=x.organization_id and w.organization_id=a.organization_id and w.resource_key=x.id::text and w.family='application' and w.input_hash=a.input_hash)) scope_verified,
   (nullif(x.resume_path,'') is null)=(x.person_resume_sha256 is null) resume_verified,c.enabled,c.phase
  from public.website_applications x
  left join person_private.application_work a on a.application_id=x.id
  left join person_private.transition_work w on w.id=a.work_id
  cross join person_private.transition_control c
  where (p_orgs is null or x.organization_id=any(p_orgs)) and coalesce(w.status,'')<>'completed' and (x.status='queued' or w.id is not null)
 ), budgets as materialized (
  select o.id,greatest(0,coalesce(o.daily_review_limit,300)) allowance,
   (select count(*) from public.rate_limit_events r where r.bucket='review:'||o.id::text and r.created_at>statement_timestamp()-interval '24 hours') used
  from public.organizations o where o.id in (select organization_id from waiting where work_id is null)
 ), eligible as (
  select id,organization_id from waiting where organization_id is not null and scope_verified and input_review_reason is null and (
   (work_id is null and person_processing_version=1 and resume_verified and exists(select 1 from budgets b where b.id=organization_id and b.used<b.allowance) and (organization_id<>'801865a7-6533-41d2-9c45-e4a90e6ad51a' or not enabled or phase='open')) or
   (effects_started_at is null and (
    (status='active' and lease_until<=statement_timestamp()) or
    (status='deferred' and (retry_after is null or retry_after<=statement_timestamp()) and
     (organization_id<>'801865a7-6533-41d2-9c45-e4a90e6ad51a' or not enabled or phase='open'))
   ))
  ) order by created_at,id limit p_limit
 ) select jsonb_build_object(
 'applications',coalesce((select jsonb_agg(to_jsonb(e)) from eligible e),'[]'::jsonb),
 'waiting',(select count(*) from waiting),
 'review_required',(select count(*) from waiting where organization_id is null or not coalesce(scope_verified,false) or (work_id is null and (not resume_verified or person_processing_version is distinct from 1)) or input_review_reason is not null or status='uncertain' or (status='active' and lease_until<=statement_timestamp() and effects_started_at is not null))
 ) into result;
 return result;
end$$;
create function public.person_application_work_queue(p_limit integer default 100,p_orgs uuid[] default null) returns jsonb
language sql stable set search_path='' as $$select person_private.application_work_queue(p_limit,p_orgs)$$;
revoke all on function person_private.application_work_queue(integer,uuid[]),public.person_application_work_queue(integer,uuid[]) from public,anon,authenticated,service_role;
grant execute on function person_private.application_work_queue(integer,uuid[]),public.person_application_work_queue(integer,uuid[]) to service_role;

alter table public.website_applications add column person_intent_hash text
 check(person_intent_hash is null or person_intent_hash ~ '^[a-f0-9]{64}$');
-- NULL hashes retain legacy behavior. New future requests use an atomic
-- conflict target scoped by organization and canonical LinkedIn identity.
create unique index application_future_intent_identity on public.website_applications(organization_id,linkedin_username,person_intent_hash);

-- A permanent input mismatch is inspectable but cannot spin through downloads.
create function person_private.application_work_review(p_id uuid,p_token uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a person_private.application_work;
begin
 if p_reason is null or p_reason not in ('resume_content_mismatch','resume_input_invalid') then raise exception 'application_review_reason';end if;
 a:=person_private.application_work_owned(p_id,p_token);
 if (select status from person_private.transition_work where id=p_id)<>'active' then raise exception 'transition_admission';end if;
 if a.effects_started_at is not null then raise exception 'application_effects_started';end if;
 update person_private.application_work set input_review_reason=p_reason,retry_after=null where work_id=p_id;
 update person_private.transition_work set status='deferred',lease_until=clock_timestamp(),finished_at=clock_timestamp() where id=p_id;
 return jsonb_build_object('status','input_review','work_id',p_id);
end$$;
create function public.person_application_work_review(p_id uuid,p_token uuid,p_reason text) returns jsonb
language sql set search_path='' as $$select person_private.application_work_review(p_id,p_token,p_reason)$$;
revoke all on function person_private.application_work_review(uuid,uuid,text),public.person_application_work_review(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function person_private.application_work_review(uuid,uuid,text),public.person_application_work_review(uuid,uuid,text) to service_role;

create or replace function person_private.application_work_input(p_row jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_object_agg(k,p_row->k)||jsonb_build_object('input_version',1)
 from unnest(array['id','organization_id','created_at','name','email','linkedin_url','linkedin_username',
 'visa_status','preferred_locations','role_ids','resume_path','person_resume_sha256','source','follow_up_at',
 'preferred_roles','preferred_workplace','comp_expectation','recruiter_profile_id','contact','location','person_processing_version','person_intent_hash']) k
$$;

grant execute on function person_private.application_work_input(jsonb) to service_role;
