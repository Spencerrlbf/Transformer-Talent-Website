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

## Independent review (2026-09-28)

No blockers: no double spend, no spend without an admitted claim, no claim committed
without its seal, lock order consistent with the producer. Fixed after review:

- Vectors stored while the lease is live are no longer rolled back if the commit
  lands after the lease passes (test: "vectors stored before the lease passes survive
  a commit that lands after it"; it fails without the fix).
- A claim returns `busy` while an earlier paid result for the candidate is unknown,
  instead of consuming one of its three attempts.
- Reusable retained vectors are validated once per claim instead of once per part.
- The three text patches of earlier functions now fail if they no longer match.

Known limits, deliberately kept:

- A job whose first journal entry shows legacy paid history (`processing`, or
  attempts above zero and not done) stays in `review`; it cannot authorize another
  paid start. `person_derivative_jobs` does not exist in production yet, so no such
  history exists at installation.
- Lifecycles are never pruned; each retained lifecycle adds validation work to a
  claim for that candidate.
- If `PERSON_TRANSITION_SUPPORT` were switched off after candidates were journaled
  (a rollback), the legacy drain can starve on journaled jobs (fence from #68). The
  rollback procedure must account for this.
- Untested: two concurrent provider starts for one request, consumer/producer
  deadlock under load, and refusal of start/store while `held`.

Still required before activation: a worker that calls these steps with a spend cap,
publication of the stored chunks, `matching_embedding` handling, and the canary.

## Verification

```sh
node scripts/build-worker-lib.mjs
PSQL=/path/to/psql bash scripts/person-derivative-lifecycle/run-local-tests.sh PORT
```

Resets only the loopback `person_directory_worker_test` database. On 2026-09-28 at
commit `feat/person-67-derivative-lifecycle` it passed all suites the harness runs
(528 tests, including 21 lifecycle tests, after the review fixes) and `tsc --noEmit`. No provider call,
production database or hosted preview was used.
