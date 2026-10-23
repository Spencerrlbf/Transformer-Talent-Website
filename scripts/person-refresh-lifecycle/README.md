# Prepared refresh lifecycle

Migration `20260927210000` and `lib/server/person/refresh-lifecycle.ts` retain a
refresh reservation, original cache evidence, one-shot provider start, and paid
response recovery. They do not normalize or publish a profile. The old refresh
worker remains blocked when transition support is on until atomic save is wired.
Do not install this restrictive migration on the shared database before release
approval and complete writer coverage.

A server-generated request UUID and token are required. Claim replay returns its
original result. Cached retries use the original ledger row and timestamp. Only
`startCertifiedRefreshProvider` returning `start` permits the single provider
request; any lost start response is uncertain and must never be retried as a new
paid request. Payload capture is allowed for that original paid token after
expiry and during draining. It preserves provider-start time and closes expired
work as a free retry. A genuinely new request UUID admits that retry. Candidate
IDs and serving profiles are unchanged by this module.

Unknown paid outcomes block transition sealing. A reservation that never started
can be released. Existing uncertified refresh attempts are refused for explicit
review; they are not silently adopted. Owned queue/attempt/source evidence stays
protected when the controller is disabled. Terminal history is archived in place.

The budget lock serializes refresh reservations against recorded Harvest misses
and outstanding refresh reservations. Application Harvest does not share this
lock, so this is not a global cap across concurrent application purchases.

Run only against the caller-owned loopback fixture PostgreSQL instance:

```sh
PSQL=/opt/homebrew/opt/postgresql@15/bin/psql \
  bash scripts/person-refresh-lifecycle/run-local-tests.sh 55487
```

The runner recreates only `person_refresh_lifecycle_test`. It checks legacy
refresh/CLI behavior before certified fixtures reserve budgets, then runs lifecycle,
lock-wait expiry, exact-write rollback, replay, tenancy, private ACL, empty payload,
shared application enrichment and pre-effect worker guard tests. No provider calls
or shared-database changes are made.
