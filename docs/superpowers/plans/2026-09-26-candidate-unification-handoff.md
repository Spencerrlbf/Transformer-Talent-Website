# Candidate storage unification: handoff and remaining runbook

Written 2026-09-26 17:20 UTC for any agent picking this work up remotely.
Plan: `docs/superpowers/plans/2026-09-26-overnight-candidate-unification.md`.
Release prerequisites and per-writer notes: `docs/person-storage-release.md`.

## Where things stand

**Code.** Parent integration branch `feat/person-00-storage-unification`,
draft PR #2 to main. Eighteen child PRs (#1, #3 to #18) are merged into the
parent. PR #19 (`feat/person-21-audit-writers`, audit guard) is open against
the parent with a green Vercel preview; its 913-call tenancy sweep has not
been run. Main is unchanged at 0c2b9a8 apart from the dispatch-only person
trial workflow file. `PERSON_WRITE_MODE` defaults to `legacy` everywhere.
Nothing new is deployed.

**Database (website Supabase project kmuihequfurvjxpnugxf).**

Applied live, all additive, none touching candidate profile columns:
`20260926011500_072_person_tables`, `20260926025355_person_writer_corrections`,
`20260926031057_person_backfill_capture`, `20260926032752_person_missing_employer_review`,
`20260926040300_person_backfill_bulk`, `20260926042200_person_reconcile`,
`20260926050355_person_source_date_holds`.

