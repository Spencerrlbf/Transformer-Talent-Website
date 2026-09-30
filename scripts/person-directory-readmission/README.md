# Certified directory reconsideration

Prepared migration `20260927190000` lets a new execution UUID reconsider a reviewed
or suppressed receipt after eligibility changes. It retains the original source
snapshot, hash and capture time, preserves attempts, and keeps every completed
UUID's original result. It does not enable the nightly worker or install anything
in production.

A private receipt head records the most recent completed execution. Admission must
match that head and its complete saved receipt; it cannot select an older matching
result. Completion advances the head with an exact compare-and-swap. Historical
outcome and suppression evidence are checked using their original observations and
events, without requiring the candidate's current state to equal that history.
Every completion rechecks the immediate predecessor's outcome proof and sealed
admission row. These checks have bounded depth even after repeated reviews.

Reconsideration resets processing fields only, inside the saving transaction. Any
failure restores the previous completed receipt. A superseded receipt cannot
reenter. A completed normalized receipt can only use the existing genuine shadow
to live promotion path. The global hold still blocks new executions; historical
UUID replay remains available.

Install this prepared chain before activating any certified directory writer. The
migration refuses existing completed directory history because its authoritative
head must not be inferred from timestamps. Adding execution columns later requires
an explicit compatibility plan: the head hash seals the complete execution row.
The private tables and helpers have no browser or service-role privileges.

Run the isolated PostgreSQL 15 fixture suite:

```sh
PSQL=/path/to/psql bash scripts/person-directory-readmission/run-local-tests.sh PORT
```

The runner resets only `person_directory_readmission_test` on loopback. It exercises
the complete prepared chain, resolved holds/state/identity/linkage, real application
admission followed by suppression, concurrent UUIDs, lease expiry during actual
row waits, altered heads and retained proofs, and rollback through commit. It also
runs the existing legacy directory and normalized writer regressions.
