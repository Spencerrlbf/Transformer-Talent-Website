# Candidate-storage release: approval package (prepared 2026-10-13)

Prepared from branch `fix/person-90-release-remediation` for Spencer's approval. Nothing in
this document has been executed against production. Every production step below is a
proposal awaiting the explicit approval requested at the end. Evidence citations point at
`RELEASE_REMEDIATION.md` (the ledger), `RELEASE_MANIFEST.md`, `MANUAL_ACCEPTANCE_PLAN.md`
and `HOSTED_TEST_READINESS.md`.

## 1. Artifact under approval

| Item | Value |
|---|---|
| Executable source | `68a77db0dd8c045b1ae67f2fc084903a11c990ea` (last code change `331b64a`; later commits are documentation) |
| Preview verified | `transformer-talent-website-3bd5n2xmy.vercel.app` (`dpl_BcedVHnrtxUSwSzmTXusCmENnFnn`), both tenancy sweeps 913 calls PASS, manual cases 16/16 on the October 5 artifact and unaffected since |
| Migrations | 138 tracked files; production installs **63** versions (manifest below); the project label is a separate operator statement |
| Runtime | Node 24.x (`engines`, `.nvmrc`, workflows) |
| Database | production `kmuihequfurvjxpnugxf` upgraded in place; the copy `qsqlgibgsxzlimoegcjx` is retired afterwards |

## 2. What was completed (October 13)

- Read-only production/copy comparison (ledger §10): production holds 96 versions through
  `20260926050355`; the copy 158. `supabase db push` is unusable on either (legacy numeric
  files are recorded under timestamp versions).
- Project-held identity label (§11, §12): production and the copy share the PostgreSQL
  system identifier; the server gate, operator tools, catch-up start and resume, finalizer
  (both paths) and the sweep's preparation, ownership recovery and cleanup now require the
  database-held label; verified on the copy and on preview deployments including a
  runtime wrong-label canary.
- Complete contact reads behind the editable drawer (§13), with regression coverage.
- Final-artifact verification (§14): controller coordinated through the transition CLI,
  disabled and armed sweeps PASS on `68a77db`.
- Copy rehearsal (§14): see the counts table there; summary in section 4 below.

## 3. Production upgrade package

### 3.1 Ordered, checksummed manifest

`scripts/person-release/production-upgrade-manifest.json`: 63 versions from
`20260926033900_person_atomic_projection.sql` to `20261013100000_person_reconcile_page_plan.sql`
with MD5 and SHA256, generated from `68a77db`'s tree, marking the three in-window versions
production already records (`20260926040300`, `20260926042200`, `20260926050355`) as
installed. `scripts/person-release/apply-upgrade.sh` applies the manifest on the 5432
session endpoint: verifies each file's SHA256, skips any version already in
`supabase_migrations.schema_migrations`, applies the rest in order each in its own
transaction, records each with the exact file bytes as its statement and verifies the
recorded hash, stops at the first error, reloads PostgREST, and prints the label statement
for the operator. Dry-run against the copy: 62 skipped, 0 applied, wrong-ref URL refused
offline. The copy's own history records the nine forward files with exactly these file
bytes (9/9 match), so the manifest reproduces the rehearsed installation.

### 3.2 Capacity (read-only, 2026-10-13 19:0x UTC)

| Measure | Production | Copy (after chain, anchors, 2,000 publications) |
|---|---|---|
| Database size | 33,938,869,395 bytes (33.94 GB; 33.77 GB at 12:51 UTC) | 38,800,075,923 bytes |
| Candidates | 431,978 | 423,059 |
| WAL directory | 1,073,742,191 bytes, 65 segments, `max_wal_size` 4096 MB | same settings |
| Public tables | 32 GB | |
| Daily physical backups | 8 listed, latest 2026-10-13 07:53 UTC (CLI) | |

