# Operator maintenance windows

Prepared only. `20260928030000_person_maintenance_window.sql` lets two runbook steps
write while the transition controller is armed and **held**, when every other TT
writer is stopped:

| Step | What it admits | Bound to |
|---|---|---|
| `catchup` | The historical reconcile runner's existing RPCs: `person_backfill_save(_many)`, `person_backfill_audit_many`, `person_reconcile_record_many`, including their saves, missing-employer flags, captured-event marking and queue draining | One exact run ID, which must already be a running reconcile run pinned to `c4d0e4e` |
| `anchors` | `person_audit_anchor_commit` from the anchor CLI | Any caller while the window is open |

The pinned runtime (`c4d0e4e`) needs no change: the RPCs keep their public signatures
and open a frame only while their run's window is active. A window opens no raw table
writes. Direct `save_person`, raw candidate, conflict, captured-event and source-hold
writes stay refused, and other families gain nothing.

Publication, undo and source-hold resolution are **not** admitted here.

## Rules

- The entry points run with owner rights. No maintenance helper or private core is
  executable by any API role, so a session cannot open a frame except through those
  RPCs.
- The run ID is a label that the service role can read. While a catch-up window is
  open, any service-role client can do exactly what the runner can do for that run:
  save documents with the run's parser version and record reconcile evidence. Keep
  windows short, start the run immediately and close the window when it finishes.
- With the controller armed but not held, the four catch-up RPCs are now refused
  (`maintenance_requires_held`) before their own checks. That includes recording
  `pending` or `review` outcomes. The historical runner must not run outside a window.

- `maintenance_open(step, run, minutes, revision, generation, reason)` and
  `maintenance_close(work_id, reason)` are operator-only: no API role can execute
  them. Opening requires the controller to be enabled and `held`, with no
  unresolved TT work, so only one window exists at a time. The window's lifetime is
  1 to 240 minutes.
- Each window is a `maintenance` row in `transition_work`. While it is open or
  expired, `seal`, `reopen` and `disarm` are refused (`transition_unresolved`), so
  the controller cannot reopen with a window pending. Close it explicitly.
- An expired window admits nothing. Reopening generations make old windows stale.
- Maintenance work rows can be created or changed only by open and close. Forged
  inserts, public claims, renewals and finishes are refused.
- Every open and close is recorded in the append-only `maintenance_events`.
- With the controller disabled, all four RPCs behave exactly as before.

## Operator sequence (from a direct session, `PERSON_PUBLISH_DATABASE_URL`)

```sql
select person_transition_status();                       -- note revision, generation
select person_private.maintenance_open('catchup','RUN_ID',120,REV,GEN,'final_catchup');
-- dispatch the pinned catch-up for RUN_ID; resume the same run if needed
select person_private.maintenance_close('WORK_ID','final_catchup_done');
select person_private.maintenance_open('anchors','anchors-DATE',120,REV,GEN,'prepare_anchors');
-- node scripts/person-audit-anchors.mjs --save ...
select person_private.maintenance_close('WORK_ID','anchors_done');
```

Legacy edits made after the baseline still reconcile as `same_snapshot_mutation`
reviews under the runner's own rule. The window does not change that outcome.

## Verification

```sh
node scripts/build-worker-lib.mjs
PSQL=/path/to/psql bash scripts/person-maintenance/run-local-tests.sh PORT
# Same tests with the frozen runner code: a checkout of c4d0e4e with its worker lib built
PINNED_RUNNER_DIR=/path/to/c4d0e4e-checkout PSQL=/path/to/psql bash scripts/person-maintenance/run-local-tests.sh PORT
```

Resets only the loopback `person_maintenance_test` database. On 2026-09-28, after an independent review, all 10
tests passed with the current runner and with the c4d0e4e runner. They cover:
disabled behavior, refusal without a window, run binding, forged work and API
roles, the full catch-up inside a window, anchors, expiry, refusal after reopening,
append-only history and disarm. The cross-family suite
(`scripts/person-derivative-journal/run-local-tests.sh`, now installing this
migration) passed 504/504. A test proves the service role cannot reach the helpers
(it fails when the pre-review grants are restored). Untested: concurrent close or
`transition_set` against an in-flight frame, and expiry in the middle of one RPC. No production database or hosted preview was used.
