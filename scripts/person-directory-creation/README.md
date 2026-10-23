# Prepared directory creation

The certified directory writer can create a candidate when the receipt has a
canonical LinkedIn identity with no existing owner. The minimal seed, original
INSERT, audit anchor, normalization, compatible profile, producer work and receipt
completion commit together. Failed work leaves no candidate; response-loss retries
retain the original candidate ID and result. Application and directory intakes
share identity locks and recheck ownership after waiting.

New people retain the existing directory behavior in shadow mode: their initial
compatible profile and matching-text work are saved. Chunk jobs are queued only
in live mode. A later live execution can promote the same certified shadow receipt
without recreating the person or changing its original creator. Later receipts
report `created: false`. Suppression, missing LinkedIn and conflicting identities
cannot create a person through this capability.

The creator proof validates the exact seed, anchor, operation guard and INSERT
attribution. Later application/directory writers reject missing or altered proof.
Transaction-local ISO date output protects source dates from pooled connection
settings. No source parser or chronology policy changes.

Migration `20260927160000` is **prepared only, not installed in production**.
Main, feature flags, nightly worker routing and derivative consumers remain held.
Suppression/review outcomes and the remaining writer families are separate release
prerequisites. Private creation functions are unavailable to browser/service roles.

Run on a caller-owned PostgreSQL 15 loopback instance:

```sh
PSQL=/path/to/psql bash scripts/person-directory-creation/run-local-tests.sh PORT
```

This resets only `person_directory_creation_test` and checks the complete prepared
chain, legacy behavior, both identity race orders, failure rollback, immutable
replays, shadow promotion, chronology reviews, exact creator proofs, and real
application/directory audit compatibility without external provider calls.
