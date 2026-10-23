# Public application acceptance and TT source fence (prepared only)

Migration `20260927080000_person_application_acceptance.sql` follows atomic
completion `20260927070000`. It is uninstalled and must not be activated as a
partial release. `PERSON_TRANSITION_SUPPORT` remains off until approval.

Apply, referral and future-interest routes use one service-only acceptance RPC
when support is on. It accepts bounded submitted inputs; SQL owns the ID, clock,
queued status, processing version and intent identity. Resume upload/hash happens
first. The RPC takes the controller before any identity/business lock. Acceptance
works in open, draining and held without work admission, review reservation or pool
writes. Exact private frames, AFTER checks and actual INSERT RETURNING prevent a
suppressed or changed insert from falsely acknowledging a submission.

Future retries compare canonical semantics with immutable intent journals and
lock the still-owned current application. Deleted, transferred or repurposed rows
cannot suppress a new submission. An occupied historical hash receives a new
DB-generated intent identity; old rows and journals stay intact. Prior TypeScript
hashes remain recognizable. Duplicate responses have `inserted:false,id:null`,
with no callback, update or new journal entry. The original timestamp is chosen
under the username lock and survives the future journal trigger.

The TT source fence covers OLD and NEW ownership, all rows including unlinked
queued input, inserts, edits, deletes and truncation. Checked finalization and
atomic completion use their existing exact private frames. Row guards take no
controller/work/identity locks. The existing statement gate runs even disabled,
so controller arm cannot overtake a legacy write. Stale isolation cannot authorize
an armed TT write. Truncation is always refused once this prepared guard is installed.

Unsupported TT application contact/resume/follow-up/add-role and TT-target Send
edits return retryable 503 before uploads or external/mirrored writes while
support and enforcement are on. Database guards remain authoritative after a
preflight race. Disabled legacy behavior and tenant product writers remain
compatible; tenant admitted processing continues while TT is held. This is **not**
a table-wide tenant writer fence. Client-target Send, other source writers,
derivatives, maintenance and complete worker canaries remain release prerequisites.

The SQL username validator contains generated Unicode 16.0 ranges matching the
existing JavaScript `L/N/M/._-` predicate, including combining marks and astral
letters/numbers. `unicode-ranges.mjs` records the runtime's Unicode version;
regenerate deliberately alongside parser changes, not during deployment.

Run the isolated loopback suite (resets only `person_application_acceptance_test`):

```sh
PSQL=/opt/homebrew/opt/postgresql@15/bin/psql bash scripts/person-application-acceptance/run-local-tests.sh 55487
```

The suite covers raw/injected writes, actual-row suppression, duplicate and
controller races in both lock orders, stale snapshots, Unicode boundaries, legacy
hashes, tenant completion while held, seven real TT intake/auditor cases including
hold/reopen and drain completion, and ten actual editor/Send route checks. The public
route/pipeline regressions remain in `scripts/person-application-queue/`.
Provider/network effects are synthetic; no candidate messages or paid calls occur.
