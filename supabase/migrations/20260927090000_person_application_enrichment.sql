-- PREPARED ONLY. TT enrichment evidence and legacy email source boundaries.
set local lock_timeout='2s';set local statement_timeout='30s';
create table person_private.application_enrichment_frames(
 backend_pid integer not null,transaction_id xid8 not null,work_id uuid not null,ledger_id uuid not null,
 kind text not null check(kind in ('harvest_store','harvest_attach','resume_parse')),before_row jsonb,after_row jsonb not null,
 primary key(backend_pid,transaction_id)
);
-- Deliberately retain a selection witness even if an unowned legacy row is
-- removed while enforcement is off. Missing evidence must fail, never refetch.
create table person_private.application_harvest_selections(
 work_id uuid primary key references person_private.application_work(work_id),ledger_id uuid not null,
 original_candidate_id uuid,evidence_hash text not null check(evidence_hash ~ '^[a-f0-9]{64}$')
);
create table person_private.application_parser_records(
 work_id uuid primary key references person_private.application_work(work_id),ledger_id uuid not null unique references public.candidate_enrichments(id) deferrable initially deferred,
 candidate_id uuid not null,parser text not null check(parser in ('llamaparse','pdf-parse')),evidence_hash text not null
);
alter table person_private.application_enrichment_frames enable row level security;
alter table person_private.application_harvest_selections enable row level security;
alter table person_private.application_parser_records enable row level security;
revoke all on person_private.application_enrichment_frames,person_private.application_harvest_selections,person_private.application_parser_records from public,anon,authenticated,service_role;

create function person_private.enrichment_evidence_hash(e public.candidate_enrichments) returns text language sql immutable set search_path='' as $$
 select person_private.intake_hash(to_jsonb(e)-array['candidate_id','created_at']||jsonb_build_object('created_at_epoch',extract(epoch from e.created_at)))
$$;
create function person_private.enrichment_frame(w uuid,e uuid,k text,o jsonb,n jsonb) returns void language sql security definer set search_path='' as $$
 insert into person_private.application_enrichment_frames values(pg_backend_pid(),pg_current_xact_id(),w,e,k,o,n)
$$;
create function person_private.enrichment_frame_clear() returns void language sql security definer set search_path='' as $$
 delete from person_private.application_enrichment_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()
$$;
create function person_private.enrichment_selection_check(w uuid,e public.candidate_enrichments) returns void language plpgsql security definer set search_path='' as $$
declare s person_private.application_harvest_selections;b person_private.application_candidates;
begin
 select * into s from person_private.application_harvest_selections where work_id=w;
 if s.work_id is null or e.id is null or s.ledger_id<>e.id or s.evidence_hash<>person_private.enrichment_evidence_hash(e) then raise exception 'enrichment_selection_changed';end if;
 if s.original_candidate_id is not null then
  if e.candidate_id is distinct from s.original_candidate_id then raise exception 'enrichment_selection_owner';end if;
 elsif e.candidate_id is not null then
  select * into b from person_private.application_candidates where work_id=w;
  if b.candidate_id is distinct from e.candidate_id then
   -- Another admitted application may have committed the same historical
   -- attachment after this work selected it but before this work bound identity.
   if b.work_id is not null or not exists(
    select 1 from person_private.application_candidates other
    join person_private.application_work aw on aw.work_id=other.work_id
    join public.person_application_receipts r on r.application_id=other.application_id and r.candidate_id=other.candidate_id and r.harvest_ledger_id=e.id
    join person_private.application_intake_ready ready on ready.work_id=other.work_id and ready.application_id=other.application_id and ready.candidate_id=other.candidate_id
    where other.candidate_id=e.candidate_id and aw.organization_id=e.organization_id and aw.input_snapshot->>'linkedin_username'=e.linkedin_username
   ) then raise exception 'enrichment_selection_owner';end if;
  end if;
 end if;
