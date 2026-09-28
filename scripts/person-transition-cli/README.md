# Transition controller CLI and cutover rehearsal

`scripts/person-transition.mjs` is the operator tool for the transition controller
and the maintenance windows. It runs from a direct website session
(`PERSON_PUBLISH_DATABASE_URL`, port 5432; transaction poolers are refused).

```sh
node scripts/person-transition.mjs --status
node scripts/person-transition.mjs --arm --reason=cutover_arm
node scripts/person-transition.mjs --drain --reason=cutover_drain
node scripts/person-transition.mjs --wait-drained --max-seconds=600
node scripts/person-transition.mjs --seal --reason=cutover_seal
node scripts/person-transition.mjs --open-window=catchup --run=RUN --minutes=120 --reason=final_catchup
node scripts/person-transition.mjs --close-window=WORK_ID --reason=catchup_done
node scripts/person-transition.mjs --reopen --reason=cutover_reopen
node scripts/person-transition.mjs --open-window=publish --run=RUN --minutes=720 --reason=publish_all
```

- **Staleness.** Every change reads the current revision and generation first, so a
  stale view is refused.
- **Reason codes.** They are required and must match `[a-z0-9_]`.
- **Status.** It reports the controller, the open maintenance windows and the
  unresolved TT work by family.
- **Errors.** Controller and window refusals, such as `transition_unresolved`, are
  printed as they are; any other failure is sanitized.
- **Output.** Status JSON only.

## Rehearsal

`test-rehearsal.mjs` walks the whole cutover on a fresh local database with the
real tools:

1. A baseline reconcile on the pinned runtime, with a late arrival captured.
2. Arm.
3. Drain, wait until drained, then seal.
4. Held maintenance: the pinned catch-up in its window, anchors in theirs. Reopen is
   refused while a window is open, then succeeds.
5. Publish while open, bound to its run. The post-cutover audit verifies everyone.
6. Rollback: drain, seal, disarm, undo the run, arm again. The audit still verifies.

A public application is submitted in every phase and all are retained. Held
submissions stay `queued`.

```sh
node scripts/build-worker-lib.mjs
PSQL=/path/to/psql bash scripts/person-transition-cli/run-local-tests.sh PORT
PINNED_RUNNER_DIR=/path/to/c4d0e4e PSQL=/path/to/psql bash scripts/person-transition-cli/run-local-tests.sh PORT
```

On 2026-09-29, the rehearsal passed 6/6 with the current runner and 6/6 with the c4d0e4e runner.

Not rehearsed:

- Application processing through the pipeline. Its drain behavior is covered by
  the application suites.
- Hosted Vercel or Actions traffic.
- Production.
