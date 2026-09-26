# Overnight Candidate Storage Unification Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task in this task. Steps use checkbox syntax for tracking. Complete and verify each numbered task before proceeding.

**Goal:** Repair and backfill the normalized candidate database overnight while preparing all TT intake changes on a parent feature branch; preserve candidate IDs and live read compatibility, and hold the application merge/switch for Spencer's approval tomorrow.

**Architecture:** Use the existing normalized tables and `save_person` foundation. First collect new writes in shadow mode while the existing application continues operating; then backfill historical sources and switch to transactional normalized writes plus the existing candidate-column representation. Keep recoverable before-images and durable progress throughout.

**Tech Stack:** Next.js/TypeScript, PostgreSQL/Supabase, Node workers, GitHub Actions, Vercel.

**Spec:** `/Users/spencerbarton-fisher/.codex/attachments/45f73a63-785e-42cc-8f99-e6011bf56434/Pasted text.txt`; verified findings in `/Users/spencerbarton-fisher/Documents/Codex/2026-09-25/pl/migration-review.md`. Also read the original `storage-final.json`, `migration-plan.json`, and `person-trial-spec.md` in the scratchpad identified by that brief before implementation.

**Status:** Spencer clarified that database fixes and migrations remain the main overnight objective; his approval tomorrow applies to merging the application feature into main. Tonight's scope includes tested additive database migrations, normalized-table trials/backfill, and task branches integrated into a parent feature branch. Keep current candidate projections and live application behavior compatible; do not merge main, deploy new application behavior, delete old data, or enable the restrictive live-write guard tonight. A morning finish is a target, not a guarantee. Do not skip a failed gate to meet it.

## Branch and approval sequence

- Parent integration branch: `feat/person-00-storage-unification`, based on the verified current main.
- Work sequentially. Start each child from the latest tested parent; complete the task, run its checks, review its diff and open a PR targeting the parent. Merge that child into the parent only when its checks pass, then begin the next task.
- Proposed child sequence: existing `fix/person-02-write-safeguards`, then `fix/person-03-writer-rules`, `feat/person-04-atomic-save`, `feat/person-05-intake`, `feat/person-06-backfill` and `chore/person-07-integration`. Keep operational tasks as checked runbook stages, not artificial code branches.
- Reuse the existing safeguard work. Once the parent exists, retarget its PR to the parent instead of releasing it independently to main. Inspect divergence before integrating; do not overwrite others' changes.
- Maintain one draft parent PR targeting main, with the combined diff, task checklist, test evidence, remaining blockers and release/rollback procedure. Attach created PRs to this task.
- A preview may connect to the shared production database. Keep new application behavior disabled there by default; use local/isolated write tests before production database trials. Do not expose unapproved new application behavior through a writable preview.
- Overnight: complete the recovery baseline, implement/test database rules and the runner, apply additive database corrections, run tasks 6–8, and prepare the application branches and compatibility tests. Any temporary coordination of overlapping database workers must retain and restore their original state; do not pause public application intake.
- Database-before-code sequencing: old live writers remain active until tomorrow. Build durable change capture and catch-up into the database migration, including writes that omit updated_at, and reconcile directory/source changes using their own watermarks. Run the catch-up during backfill and immediately before the later switch. Do not claim the new tables will remain current merely because a one-time copy completed.
- Tomorrow, after Spencer approves the combined feature and release: deploy the shared application/worker writers, reconcile the final delta, publish compatible projections and only then enforce the live-write guard. Complete production release checks and report separately from the overnight database backfill.
- Task 12 must distinguish normalized data migrated tonight from live application writers switched tomorrow. No promise of a full-pool morning finish before the pilot measures capacity.

## Execution ruling after the original-50 trial

Tasks 1, 2, 3, 6 and 7 passed. Task 5 baseline/capture and its restart checks passed; task 8 full backfill and reconciliation remain in progress. Implement task 5 on `feat/person-06-backfill` before application tasks 3–4, because the approved database backfill must run while main remains unchanged. Database triggers durably capture old-writer changes, including writes without updated_at. Historical backfill and catch-up report any source ambiguity explicitly; neither the migration nor queue processing silently labels an automated write as a recruiter edit. Application branches follow after pilot/full-backfill dispatch, still sequentially from the parent.

