-- PREPARED ONLY. Existing-person directory publication. No worker/consumer activation.
set local lock_timeout='2s';set local statement_timeout='30s';
alter table person_private.directory_executions drop constraint directory_executions_mode_check;
alter table person_private.directory_executions add constraint directory_executions_mode_check check(mode in ('shadow','live'));
alter table person_private.directory_executions add column shadow_id uuid references person_private.directory_executions(id),
 add column prepared_revision bigint,add column primary_changed boolean,add column projection jsonb,
 add column candidate_after jsonb,add column metadata_done boolean not null default false,
 add column enqueue_done boolean not null default false,add column derivative_job jsonb,
 add column receipt_after jsonb,add column derivative_receipt jsonb;


create or replace function person_private.directory_begin(p_org uuid,p_workspace uuid,p_receipt bigint,p_execution uuid,p_mode text,p_token uuid) returns jsonb
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare c person_private.transition_control;e person_private.directory_executions;r public.person_directory_receipts;w person_private.transition_work;a jsonb;h text;
begin
 c:=person_private.directory_scope(p_org,p_workspace);
 if p_execution is null or p_receipt is null or p_token is null or p_mode is null or p_mode not in ('shadow','live') then raise exception 'directory_execution_input';end if;
 -- Serialize the UUID before work/business locks, including different receipts.
 perform pg_advisory_xact_lock(72014,hashtext(p_execution::text));
 select * into e from person_private.directory_executions where id=p_execution;
 if found then
  if e.organization_id<>p_org or e.workspace_id<>p_workspace or e.receipt_id<>p_receipt or e.mode<>p_mode then raise exception 'directory_execution_binding';end if;
  select * into w from person_private.transition_work where id=e.work_id;
  if e.result is null or e.completed_at is null or w.status is distinct from 'completed' then raise exception 'directory_execution_incomplete';end if;
  return jsonb_build_object('status','completed','result',e.result);
 end if;
 if c.enabled and c.phase<>'open' then raise exception 'directory_held';end if;
 select * into r from public.person_directory_receipts where id=p_receipt;
 if r.id is null or r.workspace_id<>p_workspace or not person_private.directory_verify(p_receipt) then raise exception 'directory_input_review';end if;
 select input_hash into h from person_private.directory_inputs where receipt_id=p_receipt;
 a:=person_private.transition_claim('tt_person',p_org,'directory','directory:'||p_receipt::text||':'||p_execution::text,h,p_token,300);
 if a->>'status' is distinct from 'admitted' then raise exception 'directory_execution_admission';end if;
 perform set_config('person.work_id',a->>'work_id',true);perform set_config('person.work_token',p_token::text,true);
 insert into person_private.directory_executions(id,work_id,organization_id,workspace_id,receipt_id,contact_id,input_hash,mode,backend_pid,transaction_id)
 values(p_execution,(a->>'work_id')::uuid,p_org,p_workspace,p_receipt,r.contact_id,h,p_mode,pg_backend_pid(),pg_current_xact_id());
 e:=person_private.directory_context(p_execution);
 return jsonb_build_object('status','admitted','snapshot',r.snapshot,'workId',e.work_id);
end$$;

create or replace function person_private.directory_bind(p_id uuid,p_candidate uuid,p_identities jsonb) returns jsonb
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;r public.person_directory_receipts;s public.person_directory_state;c jsonb;prior person_private.directory_executions;
begin
 e:=person_private.directory_context(p_id);
 select * into r from public.person_directory_receipts where id=e.receipt_id for update;
 select * into s from public.person_directory_state where contact_id=e.contact_id for update;
 if s.latest_receipt_id is distinct from e.receipt_id or s.workspace_id is distinct from e.workspace_id then raise exception 'directory_receipt_ineligible';end if;
 if r.phase='done' and e.mode='live' and not r.projected then
  select * into prior from person_private.directory_executions where receipt_id=e.receipt_id and mode='shadow' and completed_at is not null order by completed_at desc limit 1;
  if prior.id is null or prior.candidate_id is distinct from p_candidate or prior.identities is distinct from p_identities or
   person_private.directory_completion_valid(prior.id) is distinct from true or r.result is distinct from prior.result or
   not exists(select 1 from person_private.transition_work where id=prior.work_id and status='completed') then raise exception 'directory_shadow_proof';end if;
 elsif r.phase<>'ready' or r.documents is not null or r.result is not null or r.candidate_id is not null or r.projected then raise exception 'directory_receipt_ineligible';end if;
 if r.derivative_text is not null or r.derivative_revision is not null or r.derivative_token is not null or r.derivative_lease_until is not null or r.derivatives_claimed_at is not null or r.derivative_attempts<>0 or r.derivative_done or r.derivative_error is not null then raise exception 'directory_derivative_unproven';end if;
 if r.snapshot->'board'->>'do_not_contact'='true' or r.snapshot->'board'->>'status'='Do Not Contact' then raise exception 'directory_suppression_unavailable';end if;
 if p_candidate is null or jsonb_typeof(p_identities) is distinct from 'array' or jsonb_array_length(p_identities)=0 then raise exception 'directory_candidate_binding';end if;
 perform pg_advisory_xact_lock(hashtext(p_candidate::text));
 select to_jsonb(x) into c from public.candidates x where id=p_candidate for update;
 if c is null or not exists(select 1 from public.candidate_profile_state where candidate_id=p_candidate) then raise exception 'directory_person_not_migrated';end if;
 if c->>'directory_contact_id' is not null and c->>'directory_contact_id'<>e.contact_id::text then raise exception 'directory_linkage_conflict';end if;
 if exists(select 1 from public.person_source_holds where candidate_id=p_candidate and resolved_at is null) then raise exception 'directory_source_hold';end if;
 perform person_private.directory_context(p_id);
 update person_private.directory_executions set candidate_id=p_candidate,candidate_before=c,identities=p_identities where id=p_id;
 if prior.id is not null then
  update person_private.directory_executions set shadow_id=prior.id,evidence=prior.evidence,decision=prior.decision,decision_hash=prior.decision_hash,primary_value=prior.primary_value where id=p_id;
  return jsonb_build_object('adopted',true,'evidence',prior.evidence,'decision',prior.decision);
 end if;
 return person_private.directory_capture(p_id);
