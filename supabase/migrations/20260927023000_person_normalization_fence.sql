-- PREPARED ONLY. Application normalization execution boundary, default off.
-- Does not cover candidate/source/projection/audit/conflict/derivative writes
-- outside save_person. Other writer families must be admitted before activation.
set local lock_timeout='2s';
set local statement_timeout='30s';
create table person_private.normalization_frames(
 backend_pid integer not null,
 transaction_id xid8 not null,
 work_id uuid not null references person_private.application_work(work_id),
 application_id uuid not null,
 candidate_id uuid not null,
 document jsonb not null,
 primary key(backend_pid,transaction_id)
);
alter table person_private.normalization_frames enable row level security;
revoke all on person_private.normalization_frames from public,anon,authenticated,service_role;

create function person_private.normalization_required() returns boolean
language sql volatile security definer set search_path='' as $$
 select (select enabled from person_private.transition_control where singleton) or
 nullif(current_setting('person.work_id',true),'') is not null or
 nullif(current_setting('person.work_token',true),'') is not null or
 coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}') ?| array['x-person-work-id','x-person-work-token']
$$;
create function person_private.normalization_gate() returns boolean
language plpgsql security definer set search_path='' as $$
begin
 -- Taken even when disabled: arm cannot overtake a legacy statement that has
 -- begun writing. Row triggers must not acquire controller or work locks later.
 perform person_private.transition_lock();
 return person_private.normalization_required();
end$$;
create function person_private.normalization_frame(p_candidate uuid default null,p_source uuid default null) returns person_private.normalization_frames
language plpgsql security definer set search_path='' as $$
declare f person_private.normalization_frames;
begin
 select * into f from person_private.normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if not found or (p_candidate is not null and p_candidate<>f.candidate_id) then raise exception 'normalization_frame';end if;
 if p_source is not null and not exists(select 1 from public.candidate_sources s where s.id=p_source and s.candidate_id=f.candidate_id and s.source=f.document->'source'->>'source' and s.payload_hash=f.document->'source'->>'payload_hash') then raise exception 'normalization_source';end if;
 return f;
end$$;

-- Keep the exact reviewed core body and resolver semantics, but remove direct
-- service execution. The public signature remains the only entry point.
alter function public.save_person(jsonb) rename to save_person_core;
alter function public.save_person_core(jsonb) set schema person_private;
alter function public.person_company(jsonb,uuid,uuid) rename to person_company_core;
alter function public.person_company_core(jsonb,uuid,uuid) set schema person_private;
alter function public.person_school(jsonb,uuid,uuid) rename to person_school_core;
alter function public.person_school_core(jsonb,uuid,uuid) set schema person_private;
alter function public.person_rerank_contacts(uuid) rename to person_rerank_contacts_core;
alter function public.person_rerank_contacts_core(uuid) set schema person_private;
revoke all on function person_private.save_person_core(jsonb),person_private.person_company_core(jsonb,uuid,uuid),person_private.person_school_core(jsonb,uuid,uuid),person_private.person_rerank_contacts_core(uuid) from public,anon,authenticated,service_role;

