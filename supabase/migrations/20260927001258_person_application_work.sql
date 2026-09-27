-- PREPARED ONLY. Atomic application work/allowance/input primitives.
-- No route opts in. Legacy queue recovery and effects-start fencing must be
-- implemented before activation; a reservation is not proof of provider success.
set local lock_timeout='2s';
set local statement_timeout='30s';
alter table public.website_applications add column person_resume_sha256 text
 check(person_resume_sha256 is null or person_resume_sha256 ~ '^[a-f0-9]{64}$');
create table person_private.application_work (
 work_id uuid primary key references person_private.transition_work(id),
 application_id uuid not null unique references public.website_applications(id),
 organization_id uuid not null references public.organizations(id),
 input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
 input_snapshot jsonb not null check(jsonb_typeof(input_snapshot)='object' and octet_length(input_snapshot::text)<=262144),
 -- Event retention may remove events after their counting window. The durable
 -- reservation remains here and is never charged again on an attempt retry.
 review_event_id bigint not null unique,
 reserved_at timestamptz not null default clock_timestamp(),
 check(input_snapshot->>'id'=application_id::text and input_snapshot->>'organization_id'=organization_id::text)
);
alter table person_private.application_work enable row level security;
revoke all on person_private.application_work from public,anon,authenticated,service_role;

create function person_private.application_work_input(p_row jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_object_agg(k,p_row->k)||jsonb_build_object('input_version',1)
 from unnest(array['id','organization_id','created_at','name','email','linkedin_url','linkedin_username',
 'visa_status','preferred_locations','role_ids','resume_path','person_resume_sha256','source','follow_up_at',
 'preferred_roles','preferred_workplace','comp_expectation','recruiter_profile_id']) k
$$;
revoke all on function person_private.application_work_input(jsonb) from public,anon,authenticated,service_role;

create function person_private.application_work_claim(p_application uuid,p_org uuid,p_token uuid,p_lease integer,p_expected_hash text) returns jsonb
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
 if found then snapshot:=reservation.input_snapshot;h:=reservation.input_hash;
 else snapshot:=person_private.application_work_input(a);h:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');end if;
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
  result:=person_private.transition_claim(scope_name,p_org,'application',p_application::text,h,p_token,p_lease);
  select * into reservation from person_private.application_work where work_id=(result->>'work_id')::uuid;
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
revoke all on function person_private.application_work_claim(uuid,uuid,uuid,integer,text) from public,anon,authenticated,service_role;
grant execute on function person_private.application_work_claim(uuid,uuid,uuid,integer,text) to service_role;
create function public.person_application_work_claim(p_application uuid,p_org uuid,p_token uuid,p_lease integer default 900,p_expected_hash text default null) returns jsonb
language sql set search_path='' as $$select person_private.application_work_claim(p_application,p_org,p_token,p_lease,p_expected_hash)$$;
revoke all on function public.person_application_work_claim(uuid,uuid,uuid,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.person_application_work_claim(uuid,uuid,uuid,integer,text) to service_role;