end$$;

create function person_private.directory_prepare(p_id uuid) returns bigint
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;r public.person_directory_receipts;s public.person_directory_state;
 old_primary jsonb;new_primary jsonb;changed_choice boolean;revision bigint;outcome jsonb;candidate jsonb;w person_private.transition_work;expected_state jsonb;returned_state jsonb;expected_contacts jsonb;actual_contacts jsonb;
begin
 e:=person_private.directory_context(p_id);
 if e.prepared_revision is not null then raise exception 'directory_already_prepared';end if;
 if e.decision is null or e.next_document<>jsonb_array_length(e.decision->'docs') then raise exception 'directory_incomplete';end if;
 select * into r from public.person_directory_receipts where id=e.receipt_id;
 select * into s from public.person_directory_state where contact_id=e.contact_id;
 if s.latest_receipt_id<>r.id or s.workspace_id<>e.workspace_id or (r.phase<>'ready' and not (r.phase='done' and e.shadow_id is not null)) then raise exception 'directory_receipt_ineligible';end if;
 if exists(select 1 from jsonb_to_recordset(e.identities) x(kind text,value text) left join public.candidate_identities i on i.kind=x.kind and i.value=x.value where i.candidate_id is distinct from e.candidate_id) then raise exception 'directory_identity_conflict';end if;
 select to_jsonb(x) into old_primary from public.person_directory_primary x where candidate_id=e.candidate_id and kind='email' for update;
 if (old_primary->>'receipt_id')::bigint>e.receipt_id then raise exception 'directory_primary_superseded';end if;
 changed_choice:=old_primary is null or old_primary->>'chosen_value' is distinct from e.primary_value;
 new_primary:=jsonb_build_object('candidate_id',e.candidate_id,'kind','email','directory_contact_id',e.contact_id,'chosen_value',e.primary_value,'receipt_id',e.receipt_id);
 perform person_private.directory_mutate('person_directory_primary',old_primary,new_primary);
 if changed_choice then
  perform person_private.directory_frame(p_id,e.decision->'docs'->0);
  select coalesce(jsonb_agg(to_jsonb(cc)||jsonb_build_object('rank',ranked.new_rank,'updated_at',case when cc.rank is distinct from ranked.new_rank then now() else cc.updated_at end) order by cc.id),'[]') into expected_contacts
  from public.candidate_contacts cc join public.person_contact_ranks(e.candidate_id) ranked on ranked.id=cc.id where cc.candidate_id=e.candidate_id;
  perform person_private.person_rerank_contacts_core(e.candidate_id);
  select coalesce(jsonb_agg(to_jsonb(cc) order by cc.id),'[]') into actual_contacts from public.candidate_contacts cc where cc.candidate_id=e.candidate_id;
  if actual_contacts is distinct from expected_contacts then raise exception 'directory_primary_actual';end if;
  select to_jsonb(ps)||jsonb_build_object('rev',ps.rev+1,'updated_at',clock_timestamp()) into expected_state from public.candidate_profile_state ps where candidate_id=e.candidate_id;
  update public.candidate_profile_state ps set rev=(expected_state->>'rev')::bigint,updated_at=(expected_state->>'updated_at')::timestamptz where candidate_id=e.candidate_id returning to_jsonb(ps) into returned_state;
  if expected_state is null or returned_state is distinct from expected_state or (select to_jsonb(ps) from public.candidate_profile_state ps where candidate_id=e.candidate_id) is distinct from expected_state then raise exception 'directory_primary_actual';end if;
  perform person_private.directory_context(p_id);perform person_private.normalization_frame(e.candidate_id);
  delete from person_private.directory_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 end if;
 select rev into revision from public.candidate_profile_state where candidate_id=e.candidate_id;
 update person_private.directory_executions set prepared_revision=revision,primary_changed=changed_choice where id=p_id;
 perform person_private.directory_context(p_id);
 return revision;
end$$;

create or replace function person_private.directory_completion_valid(p_id uuid) returns boolean
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;r public.person_directory_receipts;w person_private.transition_work;
begin
 select * into e from person_private.directory_executions where id=p_id;
 select * into r from public.person_directory_receipts where id=e.receipt_id;
 select * into w from person_private.transition_work where id=e.work_id;
 return e.id is not null and e.result is not null and e.completed_at is not null and e.candidate_id is not null and
 w.id is not null and w.family='directory' and w.scope='tt_person' and w.organization_id=e.organization_id and w.input_hash=e.input_hash and
 w.resource_key='directory:'||e.receipt_id::text||':'||e.id::text and r.phase='done' and r.candidate_id=e.candidate_id and not r.created_person and r.projected=(e.mode='live') and
 r.documents=e.decision->'docs' and r.source_reviews=e.decision->'reviews' and r.result=e.result and to_jsonb(r)=e.receipt_after and
 e.next_document=jsonb_array_length(e.decision->'docs') and e.prepared_revision is not null and
 (e.mode='shadow' or (e.projection is not null and e.candidate_after is not null and e.metadata_done and e.enqueue_done)) and
 e.decision_hash=person_private.intake_hash(jsonb_build_array(e.evidence,e.decision,e.identities,e.primary_value)) and
 exists(select 1 from person_private.directory_audit_operations d join public.person_audit_operations o on o.id=d.operation_id
 where d.execution_id=e.id and d.operation_id=e.audit_id and d.work_id=e.work_id and d.candidate_id=e.candidate_id and d.transaction_id=e.transaction_id
 and o.candidate_id=e.candidate_id and o.transaction_id=e.transaction_id and o.writer='directory' and o.receipt_ref='directory:'||e.receipt_id::text
 and d.operation_hash=person_private.directory_operation_hash(o));
end$$;

