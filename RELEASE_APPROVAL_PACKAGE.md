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

### 3.1 Ordered, checksummed manifest and atomic installer

`scripts/person-release/production-upgrade-manifest.json`: **65 versions** from
`20260926033900_person_atomic_projection.sql` to
`20261015120000_person_publish_capture_attribution.sql` with SHA256, MD5 and trimmed MD5, plus
the three window versions production already records (`recorded_in_window`: `20260926040300`,
`20260926042200`, `20260926050355`, with the digests observed on production). The whole 96-row
production history is digested in `production-history-digests.json` (whole-table digest
`b7ca867b…`, read-only through the connector on 2026-10-14).

`scripts/person-release/apply-upgrade.sh` (ledger 15.1): the destination passes the hardened
validator (selection, 5432 session endpoint, no option overrides) and the database-held label
check; every recorded window version is verified by digest before anything runs (a different body
stops with `history_mismatch`); the identity index `candidates_person_username_idx` is built
`CONCURRENTLY` before `20260927170000` when absent; then each remaining version's file and its
history row (exact file bytes) commit in **one transaction**, so an error or a lost connection
leaves neither and a resume skips only verified versions. Proof on an isolated database carrying
production's history: faults before commit leave nothing, resume completes 96 + 65, tampered
rows refuse, foreign selection refused (`test-apply-upgrade-resume.sh`, all checks). First hosted
use: the copy, 2026-10-14 18:04 UTC, `applied=1 skipped=63` (the fingerprint forward), history
160 versions. Dry run on the copy before that: 63 skipped, 1 to apply, 52 copy rows recorded
without a body counted as `unverifiable_bodies` (none on production).

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
`person_signals` 0.24 GB.

**Publication growth, measured on October 14 during the full publication (concurrency 16,
7,000 people in 8.3 minutes, 39.03 → 39.31 GB): 41 KB per published person**, of which about
21.5 KB is churn in `public.candidates` (dead row versions and TOAST/index churn from the
profile update; `autovacuum` had not yet run on the table: it fires at 20 % dead rows ≈ 84,000
updates, after which that space is reused) and about 20 KB is durable evidence
(`person_change_events` ≈ 16 KB: the captured before/after candidate rows of the publication's
own write; `person_projection_history` ≈ 4 KB; `person_audit_operations` ≈ 1 KB). The October 13
estimate (+1.4 GB for publication history) missed the captured events and the churn.

Scaled to production's 431,978 people: anchors ≈ 5.4 GB, reconcile/backfill bookkeeping ≈
2.1 GB, durable publication evidence ≈ 8.6 GB, candidates churn up to ≈ 9 GB before autovacuum
reclaims it (bounded by vacuum frequency; a `VACUUM public.candidates` between publication
windows caps it at a few GB) → **≈ 50–55 GB after cutover** (+16–21 GB), plus WAL churn. The
proposed production ceiling of 48 GB would stop publication before completion. **Revised
proposal: `TENANCY_MAX_DB_BYTES` and the catch-up/publish/audit `--max-db-bytes` =
58,000,000,000, provisioned disk ≥ 80 GB (or autoscaling confirmed on), and a scheduled
`VACUUM public.candidates` after each publication window.** The copy's approved 45 GB ceiling
stops its full publication early (ledger 15.5); raising it is a spending decision because the
copy's disk would have to grow.

