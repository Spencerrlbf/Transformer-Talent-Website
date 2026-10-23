-- PREPARED ONLY. Freeze tenant application identity; results/completion follow.
set local lock_timeout='2s';set local statement_timeout='30s';
create table person_private.tenant_application_people(
 organization_id uuid not null references public.organizations(id),linkedin_username text not null,
 application_id uuid not null unique references public.website_applications(id),
 created_at timestamptz not null default clock_timestamp(),primary key(organization_id,linkedin_username),
 check(organization_id<>'801865a7-6533-41d2-9c45-e4a90e6ad51a'),check(linkedin_username<>'' and linkedin_username=lower(btrim(linkedin_username)))
);
create table person_private.tenant_application_bindings(
 work_id uuid primary key references person_private.application_work(work_id),
 application_id uuid not null unique references public.website_applications(id),
 organization_id uuid not null references public.organizations(id),linkedin_username text,
 person_application_id uuid not null references public.website_applications(id),
 input_hash text not null,created_at timestamptz not null default clock_timestamp(),
 check(organization_id<>'801865a7-6533-41d2-9c45-e4a90e6ad51a')
);
alter table person_private.tenant_application_people enable row level security;
alter table person_private.tenant_application_bindings enable row level security;
revoke all on person_private.tenant_application_people,person_private.tenant_application_bindings from public,anon,authenticated,service_role;

-- Work locks precede identity/application locks. Tenant work is independent of
-- TT controller generation/phase. No caller-provided business ID is authority.
create function person_private.tenant_application_context() returns person_private.application_work
language plpgsql security definer set search_path='' as $$
declare headers jsonb;wid text;token text;w person_private.transition_work;a person_private.application_work;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'application_isolation';end if;
 headers:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}');
 wid:=coalesce(nullif(current_setting('person.work_id',true),''),headers->>'x-person-work-id');
 token:=coalesce(nullif(current_setting('person.work_token',true),''),headers->>'x-person-work-token');
 if wid is null or token is null or wid !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' or token !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then raise exception 'transition_admission';end if;
 w:=person_private.transition_owned(wid::uuid,token::uuid);
 select * into a from person_private.application_work where work_id=w.id for update;
 if a.work_id is null or w.scope<>'tenant_application' or w.family<>'application' or a.organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a' or w.organization_id<>a.organization_id or w.resource_key<>a.application_id::text or w.input_hash<>a.input_hash or a.input_hash<>encode(sha256(convert_to(a.input_snapshot::text,'UTF8')),'hex') then raise exception 'application_scope';end if;
 if w.status<>'active' or w.lease_until<=clock_timestamp() or a.input_review_reason is not null then raise exception 'transition_admission';end if;
 if a.effects_started_at is null or not exists(select 1 from person_private.application_work_owners where work_id=w.id and token_hash=w.token_hash) then raise exception 'application_effects_required';end if;
 perform person_private.transition_assert('tenant_application',a.organization_id,'application',a.application_id::text);
 return a;
end$$;
create function public.person_application_tenant_bind() returns jsonb
language plpgsql security definer set search_path='' as $$
declare a person_private.application_work;b person_private.tenant_application_bindings;person person_private.tenant_application_people;current_app public.website_applications;anchor public.website_applications;username text;key uuid;
begin
 a:=person_private.tenant_application_context();username:=nullif(a.input_snapshot->>'linkedin_username','');
 if username is not null and username<>lower(btrim(username)) then raise exception 'tenant_binding_identity';end if;
 if a.input_snapshot->>'source'='transformer_talent' then raise exception 'tenant_binding_scope';end if;
 perform pg_advisory_xact_lock(72008,hashtext(a.organization_id::text||':'||coalesce(username,'app:'||a.application_id::text)));
 select * into current_app from public.website_applications where id=a.application_id for share;
 if current_app.id is null or current_app.organization_id is distinct from a.organization_id or nullif(current_app.linkedin_username,'') is distinct from username or current_app.source is distinct from a.input_snapshot->>'source' or current_app.source='transformer_talent' then raise exception 'tenant_binding_scope';end if;
 perform person_private.tenant_application_context();
 select * into b from person_private.tenant_application_bindings where work_id=a.work_id;
 if username is null then key:=a.application_id;
 else
  select * into person from person_private.tenant_application_people where organization_id=a.organization_id and linkedin_username=username for share;
  if found then key:=person.application_id;
  else
   if b.work_id is not null then raise exception 'tenant_binding_anchor';end if;
   select * into anchor from public.website_applications where organization_id=a.organization_id and linkedin_username=username and source is distinct from 'transformer_talent' order by created_at asc nulls last,id limit 1 for share;
   if anchor.id is null then raise exception 'tenant_binding_anchor';end if;key:=anchor.id;
   perform person_private.tenant_application_context();
   insert into person_private.tenant_application_people(organization_id,linkedin_username,application_id) values(a.organization_id,username,key);
  end if;
 end if;
 -- Validate a retained anchor every time, without silently choosing another.
 select * into anchor from public.website_applications where id=key for share;
 if anchor.id is null or anchor.organization_id is distinct from a.organization_id or nullif(anchor.linkedin_username,'') is distinct from username or anchor.source='transformer_talent' then raise exception 'tenant_binding_anchor';end if;
 perform person_private.tenant_application_context();
 if b.work_id is null then
  insert into person_private.tenant_application_bindings(work_id,application_id,organization_id,linkedin_username,person_application_id,input_hash) values(a.work_id,a.application_id,a.organization_id,username,key,a.input_hash);
 elsif b.application_id<>a.application_id or b.organization_id<>a.organization_id or b.linkedin_username is distinct from username or b.person_application_id<>key or b.input_hash<>a.input_hash then raise exception 'tenant_binding_changed';end if;
 perform person_private.tenant_application_context();
 return jsonb_build_object('work_id',a.work_id,'application_id',a.application_id,'organization_id',a.organization_id,'person_key',key);
end$$;
revoke all on function person_private.tenant_application_context(),public.person_application_tenant_bind() from public,anon,authenticated,service_role;
grant execute on function public.person_application_tenant_bind() to service_role;
