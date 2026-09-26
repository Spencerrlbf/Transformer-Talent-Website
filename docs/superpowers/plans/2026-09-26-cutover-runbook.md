# Candidate storage cutover: pre-cutover summary and runbook

Written 2026-09-26 evening (UTC) after Phase 1 and Phase 2 of the cutover brief.
Nothing in this document has been run against production. Every step below
waits for Spencer's go-ahead at the pause points marked **PAUSE**.

## 1. Where things stand

**Production.** `main` is unchanged at `0c2b9a8` (plus the dispatch-only person
trial workflow). Nothing built for the unification is deployed. `PERSON_WRITE_MODE`
is unset everywhere, so every writer runs in legacy mode.

**Database (website project `kmuihequfurvjxpnugxf`).** Seven additive migrations
are live: `20260926011500` (072 tables), `025355`, `031057`, `032752`, `040300`,
`042200`, `050355`. Candidate rows and IDs are unchanged. Twelve prepared
migrations are NOT applied (section 4, step 13).

| Measure | Value | Evidence |
|---|---|---|
| Candidates in pool | 423,050 | `select count(*) from candidates` |
| Normalized (shadow) profiles | 423,049 | run `person-full-phones-20260926`, status `baseline_complete` |
| Excluded by source-date hold | 2 | `person_source_holds`, reason `harvest_cache_date_unknown` |
| Reconciliation | `review_required` | run `person-reconcile-full-20260926`: 422,963 verified, 87 review (2 holds + 85 same-snapshot mutations), queue 0, full scan complete, external directory not stable across the scan |
| Open identity/contact review records | 5,483 rows, ~4,835 people | `identity_conflicts` status open |
| Database size | 31.8 GB of 40 GB disk, 34 GB runner cap | `person_backfill_metrics()` |
| Nightly workflows | all 9 active (restored 2026-09-26 ~20:00 UTC) | GitHub Actions |

**Decisions taken by Spencer (2026-09-26, in chat).**
1. Restore the five paused workflows: done.
2. Fill emails at publish for the 146,696 people who have none today; collisions keep today's address and get a review record.
3. Contact rule: invalid, bounced, claimed or suppressed contacts never rank; a manual choice wins only among usable contacts.
4. Newest dated source owns current title and company; recruiter edits win; shared addresses never primary.
5. List contract: separate owners for jobs, education, skills; omitted = untouched, explicit empty = clear.
6. Company identity change: keep the job row id on an unambiguous match; review the ambiguous.
7. Parser replay: version-aware.
8. Publish everyone, including the ~4,835 review people and the 85 mutated-snapshot people (`--review=publish`); deduplicate the collision pairs in a separate review after cutover.
9. Keep the 2 holds out of publication; resolve after cutover with two fresh Harvest pulls.
10. Directory drift is a bounded catch-up step before cutover, not a gate.
11. Merge order into the parent: #22, #23, #24, #21 (#21, #22 and #25 already merged).
12. Token rotation is Spencer's, after cutover.

## 2. Pull requests and evidence

| PR | Branch | State | What | Tests |
|---|---|---|---|---|
| #2 | `feat/person-00-storage-unification` | draft to main | the parent | combined below |
| #1, #3 to #18 | children | merged | writer rules, atomic save, backfill, reconcile, holds, intake (application, refresh, directory, recruiter), published reads, derived data, audit evidence and anchors | each child's local suite, hosted preview, 913-call tenancy sweep |
| #19 | `feat/person-21-audit-writers` | merged | audit guard on writers | 149 audit tests, sweep 236 s PASS |
| #20 | `docs/person-22-handoff` | merged | handoff document | docs |
| #21 | `feat/person-23-audit-snapshots` | merged | post-cutover audit evidence snapshots | 19 PostgreSQL tests |
| #22 | `feat/person-24-publish-runbook` | merged | publish, undo, write-guard scripts and migration `183000` | 9 tests + CLI demonstration; all suites green |
| #25 | `fix/person-27-publish-review` | merged | review fixes on #22; migration `201342` (deferred guard checks) | 27 publish/undo/guard tests; sweep 252 s PASS on f0183f6 |
| #23 | `chore/person-25-email-collision-check` | open, rebased | read-only projection preview + email collision check | 3 tests; production preview run 36263047493 |
| #24 | `fix/person-26-comms-connection` | open, rebased | directory connection survives a server-side disconnect | 2 tests; reconcile, backfill, directory, trial suites |

