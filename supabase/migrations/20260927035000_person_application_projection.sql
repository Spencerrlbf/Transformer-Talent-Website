-- PREPARED ONLY. Synchronous claimed-application compatibility projection.
-- General candidate/source/derivative admission remains a release prerequisite.
set local lock_timeout='2s';
set local statement_timeout='30s';
create function person_private.projection_profile(p_row jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_object_agg(k,coalesce(p_row->k,'null'::jsonb)) from unnest(array[
 'full_name','current_title','current_company','current_company_id','work_experience','education','education_schools','education_degrees','education_fields','top_skills','all_skills_text','previous_companies','headline','profile_summary','location','profile_picture_url','email','phone']) k
$$;
create table person_private.application_projection_frames(
 backend_pid integer not null,transaction_id xid8 not null,work_id uuid not null,
 candidate_id uuid not null,operation_id uuid not null,before_profile jsonb not null,after_profile jsonb not null,
 primary key(backend_pid,transaction_id)
);
alter table person_private.application_projection_frames enable row level security;
revoke all on person_private.application_projection_frames from public,anon,authenticated,service_role;
create function person_private.projection_frame() returns person_private.application_projection_frames
language plpgsql security definer set search_path='' as $$
declare f person_private.application_projection_frames;
begin
 select * into f from person_private.application_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if not found then raise exception 'projection_frame';end if;return f;
end$$;
create function person_private.projection_proof_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare f person_private.application_projection_frames;
begin
 if tg_level='STATEMENT' then
  if person_private.normalization_gate() then perform person_private.projection_frame();end if;return null;
 end if;
 if not person_private.normalization_required() then return coalesce(new,old);end if;
 f:=person_private.projection_frame();
 if tg_op='DELETE' or (tg_op='UPDATE' and old.candidate_id<>f.candidate_id) or new.candidate_id<>f.candidate_id then raise exception 'projection_scope';end if;
 return new;
end$$;
do $$declare t text;begin
 foreach t in array array['person_projection_state','person_projection_history'] loop
  execute format('create trigger person_projection_proof_statement before insert or update or delete on public.%I for each statement execute function person_private.projection_proof_guard()',t);
  execute format('create trigger person_projection_proof_row before insert or update or delete on public.%I for each row execute function person_private.projection_proof_guard()',t);
  execute format('create trigger person_projection_no_truncate before truncate on public.%I for each statement execute function person_private.audit_proof_no_truncate()',t);
  execute format('revoke truncate on public.%I from public,anon,authenticated,service_role',t);
 end loop;
end$$;
create function person_private.application_profile_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare f person_private.application_projection_frames;
begin
 if not person_private.normalization_required() or person_private.projection_profile(to_jsonb(old))=person_private.projection_profile(to_jsonb(new)) then return new;end if;
 f:=person_private.projection_frame();
 if old.id<>f.candidate_id or new.id<>f.candidate_id or person_private.projection_profile(to_jsonb(old))<>f.before_profile or person_private.projection_profile(to_jsonb(new))<>f.after_profile then raise exception 'projection_scope';end if;
 return new;
end$$;
create trigger person_application_profile before update on public.candidates for each row execute function person_private.application_profile_guard();

create function public.person_application_project(p_operation uuid,p_revision bigint,p_envelope jsonb) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare a person_private.application_work;b person_private.application_candidates;r public.person_application_receipts;
 p person_private.application_audit_operations;o public.person_audit_operations;c public.candidates;typed public.candidates;
 before_profile jsonb;after_profile jsonb;fallback jsonb;chosen jsonb;actual jsonb;src jsonb;d jsonb;sid uuid;
 rev bigint;n integer:=0;oid uuid;event_id bigint;boundary bigint;history_id bigint;constraint_name text;
 before_hash text;after_hash text;semantic_before text;semantic_after text;chosen_bytes text;semantic_bytes text;
 collision boolean:=false;changed text[];key text;
begin
 a:=person_private.application_source_context();
 select * into b from person_private.application_candidates where work_id=a.work_id;
 select * into p from person_private.application_audit_operations where operation_id=p_operation;
 select * into o from public.person_audit_operations where id=p_operation;
 if b.work_id is null or p.operation_id is null or p.work_id<>a.work_id or p.candidate_id<>b.candidate_id or p.transaction_id<>pg_current_xact_id() or o.transaction_id is distinct from p.transaction_id or o.candidate_id<>b.candidate_id or o.writer<>'application' or o.receipt_ref<>'application:'||a.application_id::text then raise exception 'projection_operation';end if;
 perform pg_advisory_xact_lock(hashtext(b.candidate_id::text));
 select * into c from public.candidates where id=b.candidate_id for update;
 perform person_private.application_context();
 if c.id is null then raise exception 'projection_scope';end if;
 select * into r from public.person_application_receipts where application_id=a.application_id and candidate_id=b.candidate_id and created_person=b.created_person;
 select s.rev into rev from public.candidate_profile_state s where candidate_id=b.candidate_id;
 if r.application_id is null or rev is null or jsonb_array_length(r.documents) is distinct from (case when r.harvest_ledger_id is null then 2 else 3 end) then raise exception 'projection_receipt';end if;
 if rev is distinct from p_revision then raise exception 'projection_revision';end if;
 -- Same exact immutable receipt/source/identity witnesses as deferred binding.
 for d in select value from jsonb_array_elements(r.documents) loop
  n:=n+1;src:=d->'source';
  if d->>'candidate_id' is distinct from b.candidate_id::text or src->>'parser_version' is distinct from 'person-v3' or src->>'payload_hash' is null then raise exception 'projection_receipt';end if;
  if n<=2 and (src->>'source' is distinct from 'application' or src->>'provider' is distinct from (case when n=1 then 'website' else 'website-resume' end) or src->>'source_ref' is distinct from (a.application_id::text||(case when n=1 then '' else ':profile' end)) or src->>'raw_in' is distinct from 'inline' or src->>'enrichment_id' is not null) then raise exception 'projection_receipt';end if;
  if n=3 and (src->>'source' is distinct from 'harvest' or src->>'enrichment_id' is distinct from r.harvest_ledger_id::text) then raise exception 'projection_receipt';end if;
  select id into sid from public.candidate_sources where candidate_id=b.candidate_id and source=src->>'source' and provider is not distinct from src->>'provider' and source_ref is not distinct from src->>'source_ref' and payload_hash=src->>'payload_hash' and parser_version=src->>'parser_version' and fetched_at=(src->>'fetched_at')::timestamptz and raw_in=src->>'raw_in' and enrichment_id is not distinct from nullif(src->>'enrichment_id','')::uuid;
  if not found or (n=1 and not exists(select 1 from public.candidate_identities where candidate_id=b.candidate_id and kind='tt_application_id' and value=a.application_id::text and source_id=sid)) then raise exception 'projection_receipt';end if;
 end loop;
 if jsonb_typeof(p_envelope) is distinct from 'object' or octet_length(p_envelope::text)>8000000 or (select count(*) from jsonb_object_keys(p_envelope))<>7 then raise exception 'projection_envelope';end if;
 foreach key in array array['before','after','fallback','semanticBefore','semanticAfter','semanticFallback','collision'] loop
  if jsonb_typeof(p_envelope->key) is distinct from 'string' or octet_length(p_envelope->>key)>2000000 then raise exception 'projection_envelope';end if;
 end loop;
 before_profile:=(p_envelope->>'before')::jsonb;after_profile:=(p_envelope->>'after')::jsonb;fallback:=(p_envelope->>'fallback')::jsonb;
 foreach key in array array['before','after','fallback'] loop
  actual:=(p_envelope->>key)::jsonb;
  if jsonb_typeof(actual) is distinct from 'object' or actual is distinct from person_private.projection_profile(actual) then raise exception 'projection_fields';end if;
  typed:=jsonb_populate_record(null::public.candidates,actual);
  if person_private.projection_profile(to_jsonb(typed)) is distinct from actual then raise exception 'projection_types';end if;
 end loop;
 if before_profile is distinct from person_private.projection_profile(to_jsonb(c)) then raise exception 'projection_before';end if;
 if (fallback-'email') is distinct from (after_profile-'email') or (fallback->'email' is distinct from before_profile->'email' and fallback->'email'<>'null'::jsonb) then raise exception 'projection_fallback';end if;
 if (p_envelope->>'collision')::jsonb is distinct from jsonb_build_array(b.candidate_id::text,after_profile->>'email') then raise exception 'projection_collision';end if;
 -- Trusted semantic transformation is observation metadata, never authority or
 -- the no-op decision. Compatibility bytes are checked against actual typed data.
 foreach key in array array['semanticBefore','semanticAfter','semanticFallback'] loop
  if jsonb_typeof((p_envelope->>key)::jsonb) is distinct from 'object' then raise exception 'projection_envelope';end if;
 end loop;
 before_hash:=encode(sha256(convert_to(p_envelope->>'before','UTF8')),'hex');
 if exists(select 1 from public.person_projection_state where candidate_id=b.candidate_id and profile_hash<>before_hash) then raise exception 'legacy_projection_drift';end if;
 -- Reuse the complete chain/hold/auxiliary verifier before even a no-op. This
 -- operation owns the profile event; the original still finalizes preferences.
 oid:=(public.person_application_audit_begin(false)->>'id')::uuid;
 select captured_version into boundary from person_private.application_audit_operations where operation_id=oid;
 collision:=after_profile->>'email' is not null and after_profile->>'email' is distinct from c.email and exists(select 1 from public.candidates where email=after_profile->>'email' and id<>b.candidate_id);
 chosen:=case when collision then fallback else after_profile end;
 insert into person_private.application_projection_frames values(pg_backend_pid(),pg_current_xact_id(),a.work_id,b.candidate_id,oid,before_profile,chosen);
 -- A constraint race may appear after the ownership query. Roll back its
 -- candidate/event writes before retrying exactly the validated email fallback.
 for n in 1..2 loop
  begin
   if chosen is distinct from before_profile then
    typed:=jsonb_populate_record(null::public.candidates,chosen);
    update public.candidates set full_name=typed.full_name,current_title=typed.current_title,current_company=typed.current_company,current_company_id=typed.current_company_id,work_experience=typed.work_experience,education=typed.education,education_schools=typed.education_schools,education_degrees=typed.education_degrees,education_fields=typed.education_fields,top_skills=typed.top_skills,all_skills_text=typed.all_skills_text,previous_companies=typed.previous_companies,headline=typed.headline,profile_summary=typed.profile_summary,location=typed.location,profile_picture_url=typed.profile_picture_url,email=typed.email,phone=typed.phone,updated_at=clock_timestamp() where id=b.candidate_id returning person_private.projection_profile(to_jsonb(candidates)) into actual;
    if actual is distinct from chosen then raise exception 'projection_result';end if;
    select id into strict event_id from public.person_change_events where candidate_id=b.candidate_id and source_table='candidates' and source_row_id=b.candidate_id::text and transaction_id=pg_current_xact_id() and id>boundary and operation='UPDATE';
    perform person_private.attribute_change(event_id,oid,'profile');
   end if;
   exit;
  exception when unique_violation then
   get stacked diagnostics constraint_name=constraint_name;
   if n<>1 or collision or not exists(select 1 from pg_constraint k where k.conrelid='public.candidates'::regclass and k.contype='u' and k.conname=constraint_name and k.conkey=array[(select attnum from pg_attribute where attrelid='public.candidates'::regclass and attname='email')]::smallint[]) then raise;end if;
   collision:=true;chosen:=fallback;
   update person_private.application_projection_frames set after_profile=chosen where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
  end;
 end loop;
 if collision then
  insert into public.identity_conflicts(kind,candidate_ids,incoming,evidence_hash) values('legacy_email_collision',array[b.candidate_id],'{}'::jsonb,encode(sha256(convert_to(p_envelope->>'collision','UTF8')),'hex')) on conflict(kind,evidence_hash) where status='open' do nothing;
 end if;
 chosen_bytes:=p_envelope->>(case when collision then 'fallback' else 'after' end);
 semantic_bytes:=p_envelope->>(case when collision then 'semanticFallback' else 'semanticAfter' end);
 after_hash:=encode(sha256(convert_to(chosen_bytes,'UTF8')),'hex');
 semantic_before:=encode(sha256(convert_to(p_envelope->>'semanticBefore','UTF8')),'hex');semantic_after:=encode(sha256(convert_to(semantic_bytes,'UTF8')),'hex');
 select coalesce(array_agg(k order by k),'{}') into changed from jsonb_object_keys(before_profile) k where before_profile->k is distinct from chosen->k;
 if cardinality(changed)>0 then
  insert into public.person_projection_history(candidate_id,revision,before_profile,after_hash,semantic_before,semantic_after,run_id) values(b.candidate_id,rev,before_profile,after_hash,semantic_before,semantic_after,null) returning id into history_id;
 end if;
 insert into public.person_projection_state as old(candidate_id,revision,profile_hash,semantic_hash) values(b.candidate_id,rev,after_hash,semantic_after)
 on conflict(candidate_id) do update set revision=excluded.revision,profile_hash=excluded.profile_hash,semantic_hash=excluded.semantic_hash,updated_at=clock_timestamp()
 where (old.revision,old.profile_hash,old.semantic_hash) is distinct from (excluded.revision,excluded.profile_hash,excluded.semantic_hash);
 perform person_private.application_context();
 delete from person_private.application_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 return jsonb_build_object('revision',rev::text,'projected',cardinality(changed)>0,'semanticChanged',cardinality(changed)>0 and semantic_before<>semantic_after,'historyId',history_id::text,'changedFields',to_jsonb(changed),'emailCollision',collision,'usedFallback',collision);
exception when others then
 delete from person_private.application_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();raise;
end$$;
revoke all on function person_private.projection_profile(jsonb),person_private.projection_frame(),person_private.projection_proof_guard(),person_private.application_profile_guard() from public,anon,authenticated,service_role;
revoke all on function public.person_application_project(uuid,bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.person_application_project(uuid,bigint,jsonb) to service_role;