## Global Constraints

- Preserve `candidates.id`, existing links, verdicts, signals, and current application read contracts.
- TT pool scope is 423,050 candidates at the last audit; refresh the count and include arrivals during migration. Tenant applicants and sourced candidates remain organization-scoped in their existing stores.
- Keep the website accepting and durably storing applications throughout. Background enrichment failure must remain retryable.
- No duplicate-person merges, pool admission without LinkedIn, April-table changes/deletion, legacy-email deletion, or writes to the communications database.
- Keep raw source payloads and existing working data for recovery. Do not remove legacy storage overnight.
- Use existing cached enrichment data. No migration-triggered paid Harvest pulls, bulk embedding regeneration, or bulk judging; preserve existing cost caps.
- Never log or commit names, contact details, raw resumes, source payloads, or credentials. Reports use IDs, hashes and counts.
- No direct commits to main. Use reviewable branches and previews; verify production deployment after any authorized merge.
- Spencer's latest clarification puts the database migration back into tonight's scope while retaining tomorrow's confirmation for the main merge. Limit tonight's database operations to tested additive storage corrections, change capture and normalized backfill; existing candidate profile rewrites, application deployment, restrictive guards and destructive retirement remain outside tonight's scope.
- Unexplained data loss, tenancy failure, unresolved identity assignment, missing source access, failed recovery checks, or unsafe live load stops the affected rollout stage. Record the reason and continue only independent preparatory work.

## Review Focus

1. A candidate applies while the backfill is running: the application is retained and its source reaches the new store exactly once. Tests belong to tasks 4–5.
2. A delayed old refresh races with a newer directory or recruiter update: final facts are determined by source precedence, not arrival order. Tests belong to tasks 2–3.
3. The process stops after a database commit but before its checkpoint: restart neither skips that person nor duplicates contacts/jobs. Tests belong to task 5.
4. Company identity gains a numeric LinkedIn ID and a contact has conflicting verification/manual status: no silent person merge, duplicate active job or unusable primary. Tests belong to task 2.
5. A rollback occurs after another legitimate edit: restoration must not overwrite that newer edit or delete a new application. Tests belong to tasks 3 and 11.

---

### Task 1: Establish the recovery and deployment baseline

**Files/artifacts:** Existing safeguard PR #1; private `overnight-migration/baseline.json`, `workflow-state.json`, and `progress.json` outside git. Branch/worktree setup follows the using-git-worktrees skill.

- [x] Refresh main/branch state, live schema version, candidate/source counts, running Actions, database size, available disk, and normal query latency. Confirm no other session is modifying the writer/schema.
- [x] Verify a recent usable backup, recovery permissions and a documented restoration procedure. Capture row-level before-images for every planned live profile rewrite; prove the row restore procedure on a local copy. Do not describe a backup as restore-tested unless a restore was actually tested.
- [x] Record the current deployment and workflow enabled/disabled states. Identify the jobs starting at approximately 06:30–08:45 UTC; pause conflicting workers only before live schema/large-batch operations, not throughout code development. Applications remain available.
- [x] Define the progress record: task, pinned commit/parser version, start/end time, verification result, run ID, checkpoint, and rollback reference. Give every live phase a bounded maximum batch size.

**Gate:** Recoverability and required access are established; otherwise keep all production work read-only. **Undo:** None for inspection; restore only workflow states changed by this run.

### Task 2: Fix the normalized writer's known correctness gaps

**Files:** Import only the required `lib/server/person/` modules, `scripts/person-trial/`, and applied migration 072 from trial commit `69646c6`; preserve migration 072 verbatim. Extend `types.ts`, `normalize.ts`, `fromDirectory.ts`, `project.ts`, and translator tests. Add a new timestamped SQL migration for writer corrections. Do not import the trial's unrelated `spine.ts` side-role change.

**Interfaces:** Retain `PersonDoc`, `fromLegacyImport`, `fromHarvest`, `fromDirectory`, `fromApplication`, `save_person(doc jsonb)` and `project(tables: ProjectionInput): Projection`. Extend header/provenance support to current title/company without changing existing callers' required fields.

