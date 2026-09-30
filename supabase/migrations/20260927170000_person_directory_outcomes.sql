-- PREPARED ONLY. Nonmutating outcomes; no worker/consumer or suppression writes.
set local lock_timeout='2s';set local statement_timeout='30s';
alter table person_private.directory_executions add column disposition text not null default 'normalized' check(disposition in ('normalized','outcome'));
alter table person_private.directory_executions add column outcome_hash text;
-- Prepared build only. Nonunique preserves legacy mixed-case identities. The
-- bounded lock/statement timeouts apply when this chain is eventually approved.
-- Production must pre-build this CONCURRENTLY using the runbook. Do not issue
-- CREATE INDEX (even IF NOT EXISTS) for a prebuilt index: it takes ShareLock on
-- candidates until this migration commits. Fresh local fixtures can still build it.
do $$ begin
 if to_regclass('public.candidates_person_username_idx') is null then
  create index candidates_person_username_idx on public.candidates(lower(linkedin_username));
 end if;
 if not exists (
  select 1 from pg_index i join pg_class c on c.oid=i.indexrelid
  join pg_am a on a.oid=c.relam
  where i.indexrelid=to_regclass('public.candidates_person_username_idx')
   and i.indrelid='public.candidates'::regclass and i.indisvalid and i.indisready
   and not i.indisunique and i.indpred is null and i.indnatts=1 and a.amname='btree'
   and pg_get_expr(i.indexprs,i.indrelid) in ('lower(linkedin_username)','lower((linkedin_username)::text)')
 ) then raise exception 'candidate identity index is not ready'; end if;
end $$;
create function person_private.directory_identity_owners(p_contact uuid,p_identities jsonb) returns table(id uuid)
language sql stable set search_path='' as $$
 select c.id from public.candidates c where lower(c.linkedin_username)=any(array(select x.value from jsonb_to_recordset(p_identities) x(kind text,value text) where x.kind='linkedin_username'))
 union select c.id from public.candidates c where c.directory_contact_id=p_contact
 union select c.id from public.candidates c where c.airtable_id=any(array(select x.value from jsonb_to_recordset(p_identities) x(kind text,value text) where x.kind='airtable_id'))
 union select i.candidate_id from public.candidate_identities i join jsonb_to_recordset(p_identities) x(kind text,value text) on i.kind=x.kind and i.value=x.value
$$;
create table person_private.directory_outcomes(
 execution_id uuid primary key references person_private.directory_executions(id),
 work_id uuid not null,transaction_id xid8 not null,input_hash text not null,
 identities jsonb not null,observations jsonb not null,receipt_before jsonb not null,
 result jsonb not null,receipt_after jsonb not null
);
alter table person_private.directory_outcomes enable row level security;
revoke all on person_private.directory_outcomes from public,anon,authenticated,service_role;

-- Read-only, bounded by the certified input's identity set. The caller holds
-- identity/contact locks and, for a sole owner, that candidate's lock and row.
create function person_private.directory_outcome_observe(p_id uuid,p_identities jsonb) returns jsonb
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;r public.person_directory_receipts;s public.person_directory_state;newer public.person_directory_receipts;owners jsonb;candidate jsonb;profile jsonb;holds jsonb;cid uuid;
begin
 select * into e from person_private.directory_executions where id=p_id;
 if e.id is null or jsonb_typeof(p_identities) is distinct from 'array' or jsonb_array_length(p_identities)=0 then raise exception 'directory_outcome_input';end if;
 select * into r from public.person_directory_receipts where id=e.receipt_id;
 select * into s from public.person_directory_state where contact_id=e.contact_id;
 select * into newer from public.person_directory_receipts where id=s.latest_receipt_id;
 if s.workspace_id is distinct from e.workspace_id or newer.id is null or newer.id<e.receipt_id or newer.workspace_id is distinct from e.workspace_id or newer.contact_id is distinct from e.contact_id or person_private.directory_verify(newer.id) is distinct from true then raise exception 'directory_input_state';end if;
 -- A superseded input has no relevant candidate; do not resolve or lock one.
 if newer.id<>e.receipt_id then
  return jsonb_build_object('state',to_jsonb(s),'latest_input_hash',(select input_hash from person_private.directory_inputs where receipt_id=newer.id),'owners','[]'::jsonb,'candidate',null,'profile',null,'holds',null);
 end if;
 select coalesce(jsonb_agg(id order by id),'[]') into owners from person_private.directory_identity_owners(e.contact_id,p_identities);
 if jsonb_array_length(owners)=1 then
  cid:=(owners->>0)::uuid;candidate:=person_private.publication_candidate(cid);
  select to_jsonb(p) into profile from public.candidate_profile_state p where candidate_id=cid;
  select coalesce(jsonb_agg(jsonb_build_array(h.ledger_id,h.evidence_hash,h.reason) order by h.ledger_id,h.evidence_hash),'[]') into holds from public.person_source_holds h where h.candidate_id=cid and h.resolved_at is null;
 end if;
 return jsonb_build_object('state',to_jsonb(s),'latest_input_hash',(select input_hash from person_private.directory_inputs where receipt_id=newer.id),'owners',owners,'candidate',candidate,'profile',profile,'holds',holds);
