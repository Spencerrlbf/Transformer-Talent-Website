-- Forward for databases that installed 20260928050000_person_publish_admission.sql
-- (release rehearsal 2026-10-14/15). The armed publication's own write to public.candidates
-- is captured like any other candidates write (person_private.capture_change), so every
-- published person re-enters the reconciler's queue, where the pinned translator can only
-- record a same-snapshot review (no source changed; the auditor attributes publication
-- events through the certified operation). On the copy that queued 159,122 people after a
-- partial publication, about 56 hours of catch-up for production at the translator's rate.
-- This forward keeps person_publish_project's signature, grants and every check, and adds
-- one step after the projection: when the person had no unreconciled captured change before
-- this publication, the transaction's own candidates events are marked reconciled and the
-- queue row they advanced is released, exactly as a verified reconciliation does
-- (person_reconcile_record). A person with anything pending before is left to the
-- reconciler untouched.
set local lock_timeout='2s';set local statement_timeout='30s';
create or replace function public.person_publish_project(p_run text,p_candidate uuid,p_revision bigint,p_envelope jsonb) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare opened boolean;w person_private.maintenance_frames;oid uuid;r jsonb;prior_pending boolean;own_version bigint;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'publish_isolation';end if;
 if p_candidate is null or p_revision is null then raise exception 'publish_input';end if;
 opened:=person_private.maintenance_enter('publish',p_run);
 if not opened then raise exception 'publish_requires_window';end if;
 w:=person_private.maintenance_frame('publish');
 if not exists(select 1 from public.person_publish_runs where run_id=p_run and mode='publish' and status='running') then raise exception 'publish_run_inactive';end if;
 perform 1 from public.candidates where id=p_candidate for update;
 if not found then raise exception 'publish_input';end if;
 -- Captured changes nobody has reconciled yet, observed before this publication writes.
 prior_pending:=exists(select 1 from public.person_change_events e where e.candidate_id=p_candidate and e.reconciled_at is null);
 oid:=person_private.publish_audit_begin(p_candidate);
 r:=person_private.projection_apply(w.work_id,w.work_id,p_candidate,oid,p_revision,p_envelope);
 if not prior_pending then
  select max(e.id) into own_version from public.person_change_events e
   where e.candidate_id=p_candidate and e.transaction_id=pg_current_xact_id() and e.source_table='candidates';
  if own_version is not null then
   update public.person_change_events set reconciled_at=clock_timestamp()
    where candidate_id=p_candidate and transaction_id=pg_current_xact_id() and source_table='candidates' and reconciled_at is null;
   delete from public.person_change_queue where candidate_id=p_candidate and version=own_version;
  end if;
 end if;
 perform person_private.maintenance_frame('publish');
 perform person_private.maintenance_leave(opened);
 return r||jsonb_build_object('operationId',oid);
end$$;

-- The statement fence on captured events and the queue admits reconciliation only inside a
-- catch-up frame while the controller is armed (20260928030000). The publication's attribution
-- above runs inside its publish frame, so that frame is admitted for the same two tables, with
-- the same active-frame check; every other table and every unframed statement stays refused.
create or replace function person_private.audit_proof_maintenance() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if person_private.normalization_gate() then
  if not (tg_table_name in ('person_change_events','person_change_queue')
          and (person_private.maintenance_frame_present('catchup') or person_private.maintenance_frame_present('publish'))) then raise exception 'audit_proof_maintenance';end if;
  if person_private.maintenance_frame_present('catchup') then perform person_private.maintenance_frame('catchup'); -- still active, same work
  else perform person_private.maintenance_frame('publish');end if;
 end if;
 return null;
end$$;