- [x] Add failing tests: newer directory title without Harvest history wins over an older job title; older title loses; blank title does not erase; equal-date inputs converge in both arrival orders; recruiter priority remains deterministic.
- [x] Pin list semantics to the existing independently owned jobs/education/skills lists: omitted means unknown/no replacement; an explicitly present empty list means replace with empty. Document this refinement of the brief.
- [x] Add failing tests for company identity enrichment: an unambiguous company match preserves the existing job ID; ambiguous matches retain history and enter review rather than merging people or inventing equivalence.
- [x] Apply the brief's stated rule that invalid, bounced, claimed and never-primary contacts are never ranked. Preserve manual choices among usable contacts; record contradictions with existing manual selections for review before their live projection changes.
- [x] Implement version-aware replay: the same parser/hash is a no-op; an explicitly approved newer parser can correct the same historical source without pretending it was fetched later. Replay must not override a genuinely newer source.
- [x] Run translator, SQL and concurrency suites, including both arrival orders and duplicate replay; commit the independently tested correction.

**Gate:** All new regressions pass; current IDs, source dates and source precedence remain valid. **Undo:** Previous application remains active; no live profile projection changes yet.

### Task 3: Build an atomic save and compatibility projection

**Files:** New `lib/server/person/save.ts`, additive SQL migration for projection revision/hash, transactional save/project and before-images; extend `scripts/person-trial/test-save-person.sql` and concurrency tests.

**Interface:** Add server-only `savePerson(doc: PersonDoc, options: { mode: 'shadow' | 'live' }): Promise<{ candidateId: string; changed: boolean; revision: string }>` around database transactions. Shadow mode changes normalized storage only; live mode also saves the compatibility fields atomically. Every successful normalized change has a revision; projection/undo checks that revision.

- [x] Write failing tests for a failure between normalized and candidate writes: either both commit or neither does. Test duplicate submission and simultaneous sources.
- [x] Add transactional projection using the same precedence rules as `project()`, with parity tests between the two representations. Do not compute a projection from an unlocked snapshot and PATCH it unconditionally.
- [x] Preserve unique legacy email behavior, engagement/source labels, contact visibility, workflow/follow-up fields, and existing calculation rules. Do not rewrite unrelated fields or change side-role selection.
- [x] Store protected before-images and a semantic profile hash. Representation-only changes must not enqueue everyone for paid embedding/judging.
- [x] Add and test conditional undo: restore only when the candidate still has the revision this run wrote; report newer revisions as conflicts.
- [x] Run local SQL/concurrency suites and commit.

**Gate:** Atomicity, parity and rollback tests pass. **Undo:** Feature flag returns to old projection path; retain normalized facts and before-images.

### Task 4: Connect every live intake route, initially in shadow mode

**Files:** `scripts/sync-directory.mjs`, `scripts/refresh-worker.mjs`, `lib/server/applicants.ts`, `lib/server/applicant-pipeline.ts`, `lib/server/candidates-unified.ts`, `lib/server/worker-lib.ts`; new focused integration tests. Inspect all remaining candidate mutations before declaring coverage.

- [ ] Finish release verification for safeguard PR #1, including temporary tenancy fixtures and three bounded cached-profile checks if covered by run authorization. Reuse its already-passing 23 regression tests.
- [ ] Route directory and Harvest facts through task 3; retain original fetch dates. Make refresh claims atomic, and record save failures for retry rather than reporting them done.
- [ ] Connect TT job-board applications, referrals, future-interest submissions and review-queue retries through their shared pipeline. Create or resolve a pool person using LinkedIn identity safely, then persist its normalized source; concurrent applications must converge without merging by claimed email.
- [ ] Connect recruiter profile/contact edits and any TT import path. Inspect resume upload and sourcing routes to prove their organization-scoped storage stays intact; do not move tenant data into the pool.
- [ ] Persist a retryable shadow-write record before acknowledging a legacy-only save. A failed shadow save must be observable and replayable; newly created applicants cannot disappear between the two stores.
- [ ] Test new/existing TT applicant, tenant applicant, referral, future interest, resume upload, duplicate submission, recruiter edit, worker retry and submission during backfill. Mock outbound mail/enrichment in synthetic route tests.
- [ ] Rebuild worker bundle; run type checking, production build and preview tenancy test. Deploy shadow mode only after the permitted preview/release gate.