end$$;
create function person_private.enrichment_selection_pin(w uuid,e public.candidate_enrichments) returns void language plpgsql security definer set search_path='' as $$
declare expected person_private.application_harvest_selections;actual person_private.application_harvest_selections;
begin
 select * into actual from person_private.application_harvest_selections where work_id=w;
 if actual.work_id is null then
  expected:=row(w,e.id,e.candidate_id,person_private.enrichment_evidence_hash(e))::person_private.application_harvest_selections;
  insert into person_private.application_harvest_selections select(expected).*;
  select * into actual from person_private.application_harvest_selections where work_id=w;
  if to_jsonb(actual) is distinct from to_jsonb(expected) then raise exception 'enrichment_selection_actual';end if;
 end if;
 perform person_private.enrichment_selection_check(w,e);
end$$;

create function person_private.enrichment_owner_check(expected person_private.application_harvest) returns void language plpgsql security definer set search_path='' as $$
declare actual person_private.application_harvest;
begin
 select * into actual from person_private.application_harvest where work_id=expected.work_id;
 if to_jsonb(actual) is distinct from to_jsonb(expected) then raise exception 'enrichment_owner_actual';end if;
end$$;
create function person_private.enrichment_parser_check(expected person_private.application_parser_records) returns void language plpgsql security definer set search_path='' as $$
declare actual person_private.application_parser_records;
begin
 select * into actual from person_private.application_parser_records where work_id=expected.work_id;
 if to_jsonb(actual) is distinct from to_jsonb(expected) then raise exception 'enrichment_parser_actual';end if;
end$$;

-- Replace the former owned-row trigger's late application_context/work lock.
-- All authorization now comes from a synchronous private exact frame. The
-- existing BEFORE statement controller gate still precedes business row locks.
create or replace function person_private.application_harvest_immutable() returns trigger language plpgsql security definer set search_path='' as $$
declare f person_private.application_enrichment_frames;o jsonb:=to_jsonb(old);n jsonb:=to_jsonb(new);owned boolean;required boolean;
begin
 select * into f from person_private.application_enrichment_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if f.backend_pid is not null then
  if tg_op='DELETE' or f.ledger_id is distinct from new.id or f.before_row is distinct from o or f.after_row is distinct from n or
   (tg_op='INSERT' and f.kind not in ('harvest_store','resume_parse')) or (tg_op='UPDATE' and f.kind<>'harvest_attach') then raise exception 'enrichment_source_frame';end if;return new;
 end if;
 owned:=exists(select 1 from person_private.application_harvest where ledger_id=any(array[old.id,new.id])) or exists(select 1 from person_private.application_parser_records where ledger_id=any(array[old.id,new.id]));
 required:=person_private.normalization_required();
 if not required and not owned then return coalesce(new,old);end if;
 if owned then raise exception 'enrichment_source_owned';end if;
 -- Legitimate tenant spend has no TT candidate reference. A cross-org or orphan
 -- nonnull link may never evade this boundary through an organization change.
 if o->>'organization_id' is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a' and n->>'organization_id' is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a' and old.candidate_id is null and new.candidate_id is null then return coalesce(new,old);end if;
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'enrichment_source_isolation';end if;
 -- Unrelated JD parsing emits only anonymous, payload-free zero-credit telemetry.
 -- This INSERT-only exception grants no candidate/source or subsequent edit right.
 if tg_op='INSERT' and new.id is not null and new.created_at is not null and n=jsonb_build_object('id',new.id,'created_at',new.created_at,'organization_id','801865a7-6533-41d2-9c45-e4a90e6ad51a','candidate_id',null,'linkedin_username',null,'provider','llamaparse','operation','jd_parse','cache_status','miss','status','ok','raw_payload',null,'normalized_profile',null,'cost_credits',0) then return new;end if;
 raise exception 'enrichment_source_fence';