end$$;

-- No caller-supplied status/reason. Preserve the legacy outcome ordering.
create function person_private.directory_outcome_result(p_id uuid,p_identities jsonb,p_observations jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare e person_private.directory_executions;r public.person_directory_receipts;owners jsonb;candidate jsonb;suppressed boolean;cid text;
begin
 select * into e from person_private.directory_executions where id=p_id;
 select * into r from public.person_directory_receipts where id=e.receipt_id;
 owners:=p_observations->'owners';candidate:=p_observations->'candidate';cid:=candidate->>'id';
 suppressed:=r.snapshot->'board'->>'do_not_contact'='true' or r.snapshot->'board'->>'status'='Do Not Contact';
 if (p_observations->'state'->>'latest_receipt_id')::bigint<>e.receipt_id then return jsonb_build_object('status','superseded');end if;
 if jsonb_array_length(owners)>1 then return jsonb_build_object('status','review','reason','directory_identity_conflict');end if;
 if jsonb_array_length(owners)=0 and suppressed then return jsonb_build_object('status','suppressed','candidateId',null,'created',false);end if;
 if jsonb_array_length(owners)=0 and not exists(select 1 from jsonb_to_recordset(p_identities) x(kind text,value text) where x.kind='linkedin_username') then return jsonb_build_object('status','review','reason','directory_linkedin_required');end if;
 if cid is null then return null;end if;
 if candidate->>'directory_contact_id' is not null and candidate->>'directory_contact_id'<>e.contact_id::text then return jsonb_build_object('status','review','reason','directory_linkage_conflict');end if;
 if suppressed then return null;end if; -- Existing-person suppression stays gated.
 if p_observations->'profile'='null'::jsonb then return jsonb_build_object('status','review','candidateId',cid,'reason','directory_person_not_migrated');end if;
 if jsonb_array_length(p_observations->'holds')>0 then return jsonb_build_object('status','review','candidateId',cid,'reason','directory_source_hold');end if;
 return null;
end$$;

create function person_private.directory_outcome_valid(p_id uuid) returns boolean
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;proof person_private.directory_outcomes;r public.person_directory_receipts;w person_private.transition_work;observed jsonb;expected jsonb;
begin
 select * into e from person_private.directory_executions where id=p_id;
 select * into proof from person_private.directory_outcomes where execution_id=p_id;
 if e.id is null or proof.execution_id is null then return false;end if;
 select * into r from public.person_directory_receipts where id=e.receipt_id;
 select * into w from person_private.transition_work where id=e.work_id;
 observed:=person_private.directory_outcome_observe(p_id,proof.identities);
 expected:=person_private.directory_outcome_result(p_id,proof.identities,observed);
 return e.disposition='outcome' and e.result is not null and e.completed_at is not null and
  e.audit_id is null and e.decision is null and e.evidence is null and e.next_document=0 and e.projection is null and e.creation_execution_id is null and e.prepared_revision is null and not e.metadata_done and not e.enqueue_done and
  proof.work_id=e.work_id and proof.transaction_id=e.transaction_id and proof.input_hash=e.input_hash and proof.identities=e.identities and
  e.outcome_hash=person_private.intake_hash(to_jsonb(proof)) and
  w.id=e.work_id and w.family='directory' and w.scope='tt_person' and w.organization_id=e.organization_id and w.input_hash=e.input_hash and w.resource_key='directory:'||e.receipt_id::text||':'||e.id::text and
  observed=proof.observations and expected=proof.result and expected=e.result and to_jsonb(r)=proof.receipt_after and e.receipt_after=proof.receipt_after and
  e.candidate_id is not distinct from (observed->'candidate'->>'id')::uuid and e.candidate_before is not distinct from nullif(observed->'candidate','null'::jsonb) and
  proof.receipt_before->>'phase'='ready' and proof.receipt_before->'candidate_id'='null'::jsonb and proof.receipt_before->'documents'='null'::jsonb and proof.receipt_before->'result'='null'::jsonb and proof.receipt_before->'created_person'='false'::jsonb and proof.receipt_before->'projected'='false'::jsonb and
  person_private.directory_verify(e.receipt_id);
end$$;

create function person_private.directory_outcome(p_id uuid,p_identities jsonb) returns jsonb
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;r public.person_directory_receipts;s public.person_directory_state;observed jsonb;target jsonb;outcome_result jsonb;cid uuid;expected person_private.directory_outcomes;saved person_private.directory_outcomes;w person_private.transition_work;
begin
 e:=person_private.directory_context(p_id);
 if e.candidate_id is not null or e.decision is not null or e.audit_id is not null or e.disposition<>'normalized' or exists(select 1 from person_private.directory_outcomes where execution_id=p_id) then raise exception 'directory_outcome_order';end if;
 select * into r from public.person_directory_receipts where id=e.receipt_id for update;
 select * into s from public.person_directory_state where contact_id=e.contact_id for update;
 perform person_private.directory_context(p_id);
 if r.phase<>'ready' then return null;end if; -- Promotion/replay has its own proof.
 if r.candidate_id is not null or r.created_person or r.documents is not null or r.result is not null or r.projected or r.source_reviews is distinct from '[]'::jsonb or r.attempts<>0 or r.error_code is not null then raise exception 'directory_outcome_unproven';end if;
 if r.derivative_text is not null or r.derivative_revision is not null or r.derivative_token is not null or r.derivative_lease_until is not null or r.derivatives_claimed_at is not null or r.derivative_attempts<>0 or r.derivative_done or r.derivative_error is not null then raise exception 'directory_derivative_unproven';end if;
 observed:=person_private.directory_outcome_observe(p_id,p_identities);
 if jsonb_array_length(observed->'owners')=1 then
  cid:=(observed->'owners'->>0)::uuid;
  perform pg_advisory_xact_lock(hashtext(cid::text));perform 1 from public.candidates where id=cid for update;
  perform person_private.directory_context(p_id);
  observed:=person_private.directory_outcome_observe(p_id,p_identities);
  if observed->'owners' is distinct from jsonb_build_array(cid) then raise exception 'directory_identity_conflict';end if;
 end if;
 outcome_result:=person_private.directory_outcome_result(p_id,p_identities,observed);
 if outcome_result is null then return null;end if;
 target:=to_jsonb(r)||jsonb_build_object('phase',outcome_result->>'status','result',outcome_result,'error_code',outcome_result->>'reason','updated_at',clock_timestamp());
 if outcome_result ? 'candidateId' and outcome_result->>'candidateId' is not null then target:=target||jsonb_build_object('candidate_id',cid,'attempts',r.attempts+1);end if;
 expected:=row(p_id,e.work_id,e.transaction_id,e.input_hash,p_identities,observed,to_jsonb(r),outcome_result,target)::person_private.directory_outcomes;
 insert into person_private.directory_outcomes select expected.* returning * into saved;
 if to_jsonb(saved) is distinct from to_jsonb(expected) or (select to_jsonb(x) from person_private.directory_outcomes x where execution_id=p_id) is distinct from to_jsonb(expected) then raise exception 'directory_outcome_actual';end if;
 perform person_private.directory_mutate('person_directory_receipts',to_jsonb(r),target);
 perform person_private.directory_context(p_id);
 update person_private.directory_executions set disposition='outcome',outcome_hash=person_private.intake_hash(to_jsonb(expected)),candidate_id=cid,candidate_before=nullif(observed->'candidate','null'::jsonb),identities=p_identities,result=outcome_result,completed_at=clock_timestamp(),receipt_after=target where id=p_id;
 if person_private.directory_outcome_valid(p_id) is distinct from true then raise exception 'directory_outcome_witness';end if;
 perform person_private.transition_finish(e.work_id,current_setting('person.work_token')::uuid,'completed');
 select * into w from person_private.transition_work where id=e.work_id;
 if w.status is distinct from 'completed' or w.finished_at is null or w.lease_until<=clock_timestamp() or person_private.directory_outcome_valid(p_id) is distinct from true then raise exception 'directory_outcome_completion';end if;
 return outcome_result;
end$$;

do $$declare b text;needle text:=' select * into e from person_private.directory_executions where id=p_id;';begin
 b:=pg_get_functiondef('person_private.directory_completion_valid(uuid)'::regprocedure);
 if position(needle in b)=0 then raise exception 'directory_outcome_definition';end if;
 b:=replace(b,needle,needle||E'\n if e.disposition=''outcome'' then return person_private.directory_outcome_valid(p_id);end if;');execute b;
 b:=pg_get_functiondef('person_private.directory_capture(uuid)'::regprocedure);
 needle:='prior_execution.completed_at is not null';
 if position(needle in b)=0 then raise exception 'directory_outcome_definition';end if;
 b:=replace(b,needle,needle||' and prior_execution.disposition=''normalized''');execute b;
 b:=pg_get_functiondef('person_private.directory_seed(uuid,text,jsonb)'::regprocedure);
 needle:=$original$exists(select 1 from public.candidates c where c.directory_contact_id=e.contact_id or exists(select 1 from jsonb_to_recordset(p_identities) x(kind text,value text) where (x.kind='linkedin_username' and lower(c.linkedin_username)=x.value) or (x.kind='airtable_id' and c.airtable_id=x.value))) or exists(select 1 from public.candidate_identities i join jsonb_to_recordset(p_identities) x(kind text,value text) on i.kind=x.kind and i.value=x.value)$original$;
 if position(needle in b)=0 then raise exception 'directory_outcome_definition';end if;
 b:=replace(b,needle,'exists(select 1 from person_private.directory_identity_owners(e.contact_id,p_identities))');execute b;
end$$;
do $$declare p record;begin
 for p in select oid::regprocedure signature from pg_proc where pronamespace='person_private'::regnamespace and proname in ('directory_identity_owners','directory_outcome_observe','directory_outcome_result','directory_outcome_valid','directory_outcome') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',p.signature);
 end loop;
end$$;