**Gate:** Every write path is mapped; shadow failures are durable; tenancy test prints PASS. **Undo:** Disable shadow processing and restore the prior deployment; retain queued source records for later replay.

### Task 5: Build the restartable migration runner and audit report

**Files:** New `scripts/person-backfill.mjs`, `scripts/person-audit.mjs`, `scripts/test-person-backfill.mjs`, dispatch-only `.github/workflows/person-backfill.yml`; reuse source readers from `scripts/person-trial.mjs` without removing its 200-person safety limit.

**Interfaces:** Backfill CLI requires `--run-id`, `--limit`, `--batch-size` and `--mode=shadow|project`; supports `--resume` and `--dry-run`. Use `backfill_runs` for durable progress. The audit reports eligible/completed/pending/failed/conflicted candidates, source coverage, expected contacts, list ownership, projection differences and integrity failures.

- [ ] Add failure-injection tests for interruption before commit, after commit/before checkpoint, and during source retrieval; resumption processes every candidate without duplicates.
- [ ] Read bounded keyset pages, at most 500 candidates per batch; pin commit/parser/source watermarks. Start with one worker. Retry transient failures with bounded backoff; do not advance past an unrecorded failure.
- [ ] Include legacy profiles and emails, cached website Harvest payloads, directory history/contacts, TT applications and recruiter overlays. Failure to read a required source blocks that batch instead of marking it complete.
- [ ] Capture changes during the run using durable shadow writes and a final catch-up pass. A single initial candidate count or `updated_at` watermark is not sufficient.
- [ ] Stop on any lost-contact, wrong-source, broken-link, duplicate-active-job or tenancy invariant. Pause on repeated batch timeout/lock failures or sustained application latency above twice the measured baseline; collect diagnostics before resuming.
- [ ] Test dry-run, bounded execution, restart and idempotency locally; commit and verify dispatch access without logging personal data.

**Gate:** A killed/restarted synthetic run converges to the uninterrupted result. **Undo:** Stop the runner; completed shadow batches remain usable and restartable.

### Task 6: Rerun the same 50-person production trial

**Artifacts:** Private before-images, pinned parser version, aggregate trial report, source/projection differences by candidate ID.

- [x] Under production authorization, apply reviewed additive corrections after checking lock/disk conditions. Deploy scripts pinned to the reviewed commit.
- [x] Replay the same 50 with the repaired parser, preserving existing source evidence; do not use the old destructive trial undo once live shadow writes exist.
- [x] Verify the known title failure is fixed, every known contact/job is accounted for, no unusable contact is primary, and legacy profile rows are unchanged in shadow mode.
- [x] Repeat the run and require no unexplained changes. Resolve the three existing identity conflicts by preserving separate identities and reporting them; do not auto-merge.

**Gate:** No unexplained destructive difference. **Undo:** Halt expansion; leave existing candidate projections serving the app.

### Task 7: Run the 5,000-person pilot and measure capacity

- [x] Select a representative mix of old imports, directory people, cached Harvest profiles, contacts with verification conflicts, shortlisted candidates and recent applications.
- [x] Run shadow-only in bounded batches. Record elapsed time, rows/second, lock waits, query latency, database growth and errors.
- [x] Audit all 5,000 and repeat a bounded sample to prove no-op behavior. Increase workers only when measured headroom supports it.
- [x] Calculate a remaining-runtime range from actual throughput plus observed retry/validation cost. Recheck free disk using measured growth with safety headroom.

**Gate:** Integrity checks pass and the database remains healthy. A slow pilot changes the ETA; it does not justify relaxing checks. **Undo:** Stop at the saved checkpoint; live reads are unchanged.

### Task 8: Backfill the remaining TT pool

- [ ] Run resumable shadow batches using the pilot's safe settings; report progress without personal data.
- [ ] Audit contacts, jobs/company links, education, skills and source ownership throughout; quarantine recorded conflicts and keep an exact unresolved count.
- [ ] Catch up arrivals and edits since the starting watermark, then drain/reconcile the shadow retry queue.
- [ ] Require every eligible candidate to be accounted for as completed or explicitly unresolved. Any unresolved item prevents claiming a complete migration or switching that person's projection.

**Gate:** Source coverage and accounting reconcile; zero unexplained omissions. **Undo:** Stop; normalized copies are retained and the existing app remains active.