**Owner check before approval**: the project's provisioned disk size and free space in the
dashboard (Database → Disk); the Management API did not expose it to the CLI token. The upgrade
must not start unless provisioned disk ≥ 80 GB or disk autoscaling is confirmed on.

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
BACKFILL_CONFIG='{"reconcile":true,"run-id":"<RUN>","scope":"queue","limit":1000000,"batch-size":100,"dry-run":false,"max-seconds":3300,"max-db-bytes":58000000000}' node scripts/person-maintenance/start-catchup.mjs
node scripts/person-transition.mjs --open-window=catchup --run=<RUN> --minutes=240 --expect-phase=held --reason=release_catchup
BACKFILL_CONFIG='{…same…,"resume":true}' node scripts/person-maintenance/run-catchup.mjs      # repeat (resume) until source_scan_complete
node scripts/person-transition.mjs --close-window=<WORK> --reason=release_catchup_done
node scripts/person-reconcile-finalize.mjs --run-id=<RUN>                                      # reconciled | review_required | catchup_pending
node scripts/person-transition.mjs --open-window=anchors --run=<ANCHORS> --minutes=240 --expect-phase=held --reason=release_anchors
PERSON_DATABASE_URL='<5432 session url>' node scripts/person-audit-anchors.mjs --save --limit=1000000 --batch=20 --max-bytes=58000000000   # the anchors CLI reads PERSON_DATABASE_URL
node scripts/person-transition.mjs --close-window=<WORK> --reason=release_anchors_done
node scripts/person-transition.mjs --reopen --expect-phase=held --reason=release_reopen
# publication: one run, resumable across 720-minute windows; each window closed explicitly
node scripts/person-transition.mjs --open-window=publish --run=<PUB> --minutes=720 --expect-phase=open --reason=release_publish
node scripts/person-publish.mjs --run-id=<PUB> --mode=publish --review=skip --batch-size=500 --limit=1000000 --max-seconds=18000 --max-db-bytes=58000000000 --concurrency=16 [--resume]
node scripts/person-transition.mjs --close-window=<WORK> --reason=release_publish_window_closed
psql '<5432 session url>' -c 'vacuum (analyze) public.candidates'                               # between windows: reclaim the publication's row churn (3.2)
# post-publication catch-up (held: drain, seal, catch-up window, run-catchup until source_scan_complete, finalizer, reopen as above)
# declared cutoff = the close of that held window; final audit and its finalizer:
node scripts/person-postcutover-audit.mjs --run-id=<AUDIT> --record --scope=all --batch-size=20 --limit=1000000 --max-seconds=18000 --max-db-bytes=58000000000 --external-chunk=250 [--resume]
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
multi-window publication; run from a detached checkout of the release commit); people restored by an
undo are refused by the armed admission afterwards (`audit_proof_chain`: the undo operation is not
certified), so re-publishing them needs the controller disabled (legacy guarded path, `--ids` lists of
at most 500) before re-arming — rehearsed on the copy; data corruption → restore to a
new project and relabel deliberately.

## 4. Rehearsal results on the copy (October 13 summary in ledger §14; October 14 in §15)

- Final-artifact tenancy verification: disabled and armed sweeps 913 calls PASS each (October 13); loopback armed sweep 913 PASS with the repaired teardown (October 14).
- Catch-up (pinned translator, held window): `source_scan_complete` for 2,135 queued people in 16.7 min; the two leftovers verified after their evidence repair; finalizer `review_required` (external directory moved during the scan; 2,133 publication-artefact reviews). Boundary statement fixed by forward `20261014120000` (7 s → 1.2 s).
- Anchors: complete; 422,788 of 423,062, the 274 held people excepted (twice).
- Publication: **13.1 people/s at concurrency 16** (7.4 at 8; 0.91 single-session) → ≈ 9 h for production's 431,978 people. 163,500 people published on the copy (156,217 newly projected) in 3 h 28 min before the deliberate stop at the copy's approved 45 GB ceiling; growth **28.5 KB per person net** (3.2).
- Rollback: 486 restored, 0 conflict, 0 missing; undone people need re-publication with the controller disabled (486/486 done).
- Post-publication catch-up: 159,122 publication-captured people queued; at the pinned 2.1 people/s ≈ 21 h on the copy and ≈ 56 h for production; blocked on the copy by two more old-teardown leftovers (same repair).
- Final audit at the declared cutoff 18:21:06 UTC: **3.8 people/s** (68,640 in the first 5-hour pass: 85 % verified, 13 % pending on directory snapshots, 2 % review), ≈ 31 h for the full pool from this machine; resumable at its commit.
- Accounting of this rehearsal: 2,135 pending before → 2 verified + 2,133 review; publication 163,500 = 156,217 + 3,062 + 3,624 + 597 (every outcome recorded per person); undo 486 = 486 restored; re-publication 486 = 486 projected; **zero unexplained differences**.

**RR-09 is not closed.** The sequence is correct and every step is rehearsed and measured, but a complete end-to-end run did not fit the copy's approved ceiling, and the post-publication catch-up and the final audit are the binding durations (owner decisions 1–3, section 7).

## 5. Remaining exceptions and dispositions

- **RR-10, 23 orphan experience rows (3 owner ids)** present on production and the copy:
  pre-migration debris from the 2026-08-22 re-import; facts preserved under living owners;
  invisible to the product. **Recommendation: retain as a documented exception**; no
  destructive cleanup bundled with the release (ledger RR-10).
- **Ambiguous historical contact decisions**: production has no `person_recruiter_primary`
  rows (the table is created by the chain), so **no historical decision needs disposition
  in production**. On the copy, 3 automatic rows remain: copy-only test artefacts, retired
  with the copy.
- **Three deferred application attempts** (`transition_work`, family `application`,
  2026-09-29, expired leases): synthetic, no receipts, not linked; **not in production**.
  Disposition: leave deferred on the copy; nothing to replay.
