# Prepared application audit authority

Migration `20260927025000_person_application_proof.sql` remains uninstalled.
Claimed application intake now obtains its audit operation from PostgreSQL.
The database derives the work, candidate, receipt reference, anchor, current
capture boundary and auxiliary proof. Caller-authored checkpoint JSON cannot
authorize an earlier unattributed edit.

Legacy anchors receive private certification only when the existing bounded
anchor RPC actually creates a checked anchor. An unchanged public anchor without
certification is rejected; this migration does not bless preexisting anchors.
New applicant anchors derive from the same-transaction minimal seed event and
bound immutable receipt. Later writes also recheck the original creation event
and the creating application's current TT ownership.

The bounded chain begins at the certified anchor or a database-verified private
operation checkpoint. Attribution requires exact active work, candidate, receipt,
transaction and scope, and an event after that operation's captured boundary.
The proved creation event is the sole earlier-event exception. Clearing credentials
cannot turn a privately owned operation into a legacy operation. Lease checks run
again after contested locks.

Private synchronous markers protect genuine capture, epoch and source-hold inserts.
Their trigger origins and execution privileges are restricted. Internal AFTER
triggers acquire no new controller/work locks. Source BEFORE STATEMENT hooks take
the controller gate before row locks; those hooks alone do not authorize source
writes. Raw proof inserts, rewrites, deletion and reconciliation fail when guarded,
including ordinary direct PostgreSQL connections. Service ACLs provide another
layer. TRUNCATE is always rejected for proof, hold and normalized tables; application
paths have no legitimate TRUNCATE operation.

With enforcement off and no work context, existing application audit paths and
historical reconciliation remain available. Reconciliation retains only its
required capture `reconciled_at` update and queue deletion privileges. Genuine
source-date holds still originate from their private capture triggers.

This child does **not** authorize candidate/projection/source/derivative changes
or complete a drain. Typed candidate and projection operations, conflict writes,
other writer families, maintenance admission and isolated system canaries are
still required. Application credentials cannot resolve source holds. Activation
and production installation remain subject to the release gate.

```sh
PSQL=/path/to/psql bash scripts/person-application-proof/run-local-tests.sh LOCAL_PORT
```

The harness resets only loopback `person_application_proof_test` and uses actual
claimed intake with synthetic provider responses. Its 34 tests cover forged and
uncertified proof, credential removal, owner/service DML and TRUNCATE, event ordering,
creator transfers, concurrent controller/candidate locks, lease expiry, long history
and failure cleanup. Related suites cover 24 normalization checks, 32 claimed
intake/ownership, 125 legacy writers, 85 audit checks and 15 isolated canary checks.
