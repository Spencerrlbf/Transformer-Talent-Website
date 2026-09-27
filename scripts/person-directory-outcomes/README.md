# Prepared directory outcomes

The certified writer completes nonmutating reviews, unknown-person suppression,
and supersession atomically. Its private proof retains the exact source input,
observed ownership/state, before/after receipt and original UUID result. Review
outcomes never claim an applied profile: directory state, candidates, normalized
facts and derivative work remain unchanged. Retries with the same UUID retain
that result, including while the controller is held.

Preserved ordering: superseded, identity conflict, unknown suppression, unknown
missing LinkedIn, linkage conflict, then missing normalized state or source hold.
Migration 180000 separately adds existing-person suppression with an exact status
and event witness; this 170000 slice alone keeps it unavailable. Completed review/suppression
re-admission with a new UUID must be implemented before worker activation; this
child deliberately refuses it. A genuinely newer certified receipt can proceed
without treating a prior outcome as document evidence. Invariant failures remain
errors, rather than being acknowledged as reviews.

Migration `20260927170000` is **prepared only, not installed in production**.
Its nonunique `lower(linkedin_username)` index preserves mixed-case legacy owner
matching. The ordinary index build takes a write-blocking lock until the migration
transaction commits. Its two-second lock and 30-second statement timeouts bound
the operation; they do not make it online. Release must choose an approved quiet
window or prepare and validate a separate concurrent-index installation before
applying this chain. The index-plan test demonstrates an available indexed access
path; it does not measure default-planner throughput across the production pool.

Main, flags, worker routing and derivative consumers remain held. Private outcome
functions/tables are inaccessible to browser and service roles.

Run on a caller-owned PostgreSQL 15 loopback instance with `auto_explain`:

```sh
PSQL=/path/to/psql bash scripts/person-directory-outcomes/run-local-tests.sh PORT
```

This resets only `person_directory_outcomes_test`. Tests cover the full prepared
chain, legacy behavior, exact outcomes, unchanged profiles/state, proof failure
rollback, immutable retries, actual lock waits and expiry, mixed-case ownership,
and indexed owner resolution without external provider calls.
