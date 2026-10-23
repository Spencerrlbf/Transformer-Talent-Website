-- PREPARED ONLY. Conflict evidence requires a checked synchronous insertion.
set local lock_timeout='2s';set local statement_timeout='30s';
create table person_private.conflict_frames(
 backend_pid integer not null,transaction_id xid8 not null,work_id uuid not null,
 candidate_id uuid not null,expected_row jsonb not null,primary key(backend_pid,transaction_id)
);
alter table person_private.conflict_frames enable row level security;
revoke all on person_private.conflict_frames from public,anon,authenticated,service_role;
create function person_private.conflict_evidence_guard() returns trigger language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare f person_private.conflict_frames;
begin
 if not person_private.normalization_required() then return coalesce(new,old);end if;
 select * into f from person_private.conflict_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if tg_op<>'INSERT' or f.backend_pid is null or f.expected_row is distinct from to_jsonb(new) then raise exception 'conflict_evidence_frame';end if;
 return new;
end$$;
create trigger person_conflict_statement before insert or update or delete on public.identity_conflicts for each statement execute function person_private.audit_source_statement_gate();
create trigger person_conflict_before before insert or update or delete on public.identity_conflicts for each row execute function person_private.conflict_evidence_guard();
create trigger person_conflict_after after insert or update or delete on public.identity_conflicts for each row execute function person_private.conflict_evidence_guard();
create trigger person_conflict_truncate before truncate on public.identity_conflicts for each statement execute function person_private.audit_proof_no_truncate();
revoke truncate on public.identity_conflicts from public,anon,authenticated,service_role;

-- SETOF preserves the original INSERT's FOUND/row count: a global kind/hash
-- duplicate returns zero rows even if its original candidate/source differs.
create function person_private.conflict_insert(p_kind text,p_candidates uuid[],p_incoming jsonb,p_hash text,p_source uuid default null)
returns setof public.identity_conflicts language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare f person_private.normalization_frames;p person_private.application_projection_frames;
 e public.identity_conflicts;saved public.identity_conflicts;actual public.identity_conflicts;w uuid;cid uuid;s jsonb;
begin
 if not person_private.normalization_required() then
  return query insert into public.identity_conflicts(kind,candidate_ids,incoming,evidence_hash,source_id) values(p_kind,p_candidates,p_incoming,p_hash,p_source) on conflict(kind,evidence_hash) where status='open' do nothing returning *;
  return;
 end if;
 select * into f from person_private.normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 select * into p from person_private.application_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if f.backend_pid is not null then
  w:=f.work_id;cid:=f.candidate_id;s:=f.document->'source';
  if p_kind is null or p_kind not in ('identity_taken','job_identity','email_owned_by_other','contact_verification','contact_status','company_identity','school_identity') or
   not coalesce(cid=any(p_candidates),false) or p_source is null or not exists(
    select 1 from public.candidate_sources cs where cs.id=p_source and cs.candidate_id=cid and cs.source=s->>'source' and cs.provider is not distinct from s->>'provider' and cs.source_ref is not distinct from s->>'source_ref' and cs.payload_hash=s->>'payload_hash' and cs.parser_version=s->>'parser_version' and cs.fetched_at=(s->>'fetched_at')::timestamptz and cs.raw_in=s->>'raw_in' and cs.enrichment_id is not distinct from nullif(s->>'enrichment_id','')::uuid
   ) then raise exception 'conflict_evidence_source';end if;
 elsif p.backend_pid is not null then
  w:=p.work_id;cid:=p.candidate_id;
  if p_kind is distinct from 'legacy_email_collision' or p_candidates is distinct from array[cid] or p_source is not null or p_incoming is distinct from '{}'::jsonb or p_hash is null or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'conflict_evidence_projection';end if;
 else raise exception 'conflict_evidence_context';end if;
 e:=jsonb_populate_record(null::public.identity_conflicts,jsonb_build_object('id',gen_random_uuid(),'kind',p_kind,'candidate_ids',p_candidates,'incoming',p_incoming,'evidence_hash',p_hash,'source_id',p_source,'status','open','created_at',clock_timestamp()));
 insert into person_private.conflict_frames values(pg_backend_pid(),pg_current_xact_id(),w,cid,to_jsonb(e));
 insert into public.identity_conflicts select(e).* on conflict(kind,evidence_hash) where status='open' do nothing returning * into saved;
 if found then
  select * into actual from public.identity_conflicts where id=e.id;
  if to_jsonb(saved) is distinct from to_jsonb(e) or to_jsonb(actual) is distinct from to_jsonb(e) then raise exception 'conflict_evidence_actual';end if;
 else
  -- BEFORE INSERT suppression also yields zero. Require a real retained dedup
  -- row; never interpret absent evidence as an idempotent insertion.
  perform 1 from public.identity_conflicts where kind=p_kind and evidence_hash=p_hash and status='open' for share;
  if not found then raise exception 'conflict_evidence_actual';end if;
 end if;
 delete from person_private.conflict_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if saved.id is not null then return next saved;end if;
 return;
end$$;
revoke all on function person_private.conflict_evidence_guard(),person_private.conflict_insert(text,uuid[],jsonb,text,uuid) from public,anon,authenticated,service_role;

-- Preserve all reviewed resolver/writer calculations, conflict keys and FOUND
-- branches. Only replace their exact INSERT ... VALUES ... DO NOTHING blocks.
-- Historical SECURITY INVOKER missing-employer handling stays unchanged; its
-- raw writes remain available disabled and require future maintenance admission.
do $$
declare r record;body text;pattern text:='insert\s+into\s+public\.identity_conflicts\s*\(kind\s*,\s*candidate_ids\s*,\s*incoming\s*,\s*evidence_hash(?:\s*,\s*source_id)?\s*\)\s*values\s*\(([^;]*)\)\s*on\s+conflict\s*\(kind\s*,\s*evidence_hash\)\s*where\s+status\s*=\s*''open''\s*do\s+nothing\s*;';n integer;
begin
 for r in select * from(values
  ('person_private.save_person_core(jsonb)',5),('person_private.person_company_core(jsonb,uuid,uuid)',1),('person_private.person_school_core(jsonb,uuid,uuid)',1),('person_private.intake_project_core(uuid,bigint,jsonb)',1)
 ) x(signature,expected) loop
  body:=pg_get_functiondef(r.signature::regprocedure);
  select count(*) into n from regexp_matches(body,pattern,'gs');
  if n<>r.expected then raise exception 'conflict_evidence_definition';end if;
  body:=regexp_replace(body,pattern,E'perform 1 from person_private.conflict_insert(\\1);','gs');
  execute body;
 end loop;
end$$;
