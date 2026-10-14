# Candidate-storage release: acceptance checklist (2026-10-14)

One row per item of the October 14 brief, with the evidence, the measured duration and the service
impact. Evidence references: release ledger `RELEASE_REMEDIATION.md` (section numbers), scripts and
tests on branch `fix/person-90-release-remediation`. Status: **done** (evidence attached),
**measured** (number recorded, no fix needed), **owner** (decision only the owner can take).
Nothing here is a production change; production was read only throughout.

| # | Item | Status | Evidence | Duration / impact |
|---|---|---|---|---|
| 1 | Migration installer: file and history row commit atomically | done | `apply-upgrade.sh` one transaction per version (`\i` + insert, commit); ledger 15.1 | install of 63 files on the isolated database: under 2 minutes; production estimate ≤ 10 minutes, additive, app stays legacy |
| 2 | Installer destination checks use the hardened validator | done | `checkDatabaseUrl` (5432, selection, no option overrides) before any connection; label read at run time; foreign selection refused in the proof (`person_target:database_mismatch`) | none |
| 3 | Recorded-version integrity checked | done | trimmed-digest verification of every recorded window version; `history_mismatch` on a tampered row (proof exit 5); production's CLI-recorded digests in `production-upgrade-manifest.json#recorded_in_window`; `production-history-digests.json` equals production's whole-table digest `b7ca867b…` | none |
| 4 | Interruption/resume proven on an isolated database with production's history | done | `test-apply-upgrade-resume.sh`: 96 production rows imported (digest verified), error fault and lost-connection fault before commit leave nothing of the version, resume to 159 with exact bodies, index built concurrently; all checks passed (ledger 15.1) | local only |
| 5 | Storage export: every nested object | done | recursive folder walk (`listBucket`); production's 55 objects are all nested (read-only count), the old script would have exported none; copy inventory 38 = 38 | export of 8.3 MB: seconds |
| 6 | Storage export rejects listing failures | done | non-2xx or non-array listing throws `storage_list_failed` (test 2); bucket listing failure throws | none |
| 7 | Storage export verifies inventory, sizes and hashes | done | REST listing vs `storage.objects` (set and sizes), body size per object, plain-eTag MD5, SHA256/MD5 manifest, `--verify` re-hash; tests 6/6; on the copy 10 real blobs verified 10/10 (the clone lacks the other 28 blobs, ledger 15.2) | none |
| 8 | Armed-sweep teardown keeps retained people's complete evidence graph | done | `fixture.mjs` retains normalized pool people whole; loopback armed sweep 913 PASS, 3 retained with derived rows, sources and anchors intact (ledger 15.3) | sweep 45 s on the loopback stack |
| 9 | Catch-up succeeds after teardown | done | loopback pinned queue catch-up `source_scan_complete`; pinned full source scan (`scope: all`) 3/3 `verified`, `integrity_ok`, external stable (ledger 15.3) | 5 s |
| 10 | Evidence-preserving disposition for the two synthetic failures | done | derived rows re-derived from the stored owner source with the controller disabled, nothing deleted, before/after digests recorded; both people `verified` by the pinned catch-up run `rehearsal-catchup-20261014` (ledger 15.3, 15.5) | 1 transaction each |
| 11 | Cutover sequence corrected: support on before arming | done | package 3.5 step 2; the copy's preview runs `PERSON_TRANSITION_SUPPORT=on`, `PERSON_WRITE_MODE=live`; rehearsal armed under that deployment | — |
| 12 | Old workers settled | done (procedure) | package 3.5 step 2b: `gh run list --status in_progress`, schedules disabled for the sitting (hourly derivative worker, 06:30/07:00/08:00 UTC jobs); no worker targets the copy, so nothing to settle there | minutes |
| 13 | Required index preparation | done | installer builds `candidates_person_username_idx` CONCURRENTLY before `20260927170000` (autocommit, 30-minute statement bound); invalid leftover stops the run; proven in the resume proof | production build on 431,978 rows: estimated 1–3 minutes, no write lock |
| 14 | Stable full reconciliation | see 15.5 | queue catch-up to `source_scan_complete` with external boundary stable, then `person-reconcile-finalize.mjs` | ledger 15.5 |
| 15 | Valid CLI limits | done | package 3.5 uses `--max-seconds=18000` (was 43,000, above the CLI maximum), windows 720/240 minutes, `--limit=1000000`, `--concurrency=8`; the transition CLI refuses out-of-range values | — |
| 16 | Explicit resume/window closure | done | every window in 3.5 and in the rehearsal scripts is closed by work id; publication resumes with `--resume` in each new window | — |
| 17 | Reconciliation and audit finalizers | see 15.5 | `person-reconcile-finalize.mjs` after the catch-up; `person-postcutover-finalize.mjs` after the final audit; both in 3.5 | — |
| 18 | Complete rollback/conflict accounting | see 15.5 | `person-publish-undo.mjs` rehearsed on the benchmark run (restored/conflict counts); open identity conflicts counted (`review_skipped`) | — |
| 19 | Publication profiled and benchmarked on newly published people | see 15.5 | 17 round trips per person at 46 ms (latency bound, ledger 15.4); benchmark run with `--concurrency=8` on unpublished people | ledger 15.5 |
| 20 | Audit startup and finalization measured | measured / 15.5 | scope statement 9.8 s; fingerprint 10–13 minutes per end (data volume); per-person rate and finalizer in 15.5 | ledger 15.5 |
| 21 | Complete rehearsal at a declared cutoff | see 15.5 | full publication, post-publication catch-up, declared cutoff, final audit, finalizer | ledger 15.5 |
| 22 | Manifest refreshed with reproducible commits | see RELEASE_MANIFEST.md | application commit, migration/tooling commits, deployment | — |

Remaining owner decisions are listed at the end of `RELEASE_APPROVAL_PACKAGE.md` (section 7).