Local suites at the current parent (Node 24, PostgreSQL 15): publish 9 + 18 + 3,
atomic 15, audit 149, backfill 15, derivatives 16, directory 48, intake 27,
published 27, reconcile 8, recruiter 23, refresh 23. `tsc --noEmit` exit 0.
Note: the suites end their connection pool in top-level code and fail under
Node 20 even on unmodified code; use `/opt/homebrew/bin/node` (24).

## 3. The parity diff, explained

Read-only projection preview over all 423,049 migrated people (Actions run
36263047493, 4,041 s). Full table with per-column explanations is on PR #23.

| Column | Would change | Cause |
|---|---|---|
| current_company_id | 415,485 | null for everyone today; projection links the companies table |
| work_experience | 419,442 | 92.8% same positions gaining company references; 6.2% more positions than the old JSON; 0.2% fewer (exact duplicates and empty positions removed) |
| previous_companies | 299,985 | derived from the same positions by the projection rule |
| top_skills / all_skills_text | 179,205 / 177,514 | 134,705 filled from empty; 17,960 supersets; 26,540 newer set |
| profile_summary | 138,049 | ~119,000 whitespace and newline normalisation; ~18,500 newer text; 210 filled |
| education_fields / degrees / schools | 120,186 / 55,313 / 20,851 | one entry per education row instead of the old deduplicated list; filled from empty; canonical school names |
| headline, current_title, current_company, full_name, photo, location, phone | 16,258 / 9,275 / 3,078 / 789 / 4,457 / 23 / 812 | normalisation, plus newer-source values (832 titles, 705 names) |
| email | 146,699 | 146,696 filled from normalized contacts; 91 different; 4 case only; 180 cleared as invalid or bounced; 272 collisions kept as today with a review record |