Prepared in the branch, NOT applied: `20260926033900_person_atomic_projection`,
`20260926044800_person_application_intake`, `20260926054500_person_refresh_intake`,
`20260926061600_person_directory_intake` (plus `scripts/person-directory/prepare-lookup.sql`,
run outside a transaction), `20260926065300_person_recruiter_contacts`,
`20260926072840_person_derivative_jobs`, `20260926074407_person_audit_evidence`,
`20260926080238` (anchors), `20260926082012` (audit guard, PR #19).

**Shadow backfill: COMPLETE.** Run `person-full-phones-20260926`, pinned commit
`c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc` (branch `fix/person-13-phone-audit`),
parser `person-v3`, status `baseline_complete` at 2026-09-26 17:04:41 UTC
(GitHub Actions runs 36221894748, 36223417225, 36244794998).

| Measure | Value |
|---|---|
| Candidates in pool | 423,050 |
| Processed and audited | 423,048 |
| Excluded by design | 2 (unresolved source-date holds) |
| Rows in candidate_profile_state | 423,049 |
| Rows in candidate_sources | 491,056 |
| People with a review record | 5,007 |
| Rows in identity_conflicts | 5,483 |
| Blocked sessions / pending queue / captured events at finish | 0 / 0 / 0 |
| Database size | 31.2 GB (runner cap 34 GB, disk 40 GB) |

Candidate rows and IDs are unchanged. Two earlier full runs
(`person-full-20260926`, `person-full-bulk-20260926`) failed safely and are
retained as records; do not resume them.

**Reconciliation.** Only a 500-person saving pilot has run
(`person-reconcile-save500-20260926`, paused, source scan complete, external
directory fingerprint stable at 54c56e296a2a744d00e07bc196a8afca). Full
reconciliation has NOT run.

**Paused workflows.** Disabled at 03:49 UTC and still disabled; prior state was
active for all five: `build-shortlists.yml`, `compute-signals.yml`,
`judge-shortlists.yml`, `refresh-queue.yml`, `sync-candidates.yml`.
`review-queue.yml`, `sourcing-resumer.yml`, `draft-open-roles.yml` and
`person-trial.yml` were left active. Restore in plan task 11.

**Holds.** Two people are held because the original fetch date of their cached
Harvest payload cannot be proven. Do not clear a hold without provenance.
Final accounting cannot report `reconciled` while they stand.

**Security note.** During the overnight session a process listing exposed the
Supabase MCP access token in private tool output. It was not used or committed.
Rotate it after the runner no longer depends on it; coordinate dependent access.

## How to run things

All production runs go through the dispatch-only workflow `person-trial.yml`,
dispatched with `--ref` pointing at the branch whose scripts should run. Logs
show IDs, hashes and counts only. Never log names, contacts or payloads.

```bash
# Queue catch-up: drain captured old-writer changes and pending revisions.
gh workflow run person-trial.yml --repo Spencerrlbf/Transformer-Talent-Website \
  --ref fix/person-13-phone-audit -f dry_run=false \
  -f backfill='{"run-id":"person-reconcile-queue-20260926","reconcile":true,"scope":"queue","limit":1000000,"batch-size":500,"max-db-bytes":34000000000,"max-seconds":18000}'

# Full reconciliation source scan (about an hour; two directory fingerprints
# of roughly six minutes each dominate). Add "resume":true to continue a
# paused scan under the same run-id.
gh workflow run person-trial.yml --repo Spencerrlbf/Transformer-Talent-Website \
  --ref fix/person-13-phone-audit -f dry_run=false \
  -f backfill='{"run-id":"person-reconcile-full-20260926","reconcile":true,"scope":"all","limit":1000000,"batch-size":500,"max-db-bytes":34000000000,"max-seconds":18000}'

# Finalize after the scan pauses with source_scan_complete=true. Runs locally
# through the linked Supabase CLI workdir (on the Mac Mini:
# ~/Mac-Mini-Projects/Recruitment-Matching is linked to the website project).
node scripts/person-reconcile-finalize.mjs --run-id=person-reconcile-full-20260926 \
  --workdir=/Users/spencerbarton-fisher/Mac-Mini-Projects/Recruitment-Matching
```

Rules: only one saving run at a time (they share the `person-trial`
concurrency group); a dry run with `reconcile:true` uses the read-only group
and may overlap. Do not run a full reconciliation while preview tenancy
fixtures are active. GitHub hides Actions logs until a run finishes; watch
progress in `public.backfill_runs` instead:

```sql
select run_id, status, processed, conflicts, notes->'metrics'
from public.backfill_runs order by started_at desc limit 5;
```

## Remaining steps in order

1. **Catch-up** (`scope: queue`). Expected near no-op; captured events read 0 all day.
2. **Full reconciliation** (`scope: all`) then finalize. Expect `review_required`
   because of the two holds and the 5,007 review records, not `reconciled`.
3. **Spencer's decisions**: how the 5,007 review people publish (mostly jobs
   with no identifiable employer, ambiguous company matches); what to do with
   the two holds; review of parent PR #2. PR #19 needs its tenancy sweep and
   merge into the parent first. The post-cutover audit tool designed in
   `.superpowers` notes was never built; it is not a cutover blocker.
4. **Merge parent to main**, apply the nine prepared migrations plus the
   concurrent lookup index. Verify the production deployment is green.
5. **Writers live**: set the server-only pooled `PERSON_DATABASE_URL` on Vercel
   and worker secrets (website project, never the communications database).
   Drain in-flight old workers. Set `PERSON_WRITE_MODE=live` on a bounded
   canary, then everywhere. Rerun catch-up immediately before the switch.
6. **Publish projections** in controlled batches with before-images and
   revision checks; verify Network and Send snapshots; recompute unpaid signals
   only. Then enable the legacy-write guard after testing allowed and rejected
   writes. Do not mass-trigger paid embedding or judging for storage-only
   differences.
7. **Restore** the five paused workflows in dependency order, run
   `scripts/test-tenancy.mjs` and bounded live read checks, rotate the exposed
   token, and write the completion report (plan task 12) stating separately:
   historical data copied, live writers switched, projections published,
   derived data refreshed.

## Constraints that still apply

No direct commits to main. No merges without Spencer's word. No deletion of
April tables, legacy JSON or legacy emails. No writes to the communications
database. No paid Harvest pulls, bulk embedding or bulk judging as part of the
migration. Preserve candidate IDs, verdicts, signals and read contracts.
