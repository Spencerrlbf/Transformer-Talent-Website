# Transition controller CLI and cutover rehearsal

`scripts/person-transition.mjs` is the operator tool for the transition controller
and the maintenance windows. It runs from a direct website session
(`PERSON_PUBLISH_DATABASE_URL`, port 5432; transaction poolers are refused).

```sh
node scripts/person-transition.mjs --status
node scripts/person-transition.mjs --arm --expect-phase=disabled --reason=cutover_arm
node scripts/person-transition.mjs --drain --expect-phase=open --reason=cutover_drain
node scripts/person-transition.mjs --wait-drained --max-seconds=600
node scripts/person-transition.mjs --seal --expect-phase=draining --reason=cutover_seal
node scripts/person-transition.mjs --open-window=catchup --run=RUN --minutes=120 --expect-phase=held --reason=final_catchup
node scripts/person-transition.mjs --close-window=WORK_ID --reason=catchup_done
node scripts/person-transition.mjs --reopen --expect-phase=held --reason=cutover_reopen
node scripts/person-transition.mjs --open-window=publish --run=RUN --minutes=720 --expect-phase=open --reason=publish_all
```

- **Expected phase.** Every controller change and window opening requires `--expect-phase`
  (disabled, open, draining or held). A different current phase is refused
  (`transition_expected:<actual>`). Closing an exact work ID is idempotent in any
  phase and intentionally takes no `--expect-phase` option.
- **Unused options.** Options that don't belong to the chosen action are refused.
- **Waiting for the drain.** `--wait-drained` runs only while draining.
  - It waits for live admitted non-maintenance work only. Parked (`deferred`) work counts as
    resolved, as for seal.
  - Expired or uncertain work is reported as `stuck` at once. Retire expired
    pre-effects application work by re-claiming it, which parks it. Review
    uncertain work.
  - Active and expired maintenance windows are immediate blockers. Stop the
    owning runner and close each exact `windows[].work_id` with `--close-window`
    before retrying; expiry does not close a window.
  - It exits 2 when not drained.
- **Reason codes.** They are required and must match `[a-z0-9_]`.
- **Status.** It reports the controller, the open maintenance windows and the
  unresolved TT work by family.
- **Errors.** Controller, window and option refusals are printed as they are; any
  other failure is sanitized.
- **Output.** Status JSON only.

## Rehearsal

`test-rehearsal.mjs` rehearses the controller, admission, maintenance and publication
sequence on a fresh local database with real tools:

1. A baseline reconcile on the pinned runtime, with a late arrival captured.
2. Arm, after the tool refuses a missing or wrong expected phase and bad options.
   Real application work is then admitted: one live, one to be parked, one with a
   short lease.
3. Drain. New work is refused. The expired work is reported as stuck and retired,
   and seal is refused while live work is owned. The worker parks one item and
   proves incomplete work cannot finish, then explicitly parks the other.
   Drained, then seal, with parked work still parked.
4. Held maintenance: the pinned catch-up in its window, anchors in theirs. Reopen is
   refused while a window is open, then succeeds.
5. Publish while open, bound to its run. The post-cutover audit verifies everyone.
6. Rollback: drain, seal, disarm, undo the run, arm again. The audit still verifies.
7. Both active and expired publish windows block drain success and seal until
   explicitly closed; CLI exit status is 2 and closing twice is safe.

A public application is submitted in every phase, and all 12 are retained.

Without `20260928090000_person_maintenance_deferred.sql`, the rehearsal fails at
step 4. Seal allowed the parked work, but the catch-up window refused it
(`transition_unresolved`). The migration makes held windows count parked work as
resolved, like the controller.

```sh
node scripts/build-worker-lib.mjs
PSQL=/path/to/psql bash scripts/person-transition-cli/run-local-tests.sh PORT
PINNED_RUNNER_DIR=/path/to/c4d0e4e PSQL=/path/to/psql bash scripts/person-transition-cli/run-local-tests.sh PORT
```

The historical September 28 rehearsal passed 6/6 on both runtimes. September 30
review exposed two misleading-success cases: maintenance windows omitted from
drain status and an arbitrary completion failure swallowed as a defer. Two real
database regressions reproduced false drain success; the current eight tests
require explicit parking and matching CLI/database drain results. Both current
and frozen c4d0e4e runs pass 8/8 after the fixes. The combined chain also passes
504 cross-family tests, 48 SQL assertions, 11 publication checks, 10 maintenance
checks, 61 edit tests, 13 contact-read tests and TypeScript. These are local
synthetic tests; the prepared SQL has not been installed in production.

Not rehearsed:

- Application processing through the full pipeline. Work is claimed, parked and
  retired directly. Successful pipeline completion is not claimed.
- Section 4 of the runbook (worker canary and writer expansion), the anchor dry run,
  the full audit runner and finalize, and the write guard.
- Hosted Vercel or Actions traffic.
- Production.