create or replace function person_private.directory_complete(p_id uuid) returns jsonb
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;r public.person_directory_receipts;s public.person_directory_state;
 old_primary jsonb;new_primary jsonb;changed_choice boolean;revision bigint;outcome jsonb;candidate jsonb;w person_private.transition_work;expected_state jsonb;returned_state jsonb;expected_contacts jsonb;actual_contacts jsonb;
begin
 e:=person_private.directory_context(p_id);
 if e.decision is null or e.next_document<>jsonb_array_length(e.decision->'docs') then raise exception 'directory_incomplete';end if;
 if e.prepared_revision is null then
  if e.mode<>'shadow' then raise exception 'directory_not_prepared';end if;
  perform person_private.directory_prepare(p_id);e:=person_private.directory_context(p_id);
 end if;
 select * into r from public.person_directory_receipts where id=e.receipt_id;
 select * into s from public.person_directory_state where contact_id=e.contact_id;
 if s.latest_receipt_id is distinct from r.id or s.workspace_id is distinct from e.workspace_id then raise exception 'directory_receipt_ineligible';end if;
 revision:=e.prepared_revision;changed_choice:=e.primary_changed;
 if (select rev from public.candidate_profile_state where candidate_id=e.candidate_id) is distinct from revision then raise exception 'projection_revision';end if;
 if e.mode='live' and (e.projection is null or not e.metadata_done or not e.enqueue_done or to_jsonb(r) is distinct from e.derivative_receipt or
  (select to_jsonb(j) from public.person_derivative_jobs j where candidate_id=e.candidate_id) is distinct from e.derivative_job or
  (select to_jsonb(ps) from public.person_projection_state ps where ps.candidate_id=e.candidate_id) is distinct from e.projection->'state' or
 (e.projection->>'historyId' is not null and (select to_jsonb(ph) from public.person_projection_history ph where ph.id=(e.projection->>'historyId')::bigint) is distinct from e.projection->'history')) then raise exception 'directory_publication_incomplete';end if;
 select to_jsonb(x) into candidate from public.candidates x where id=e.candidate_id;
 if candidate is distinct from (case when e.mode='live' then e.candidate_after else e.candidate_before end) then raise exception 'directory_candidate_changed';end if;
 outcome:=jsonb_build_object('status','done','candidateId',e.candidate_id,'created',false,'revision',revision::text,'semanticChanged',coalesce((e.projection->>'semanticChanged')::boolean,false),'projected',coalesce((e.projection->>'projected')::boolean,false),'reviewCount',jsonb_array_length(e.decision->'reviews'),'changed',e.changed or changed_choice or coalesce((e.projection->>'projected')::boolean,false));
 perform person_private.directory_mutate('person_directory_receipts',to_jsonb(r),to_jsonb(r)||jsonb_build_object('candidate_id',e.candidate_id,'projected',e.mode='live','documents',e.decision->'docs','source_reviews',e.decision->'reviews','phase','done','result',outcome,'attempts',r.attempts+1,'updated_at',clock_timestamp()));
 perform person_private.directory_mutate('person_directory_state',to_jsonb(s),to_jsonb(s)||jsonb_build_object('applied_receipt_id',e.receipt_id));
 perform person_private.directory_context(p_id);
 update person_private.directory_executions set result=outcome,completed_at=clock_timestamp(),receipt_after=(select to_jsonb(rr) from public.person_directory_receipts rr where rr.id=e.receipt_id) where id=p_id;
 if person_private.directory_completion_valid(p_id) is distinct from true then raise exception 'directory_completion_witness';end if;
 perform person_private.transition_finish(e.work_id,current_setting('person.work_token')::uuid,'completed');
 select * into w from person_private.transition_work where id=e.work_id;
 if w.status<>'completed' or w.finished_at is null or w.lease_until<=clock_timestamp() then raise exception 'directory_completion_work';end if;
 if (select to_jsonb(x) from public.candidates x where id=e.candidate_id) is distinct from (case when e.mode='live' then e.candidate_after else e.candidate_before end) then raise exception 'directory_candidate_changed';end if;
 return outcome;
end$$;

create table person_private.directory_projection_frames(
 backend_pid integer not null,transaction_id xid8 not null,work_id uuid not null,candidate_id uuid not null,
 operation_id uuid not null,before_profile jsonb not null,after_profile jsonb not null,
 execution_id uuid not null references person_private.directory_executions(id),primary key(backend_pid,transaction_id)
);
alter table person_private.directory_projection_frames enable row level security;
revoke all on person_private.directory_projection_frames from public,anon,authenticated,service_role;
create function person_private.projection_owner(p_execution uuid) returns void language plpgsql set search_path='' as $$
begin
 if p_execution is null then perform person_private.application_context();else perform person_private.directory_context(p_execution);end if;
end$$;
create or replace function person_private.projection_frame() returns person_private.application_projection_frames
language plpgsql security definer set search_path='' as $$
declare f person_private.application_projection_frames;d person_private.directory_projection_frames;e person_private.directory_executions;
begin
 select * into f from person_private.application_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 select * into d from person_private.directory_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if f.backend_pid is not null and d.backend_pid is not null then raise exception 'projection_nested';end if;
 if d.backend_pid is not null then
  e:=person_private.directory_context(d.execution_id);
  if e.mode<>'live' or e.work_id<>d.work_id or e.candidate_id is distinct from d.candidate_id or e.audit_id is distinct from d.operation_id then raise exception 'directory_projection_frame';end if;
  f:=row(d.backend_pid,d.transaction_id,d.work_id,d.candidate_id,d.operation_id,d.before_profile,d.after_profile)::person_private.application_projection_frames;
 end if;
 if f.backend_pid is null then raise exception 'projection_frame';end if;
 return f;
end$$;
create function person_private.projection_frame_clear(p_execution uuid) returns void language plpgsql set search_path='' as $$
begin
 if p_execution is null then delete from person_private.application_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 else delete from person_private.directory_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();end if;