- **Synthetic sweep leftovers on the copy**: two repaired and verified (ledger 15.3); two more
  (`0147d75c…`, `2a8bbcad…`) surfaced when the publication queued them, same disposition to
  apply with the controller disabled; the repaired teardown prevents new ones. Production has
  none (no armed sweep has run there); do not run the armed sweep on production before the
  pinned catch-up has completed.
- **Durations** (measured): publication ≈ 9 h at concurrency 16; post-publication catch-up
  ≈ 56 h at the pinned translator's rate for 423k publication-captured people; final audit
  ≈ 31 h from an operator machine (round trip 44 ms). Both long steps are resumable and run with
  the controller open except the catch-up's held window. Decision needed on where they run
  (a machine in the database's region would cut the round-trip share) and on the acceptance of
  publication-captured reviews.
- **External directory stability**: the communications project is written by its own tools
  during any scan; the finalizer reports it (`review_required`/`catchup_pending`); owner
  decision 2.
- **Capacity**: 28.5 KB per published person; ceilings revised to 58 GB and disk ≥ 80 GB
  (3.2); owner decision 1.
- **Runs left on the copy**: catch-up `review_required`, post catch-up `failed`, publication
  `running` (interrupted; resumable at `97c7cc6`), first full attempt `running` (nothing
  projected), audit `paused` (resumable at `e2cf214`): recorded history, retired with the copy.

## 6. Retirement of the paid copy (after production verification)

1. Export evidence: ledger sections 10–14, run/result tables (`backfill_runs`,
   `person_reconcile_people` summaries, `person_publish_runs/results`,
   `person_postcutover_audit_runs/results`, `transition_events`, `maintenance_events`) as
   CSV into the repository's evidence folder; keep `.env.rehearsal` private until deletion.
2. Remove dependencies: the branch preview's copy-scoped variables (Vercel, branch
   `fix/person-90-release-remediation`), the Turnstile hostname, synthetic provider keys,
   `.env.rehearsal`, launch entries; stop referencing the fixed October 5 URL.
3. Delete the project in the dashboard (irreversible; billing stops from that point).

## 7. Approval requested, and the decisions only the owner can take

Approve, in writing: (a) the production schema install with
`scripts/person-release/apply-upgrade.sh` and the label statement; (b) the production
configuration changes in 3.4 (transition support on before arming); (c) the operator sequence in
3.5 with the revised ceilings in 3.2; (d) the main merge of the parent PR after the remediation
PR review; (e) retirement of the copy per section 6 after production verification.

Expected downtime: none for public pages; recruiter contact edits and application processing
refused during held windows (the catch-up window: ≈ 17 minutes on the copy for 2,135 queued
people plus ≈ 6 minutes of fingerprint; production's queue size at the sitting decides; anchors
minutes). Publication runs with the controller open (writers keep working): ≈ 9 hours for
431,978 people at the measured 13–14 people/s with 16 sessions from one operator machine (two
720-minute windows at most), plus the post-publication held window and the final audit (its rate
is in ledger 15.5). Cost: the copy's hourly compute until deletion; no new paid services; disk
growth of production by 16–21 GB (3.2) under the existing plan's disk pricing.

Decisions that are the owner's:

1. **Disk and ceiling** (3.2): confirm provisioned disk ≥ 80 GB or autoscaling, approve the
   58 GB `--max-db-bytes` ceiling, and whether the copy's ceiling may be raised to let its
   publication finish (its disk would grow; a spending decision). Without it the copy
   rehearsal's publication stops at the approved 45 GB.
2. **External directory stability**: the communications project changes while a scan runs
   (18 directory rows changed during the 17-minute copy scan), so the reconcile finalizer
   reports `review_required`/`catchup_pending` and a short final scan at the cutoff is needed;
   accept that outcome rule, or coordinate a pause of the directory's own writers (reply-ops)
   for the cutoff window.
3. **Rollback scope**: an undo is a full abandonment step for the publication (the armed
   admission refuses undone people afterwards; re-publication needs the controller disabled,
   rehearsed on the copy). Accept, or commission an armed-aware undo before the sitting.
4. **Review policy**: 5,488 open identity conflicts over 9,352 people are `review_skipped`
   with `--review=skip` (decision B5); the alternative `--review=publish` publishes them.
5. **`package.json` `packageManager` line** from the October 12 session: commit (switches
   Vercel's installer to pnpm without a lockfile) or discard.
6. **Fresh backup/PITR** before the sitting (3.3) and the dashboard disk check (3.2).