Not touched by publish: candidate ids, verdict links, signals, status, notes,
follow_up_at, contact JSON, embeddings and every non-profile column (publish
writes the 18 profile columns and `updated_at` only; proven by the publish
suite's workflow-preservation and exact-undo assertions).

## 4. Cutover runbook (Phase 4)

Run from the Mac Mini in one sitting. Conventions: `REPO` is a checkout of the
parent at the released commit; `WD` is `~/Mac-Mini-Projects/Recruitment-Matching`
(linked to the website Supabase project); every `psql`-style check goes through
`supabase db query --linked --workdir $WD`. Logs carry ids and counts only.

Secrets needed before step 14, provided by Spencer and never pasted in chat:
- `PERSON_DATABASE_URL`: the website project's **transaction pooler (port 6543)** URL, for Vercel and the worker secrets.
- `PERSON_PUBLISH_DATABASE_URL`: the **direct or session pooler (port 5432)** URL, for the publish, undo and guard CLIs (they refuse 6543).
- The `.env.scripts` file (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`) for the tenancy test.

### Step 12: merge the parent to main and verify the deploy
1. Merge #23 and #24 into the parent (after #23's tenancy sweep, or Spencer's acceptance of the suites).
2. Take PR #2 out of draft and merge it to main **only on Spencer's explicit go**.
3. Verify: `gh run list` shows the main deploy green; Vercel production points at the merge commit; `curl -sL -o /dev/null -w '%{http_code}' https://www.transformertalent.com/` and `/roles`, `/talent`, `/apply` return 200. Flags are unset, so behaviour is unchanged.
- Rollback: revert the merge commit on main; Vercel redeploys the previous build.

### Step 13: apply the prepared migrations
Apply in this order, each file in one transaction through the linked CLI, and
record each in `supabase_migrations.schema_migrations` with its filename prefix
as the version, the same way the seven live ones were recorded overnight:

```
20260926033900_person_atomic_projection.sql
20260926044800_person_application_intake.sql
20260926054500_person_refresh_intake.sql
20260926061600_person_directory_intake.sql
20260926065300_person_recruiter_contacts.sql
20260926072840_person_derivative_jobs.sql
20260926074407_person_audit_evidence.sql
20260926080238_person_audit_anchor_preparation.sql
20260926082012_person_audit_writer_guards.sql
20260926172608_person_postcutover_snapshots.sql
20260926183000_person_publish_runbook.sql
20260926201342_person_publish_review_guards.sql
```

Then, outside a transaction: `psql -v ON_ERROR_STOP=1 -f scripts/person-directory/prepare-lookup.sql`
(creates the case-folded LinkedIn lookup index concurrently).

Verify after each file: `select to_regclass('public.<new table>')` is not null for
its tables; `select public.person_write_guard_status()` returns `enabled: false`;
`select count(*) from candidates` is still 423,050; the site still answers 200.
All twelve are additive; none rewrites a candidate row.
- Rollback: each migration's objects can be dropped without touching candidate rows; nothing reads them until the flag flips.

**PAUSE 1: report the applied list and checks to Spencer; wait for OK.**

### Step 14: secrets, drain, catch-up, anchors
1. Set `PERSON_DATABASE_URL` in Vercel (production, server-only) and in the GitHub Actions secrets used by `refresh-queue.yml`, `sync-candidates.yml` and `review-queue.yml`. Leave `PERSON_WRITE_MODE` unset (legacy).
2. Redeploy so the new secret is present; verify the deploy is green and pages return 200.
3. Drain in-flight old workers: confirm no `Person writer trial`, refresh, directory sync or review-queue run is in progress (`gh run list --status in_progress`).
4. Directory catch-up (decision 10): dispatch `person-trial.yml` with `dry_run` off and
   `backfill = {"run-id":"person-reconcile-precutover-<date>","reconcile":true,"scope":"directory","limit":1000000,"batch-size":500,"max-db-bytes":34000000000,"max-seconds":18000}`;
   expect `source_scan_complete` and finalize locally with `scripts/person-reconcile-finalize.mjs`. Record the status; `review_required` from the 87 known review people is expected.
5. Prepare audit anchors for the whole pool (publish refuses a person without one):
   `PERSON_PUBLISH_DATABASE_URL=... node scripts/person-audit-anchors.mjs --limit=1000 --batch=20` (dry) then `--save`, measuring throughput on the first 1,000 before extending `--limit` and `--max-seconds`. Expected outcome per person: `created`, `unchanged` or `review`; `review` people are the same review bucket.
- Rollback: remove the secret and redeploy; anchors are additive rows.

### Step 15: writers live, canary first
1. Set `PERSON_WRITE_MODE=live` on **one** surface first: the review-queue Actions workflow (bounded, retryable, TT applications only). Dispatch it once; verify in `person_application_receipts` that receipts commit and that `person_derivative_jobs` shows queued work with no `review` status.
2. Extend to `refresh-queue.yml` and `sync-candidates.yml`, one nightly cycle each, checking `person_refresh_attempts` and `person_directory_receipts`.
3. Set `PERSON_WRITE_MODE=live` in Vercel production and redeploy. Submit one synthetic test application through the tenancy fixture (`node scripts/test-tenancy.mjs --base https://www.transformertalent.com`) and confirm the 913 calls PASS and cleanup is empty.
4. Health checks between each move: `person_backfill_metrics()` (blocked sessions 0, queue pending 0), Vercel function error rate, `select count(*) from person_change_queue`.
- Rollback: unset `PERSON_WRITE_MODE` on the affected surface and redeploy; legacy writers resume; normalized receipts remain for replay.

**PAUSE 2: report canary results; wait for OK before flipping everywhere.**

### Step 16: publish projections in batches
Dry run first, over everyone (writes nothing):
```
PERSON_PUBLISH_DATABASE_URL=... node scripts/person-publish.mjs --run-id=publish-<date>-dry --mode=dry --limit=1000000 --batch-size=500 --review=publish --out=<private path>
```
Expected: counts matching the PR #23 preview within the drift of live intake.

First batch, the 50 trial people. They are the only people with a normalized
source written before the baseline started:
`select distinct candidate_id from candidate_sources where created_at < '2026-09-26 03:30+00'`
(verified: exactly 50). Pass them as `--ids`:
```
PERSON_PUBLISH_DATABASE_URL=... node scripts/person-publish.mjs --run-id=publish-<date> --mode=publish --ids=<50 ids> --review=publish
```
Verify: `select status,count(*) from person_publish_results where run_id='publish-<date>' group by 1`
shows `projected` and `unchanged` only; open three of the 50 in the pool drawer,
Network and Send and confirm title, company, contacts; `select count(*) from
person_projection_history where run_id='publish-<date>'` equals the projected count.

**PAUSE 3: show the first batch's results; wait for OK before publishing beyond it.**

Then the pool, resumable, in one-hour slices:
```
PERSON_PUBLISH_DATABASE_URL=... node scripts/person-publish.mjs --run-id=publish-<date> --mode=publish --limit=1000000 --batch-size=500 --review=publish --resume --max-seconds=3600
```
Repeat with `--resume` until `publish_complete`. Watch `person_publish_runs.counts`
after each slice: `drift` and `audit_blocked` must stay near zero (a rising
`drift` means a legacy writer is still active: stop and find it). Expected
totals: about 420,000 projected, about 2,800 unchanged, 2 held, 0 unmigrated.
Recompute unpaid signals only (`compute-signals.yml` on its schedule); do not
dispatch judge or refresh for storage-only changes.
- Rollback: `node scripts/person-publish-undo.mjs --run-id=publish-<date>` (count), then `--apply`; `conflict` rows are people edited since publish and are left alone.

### Step 17: audit and enable the guard
1. Run the post-cutover auditor over the published pool, dry first, then recording:
```
PERSON_PUBLISH_DATABASE_URL=... node scripts/person-postcutover-audit.mjs --run-id=audit-<date> --limit=1000 --batch-size=10
PERSON_PUBLISH_DATABASE_URL=... node scripts/person-postcutover-audit.mjs --run-id=audit-<date> --record --limit=1000000 --batch-size=10 --max-seconds=3600
# repeat with --resume until audit_scan_paused reports processed = the pool, then:
PERSON_PUBLISH_DATABASE_URL=... node scripts/person-postcutover-finalize.mjs --run-id=audit-<date> --external-stable=<true|false from the last directory reconciliation>
```
   Expected: `verified` for published people; `review` for the known review bucket (holds, mutated snapshots) and for anything with an unexplained edit; `pending` for raw facts or receipts no writer has admitted yet. Finalize reports `audited`, `catchup_pending` (with which fence moved) or `review_required`. Anything `review` outside the known bucket stops the sitting.
2. `node scripts/person-guard.mjs --test-rejected=<one published id>` must print `outcome: rejected` (guard still disabled prints `allowed`, which is expected before enabling) and `--test-allowed=<same id>` must print `allowed`. Both roll back.
3. `node scripts/person-guard.mjs --enable --note="cutover <date>"`, then repeat both tests: rejected and allowed.

**PAUSE 4: show the two test writes; wait for OK before leaving the guard enabled.**

- Rollback: `node scripts/person-guard.mjs --disable --note="..."`, instant.

### Step 18: restore, verify, rotate
1. Workflows are already active; confirm each of shortlists, signals, judge, refresh queue and directory sync completes one clean scheduled cycle against the live writer (the morning after).
2. Tenancy test against production: 913 calls PASS, cleanup empty.
3. Live read checks: pool drawer, Network, Send, public talent cards, `/roles`, `/apply`.
4. Spencer rotates the Supabase access token noted in the overnight ledger.

### Step 19: completion report
State separately: historical data copied (done 2026-09-26 17:04 UTC); sources
reconciled (review_required with 87 known); writers switched (per surface, with
dates); projections published (count, held 2, drift, blocked); derived data
refreshed (which nightly cycle). Include the review-bucket status (~4,835
collision people + 85 mutated snapshots + 272 email collisions: resolved or
deferred with counts), the 2 holds, and token rotation. April retirement is
out of scope.

## 5. Open items that are not blockers
- The 272 email collision ids and the 2,000-id sample of collision people are in the preview run log; the dedup review is post-cutover work.
- PR #24's connection fix is not in the pinned runner used by the reconciliation runs; the next long scan should use a new pin that includes it.
- The tenancy sweep for #23 needs `.env.scripts` on the Mac Mini or Spencer's acceptance of the suites.