### Task 9: Verify app behavior against the completed data

**Files:** Integration tests from task 4, `scripts/test-tenancy.mjs`, `scripts/person-audit.mjs`; any narrowly required compatibility repairs.

- [ ] Run the build and relevant tests at the exact release commit; test preview tenancy with approved temporary fixtures and clean them up.
- [ ] Verify candidate search/drawer, Network, shortlist/matching inputs, public talent cards, Send snapshots, contacts and current title/company against the proposed projections.
- [ ] Exercise job-board application, referral, future-interest and resume-upload paths, including tenant ownership and retry behavior. Capture external notifications in test mode; do not contact real candidates as a smoke test.
- [ ] Check that IDs, verdict links, workflow state, follow-up dates and valid contact selections survive. Explain intentional corrections; hold unexplained differences.

**Gate:** Tested routes and reports demonstrate compatibility. **Undo:** Fix in branch or retain shadow mode.

### Task 10: Switch live writes and progressively publish projections

- [ ] Coordinate Vercel and worker configuration so every active pool writer supports the new transactional path. Drain old in-flight workers before enabling live writes. Verify deployment status and effective configuration.
- [ ] Enable live mode on a bounded canary, then project in controlled batches with before-images/revision checks. New arrivals already use the same writer; do not overwrite them with an earlier backfill snapshot.
- [ ] Retain today's candidate fields as compatibility copies. Recompute affected unpaid derived signals and verify Network snapshots; do not mass-trigger paid jobs for storage-only differences.
- [ ] Where genuinely changed profile content requires paid work outside existing authorization, hold the affected rollout rather than publish inconsistent derived results or spend without a cap.
- [ ] After all legitimate writers pass, enforce the profile write guard. Permit authorized workflow/status changes and transactional person creation. Test both allowed and rejected writes before enabling it.

**Gate:** All writers use the same rules, compatibility reads work, and no unapproved legacy profile mutation bypasses them. **Undo:** Stop projection, disable the guard/live flag in the tested sequence, restore the prior deployment and conditionally restore affected projections; retain newer applications and source evidence.

### Task 11: Restore schedules and prove the release remains healthy

- [ ] Verify the production deployment is green and perform bounded live read checks plus approved synthetic intake/tenancy checks.
- [ ] Check application receipts, source queues, writer failures, conflicts, query latency and new profile creation after cutover.
- [ ] Restore only schedules changed by this run, in dependency order, retaining prior enabled/disabled states and existing spending limits. Do not blindly dispatch every paid nightly job.
- [ ] If a check fails, execute the tested rollback and report what remained migrated in shadow storage. Never report a rollback as a completed live migration.

**Gate:** Intake succeeds, scheduled workers are in a documented state, and production checks pass. **Undo:** Task 10's conditional rollback.

### Task 12: Leave a morning completion report and next checkpoint

- [ ] Record released commit/deployment, migrations applied, exact processed/remaining/conflict counts, checks run, schedules restored, costs triggered and rollback locations.
- [ ] State separately whether historical data was copied, every live writer was switched, compatibility projections were published, and derived data was refreshed. "Backfill done" must not imply all four are done.
- [ ] If unfinished, give the safe current mode, exact checkpoint and remaining blocker. Leave no unmonitored non-resumable operation running.
- [ ] Keep April tables, old JSON, legacy email references and the external `legacy_pull.py` dependency intact. Their retirement is a separate later operation with exports, restore proof and the brief's observation/approval period.

## Self-review

- Covers pool storage, all identified intake paths, contact provenance, titles, independent list ownership, stable identity, concurrency, applications during migration, resume/tenant compatibility, checkpointing, recovery and deployment.
- Covers each of the five review-focus failures in an owning task.
- Uses existing translator/project interfaces and introduces one shared server save interface; storage creation details must be verified against the current schema before implementing new-person transactions.
- Treats overnight observation as bounded canary evidence, not as proof equivalent to the original multi-night observation window.
- Defers destructive retirement and unapproved paid recomputation explicitly; neither can be silently included in an overnight completion claim.
- Incorporates Spencer's corrected boundary: sequential child branches feed a parent feature branch; database migration/backfill is tonight's objective, while main merge and live application cutover await tomorrow's approval. Durable catch-up is required because old writers stay live overnight.
