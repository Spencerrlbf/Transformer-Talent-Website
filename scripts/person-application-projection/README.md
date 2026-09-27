# Prepared application projection

`20260927035000_person_application_projection.sql` remains uninstalled. It moves
claimed applications' compatibility profile, attribution, recovery history and
projection state into one synchronous database operation. Other writers retain
the existing path with the controller disabled and no work credentials.

The operation derives candidate ownership from active private work and audit
mappings, requires the immutable receipt's normalized source/identity witnesses,
and checks the expected normalized revision. It locks the candidate and compares
the exact typed before-image. A fresh database audit operation rechecks the full
chain, source holds and auxiliary proof, including for unchanged projections.
The original operation still owns later application finalization/preferences.

The server remains responsible for the reviewed compatibility and semantic
transformations. It supplies canonical serialized before/after/fallback envelopes;
PostgreSQL validates the fixed compatibility fields against actual typed values
and hashes the selected bytes using the existing SHA256 contract. Semantic
transformation metadata never authorizes a mutation or determines whether history
is needed. Inputs and each serialized envelope have explicit size limits.

Email ownership is checked inside the operation. Only an actual candidate-email
unique constraint invokes fallback; that failed attempt and its captured event
roll back together. The fallback can change only email, retaining the incumbent
or clearing an invalidated value. Actual values determine changed fields and
history. Conflict ownership and stored revisions come from the database.

A private synchronous frame protects profile UPDATEs and projection proof DML.
Frames cannot be opened by service callers or reused after return; failures roll
back all effects. This child does not fence candidate seed INSERT/DELETE, other
candidate fields, source rows, derivative jobs or conflicts outside this helper.
Other writer families, maintenance, complete canaries and drain coverage remain
required before activation. No production projection or guard is authorized here.
The extra audit operation consumes existing bounded snapshot capacity; overflow
continues to require review.

```sh
PSQL=/path/to/psql bash scripts/person-application-projection/run-local-tests.sh LOCAL_PORT
```

The loopback harness owns only `person_application_projection_test`. Its 31 checks
cover actual new/existing/replay intake, exact hashes, raw DML protection, stale
and malformed input, partial receipt application, unchanged validation, rollback,
real uniqueness/state lock waits, expired work, and usable/invalidated email
fallback. Provider responses are synthetic and outbound network calls are blocked.
Related checks cover 32 claimed intake/ownership, 24 normalization, 34 audit proof,
85 auditor, 15 local canary and 125 legacy writer/UI regressions plus the Next build.