Growth drivers measured on the copy: `person_audit_anchors` 5.92 GB (avg 12,491 bytes ×
422,785 anchors), `person_reconcile_people` 1.36 GB, `person_backfill_people` 0.73 GB,
`person_signals` 0.24 GB, `person_projection_history` avg 3,272 bytes per publication.
Scaled to production's 431,978 people: anchors ≈ 5.4 GB, reconcile/backfill bookkeeping ≈
2.1 GB, full publication history ≈ 1.4 GB, other ≈ 0.4 GB → **≈ 43.3 GB after cutover**
(+9.4 GB, +28 %), plus WAL churn during publication. Proposed production ceilings:
`TENANCY_MAX_DB_BYTES` and the catch-up/publish/audit `--max-db-bytes` = **48,000,000,000**
(the default 34 GB is already within 0.2 % of today's size and would refuse). **Owner check
before approval**: the project's provisioned disk size and free space in the dashboard
(Database → Disk); the Management API did not expose it to the CLI token. The upgrade must
not start unless provisioned disk ≥ 60 GB or disk autoscaling is confirmed on.

### 3.3 Backups, recovery, rollback, live writes, Storage objects

1. **Backups**: daily physical backups exist (latest 2026-10-13 07:53 UTC). Immediately
   before the sitting: confirm PITR status in the dashboard (unknown to the CLI; the copy had
   PITR disabled) and trigger/await a fresh physical backup. The migrations are forward-only;
   schema rollback is a restore.
2. **Storage objects are not in database backups**: production holds 55 objects, 8.3 MB
   (`resumes` 53 / 5.4 MB, `company-assets` 1, `recruiter-photos` 1). Run
   `scripts/person-release/export-storage-objects.sh <private dir>` (read-only, lists and
   downloads every object with a manifest) before the sitting and keep the directory private
   until retirement of the copy is complete.
3. **Rollback conditions and procedure** (any of): a migration file fails (the script stops;
   the failed file's transaction is rolled back; already-applied files are additive and leave
   legacy mode unchanged → no restore needed, fix and resume); the application gate refuses
   production after labelling (`identity_*`): stop the rollout, keep legacy mode (unset
   `PERSON_TARGET_PROJECT_REF`/`PERSON_WRITE_MODE`), investigate; publication produces
   `drift`/`audit_blocked` beyond the rehearsal's rate or the final audit reports
   `review_required` above the agreed count: `scripts/person-publish-undo.mjs --run-id=<run>
   --apply` restores the published rows from their before-images (rehearsed), the controller
   is disarmed, legacy readers continue; data corruption suspected: restore from the fresh
   backup/PITR to a new project and relabel deliberately (runbook "Project label").
4. **Live-write coordination**: production runs legacy mode with no selection today, so the
   schema install is additive and safe with the app running. Sequence: install (app still
   legacy) → label → deploy the application with the selection in legacy mode (gate proves
   identity; no behaviour change) → arm the controller → held catch-up window → anchors →
   publication windows (≤ 720 min each; other admitted writers keep running) →
   post-publication catch-up → final audit → enable live mode / transition support for
   app and workers. During held windows recruiter edits and application processing are
   refused with "temporarily unavailable" (seconds to minutes per window); public
   application submissions stay accepted and queued.

### 3.4 Configuration to set at release (names only)

- Vercel production environment: add `PERSON_TARGET_PROJECT_REF=kmuihequfurvjxpnugxf`,
  `PERSON_DATABASE_URL` (transaction pooler 6543, `postgres.kmuihequfurvjxpnugxf`),
  `PERSON_WRITE_MODE` and `PERSON_TRANSITION_SUPPORT` (legacy/off until the cutover step),
  no `OUTBOUND_DENY_HOSTS`. Today production has none of the `PERSON_*` variables.
- GitHub Actions: repository variable `PERSON_TARGET_PROJECT_REF`, secret
  `PERSON_DATABASE_URL`, variables `PERSON_WRITE_MODE`/`PERSON_TRANSITION_SUPPORT` as the
  cutover step requires (workflows `derivative-worker`, `review-queue`, `refresh-queue`,
  `sync-candidates` read them; none exist today). Workers run Node 24.
- Operator machine: `PERSON_PUBLISH_DATABASE_URL` (5432 session), `COMMS_DATABASE_URL`
  (5432 session of the communications project), `PINNED_RUNNER_DIR` = clean `c4d0e4e`,
  `PERSON_CATCHUP_COMPATIBILITY_ID=c4d0e4e-explicit-contact-clear-v1`,
  `PERSON_CATCHUP_ARTIFACT_SHA256=0d30436b535ffc015624b7f8f0153c6cf769908ed6e6a31597f8e71659407250`.

### 3.5 Release sequence and commands (production; each step requires the approval below)

Order of operations, as rehearsed on the copy on October 14 (ledger section 15): schema install
(application still legacy) → label → application and workers deployed with the selection **and
transition support on** (`PERSON_TRANSITION_SUPPORT=on`, legacy write mode) → old workers settled →
arm → drain/seal → catch-up → reconcile finalizer → anchors → reopen → publication windows →
post-publication catch-up (held) → final audit at the declared cutoff → audit finalizer → live write
mode. Every maintenance window is closed explicitly; every CLI value below is inside its option's
range (`--max-seconds` ≤ 18,000, `--minutes` ≤ 720 for publication, 240 otherwise, `--limit` ≤
1,000,000, `--batch-size` ≤ 500, `--concurrency` ≤ 16).

```sh
# 0. owner: dashboard disk/PITR check; fresh backup; Storage export (read-only, folders walked, verified)
PERSON_TARGET_PROJECT_REF=kmuihequfurvjxpnugxf SUPABASE_URL=https://kmuihequfurvjxpnugxf.supabase.co SUPABASE_SERVICE_ROLE_KEY=… STORAGE_DATABASE_URL='<5432 session url>' \
  bash scripts/person-release/export-storage-objects.sh <private dir> && bash scripts/person-release/export-storage-objects.sh --verify <private dir>
# 1. schema (app still legacy): atomic per version, recorded versions verified and skipped, identity index built concurrently first
PERSON_TARGET_PROJECT_REF=kmuihequfurvjxpnugxf UPGRADE_DATABASE_URL='<5432 session url>' bash scripts/person-release/apply-upgrade.sh --dry-run
PERSON_TARGET_PROJECT_REF=kmuihequfurvjxpnugxf UPGRADE_DATABASE_URL='<5432 session url>' bash scripts/person-release/apply-upgrade.sh
psql '<5432 session url>' -c "select person_private.target_label('kmuihequfurvjxpnugxf')"
psql '<5432 session url>' -c "select public.person_target_identity()"
# 2. application (Vercel production env, 3.4) and workers (GitHub variables/secrets) with the selection,
#    PERSON_WRITE_MODE=legacy and PERSON_TRANSITION_SUPPORT=on; verify REST+PG identity through one signed-in request.
#    Support must be on BEFORE the controller is armed: an armed controller refuses raw legacy candidate writes
#    (candidate_mutation_frame); supported writers defer through the transition path instead.
# 2b. old workers settled: no in-progress run, schedules paused for the sitting (derivative-worker hourly,
#     review-queue 06:30, sync-candidates 07:00, refresh-queue 08:00 UTC); re-enable after step 4.
gh run list --status in_progress --limit 20
for wf in derivative-worker.yml review-queue.yml refresh-queue.yml sync-candidates.yml; do gh workflow disable "$wf"; done
# 3. operator sequence (reason codes [a-z0-9_]{1,80}; every change names the phase it expects)
node scripts/person-transition.mjs --arm --expect-phase=disabled --reason=release_arm
node scripts/person-transition.mjs --drain --expect-phase=open --reason=release_drain && node scripts/person-transition.mjs --wait-drained --max-seconds=600
node scripts/person-transition.mjs --seal --expect-phase=draining --reason=release_seal
BACKFILL_CONFIG='{"reconcile":true,"run-id":"<RUN>","scope":"queue","limit":1000000,"batch-size":100,"dry-run":false,"max-seconds":3300,"max-db-bytes":48000000000}' node scripts/person-maintenance/start-catchup.mjs
node scripts/person-transition.mjs --open-window=catchup --run=<RUN> --minutes=240 --expect-phase=held --reason=release_catchup
BACKFILL_CONFIG='{…same…,"resume":true}' node scripts/person-maintenance/run-catchup.mjs      # repeat (resume) until source_scan_complete
node scripts/person-transition.mjs --close-window=<WORK> --reason=release_catchup_done
node scripts/person-reconcile-finalize.mjs --run-id=<RUN>                                      # reconciled | review_required | catchup_pending
node scripts/person-transition.mjs --open-window=anchors --run=<ANCHORS> --minutes=240 --expect-phase=held --reason=release_anchors
PERSON_DATABASE_URL='<5432 session url>' node scripts/person-audit-anchors.mjs --save --limit=1000000 --batch=20 --max-bytes=48000000000   # the anchors CLI reads PERSON_DATABASE_URL
node scripts/person-transition.mjs --close-window=<WORK> --reason=release_anchors_done
node scripts/person-transition.mjs --reopen --expect-phase=held --reason=release_reopen
# publication: one run, resumable across 720-minute windows; each window closed explicitly
node scripts/person-transition.mjs --open-window=publish --run=<PUB> --minutes=720 --expect-phase=open --reason=release_publish
node scripts/person-publish.mjs --run-id=<PUB> --mode=publish --review=skip --batch-size=500 --limit=1000000 --max-seconds=18000 --max-db-bytes=48000000000 --concurrency=8 [--resume]
node scripts/person-transition.mjs --close-window=<WORK> --reason=release_publish_window_closed
# post-publication catch-up (held: drain, seal, catch-up window, run-catchup until source_scan_complete, finalizer, reopen as above)
# declared cutoff = the close of that held window; final audit and its finalizer:
node scripts/person-postcutover-audit.mjs --run-id=<AUDIT> --record --scope=all --batch-size=20 --limit=1000000 --max-seconds=18000 --max-db-bytes=48000000000 --external-chunk=250 [--resume]
node scripts/person-postcutover-finalize.mjs --run-id=<AUDIT>                                  # audited | catchup_pending | review_required
# 4. cutover: PERSON_WRITE_MODE=live for app and workers; re-enable the worker schedules; main merge of PR #2 after the remediation PR
```

Rollback at any step: a failed migration leaves nothing of that version (fix, rerun; legacy mode
unchanged); a gate refusal after labelling keeps legacy mode (unset the selection); a publication
run is reversed with `scripts/person-publish-undo.mjs --run-id=<PUB> --apply` **after the controller
has been disarmed through the CLI** (drain → wait-drained → seal → disarm; an armed controller
fences the undo's writer with `audit_proof_frame`, rehearsed 2026-10-14); before-images are kept
per run; a later edit, later publication or email clash is a `conflict` and is left alone, counted
in the undo run's totals (rehearsal: 486 restored, 0 conflict, 0 missing); publication resumes
are pinned to the commit the run started at (do not move HEAD on the operator machine during a
multi-window publication; run from a detached checkout of the release commit); data corruption → restore to a
new project and relabel deliberately.

## 4. Rehearsal results on the copy (summary; details §14)

- Final-artifact tenancy verification: disabled and armed sweeps 913 calls PASS each, controller coordinated through the transition CLI.
- Catch-up: the first run exposed a pager plan defect (statement timeout after 2,000 people; fixed by forward `20261013100000`, installed on the copy); the second run exposed two unreconcilable synthetic people left by the armed sweep's teardown (copy-only; blocks the pinned queue scan; follow-up filed). 142 genuine legacy changes verified; the 1,859 published people are `same_snapshot_mutation` reviews by the pinned rule and are the auditor's to attribute.
- Anchors: complete; 422,788 of 423,062, the 274 held people excepted.
- Publication: **0.91 people/s** single stream (one publish window per run, one window at a time) → ≈ 5.4 days for 423,062 people. Not completed.
- Post-cutover audit: startup fingerprint over the directory provenance did not finish within 10 minutes on the copy; per-person rate unmeasured. Not completed.
- Accounting: 2,135 pending = 1,859 + 274 + 2 with **zero unexplained differences**; counts table in §14.

**RR-09 is not closed.** The production sitting cannot be approved on duration grounds until publication and audit have a plan that fits the maintenance budget (several resumable 720-minute windows over days, or a reviewed faster path), and the sweep-leftover defect is fixed or the armed sweep is kept away from production until after cutover.

## 5. Remaining exceptions and dispositions

- **RR-10, 23 orphan experience rows (3 owner ids)** present on production and the copy:
  pre-migration debris from the 2026-08-22 re-import; facts preserved under living owners;
  invisible to the product. **Recommendation: retain as a documented exception**; no
  destructive cleanup bundled with the release (ledger RR-10).
- **Ambiguous historical contact decisions**: production has no `person_recruiter_primary`
  rows (the table is created by the chain), so **no historical decision needs disposition
  in production**. On the copy, 3 automatic rows (NULL, not suppressed) remain: 2 are the
  2026-10-13 withdrawal of the Jordan Avery test clears, 1 is a 2026-09-29 live phone row on a
  real published person written during the recovery exercise; both are copy-only test
  artefacts and are retired with the copy.
- **Three deferred application attempts** (`transition_work`, family `application`,
  2026-09-29, expired leases): synthetic failed applications from the recovery exercise, no
  receipts, no Harvest ledger rows, not linked; **they do not exist in production**
  (no controller tables there). Disposition: leave deferred on the copy; nothing to replay.
- **Production disk/PITR**: owner dashboard check (3.2, 3.3).
- **Publication duration**: 0.91 people/s single stream (§14); a publication window is bound to one run and only one window may be open, so there is no parallel-run plan today. Decision needed: multi-day windows or a reviewed faster publication path.
- **Post-cutover audit startup**: the directory-provenance fingerprint exceeded 10 minutes on the copy (62,208 linked contacts); a 15 s statement timeout stopped one attempt. The auditor needs a measured plan before the sitting.
- **Armed sweep leftovers**: two synthetic people on the copy are unreconcilable after the sweep's teardown and stop the pinned queue scan; follow-up task filed. Do not run the armed sweep against production before the pinned catch-up has completed.
- **Queue pager**: forward `20261013100000` (installed on the copy, in the production manifest) is required for any queue catch-up past a few thousand people.

## 6. Retirement of the paid copy (after production verification)

1. Export evidence: ledger sections 10–14, run/result tables (`backfill_runs`,
   `person_reconcile_people` summaries, `person_publish_runs/results`,
   `person_postcutover_audit_runs/results`, `transition_events`, `maintenance_events`) as
   CSV into the repository's evidence folder; keep `.env.rehearsal` private until deletion.
2. Remove dependencies: the branch preview's copy-scoped variables (Vercel, branch
   `fix/person-90-release-remediation`), the Turnstile hostname, synthetic provider keys,
   `.env.rehearsal`, launch entries; stop referencing the fixed October 5 URL.
3. Delete the project in the dashboard (irreversible; billing stops from that point).

## 7. Approval requested

Approve, in writing: (a) the production schema install with
`scripts/person-release/apply-upgrade.sh` and the label statement; (b) the production
configuration changes in 3.4; (c) the operator sequence in 3.5 with the ceilings in 3.2;
(d) the main merge of the parent PR after the remediation PR review; (e) retirement of the
copy per section 6 after production verification. Expected downtime: none for public pages;
recruiter contact edits and application processing refused during held windows (minutes per
window). Cost: the copy's hourly compute until deletion; no new paid services.
