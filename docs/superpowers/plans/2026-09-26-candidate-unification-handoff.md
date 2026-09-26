# Candidate storage unification: handoff and remaining runbook

Updated 2026-09-26 20:30 UTC for any agent continuing this work.
Plan: `docs/superpowers/plans/2026-09-26-overnight-candidate-unification.md`.
Release prerequisites and per-writer notes: `docs/person-storage-release.md`.

## Where things stand

**Code.** Parent integration branch `feat/person-00-storage-unification`,
draft PR #2 to main. Child PRs #1 and #3–#21 are merged into the parent. PR #21
(`feat/person-23-audit-snapshots`) passed its exact-commit hosted preview and
all 913 tenancy calls in 260 seconds, with full fixture cleanup.
The parent is at `d1987ab0c07b62cdbb50e7c9a5eafb3e381c2efe`. The next child,
`fix/person-27-publish-review`, combines PR #22's prepared publish runbook with
independently reviewed rollback, audit and restart fixes. PR #23's read-only
preview and PR #24's comms reconnect fix remain unintegrated; the latter must
preserve the entire repeatable-read scope across a connection failure.
Main remains unchanged at `0c2b9a8463f902737fd6e7e35aea724fa31755a8`
(which already contains the dispatch-only person trial workflow). `PERSON_WRITE_MODE` defaults to `legacy` everywhere.
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
`20260926080238` (anchors), `20260926082012` (audit guard, PR #19),
`20260926172608` (post-cutover snapshots, PR #21), `20260926183000`
(publish runbook), `20260926201342` (exact attribution enforcement, disabled).

**Historical baseline copy: COMPLETE for unheld candidates.** Run `person-full-phones-20260926`, pinned commit
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

**Reconciliation.** Queue catch-up `36258797364` completed with zero pending
people. The full source scan `person-reconcile-full-20260926` completed at the
same reviewed pin through GHA `36259479370` and safe resume `36266729979`.
Finalized at 19:52:54 UTC with **review_required**, not reconciled:

| Measure | Final value |
|---|---:|
| Pool / scanned | 423,050 / 423,050 |
| Verified / source review / unscanned | 422,963 / 87 / 0 |
| Same-snapshot mutations / unknown Harvest dates | 85 / 2 |
| Open identity/contact/employer conflict rows | 5,483 |
| Distinct pool people with open conflicts | 9,346 |
| People in both source review and open conflicts | 3 |
| Captured events / queue / blocked sessions after fixture cleanup | 0 / 0 / 0 |
| Database bytes | 31,881,792,659 |

The external directory fingerprint changed during the scan. Stable source
catch-up remains necessary; a finished scan does not establish a consistent
external boundary. No people were merged and no source dates were invented.
Do not redispatch or refinalize these completed run IDs.

**Restored workflows.** Restored at 19:53 UTC and verified active after migration
load ended. Prior state was active for all five: `build-shortlists.yml`, `compute-signals.yml`,
`judge-shortlists.yml`, `refresh-queue.yml`, `sync-candidates.yml`.
`review-queue.yml`, `sourcing-resumer.yml`, `draft-open-roles.yml` and
`person-trial.yml` were left active. No paid workflow was manually dispatched.
The private restoration ledger retains original states and timestamps. Future
pauses must be separately recorded and restored after the relevant load ends.

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
The commands below document the completed historical runs, not instructions to
dispatch them again. A further pass needs a reviewed source plan, fresh run ID
and verified idle Actions/database checkpoints.

```bash
# Queue catch-up: drain captured old-writer changes and pending revisions.
gh workflow run person-trial.yml --repo Spencerrlbf/Transformer-Talent-Website \
  --ref fix/person-13-phone-audit -f dry_run=false \
  -f backfill='{"run-id":"person-reconcile-queue-20260926","reconcile":true,"scope":"queue","limit":1000000,"batch-size":500,"max-db-bytes":34000000000,"max-seconds":18000}'

# Full reconciliation source scan. Run only after the queue pass finishes
# and after checking Actions/checkpoints again. Measure its own throughput;
# the 500-person pilot is not evidence that the whole scan takes one hour.
# Add "resume":true to continue a paused scan under the same run-id.
gh workflow run person-trial.yml --repo Spencerrlbf/Transformer-Talent-Website \
  --ref fix/person-13-phone-audit -f dry_run=false \
  -f backfill='{"run-id":"person-reconcile-full-20260926","reconcile":true,"scope":"all","limit":1000000,"batch-size":500,"max-db-bytes":34000000000,"max-seconds":18000}'

# Finalize after the scan pauses with source_scan_complete=true. Runs locally
# through a verified website-linked Supabase CLI workdir. Check the local
# project-ref; the finalizer explicitly refuses a different project.
node scripts/person-reconcile-finalize.mjs --run-id=person-reconcile-full-20260926 \
  --workdir=../audit-db
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

1. **Stable source catch-up.** The queue and full historical scan completed;
   the external boundary was unstable. Retain the 85 same-snapshot source
   reviews and two date holds until real provenance supports a reviewed repair.
   Recheck Actions/checkpoints before any additional bounded run.
2. **Finish reviewed preparation.** Integrate the publish/undo remediation only
   after its local regressions, build, independent review and exact-preview
   tenancy gate. Repair PR #24's mid-transaction reconnect behavior before
   using it in another scan; give the read-only preview load/time gates.
3. **Complete application preparation**: finish and test the separate post-cutover
   auditor. It must understand frozen anchors, actual receipt documents and exact
   captured-event attribution. The historical reconciler cannot certify newly
   published profiles. This remains a release prerequisite; flags stay off.
4. **Maintain schedules and accounting.** The original five schedules are
   restored. Keep exact review/hold/conflict counts separate and preserve
   existing budget limits; restore any future temporary pauses promptly.
5. **Spencer's release approval** covers parent PR #2, deployment, profile
   publication and restrictive write guards. Child integration and additive shadow
   database work remain authorized. Retain unresolved identity/source conflicts;
   do not merge people or guess source dates.
6. **Approved release sequencing**: provision the website-only pooled
   `PERSON_DATABASE_URL`, apply the complete reviewed prepared migration chain
   and concurrent lookup index, finish historical catch-up, then prepare verified
   immutable anchors before enabling any normalized intake. Install all three
   audit migrations before preparing anchors so timestamp proofs agree. Missing
   or stale anchors refuse writes and are not a reason to bypass the guard.
   Deploy the approved feature with flags initially off and verify deployment.
7. **Writers live and publication**: drain in-flight old workers while keeping
   public submissions durably accepted. Enable a bounded canary, audit it using
   the new receipt-aware auditor, then progressively expand. Publish existing
   profiles in controlled batches with before-images/revision checks; verify
   Network and Send snapshots and preserve unresolved holds. Only then enable
   the restrictive legacy-write guard after testing allowed and rejected writes.
   Do not mass-trigger paid embedding/judging for storage-only changes.
8. **Release checks and reporting**: verify preview/production tenancy and bounded
   intake/read checks, schedules, source receipts/queues and query health. Arrange
   rotation of the exposed MCP token with its owner without breaking active access.
   State separately: historical copy, source reconciliation, switched writers,
   published projections and derivative refresh. None implies the others.

## Constraints that still apply

No direct commits or merges to main without Spencer's release approval.
Sequential tested child merges into the feature parent remain authorized. No deletion of
April tables, legacy JSON or legacy emails. No writes to the communications
database. No paid Harvest pulls, bulk embedding or bulk judging as part of the
migration. Preserve candidate IDs, verdicts, signals and read contracts.
