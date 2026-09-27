-- PREPARED ONLY. Read a bounded certificate before a worker skips a receipt.
-- No writer activation, source scan, profile publication or paid consumer.
set local lock_timeout='2s';set local statement_timeout='30s';
create function person_private.directory_current(p_org uuid,p_workspace uuid,p_receipt bigint) returns jsonb
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare r public.person_directory_receipts;h person_private.directory_heads;e person_private.directory_executions;
begin
 perform person_private.directory_scope(p_org,p_workspace);
 select * into r from public.person_directory_receipts where id=p_receipt for share;
 if r.id is null or r.workspace_id is distinct from p_workspace or person_private.directory_verify(r.id) is distinct from true then raise exception 'directory_current_input';end if;
 select * into h from person_private.directory_heads where receipt_id=r.id;
 if h.receipt_id is null then
  if exists(select 1 from person_private.directory_executions where receipt_id=r.id) or
   r.phase<>'ready' or r.candidate_id is not null or r.result is not null or r.documents is not null or r.created_person or r.projected or r.source_reviews is distinct from '[]'::jsonb or r.attempts<>0 or r.error_code is not null or
   r.derivatives_claimed_at is not null or r.derivative_text is not null or r.derivative_revision is not null or r.derivative_token is not null or r.derivative_lease_until is not null or r.derivative_attempts<>0 or r.derivative_done or r.derivative_error is not null then raise exception 'directory_current_proof';end if;
  return jsonb_build_object('status','ready');
 end if;
 select * into e from person_private.directory_executions where id=h.execution_id;
 if person_private.directory_head_valid(to_jsonb(h),r.id) is distinct from true or e.organization_id is distinct from p_org or e.workspace_id is distinct from p_workspace or e.receipt_after is distinct from to_jsonb(r) or person_private.directory_admission_valid(e.id) is distinct from true then raise exception 'directory_current_proof';end if;
 -- Current candidate contents may legitimately differ after a later writer.
 -- Validate the retained certificates, not today's candidate against old facts.
 if e.disposition='normalized' then
  if person_private.directory_completion_body(e.id) is distinct from true then raise exception 'directory_current_proof';end if;
 elsif e.disposition='outcome' then
  if person_private.directory_outcome_history_valid(e.id) is distinct from true then raise exception 'directory_current_proof';end if;
 else raise exception 'directory_current_proof';end if;
 return jsonb_build_object('status','completed','mode',e.mode,'disposition',e.disposition,'result',e.result);
end$$;
revoke all on function person_private.directory_current(uuid,uuid,bigint) from public,anon,authenticated,service_role;
