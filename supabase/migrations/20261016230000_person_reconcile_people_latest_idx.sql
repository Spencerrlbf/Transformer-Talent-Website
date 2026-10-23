-- Plan fix (release remediation, 2026-10-16): the pending view (person_reconcile_pending) and
-- person_reconcile_finish take each person's latest check with
--   distinct on (candidate_id) ... order by candidate_id, checked_at desc, run_id desc
-- over person_reconcile_people. The table carries only (run_id, candidate_id) and
-- (candidate_id, checked_at desc) indexes, so the planner chooses between an incremental sort on the
-- second index and a primary-key scan with a full sort of every row past the cursor; the two cost
-- estimates are nearly equal and the choice flips with the cursor. On production the primary-key path
-- read the whole history past the cursor on a cold cache and person_reconcile_page exceeded the REST
-- layer's 8 s statement limit (2026-10-16 22:04 UTC, run release-catchup-post-20261016, page 37).
-- An index in the exact distinct-on order removes the sort altogether. Same results; no semantics
-- change; the statement limits stay as they are.
create index if not exists person_reconcile_people_latest_idx
 on public.person_reconcile_people(candidate_id, checked_at desc, run_id desc);