create function public.save_person(doc jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a person_private.application_work;b person_private.application_candidates;r public.person_application_receipts;result jsonb;
begin
 if not person_private.normalization_gate() then return person_private.save_person_core(doc);end if;
 a:=person_private.application_source_context();
 select * into b from person_private.application_candidates where work_id=a.work_id;
 select * into r from public.person_application_receipts where application_id=a.application_id for share;
 if b.work_id is null or r.application_id is null or r.candidate_id<>b.candidate_id or r.created_person<>b.created_person or
 doc->>'candidate_id' is distinct from b.candidate_id::text or not exists(select 1 from jsonb_array_elements(r.documents) d where d=doc) then raise exception 'normalization_document';end if;
 if exists(select 1 from person_private.normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'normalization_nested';end if;
 insert into person_private.normalization_frames(backend_pid,transaction_id,work_id,application_id,candidate_id,document)
 values(pg_backend_pid(),pg_current_xact_id(),a.work_id,a.application_id,b.candidate_id,doc);
 begin
  result:=person_private.save_person_core(doc);
  -- An unchanged document has the same admission and expiry requirements.
  perform person_private.application_context();
  delete from person_private.normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
  return result;
 exception when others then
  delete from person_private.normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
  raise;
 end;
end$$;
create function public.person_company(i jsonb,p_candidate uuid,p_source uuid,out company_id uuid,out created boolean,out conflicts integer)
language plpgsql security definer set search_path='' as $$
begin
 if person_private.normalization_gate() then
  perform person_private.normalization_frame(p_candidate,p_source);
  if p_candidate is null or p_source is null then raise exception 'normalization_source';end if;
 end if;
 select * into company_id,created,conflicts from person_private.person_company_core(i,p_candidate,p_source);
end$$;
create function public.person_school(i jsonb,p_candidate uuid,p_source uuid,out school_id uuid,out created boolean,out conflicts integer)
language plpgsql security definer set search_path='' as $$
begin
 if person_private.normalization_gate() then
  perform person_private.normalization_frame(p_candidate,p_source);
  if p_candidate is null or p_source is null then raise exception 'normalization_source';end if;
 end if;
 select * into school_id,created,conflicts from person_private.person_school_core(i,p_candidate,p_source);
end$$;
create function public.person_rerank_contacts(p_candidate uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if person_private.normalization_gate() then
  perform person_private.normalization_frame(p_candidate);
  if p_candidate is null then raise exception 'normalization_frame';end if;
 end if;
 perform person_private.person_rerank_contacts_core(p_candidate);
end$$;

create function person_private.normalization_statement() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if person_private.normalization_gate() and tg_table_name<>'candidate_experiences' then perform person_private.normalization_frame();end if;
 return null;
end$$;
create function person_private.normalization_row() returns trigger
language plpgsql security definer set search_path='' as $$
declare f person_private.normalization_frames;
begin
 if not person_private.normalization_required() then return coalesce(new,old);end if;
 if tg_table_name='candidate_experiences' and coalesce(to_jsonb(old)->>'source','')<>'person' and coalesce(to_jsonb(new)->>'source','')<>'person' then return coalesce(new,old);end if;
 f:=person_private.normalization_frame();
 if tg_table_name not in ('companies','schools','skills') then
  if (tg_op<>'INSERT' and to_jsonb(old)->>'candidate_id' is distinct from f.candidate_id::text) or
     (tg_op<>'DELETE' and to_jsonb(new)->>'candidate_id' is distinct from f.candidate_id::text) then raise exception 'normalization_candidate';end if;
 end if;
 return coalesce(new,old);
end$$;
do $$declare t text;
begin
 foreach t in array array['candidate_sources','candidate_profile_state','candidate_identities','candidate_experiences','candidate_educations','candidate_skills','candidate_contacts','companies','schools','skills'] loop
  execute format('create trigger person_normalization_statement before insert or update or delete on public.%I for each statement execute function person_private.normalization_statement()',t);
  execute format('create trigger person_normalization_row before insert or update or delete on public.%I for each row execute function person_private.normalization_row()',t);
  execute format('revoke truncate on public.%I from public,service_role,anon,authenticated',t);
 end loop;
end$$;
revoke all on function person_private.normalization_required(),person_private.normalization_gate(),person_private.normalization_frame(uuid,uuid),person_private.normalization_statement(),person_private.normalization_row() from public,anon,authenticated,service_role;
revoke all on function public.save_person(jsonb),public.person_company(jsonb,uuid,uuid),public.person_school(jsonb,uuid,uuid),public.person_rerank_contacts(uuid) from public,anon,authenticated,service_role;
grant execute on function public.save_person(jsonb),public.person_company(jsonb,uuid,uuid),public.person_school(jsonb,uuid,uuid),public.person_rerank_contacts(uuid) to service_role;
