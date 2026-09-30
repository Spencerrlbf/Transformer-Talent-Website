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

## Starting the catch-up run

The window needs an already-running pinned checkpoint. Invoke the helper from the
reviewed release checkout, with an absolute clean Git checkout of the actual
`c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc` in `PINNED_RUNNER_DIR`:

```sh
# Credentials are already configured privately; do not place them on a command line.
# Run/recovery/capacity and no-conflicting-process gates must pass first.
PINNED_RUNNER_DIR=/absolute/pinned-checkout \
BACKFILL_CONFIG='{"reconcile":true,"run-id":"NEW_RUN","scope":"queue","limit":1000,"batch-size":100,"dry-run":false}' \
node scripts/person-maintenance/start-catchup.mjs
```

The helper verifies actual Git HEAD and a clean tracked tree independently of any
commit label, rebuilds the ignored worker bundle from that tree, and records its
hash. A source archive inside another checkout is refused. The pinned translators,
fingerprint algorithm and options remain unchanged; the helper uses a bounded
read-only directory connection using a verified Supabase direct/session endpoint
on port 5432 (transaction poolers and custom proxies are refused; loopback fixtures
are allowed), with a 10-second connect, 8-second server statement,
9-second client query limit and pinned REST transport. `max-seconds` is checked
after runtime preparation and again before creating the checkpoint; an expired
fingerprint cannot start a run. It does not cancel an in-flight fingerprint: its
individual queries retain the stated bounds. Existing run IDs and failed
DB-capacity checks are refused before fingerprint/start. Output contains run status
and hashes only; errors are sanitized and acquired resources are closed on failure.

After a successful start, open that run's window and use the actual pinned CLI with
the identical configuration plus `resume:true`. Inspect durable state after an
ambiguous start: absent means diagnose and start again after gates pass; a matching
running checkpoint means continue that run after opening its window, even if the
start response was lost. Failed/paused checkpoints need diagnosis and matching
configuration before resume. Finalized checkpoints stay closed. Never infer that
an initial fingerprint timeout created a run, and never duplicate an active run.

The September 30 helper change has 27 offline tests covering false commit labels,
privacy, acquisition cleanup, capacity refusal, existing checkpoints, lost responses, endpoint refusal and expiry before start. These use synthetic transports. The historical restored-copy rehearsal
reported on September 28 did not test this new helper. A live invocation and runtime
connection proof remain approval-gated release checks.

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
node --test scripts/person-maintenance/test-start-catchup*.mjs
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
