# Checked derivative consumer lifecycle

Prepared only. `20260928020000_person_derivative_lifecycle.sql` adds the admitted
consumer that the producer journal (`20260928010000`) left missing: a separately
admitted claim, a single certified provider start, vector retention and recovery for
candidate embedding chunks. It does not call any provider, replace
`candidates.matching_embedding`, fan out enqueues or activate anything in production.

Library: `lib/server/person/derivative-lifecycle.ts` (bundled into the worker lib).

| Step | Function | Notes |
|---|---|---|
| Claim | `claimCertifiedDerivatives` | Requires `PERSON_TRANSITION_SUPPORT=on` and `allowPaid:true`; otherwise returns `disabled` before any query. Begin, canonical manifest and seal commit in one transaction or not at all. Replay returns the same claim. |
| Provider start | `startCertifiedDerivativesProvider` | Certified once per request; an unknown earlier paid request blocks another start. |
| Store vectors | `storeCertifiedDerivativeVectors` | At most 18 vectors of 1536 finite numbers. Late vectors after lease expiry are retained; replay returns the same result. |
| Recover | `recoverCertifiedDerivatives` | Captures a retained paid result without a new provider request. |

Held or draining transitions refuse fresh claims but let admitted recovery drain.
Generic work admission, finish and renewal cannot bypass the lifecycle. Legacy paid
history retained in producer genesis cannot authorize a new provider start. All new
tables and functions are private to `person_private` with no service-role grant.

Still required before activation: a worker that calls these steps with a spend cap,
publication of the stored chunks, `matching_embedding` handling, and the canary.

## Verification

```sh
node scripts/build-worker-lib.mjs
PSQL=/path/to/psql bash scripts/person-derivative-lifecycle/run-local-tests.sh PORT
```

Resets only the loopback `person_directory_worker_test` database. On 2026-09-28 at
commit `feat/person-67-derivative-lifecycle` it passed all suites the harness runs
(527 tests, including 20 lifecycle tests) and `tsc --noEmit`. No provider call,
production database or hosted preview was used.