end$$;
create trigger person_enrichment_source_after after insert or update or delete on public.candidate_enrichments for each row execute function person_private.application_harvest_immutable();
create function person_private.legacy_email_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin if tg_op='TRUNCATE' or person_private.normalization_required() then raise exception 'legacy_email_fence';end if;return coalesce(new,old);end$$;
create trigger person_legacy_email_before before insert or update or delete on public.candidate_emails for each row execute function person_private.legacy_email_guard();
create trigger person_legacy_email_after after insert or update or delete on public.candidate_emails for each row execute function person_private.legacy_email_guard();
create trigger person_legacy_email_truncate before truncate on public.candidate_emails for each statement execute function person_private.legacy_email_guard();
create function person_private.enrichment_no_truncate() returns trigger language plpgsql security definer set search_path='' as $$begin raise exception 'enrichment_source_truncate';end$$;
create trigger person_enrichment_truncate before truncate on public.candidate_enrichments for each statement execute function person_private.enrichment_no_truncate();
revoke truncate on public.candidate_enrichments,public.candidate_emails from public,anon,authenticated,service_role;

create or replace function public.person_application_harvest_store(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare a person_private.application_work;l person_private.application_harvest;e public.candidate_enrichments;saved public.candidate_enrichments;h text;
begin
 a:=person_private.application_source_context();
 if p_payload is null or jsonb_typeof(p_payload) not in ('object','array') or octet_length(p_payload::text)>8388608 then raise exception 'application_harvest_payload';end if;
 h:=person_private.intake_hash(p_payload);select * into l from person_private.application_harvest where work_id=a.work_id;
 if found then
  if l.payload_hash<>h then raise exception 'application_harvest_changed';end if;
  select * into e from public.candidate_enrichments where id=l.ledger_id for share;
  perform person_private.enrichment_selection_check(a.work_id,e);perform person_private.application_context();return jsonb_build_object('id',e.id);
 end if;
 if exists(select 1 from person_private.application_harvest_selections where work_id=a.work_id) then raise exception 'enrichment_selection_exists';end if;
 e:=jsonb_populate_record(null::public.candidate_enrichments,jsonb_build_object('id',gen_random_uuid(),'organization_id',a.organization_id,'linkedin_username',a.input_snapshot->>'linkedin_username','provider','harvest','operation','full_profile','cache_status','miss','status','ok','raw_payload',p_payload,'cost_credits',1,'created_at',clock_timestamp()));
 l:=row(a.work_id,e.id,h,null)::person_private.application_harvest;
 insert into person_private.application_harvest select(l).*;perform person_private.enrichment_owner_check(l);
 perform person_private.enrichment_frame(a.work_id,e.id,'harvest_store',null,to_jsonb(e));
 insert into public.candidate_enrichments select(e).* returning * into saved;
 if not found or to_jsonb(saved) is distinct from to_jsonb(e) then raise exception 'enrichment_actual';end if;
 perform person_private.enrichment_frame_clear();perform person_private.enrichment_owner_check(l);perform person_private.enrichment_selection_pin(a.work_id,saved);perform person_private.application_context();
 return jsonb_build_object('id',saved.id);
end$$;

create function person_private.enrichment_cache_eligible(a person_private.application_work,e public.candidate_enrichments) returns void language plpgsql security definer set search_path='' as $$
declare l person_private.application_harvest;
begin
 if e.id is null or e.organization_id is distinct from a.organization_id or e.linkedin_username is distinct from a.input_snapshot->>'linkedin_username' or e.provider<>'harvest' or e.operation<>'full_profile' or e.cache_status<>'miss' or e.status<>'ok' or e.raw_payload is null then raise exception 'enrichment_selection_scope';end if;
 select * into l from person_private.application_harvest where ledger_id=e.id;
 if l.work_id is not null and l.work_id<>a.work_id and not exists(select 1 from person_private.application_candidates b join public.person_application_receipts r on r.application_id=b.application_id and r.candidate_id=b.candidate_id and r.harvest_ledger_id=e.id where b.work_id=l.work_id and b.candidate_id=e.candidate_id) then raise exception 'application_harvest_owner';end if;
end$$;
create or replace function public.person_application_harvest_cache(p_since timestamptz,p_ledger uuid default null) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare a person_private.application_work;s person_private.application_harvest_selections;e public.candidate_enrichments;
begin
 a:=person_private.application_source_context();select * into s from person_private.application_harvest_selections where work_id=a.work_id;
 if found then
  if p_ledger is not null and p_ledger<>s.ledger_id then raise exception 'enrichment_selection_changed';end if;
  select * into e from public.candidate_enrichments where id=s.ledger_id for share;
  perform person_private.enrichment_selection_check(a.work_id,e);
 else
  select x.* into e from public.candidate_enrichments x left join person_private.application_harvest l on l.ledger_id=x.id
   where x.organization_id=a.organization_id and x.linkedin_username=a.input_snapshot->>'linkedin_username' and x.provider='harvest' and x.operation='full_profile' and x.status='ok' and x.cache_status='miss' and x.raw_payload is not null
    and (case when p_ledger is null then x.created_at>=p_since else x.id=p_ledger end)
    and (l.work_id is null or l.work_id=a.work_id or exists(select 1 from person_private.application_candidates b join public.person_application_receipts r on r.application_id=b.application_id and r.candidate_id=b.candidate_id and r.harvest_ledger_id=x.id where b.work_id=l.work_id and b.candidate_id=x.candidate_id))
   order by x.created_at desc,x.id desc limit 1 for share of x;
  if not found then perform person_private.application_context();return null;end if;
 end if;
 perform person_private.enrichment_cache_eligible(a,e);perform person_private.application_context();perform person_private.enrichment_selection_pin(a.work_id,e);perform person_private.application_context();
 return jsonb_build_object('id',e.id,'raw_payload',e.raw_payload);
end$$;

create or replace function public.person_application_harvest_attach(p_ledger uuid) returns void language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare a person_private.application_work;b person_private.application_candidates;l person_private.application_harvest;e public.candidate_enrichments;target public.candidate_enrichments;saved public.candidate_enrichments;
begin
 a:=person_private.application_source_context();select * into b from person_private.application_candidates where work_id=a.work_id;
 if b.work_id is null then raise exception 'application_candidate_required';end if;
 -- Capture/FKs need the candidate before the ledger; no inverse lock in triggers.
 perform pg_advisory_xact_lock(hashtext(b.candidate_id::text));perform 1 from public.candidates where id=b.candidate_id for share;if not found then raise exception 'application_candidate_required';end if;
 select * into e from public.candidate_enrichments where id=p_ledger for update;
 perform person_private.application_context();perform person_private.enrichment_cache_eligible(a,e);perform person_private.enrichment_selection_check(a.work_id,e);
 if e.candidate_id is not null and e.candidate_id<>b.candidate_id then raise exception 'application_harvest_owner';end if;
 select * into l from person_private.application_harvest where ledger_id=p_ledger;
 if l.work_id is not null and l.work_id<>a.work_id then perform person_private.application_context();return;end if;
 if l.work_id=a.work_id then
  l.attached_candidate_id:=b.candidate_id;update person_private.application_harvest set attached_candidate_id=b.candidate_id where work_id=a.work_id;perform person_private.enrichment_owner_check(l);
 end if;
 if e.candidate_id is null then
  target:=e;target.candidate_id:=b.candidate_id;perform person_private.enrichment_frame(a.work_id,e.id,'harvest_attach',to_jsonb(e),to_jsonb(target));
  update public.candidate_enrichments set candidate_id=b.candidate_id where id=e.id returning * into saved;
  if not found or to_jsonb(saved) is distinct from to_jsonb(target) then raise exception 'enrichment_actual';end if;
  perform person_private.enrichment_frame_clear();perform person_private.enrichment_selection_check(a.work_id,saved);
 end if;
 if l.work_id=a.work_id then perform person_private.enrichment_owner_check(l);end if;
 perform person_private.application_context();
end$$;

create function public.person_application_parser_record(p_parser text) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare a person_private.application_work;b person_private.application_candidates;r public.person_application_receipts;ready person_private.application_intake_ready;p person_private.application_parser_records;e public.candidate_enrichments;saved public.candidate_enrichments;
begin
 a:=person_private.application_source_context();
 if p_parser is null or p_parser not in ('llamaparse','pdf-parse') then raise exception 'enrichment_parser';end if;
 select * into b from person_private.application_candidates where work_id=a.work_id;select * into r from public.person_application_receipts where application_id=a.application_id;select * into ready from person_private.application_intake_ready where work_id=a.work_id;
 if b.work_id is null or ready.work_id is null or r.application_id is null or ready.candidate_id<>b.candidate_id or r.candidate_id<>b.candidate_id or nullif(btrim(r.application_snapshot->>'resume_text'),'') is null or nullif(a.input_snapshot->>'resume_path','') is null or a.input_snapshot->>'person_resume_sha256' is null then raise exception 'enrichment_parser_ready';end if;
 perform pg_advisory_xact_lock(hashtext(b.candidate_id::text));perform 1 from public.candidates where id=b.candidate_id for share;if not found then raise exception 'enrichment_parser_ready';end if;
 perform person_private.application_context();perform person_private.intake_ready_proof(ready,jsonb_build_object('work_id',a.work_id,'application_id',a.application_id,'candidate_id',b.candidate_id,'receipt',to_jsonb(r)));
 select * into p from person_private.application_parser_records where work_id=a.work_id;
 if found then
  select * into e from public.candidate_enrichments where id=p.ledger_id for share;
  if p.parser<>p_parser or p.candidate_id<>b.candidate_id or e.id is null or e.candidate_id is distinct from b.candidate_id or p.evidence_hash<>person_private.enrichment_evidence_hash(e) then raise exception 'enrichment_parser_replay';end if;
  perform person_private.application_context();return jsonb_build_object('id',e.id);
 end if;
 e:=jsonb_populate_record(null::public.candidate_enrichments,jsonb_build_object('id',gen_random_uuid(),'organization_id',a.organization_id,'candidate_id',b.candidate_id,'linkedin_username',a.input_snapshot->>'linkedin_username','provider',p_parser,'operation','resume_parse','cache_status','miss','status','ok','cost_credits',0,'created_at',clock_timestamp()));
 p:=row(a.work_id,e.id,b.candidate_id,p_parser,person_private.enrichment_evidence_hash(e))::person_private.application_parser_records;
 insert into person_private.application_parser_records select(p).*;perform person_private.enrichment_parser_check(p);
 perform person_private.enrichment_frame(a.work_id,e.id,'resume_parse',null,to_jsonb(e));insert into public.candidate_enrichments select(e).* returning * into saved;
 if not found or to_jsonb(saved) is distinct from to_jsonb(e) then raise exception 'enrichment_actual';end if;
 perform person_private.enrichment_frame_clear();perform person_private.enrichment_parser_check(p);perform person_private.application_context();return jsonb_build_object('id',saved.id);
end$$;
revoke all on function person_private.enrichment_owner_check(person_private.application_harvest),person_private.enrichment_parser_check(person_private.application_parser_records),person_private.enrichment_evidence_hash(public.candidate_enrichments),person_private.enrichment_frame(uuid,uuid,text,jsonb,jsonb),person_private.enrichment_frame_clear(),person_private.enrichment_selection_check(uuid,public.candidate_enrichments),person_private.enrichment_selection_pin(uuid,public.candidate_enrichments),person_private.enrichment_cache_eligible(person_private.application_work,public.candidate_enrichments),person_private.legacy_email_guard(),person_private.enrichment_no_truncate(),public.person_application_parser_record(text) from public,anon,authenticated,service_role;
grant execute on function public.person_application_parser_record(text) to service_role;
