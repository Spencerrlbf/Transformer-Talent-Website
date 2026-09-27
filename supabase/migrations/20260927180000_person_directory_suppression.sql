-- PREPARED ONLY. A certified directory safety status admits no profile facts.
set local lock_timeout='2s';set local statement_timeout='30s';
alter table person_private.directory_outcomes add column suppression jsonb;

create function person_private.directory_suppression_change(p_id uuid,p_identities jsonb,p_observed jsonb) returns jsonb
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;r public.person_directory_receipts;before_row jsonb;target jsonb;returned jsonb;actual jsonb;f person_private.directory_candidate_frames;cid uuid;boundary bigint;ev public.person_change_events;proof jsonb;
begin
 e:=person_private.directory_context(p_id);
 select * into r from public.person_directory_receipts where id=e.receipt_id;
 before_row:=nullif(p_observed->'candidate','null'::jsonb);
 if before_row is null or not coalesce(r.snapshot->'board'->>'do_not_contact'='true' or r.snapshot->'board'->>'status'='Do Not Contact',false) then return null;end if;
 cid:=(before_row->>'id')::uuid;
 if r.phase<>'ready' or (p_observed->'state'->>'latest_receipt_id')::bigint<>e.receipt_id or p_observed->'owners' is distinct from jsonb_build_array(cid) or
  (before_row->>'directory_contact_id' is not null and before_row->>'directory_contact_id'<>e.contact_id::text) or
  person_private.directory_outcome_observe(p_id,p_identities) is distinct from p_observed then raise exception 'directory_suppression_scope';end if;
 perform pg_advisory_xact_lock(hashtext(cid::text));perform 1 from public.candidates where id=cid for update;
 perform person_private.directory_context(p_id);
 if person_private.publication_candidate(cid) is distinct from before_row then raise exception 'directory_suppression_before';end if;
 -- Claim this execution before touching the candidate. A discarded helper
 -- result can never be replaced by a second call that observes an already-DNC row.
 if e.candidate_id is not null or e.candidate_before is not null or e.identities is not null then raise exception 'directory_suppression_reentry';end if;
 update person_private.directory_executions set candidate_id=cid,candidate_before=before_row,identities=p_identities where id=p_id;
 e:=person_private.directory_context(p_id);
 if e.candidate_id is distinct from cid or e.candidate_before is distinct from before_row or e.identities is distinct from p_identities then raise exception 'directory_suppression_binding';end if;

 select coalesce(max(id),0) into boundary from public.person_change_events where candidate_id=cid;
 if exists(select 1 from person_private.directory_candidate_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
  exists(select 1 from person_private.intake_mutation_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
  exists(select 1 from person_private.application_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
  exists(select 1 from person_private.directory_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
  exists(select 1 from person_private.normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
  exists(select 1 from person_private.directory_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'directory_suppression_nested';end if;
 target:=before_row;
 if before_row->>'status' is distinct from 'Do Not Contact' then
  target:=before_row||jsonb_build_object('status','Do Not Contact','updated_at',clock_timestamp());
  insert into person_private.directory_candidate_frames(backend_pid,transaction_id,execution_id,before_row,after_row) values(pg_backend_pid(),pg_current_xact_id(),p_id,before_row,target);
  select * into f from person_private.directory_candidate_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
  if f.execution_id is distinct from p_id or f.before_row is distinct from before_row or f.after_row is distinct from target or f.before_seen or f.after_seen then raise exception 'directory_suppression_frame';end if;
  update public.candidates set status='Do Not Contact',updated_at=(target->>'updated_at')::timestamptz where id=cid returning to_jsonb(candidates) into returned;
  actual:=person_private.publication_candidate(cid);
  select * into f from person_private.directory_candidate_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
  if returned is distinct from target or actual is distinct from target or f.execution_id is distinct from p_id or f.before_row is distinct from before_row or f.after_row is distinct from target or not coalesce(f.before_seen and f.after_seen,false) then raise exception 'directory_suppression_actual';end if;
  select * into strict ev from public.person_change_events where candidate_id=cid and source_table='candidates' and transaction_id=pg_current_xact_id() and id>boundary;
  if ev.source_row_id is distinct from cid::text or ev.operation is distinct from 'UPDATE' or ev.previous_payload is distinct from (before_row-array['resume_embedding','matching_embedding','resume_text','notes']) or ev.payload is distinct from (target-array['resume_embedding','matching_embedding','resume_text','notes']) then raise exception 'directory_suppression_event';end if;
  perform person_private.directory_context(p_id);
  delete from person_private.directory_candidate_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
  if exists(select 1 from person_private.directory_candidate_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'directory_suppression_cleanup';end if;
 end if;
 proof:=jsonb_build_object('version','directory-suppression-1','after',target,'boundary',boundary::text,'event',case when ev.id is null then null else to_jsonb(ev) end);
 return proof;
end$$;

-- Validate the witness without requiring a normalization/anchor checkpoint. The
-- immutable original observation is the before-image; only DNC/updated_at differ.
create function person_private.directory_suppression_valid(p_id uuid,p_proof jsonb,p_before jsonb) returns boolean
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;r public.person_directory_receipts;target jsonb;ev public.person_change_events;n bigint;boundary bigint;cid uuid;
begin
 select * into e from person_private.directory_executions where id=p_id;
 select * into r from public.person_directory_receipts where id=e.receipt_id;
 cid:=(p_before->>'id')::uuid;target:=p_proof->'after';boundary:=(p_proof->>'boundary')::bigint;
 if e.id is null or cid is null or p_proof is null or p_proof->>'version' is distinct from 'directory-suppression-1' or boundary is null or boundary<0 or target->>'status' is distinct from 'Do Not Contact' or
  (r.snapshot->'board'->>'do_not_contact'='true' or r.snapshot->'board'->>'status'='Do Not Contact') is not true or
  (p_before->>'status' is distinct from 'Do Not Contact' and target->>'updated_at' is null) or target-array['status','updated_at'] is distinct from p_before-array['status','updated_at'] or
  person_private.publication_candidate(cid) is distinct from target or e.candidate_after is distinct from target or e.candidate_before is distinct from p_before then return false;end if;
 select count(*) into n from public.person_change_events where candidate_id=cid and source_table='candidates' and transaction_id=e.transaction_id and id>boundary;
 if p_before->>'status'='Do Not Contact' then return target=p_before and p_proof->'event'='null'::jsonb and n=0;end if;
 select * into ev from public.person_change_events where id=(p_proof->'event'->>'id')::bigint;
 return n=1 and ev.id>boundary and ev.candidate_id=cid and ev.source_table='candidates' and ev.source_row_id=cid::text and ev.transaction_id=e.transaction_id and ev.operation='UPDATE' and
  ev.previous_payload=(p_before-array['resume_embedding','matching_embedding','resume_text','notes']) and ev.payload=(target-array['resume_embedding','matching_embedding','resume_text','notes']) and to_jsonb(ev)=p_proof->'event' and not exists(select 1 from public.person_change_attributions where event_id=ev.id);
end$$;

-- Retain the existing outcome completion and independently computed proof hash.
-- Each substitution is pinned to the preceding prepared definition.
do $$declare b text;needle text;begin
 b:=pg_get_functiondef('person_private.directory_outcome_result(uuid,jsonb,jsonb)'::regprocedure);
 needle:=' if suppressed then return null;end if; -- Existing-person suppression stays gated.';
 if position(needle in b)=0 then raise exception 'directory_suppression_definition';end if;
 b:=replace(b,needle,' if suppressed then return jsonb_build_object(''status'',''suppressed'',''candidateId'',cid,''created'',false);end if;');execute b;
 b:=pg_get_functiondef('person_private.directory_outcome(uuid,jsonb)'::regprocedure);
 needle:='saved person_private.directory_outcomes;w person_private.transition_work;';
 if position(needle in b)=0 then raise exception 'directory_suppression_definition';end if;
 b:=replace(b,needle,needle||'suppression jsonb;');
 needle:=' if outcome_result is null then return null;end if;';
 if position(needle in b)=0 then raise exception 'directory_suppression_definition';end if;
 b:=replace(b,needle,needle||E'\n if outcome_result->>''status''=''suppressed'' and outcome_result->>''candidateId'' is not null then suppression:=person_private.directory_suppression_change(p_id,p_identities,observed);end if;');
 needle:='observed,to_jsonb(r),outcome_result,target)::person_private.directory_outcomes';
 if position(needle in b)=0 then raise exception 'directory_suppression_definition';end if;
 b:=replace(b,needle,'observed,to_jsonb(r),outcome_result,target,suppression)::person_private.directory_outcomes');
 needle:='candidate_before=nullif(observed->''candidate'',''null''::jsonb),identities=p_identities';
 if position(needle in b)=0 then raise exception 'directory_suppression_definition';end if;
 b:=replace(b,needle,'candidate_after=suppression->''after'','||needle);execute b;
 b:=pg_get_functiondef('person_private.directory_outcome_valid(uuid)'::regprocedure);
 needle:=' observed:=person_private.directory_outcome_observe(p_id,proof.identities);';
 if position(needle in b)=0 then raise exception 'directory_suppression_definition';end if;
 b:=replace(b,needle,needle||E'\n if proof.suppression is not null then\n  if person_private.directory_suppression_valid(p_id,proof.suppression,proof.observations->''candidate'') is distinct from true then return false;end if;\n  observed:=jsonb_set(observed,''{candidate}'',proof.observations->''candidate'');\n elsif e.candidate_after is not null then return false;end if;');
 needle:=' return e.disposition=''outcome''';
 if position(needle in b)=0 then raise exception 'directory_suppression_definition';end if;
 b:=replace(b,needle,' return ((expected->>''status''=''suppressed'' and expected->>''candidateId'' is not null)=(proof.suppression is not null)) and e.disposition=''outcome''');execute b;
end$$;
revoke all on function person_private.directory_suppression_change(uuid,jsonb,jsonb),person_private.directory_suppression_valid(uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
