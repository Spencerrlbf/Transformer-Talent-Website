# Candidate write safeguards implementation plan

> Execute inline using superpowers:executing-plans. The larger storage migration remains gated separately.

**Goal:** Stop the existing nightly writers losing newer data before expanding the person-table migration.

**Architecture:** Preserve the current candidate shape and source labels. Apply source-date checks in the directory writer and explicit success/failure handling in the refresh worker. No production schema change is needed for this repair.

**Tech stack:** Node.js scripts, existing TypeScript worker bundle, Supabase REST.

**Spec:** The user-supplied Transformer Talent storage brief, sections 3, 6 and 7, plus migration-plan.json steps 1 and 6 in the prior session scratchpad.

## Constraints

- No production write, workflow dispatch that writes, merge, paid API call, or April-table change during preparation.
- Preserve existing `candidates` IDs, tenancy, source labels and directory sync hashes.
- Tests use synthetic profiles and local HTTP endpoints. Logs contain counts and IDs only.
- Production deployment requires the owner's explicit approval and the repository's preview tenancy test.

## Review focus

- An older or undated directory copy must not overwrite a dated website refresh, including under concurrent refresh.
- Empty email and follow-up values must not clear existing values; Do Not Contact must still propagate.
- A failed profile PATCH must never finish as done or create an extra paid-pull ledger entry.
- A free retry must work when the paid budget is zero and must never fetch a fresh paid payload.
- A repeated failure must be visible and bounded, including missing cached payloads.

## Task 1: Directory safeguards

Files: `scripts/sync-directory.mjs`, `scripts/test-directory-write-safeguards.mjs`.

- [x] Write regression tests for empty fields, older/equal/newer/unknown timestamps, contact/status propagation and stale embedding input.
- [x] Run tests and verify the failures correspond to the observed bugs.
- [x] Implement `patchFor(mapped, previous)` using LinkedIn fetch dates and non-empty values. Extend every lookup with the required fields. Guard the write against a refresh occurring since the lookup, leaving the sync hash unchanged if skipped.
- [x] Run regression tests and syntax checks. Add dry-run aggregate counters.

## Task 2: Refresh persistence and free recovery

Files: `scripts/refresh-worker.mjs`, `scripts/test-refresh-write-safeguards.mjs` and local-only test utilities if needed.

- [x] Exercise the real worker against a local HTTP fixture: successful cached save, transient failure, repeated failure, free retry with no budget, expired/missing payload, exhausted retry.
- [x] Run tests before changing the worker and record expected failures.
- [x] Stamp `updated_at`; retry the PATCH once; finish failures as `patch_failed`. Process up to 50 recent unretried `patch_failed` rows directly before normal work, stamping reason `patch_retry`, without a paid request or another enrichment-ledger row.
- [x] Run the complete focused suite, worker build, TypeScript check and application build as applicable.

## Task 3: Review and migration release gates

- [x] Independently review the branch, correct demonstrated issues, and prepare a draft PR.
- [x] Record live database counts and migration blockers in a review note. Separate facts verified now from historical estimates.
- [ ] Present the exact release and trial gates to the owner. Do not treat preparing the safeguards as completing the migration.

## Decisions during implementation

- Bound recovery at 50 people per run. Keep failed rows in place rather than converting them to queued: the existing uniqueness constraint permits an ordinary queued row for the same candidate.
- Preserve paid-budget semantics for ordinary queue work; the separate recovery pass remains available at zero paid budget.
- An optimistic REST predicate must protect the directory read/write gap; source-date checks on a stale in-memory row alone are insufficient.

## Validation record

23 focused tests pass after demonstrating the reported failures first. The final directory embedding race was reproduced through the actual CLI, then fixed. TypeScript checking, worker bundling and Next.js build pass. Existing trial translator tests (51), local SQL writer assertions and eight-session concurrency tests also pass. Production tenancy fixtures and the three-profile save test await explicit approval.
