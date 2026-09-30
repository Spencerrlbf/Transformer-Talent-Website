# Prepared atomic application completion

`20260927070000_person_application_completion.sql` is a release dependency;
it is not installed in production. It replaces mutable processed-status trust
with a checked result write and private completion witness in one transaction.

The claimed pipeline stages one result in its trusted async context. Only after
the process and existing best-effort mirrors return does the wrapper renew and
call `person_application_work_complete`. Tenant extracted contacts join that
transaction; claimed processing no longer PATCHes contact or result fields.
Support-off callers retain their existing profile-before-contact ordering.

The RPC derives scope from admitted work, consumes an existing tenant identity
binding or TT intake readiness, and validates exact retained input. TT profile
results come from the immutable receipt; current resolved name/contact and newer
preferences are preserved. Historical readiness uses its original immutable
references rather than today's candidate revision or transaction ID.

Tenant contacts merge against locked application and same-company sourced rows.
A curated phone on either half wins. At most one new email is appended below the
eight-address cap, excluding known/primary addresses without regard to case.
Existing keys and over-cap lists remain intact. Only the application is changed.
General sourced-row insert coordination remains a later release prerequisite.

Results have bounded typed envelopes: TT matches allow ten site/TT role IDs,
tenants five company role IDs, and screening allows five verdicts with checked
answer, signal and scorecard structures. Cache-only facts/origin metadata stays
out of this envelope. No payload can choose candidate, application or company IDs,
status, preferences, resume storage identity or pool-created state.

Private exact OLD/NEW frames and UPDATE RETURNING check the actual saved result,
including resume text. The private witness binds work/input/person and readiness
or tenant-binding proof to the actual result hash. Result, witness and completed
work commit together; expired leases, altered/suppressed updates and witness
failure roll back. Every completed claim/finish/replay requires the witness and
current company ownership. Lost responses cannot downgrade completed work or
relaunch providers. Historical replay does not overwrite later legitimate edits.

```sh
PSQL=/path/to/psql bash scripts/person-application-completion/run-local-tests.sh LOCAL_PORT
```

This resets only loopback `person_application_completion_test`. The 35 SQL,
five actual TT receipt/audit and six processing tests cover atomicity, missing
proof, cross-company claim races, actual lock waits, final lease expiry, suppressed
updates, role/contact validation, TT site matches and lost-response recovery.
The actual bundled pipeline cache-hit regression also exercises real screening
cache reads using synthetic HTTP responses. Full prepared-chain intake, readiness,
projection, normalization, audit, queue/public-route, legacy/UI, local canary and
build checks run separately. Test providers are mocked; no real messages or paid
requests are sent.

General acceptance/edit/delete/transfer fences, other writer families, derivative
admission, historical maintenance and whole-worker canary/drain integration remain
required before activation. This child does not install or enable any guard.