end$$;
create function person_private.projection_frame_set(p_execution uuid,p_work uuid,p_candidate uuid,p_operation uuid,p_before jsonb,p_after jsonb,p_retry boolean) returns void
language plpgsql set search_path='' as $$
declare f person_private.application_projection_frames;
begin
 perform person_private.projection_owner(p_execution);
 if p_retry then
  f:=person_private.projection_frame();
  if f.work_id<>p_work or f.candidate_id<>p_candidate or f.operation_id<>p_operation or f.before_profile<>p_before then raise exception 'projection_frame_result';end if;
  perform person_private.projection_frame_clear(p_execution);
 elsif exists(select 1 from person_private.application_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or exists(select 1 from person_private.directory_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'projection_nested';end if;
 if p_execution is null then insert into person_private.application_projection_frames values(pg_backend_pid(),pg_current_xact_id(),p_work,p_candidate,p_operation,p_before,p_after);
 else insert into person_private.directory_projection_frames values(pg_backend_pid(),pg_current_xact_id(),p_work,p_candidate,p_operation,p_before,p_after,p_execution);end if;
 f:=person_private.projection_frame();
 if f.work_id is distinct from p_work or f.candidate_id is distinct from p_candidate or f.operation_id is distinct from p_operation or f.before_profile is distinct from p_before or f.after_profile is distinct from p_after then raise exception 'projection_frame_result';end if;
end$$;
-- Every projection reader dispatches through the same mutually exclusive frame.
do $$declare b text;sig text;needle text:='select * into p from person_private.application_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();';begin
 foreach sig in array array['person_private.conflict_insert(text,uuid[],jsonb,text,uuid)','person_private.intake_mutation_guard()'] loop
  b:=pg_get_functiondef(sig::regprocedure);if position(needle in b)=0 then raise exception 'projection_definition';end if;
  b:=replace(b,needle,'if exists(select 1 from person_private.application_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or exists(select 1 from person_private.directory_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then p:=person_private.projection_frame();end if;');execute b;
 end loop;
end$$;
create function person_private.directory_attribution_context(p_event bigint,p_operation uuid,p_scope text) returns uuid language plpgsql set search_path='' as $$
declare d person_private.directory_audit_operations;e person_private.directory_executions;o public.person_audit_operations;ev public.person_change_events;
begin
 select * into d from person_private.directory_audit_operations where operation_id=p_operation;
 e:=person_private.directory_context(d.execution_id);
 select * into o from public.person_audit_operations where id=p_operation;
 select * into ev from public.person_change_events where id=p_event;
 if e.mode<>'live' or e.audit_id is distinct from p_operation or d.work_id<>e.work_id or d.candidate_id<>e.candidate_id or
 d.transaction_id<>pg_current_xact_id() or o.transaction_id is distinct from d.transaction_id or
 d.operation_hash is distinct from person_private.directory_operation_hash(o) or ev.id is null or ev.id<=d.captured_version or ev.candidate_id<>e.candidate_id or ev.transaction_id is distinct from d.transaction_id or ev.source_table<>'candidates' or ev.source_row_id<>e.candidate_id::text or ev.operation<>'UPDATE' or p_scope not in ('profile','directory_metadata') then raise exception 'directory_attribution_scope';end if;
 return e.id;
end$$;
create or replace function person_private.attribute_change(p_event bigint,p_operation uuid,p_scope text) returns void
language plpgsql security definer set search_path='' as $$
declare guarded boolean;cid uuid;directory_id uuid;
begin
 if exists(select 1 from person_private.directory_audit_operations where operation_id=p_operation) then
  directory_id:=person_private.directory_attribution_context(p_event,p_operation,p_scope);
 else
  guarded:=person_private.normalization_gate() or exists(select 1 from person_private.application_audit_operations where operation_id=p_operation);
  if guarded then perform person_private.application_attribution_context(p_event,p_operation,p_scope);end if;
 end if;
 select candidate_id into cid from public.person_audit_operations where id=p_operation;
 perform person_private.audit_proof_frame('person_change_attributions',cid);
 perform person_private.attribute_change_core(p_event,p_operation,p_scope);
 perform person_private.audit_proof_clear('person_change_attributions');
 if directory_id is not null then perform person_private.directory_context(directory_id);elsif guarded then perform person_private.application_context();end if;
exception when others then perform person_private.audit_proof_clear('person_change_attributions');raise;
end$$;

create function person_private.projection_apply(p_execution uuid,wid uuid,cid uuid,oid uuid,rev bigint,p_envelope jsonb) returns jsonb
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
<<shared_projection>>
declare expected_history public.person_projection_history;expected_state public.person_projection_state;c public.candidates;typed public.candidates;before_profile jsonb;after_profile jsonb;fallback jsonb;chosen jsonb;actual jsonb;
 n integer;event_id bigint;boundary bigint;history_id bigint;constraint_name text;before_hash text;after_hash text;
 semantic_before text;semantic_after text;chosen_bytes text;semantic_bytes text;collision boolean:=false;changed text[];key text;
begin
 perform person_private.projection_owner(p_execution);
 if exists(select 1 from person_private.application_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or exists(select 1 from person_private.directory_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'projection_nested';end if;
 select * into c from public.candidates where id=cid for update;
 if c.id is null or (select s.rev from public.candidate_profile_state s where candidate_id=cid) is distinct from rev then raise exception 'projection_revision';end if;
 select coalesce(max(id),0) into boundary from public.person_change_events where candidate_id=cid;
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
 if (p_envelope->>'collision')::jsonb is distinct from jsonb_build_array(cid::text,after_profile->>'email') then raise exception 'projection_collision';end if;
 -- Trusted semantic transformation is observation metadata, never authority or
 -- the no-op decision. Compatibility bytes are checked against actual typed data.
 foreach key in array array['semanticBefore','semanticAfter','semanticFallback'] loop
  if jsonb_typeof((p_envelope->>key)::jsonb) is distinct from 'object' then raise exception 'projection_envelope';end if;
 end loop;
 before_hash:=encode(sha256(convert_to(p_envelope->>'before','UTF8')),'hex');
 if exists(select 1 from public.person_projection_state where candidate_id=cid and profile_hash<>before_hash) then raise exception 'legacy_projection_drift';end if;
 collision:=after_profile->>'email' is not null and after_profile->>'email' is distinct from c.email and exists(select 1 from public.candidates where email=after_profile->>'email' and id<>cid);
 chosen:=case when collision then fallback else after_profile end;
 perform person_private.projection_frame_set(p_execution,wid,cid,oid,before_profile,chosen,false);
 -- A constraint race may appear after the ownership query. Roll back its
 -- candidate/event writes before retrying exactly the validated email fallback.
 for n in 1..2 loop
  begin
   if chosen is distinct from before_profile then
    typed:=jsonb_populate_record(null::public.candidates,chosen);
    update public.candidates set full_name=typed.full_name,current_title=typed.current_title,current_company=typed.current_company,current_company_id=typed.current_company_id,work_experience=typed.work_experience,education=typed.education,education_schools=typed.education_schools,education_degrees=typed.education_degrees,education_fields=typed.education_fields,top_skills=typed.top_skills,all_skills_text=typed.all_skills_text,previous_companies=typed.previous_companies,headline=typed.headline,profile_summary=typed.profile_summary,location=typed.location,profile_picture_url=typed.profile_picture_url,email=typed.email,phone=typed.phone,updated_at=clock_timestamp() where id=cid returning person_private.projection_profile(to_jsonb(candidates)) into actual;
    if actual is distinct from chosen then raise exception 'projection_result';end if;
    select id into strict event_id from public.person_change_events where candidate_id=cid and source_table='candidates' and source_row_id=cid::text and transaction_id=pg_current_xact_id() and id>boundary and operation='UPDATE';
    perform person_private.attribute_change(event_id,oid,'profile');
   end if;
   exit;
  exception when unique_violation then
   get stacked diagnostics constraint_name=constraint_name;
   if n<>1 or collision or not exists(select 1 from pg_constraint k where k.conrelid='public.candidates'::regclass and k.contype='u' and k.conname=constraint_name and k.conkey=array[(select attnum from pg_attribute where attrelid='public.candidates'::regclass and attname='email')]::smallint[]) then raise;end if;
   collision:=true;chosen:=fallback;
   perform person_private.projection_frame_set(p_execution,wid,cid,oid,before_profile,chosen,true);
  end;
 end loop;
 if collision then
  perform 1 from person_private.conflict_insert('legacy_email_collision',array[cid],'{}'::jsonb,encode(sha256(convert_to(p_envelope->>'collision','UTF8')),'hex'));
 end if;
 chosen_bytes:=p_envelope->>(case when collision then 'fallback' else 'after' end);
 semantic_bytes:=p_envelope->>(case when collision then 'semanticFallback' else 'semanticAfter' end);
 after_hash:=encode(sha256(convert_to(chosen_bytes,'UTF8')),'hex');
 semantic_before:=encode(sha256(convert_to(p_envelope->>'semanticBefore','UTF8')),'hex');semantic_after:=encode(sha256(convert_to(semantic_bytes,'UTF8')),'hex');
 select coalesce(array_agg(k order by k),'{}') into changed from jsonb_object_keys(before_profile) k where before_profile->k is distinct from chosen->k;
 if cardinality(changed)>0 then
  expected_history:=jsonb_populate_record(null::public.person_projection_history,jsonb_build_object('id',nextval('public.person_projection_history_id_seq'),'candidate_id',cid,'revision',rev,'before_profile',before_profile,'after_hash',after_hash,'semantic_before',semantic_before,'semantic_after',semantic_after,'created_at',clock_timestamp(),'restored_at',null,'run_id',null));
  insert into public.person_projection_history overriding system value select expected_history.* returning id into history_id;
  if history_id is distinct from expected_history.id or (select to_jsonb(h) from public.person_projection_history h where id=history_id) is distinct from to_jsonb(expected_history) then raise exception 'projection_history_actual';end if;
 end if;
 select * into expected_state from public.person_projection_state where candidate_id=cid;
 if expected_state.candidate_id is null or (expected_state.revision,expected_state.profile_hash,expected_state.semantic_hash) is distinct from (rev,after_hash,semantic_after) then
  expected_state:=row(cid,rev,after_hash,semantic_after,clock_timestamp())::public.person_projection_state;
  insert into public.person_projection_state as old select expected_state.*
  on conflict(candidate_id) do update set revision=excluded.revision,profile_hash=excluded.profile_hash,semantic_hash=excluded.semantic_hash,updated_at=excluded.updated_at;
 end if;
 if (select to_jsonb(ps) from public.person_projection_state ps where candidate_id=cid) is distinct from to_jsonb(expected_state) then raise exception 'projection_state_actual';end if;
 if person_private.projection_profile((select to_jsonb(cc) from public.candidates cc where id=cid)) is distinct from chosen or
 ((select to_jsonb(cc) from public.candidates cc where id=cid)-array(select jsonb_object_keys(chosen))-'updated_at') is distinct from (to_jsonb(c)-array(select jsonb_object_keys(chosen))-'updated_at') or
 not exists(select 1 from public.person_projection_state where candidate_id=cid and revision=rev and profile_hash=shared_projection.after_hash and semantic_hash=shared_projection.semantic_after) or
 (history_id is not null and not exists(select 1 from public.person_projection_history h where h.id=history_id and h.candidate_id=cid and h.revision=rev and h.before_profile=shared_projection.before_profile and h.after_hash=shared_projection.after_hash and h.semantic_before=shared_projection.semantic_before and h.semantic_after=shared_projection.semantic_after and h.run_id is null and h.restored_at is null)) then raise exception 'projection_actual';end if;
 perform person_private.projection_owner(p_execution);
 perform person_private.projection_frame_clear(p_execution);
 return jsonb_build_object('revision',rev::text,'projected',cardinality(changed)>0,'semanticChanged',cardinality(changed)>0 and semantic_before<>semantic_after,'historyId',history_id::text,'changedFields',to_jsonb(changed),'emailCollision',collision,'usedFallback',collision);
exception when others then
 perform person_private.projection_frame_clear(p_execution);raise;
end$$;

CREATE OR REPLACE FUNCTION person_private.intake_project_core(p_operation uuid, p_revision bigint, p_envelope jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
 SET "DateStyle" TO 'ISO,YMD'
AS $function$
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
 oid:=(public.person_application_audit_begin(false)->>'id')::uuid;
 return person_private.projection_apply(null,a.work_id,b.candidate_id,oid,rev,p_envelope);
end$function$;
create function person_private.directory_project(p_id uuid,p_revision bigint,p_envelope jsonb) returns jsonb
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;doc jsonb;src jsonb;project_result jsonb;
begin
 e:=person_private.directory_context(p_id);
 if e.mode<>'live' or e.audit_id is null or e.projection is not null or e.prepared_revision is distinct from p_revision or e.next_document<>jsonb_array_length(e.decision->'docs') then raise exception 'directory_projection_order';end if;
 for doc in select value from jsonb_array_elements(e.decision->'docs') loop
  src:=doc->'source';
  if not exists(select 1 from public.candidate_sources cs where cs.candidate_id=e.candidate_id and cs.source=src->>'source' and cs.source_ref is not distinct from src->>'source_ref' and cs.provider is not distinct from src->>'provider' and cs.payload_hash=src->>'payload_hash' and cs.parser_version=src->>'parser_version' and cs.fetched_at=(src->>'fetched_at')::timestamptz and cs.raw_in=src->>'raw_in' and cs.enrichment_id is not distinct from nullif(src->>'enrichment_id','')::uuid) then raise exception 'directory_projection_source';end if;
 end loop;
 project_result:=person_private.projection_apply(p_id,e.work_id,e.candidate_id,e.audit_id,p_revision,p_envelope);
 perform person_private.directory_context(p_id);
 update person_private.directory_executions set projection=project_result||jsonb_build_object('state',(select to_jsonb(ps) from public.person_projection_state ps where ps.candidate_id=e.candidate_id),'history',(select to_jsonb(ph) from public.person_projection_history ph where ph.id=(project_result->>'historyId')::bigint)),candidate_after=(select to_jsonb(c) from public.candidates c where id=e.candidate_id) where id=p_id;
 return project_result;
end$$;
create table person_private.directory_candidate_frames(
 backend_pid integer not null,transaction_id xid8 not null,execution_id uuid not null,
 before_row jsonb not null,after_row jsonb not null,before_seen boolean not null default false,after_seen boolean not null default false,
 primary key(backend_pid,transaction_id)
);
alter table person_private.directory_candidate_frames enable row level security;
revoke all on person_private.directory_candidate_frames from public,anon,authenticated,service_role;
-- Dispatch metadata before the existing application-only mutation branches. Both
-- BEFORE and AFTER must consume their one-use exact full-row proof.
do $$declare b text;needle text:=' if not person_private.normalization_required() then return coalesce(new,old);end if;';begin
 b:=pg_get_functiondef('person_private.intake_mutation_guard()'::regprocedure);
 if position(needle in b)=0 then raise exception 'directory_metadata_definition';end if;
 b:=replace(b,';k text;', ';k text;df person_private.directory_candidate_frames;');
 b:=replace(b,needle,$fragment$
 if tg_table_name='candidates' then
  select * into df from person_private.directory_candidate_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
  if df.backend_pid is not null then
   perform person_private.directory_context(df.execution_id);
   if tg_op<>'UPDATE' or df.before_row is distinct from o or df.after_row is distinct from n or
    exists(select 1 from person_private.intake_mutation_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
    exists(select 1 from person_private.application_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
    exists(select 1 from person_private.directory_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'directory_metadata_frame';end if;
   if tg_when='BEFORE' then
    if df.before_seen or df.after_seen then raise exception 'directory_metadata_reentry';end if;
    update person_private.directory_candidate_frames set before_seen=true where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
   else
    if not df.before_seen or df.after_seen then raise exception 'directory_metadata_reentry';end if;
    update person_private.directory_candidate_frames set after_seen=true where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
   end if;
   return new;
  end if;
 end if;
 if not person_private.normalization_required() then return coalesce(new,old);end if;
$fragment$);execute b;
end$$;
create function person_private.directory_candidate_mutate(p_id uuid,p_before jsonb,p_after jsonb) returns void
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;f person_private.directory_candidate_frames;actual jsonb;returned jsonb;boundary bigint;event_id bigint;cols text;
begin
 e:=person_private.directory_context(p_id);
 if e.mode<>'live' or e.projection is null or e.metadata_done or e.audit_id is null or p_before->>'id' is distinct from e.candidate_id::text or p_after->>'id' is distinct from e.candidate_id::text then raise exception 'directory_metadata_scope';end if;
 if exists(select 1 from person_private.directory_candidate_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'directory_metadata_nested';end if;
 if p_before=p_after then return;end if;
 select coalesce(max(id),0) into boundary from public.person_change_events where candidate_id=e.candidate_id;
 insert into person_private.directory_candidate_frames(backend_pid,transaction_id,execution_id,before_row,after_row) values(pg_backend_pid(),pg_current_xact_id(),p_id,p_before,p_after);
 update public.candidates set calculated_experience_years=(p_after->>'calculated_experience_years')::numeric,
 directory_contact_id=(p_after->>'directory_contact_id')::uuid,directory_sync_hash=p_after->>'directory_sync_hash',source=p_after->>'source',status=p_after->>'status',follow_up_at=(p_after->>'follow_up_at')::date,linkedin_enrichment_date=(p_after->>'linkedin_enrichment_date')::timestamptz,updated_at=(p_after->>'updated_at')::timestamptz where id=e.candidate_id returning to_jsonb(candidates) into returned;
 select to_jsonb(c) into actual from public.candidates c where id=e.candidate_id;
 select * into f from person_private.directory_candidate_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if returned is distinct from p_after or actual is distinct from p_after or f.execution_id is distinct from p_id or f.before_row is distinct from p_before or f.after_row is distinct from p_after or not coalesce(f.before_seen and f.after_seen,false) then raise exception 'directory_metadata_actual';end if;
 select id into strict event_id from public.person_change_events where candidate_id=e.candidate_id and source_table='candidates' and transaction_id=pg_current_xact_id() and id>boundary;
 perform person_private.attribute_change(event_id,e.audit_id,'directory_metadata');
 perform person_private.directory_context(p_id);
 delete from person_private.directory_candidate_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
end$$;
create function person_private.directory_metadata(p_id uuid,p_years numeric,p_witnesses jsonb,p_followup date,p_harvest timestamptz) returns void
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;r public.person_directory_receipts;c jsonb;target jsonb;admitted timestamptz;
begin
 e:=person_private.directory_context(p_id);
 select * into r from public.person_directory_receipts where id=e.receipt_id;
 select to_jsonb(cc) into c from public.candidates cc where id=e.candidate_id;
 if e.mode<>'live' or e.projection is null or e.metadata_done or c is distinct from e.candidate_after or (p_years is not null and (p_years<0 or p_years>1000 or p_years<>round(p_years))) then raise exception 'directory_metadata_order';end if;
 -- Frozen server translators supply potential old-monolithic and split-Harvest
 -- witnesses. Actual normalized evidence must match original content and date.
 if p_harvest is not null and exists(select 1 from public.candidate_sources cs join jsonb_to_recordset(p_witnesses) w(source_ref text,payload_hash text,parser_version text,fetched_at timestamptz)
 on cs.source_ref=w.source_ref and cs.payload_hash=w.payload_hash and cs.parser_version=w.parser_version and cs.fetched_at=w.fetched_at
 where cs.candidate_id=e.candidate_id and cs.source='directory' and w.source_ref in (e.contact_id::text,e.contact_id::text||':harvest') and cs.fetched_at=p_harvest) then admitted:=p_harvest;end if;
 if p_years is not null and (c->>'calculated_experience_years')::numeric is distinct from p_years then
  target:=c||jsonb_build_object('calculated_experience_years',p_years);
  perform person_private.directory_candidate_mutate(p_id,c,target);c:=target;
 end if;
 target:=c||jsonb_build_object('directory_contact_id',e.contact_id,'directory_sync_hash',r.snapshot_hash,'source','directory','status',case when c->>'status'='Do Not Contact' then 'Do Not Contact' else coalesce(nullif(r.snapshot->'board'->>'status',''),'engaged') end,'follow_up_at',coalesce((c->>'follow_up_at')::date,p_followup),'linkedin_enrichment_date',greatest((c->>'linkedin_enrichment_date')::timestamptz,admitted));
 if target is distinct from c then
  target:=target||jsonb_build_object('updated_at',clock_timestamp());perform person_private.directory_candidate_mutate(p_id,c,target);
 end if;
 perform person_private.directory_context(p_id);
 update person_private.directory_executions set metadata_done=true,candidate_after=target where id=p_id;
end$$;
create table person_private.derivative_producer_frames(
 backend_pid integer not null,transaction_id xid8 not null,work_id uuid not null,candidate_id uuid not null,
 before_row jsonb,after_row jsonb not null,before_seen boolean not null default false,after_seen boolean not null default false,
 primary key(backend_pid,transaction_id)
);
alter table person_private.derivative_producer_frames enable row level security;
revoke all on person_private.derivative_producer_frames from public,anon,authenticated,service_role;
create function person_private.derivative_producer_guard() returns trigger language plpgsql security definer set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare f person_private.derivative_producer_frames;
begin
 if tg_level='STATEMENT' then
  if person_private.normalization_gate() and not exists(select 1 from person_private.derivative_producer_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'derivative_producer_frame';end if;return null;
 end if;
 select * into f from person_private.derivative_producer_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if f.backend_pid is null and not person_private.normalization_required() then return coalesce(new,old);end if;
 if f.backend_pid is null or tg_op='DELETE' or f.before_row is distinct from (case when tg_op='INSERT' then null else to_jsonb(old) end) or f.after_row is distinct from to_jsonb(new) then raise exception 'derivative_producer_frame';end if;
 if tg_when='BEFORE' then
  if f.before_seen or f.after_seen then raise exception 'derivative_producer_reentry';end if;
  update person_private.derivative_producer_frames set before_seen=true where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 else
  if not f.before_seen or f.after_seen then raise exception 'derivative_producer_reentry';end if;
  update person_private.derivative_producer_frames set after_seen=true where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 end if;
 return new;
end$$;
create trigger derivative_producer_statement before insert or update or delete or truncate on public.person_derivative_jobs for each statement execute function person_private.derivative_producer_guard();
create trigger derivative_producer_before before insert or update or delete on public.person_derivative_jobs for each row execute function person_private.derivative_producer_guard();
create trigger derivative_producer_after after insert or update or delete on public.person_derivative_jobs for each row execute function person_private.derivative_producer_guard();
create trigger derivative_producer_no_truncate before truncate on public.person_derivative_jobs for each statement execute function person_private.audit_proof_no_truncate();
revoke truncate on public.person_derivative_jobs from public,anon,authenticated,service_role;
create function person_private.derivative_enqueue(p_execution uuid,p_candidate uuid,p_receipt text,p_before jsonb,p_data jsonb) returns jsonb
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;a person_private.application_work;wid uuid;old_job public.person_derivative_jobs;target public.person_derivative_jobs;saved jsonb;f person_private.derivative_producer_frames;changed boolean;bytes jsonb;
begin
 p_before:=to_jsonb(jsonb_populate_record(null::public.candidates,p_before));
 if p_execution is not null then
  e:=person_private.directory_context(p_execution);wid:=e.work_id;
  if e.mode<>'live' or not e.metadata_done or e.enqueue_done or e.candidate_id is distinct from p_candidate or p_receipt is distinct from 'directory:'||e.receipt_id::text or p_before is distinct from e.candidate_after then raise exception 'directory_derivative_scope';end if;
 else
  a:=person_private.application_source_context();wid:=a.work_id;
  if p_receipt is distinct from 'application:'||a.application_id::text or not exists(select 1 from person_private.application_candidates where work_id=a.work_id and candidate_id=p_candidate) then raise exception 'application_derivative_scope';end if;
 end if;
 if (select to_jsonb(c) from public.candidates c where id=p_candidate) is distinct from p_before or not exists(select 1 from public.person_projection_state p join public.candidate_profile_state s using(candidate_id) where p.candidate_id=p_candidate and p.revision=s.rev and p.revision=(p_data->>'revision')::bigint and p.profile_hash=p_data->>'profileHash') or exists(select 1 from public.person_source_holds where candidate_id=p_candidate and resolved_at is null) then raise exception 'derivative_profile';end if;
 bytes:=(p_data->>'bytes')::jsonb;
 if bytes is distinct from jsonb_build_array('text-embedding-3-small',1536,p_data->'sources') or jsonb_typeof(p_data->'sources') is distinct from 'object' or
 (select count(*) from jsonb_object_keys(p_data->'sources'))<>3 or exists(select 1 from jsonb_each(p_data->'sources') v where v.key not in ('linkedin_profile','resume','summary') or jsonb_typeof(v.value)<>'string') or
 p_data->'sources'->>'resume' is distinct from coalesce(p_before->>'resume_text','') or p_data->'sources'->>'summary' is distinct from coalesce(p_before->>'profile_summary','') then raise exception 'derivative_input';end if;
 if exists(select 1 from person_private.derivative_producer_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'derivative_producer_nested';end if;
 select * into old_job from public.person_derivative_jobs where candidate_id=p_candidate for update;
 target:=old_job;
 if old_job.candidate_id is null then target:=jsonb_populate_record(null::public.person_derivative_jobs,jsonb_build_object('candidate_id',p_candidate,'status','pending','attempts',0,'updated_at',clock_timestamp()));end if;
 target.desired_revision:=(p_data->>'revision')::bigint;target.desired_hash:=encode(sha256(convert_to(p_data->>'bytes','UTF8')),'hex');
 target.sources:=p_data->'sources';target.model:='text-embedding-3-small';target.dimensions:=1536;target.receipt_ref:=p_receipt;
 changed:=old_job.candidate_id is not null and old_job.desired_hash<>target.desired_hash;
 if changed then target.status:='pending';target.attempts:=0;target.claim_token:=null;target.lease_until:=null;target.claim_missing:=null;target.error_code:=null;target.updated_at:=clock_timestamp();end if;
 insert into person_private.derivative_producer_frames(backend_pid,transaction_id,work_id,candidate_id,before_row,after_row) values(pg_backend_pid(),pg_current_xact_id(),wid,p_candidate,case when old_job.candidate_id is null then null else to_jsonb(old_job) end,to_jsonb(target));
 if old_job.candidate_id is null then insert into public.person_derivative_jobs select target.* returning to_jsonb(person_derivative_jobs) into saved;
 else update public.person_derivative_jobs j set desired_revision=target.desired_revision,desired_hash=target.desired_hash,sources=target.sources,model=target.model,dimensions=target.dimensions,receipt_ref=target.receipt_ref,status=target.status,attempts=target.attempts,claim_token=target.claim_token,lease_until=target.lease_until,claim_missing=target.claim_missing,error_code=target.error_code,updated_at=target.updated_at where candidate_id=p_candidate returning to_jsonb(j) into saved;end if;
 select * into f from person_private.derivative_producer_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if saved is distinct from to_jsonb(target) or (select to_jsonb(j) from public.person_derivative_jobs j where candidate_id=p_candidate) is distinct from to_jsonb(target) or f.work_id is distinct from wid or f.candidate_id is distinct from p_candidate or f.after_row is distinct from to_jsonb(target) or f.before_row is distinct from (case when old_job.candidate_id is null then null else to_jsonb(old_job) end) or not coalesce(f.before_seen and f.after_seen,false) then raise exception 'derivative_producer_actual';end if;
 perform person_private.projection_owner(p_execution);
 delete from person_private.derivative_producer_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 return to_jsonb(target);
end$$;
create function person_private.directory_enqueue(p_id uuid,p_before jsonb,p_data jsonb,p_text text,p_before_text text) returns void
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;r public.person_directory_receipts;job jsonb;
begin
 e:=person_private.directory_context(p_id);
 if p_text is null or length(p_text)>8000 or p_before_text is null then raise exception 'directory_derivative_text';end if;
 job:=person_private.derivative_enqueue(p_id,e.candidate_id,'directory:'||e.receipt_id::text,p_before,p_data);
 select * into r from public.person_directory_receipts where id=e.receipt_id;
 if r.derivative_text is null and (e.candidate_before->>'matching_embedding' is null or p_text<>p_before_text or exists(select 1 from public.person_directory_receipts where candidate_id=e.candidate_id and derivative_text=p_text and not derivative_done and id<>r.id)) then
  perform person_private.directory_mutate('person_directory_receipts',to_jsonb(r),to_jsonb(r)||jsonb_build_object('derivative_text',p_text,'derivative_revision',e.prepared_revision));
 end if;
 perform person_private.directory_context(p_id);
 update person_private.directory_executions set enqueue_done=true,derivative_job=job,derivative_receipt=(select to_jsonb(rr) from public.person_directory_receipts rr where rr.id=e.receipt_id) where id=p_id;
end$$;
do $$declare p record;begin
 for p in select oid::regprocedure signature from pg_proc where pronamespace='person_private'::regnamespace and proname in
 ('directory_prepare','projection_owner','projection_frame_set','projection_frame_clear','projection_apply','directory_project','directory_attribution_context','directory_candidate_mutate','directory_metadata','derivative_producer_guard','derivative_enqueue','directory_enqueue') loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',p.signature);
 end loop;
end$$;

create function person_private.publication_candidate(p_candidate uuid) returns jsonb language sql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$select to_jsonb(c) from public.candidates c where id=p_candidate$$;
revoke all on function person_private.publication_candidate(uuid) from public,anon,authenticated,service_role;
