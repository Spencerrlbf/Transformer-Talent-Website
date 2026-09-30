# Local application-admission rehearsal

This invokes the real TT application admission service on a disposable local
PostgreSQL database and always rolls back. A successful result verifies one fresh
synthetic application's receipt, candidate creation proof, initial compatibility
profile and precommit audit plan. It also runs the actual deferred attribution
guard. It is admission coverage, not a whole pipeline or production audit.

Run the isolated test harness (it resets only `person_canary_test` on loopback):

```sh
PSQL=/opt/homebrew/opt/postgresql@15/bin/psql bash scripts/person-canary/run-local-tests.sh 55487
```

The harness installs the prepared schema locally and tests transaction rollback,
normal writer behavior, scope violations, collisions, deferred guards and network
restrictions. It enables the profile guard only in that disposable database.
Afterward, run either process-local mode against those installed fixtures:

```sh
LOCAL_DATABASE_URL=postgresql://postgres@127.0.0.1:55487/person_canary_test node scripts/person-canary/rehearse.mjs --mode=shadow
LOCAL_DATABASE_URL=postgresql://postgres@127.0.0.1:55487/person_canary_test node scripts/person-canary/rehearse.mjs --mode=live
```

Both modes roll back. A new candidate gets an initial compatibility projection
in either mode; live additionally enqueues one pending derivative job inside the
rolled-back transaction. No derivative worker or paid provider is called.

The invocation accepts only this exact local database, refuses connection-query
overrides, and imports no environment-file loader. HTTP fetches and sockets to
anything except the chosen loopback database port are denied during rehearsal.
`--apply`, production targets and arbitrary source payloads are unsupported.
Fixtures contain only a generated TT application identity, header/contact and
synthetic resume text; no Harvest, embedding vector or shared lookup admission.

The admission service owns its transaction. Internal hooks prepare the fixture
after BEGIN and verify before COMMIT, then throw a private rollback sentinel.
An outer BEGIN around the normal service is not a rollback boundary because the
service commits itself. Normal callers do not pass these hooks.

Verification preserves every pre-existing table row, permits new rows only in
this exact candidate/application footprint, rejects shared lookup changes, and
checks rollback from a new database connection. These bounded whole-table reads
are suitable only for this small isolated fixture. They do not provide a bounded
production scope fence under concurrent writes. SQL timeouts remain eight seconds
for the rehearsal, with at most 1,000 rows per table, 10,000 rows and 8 MB total
per snapshot. Sequence counters may advance despite rollback, as usual in Postgres.

Before a website canary, implement and independently verify its bounded scope,
concurrency and load controls and obtain the release approval. The separate
public queue/drain transition remains unfinished; this rehearsal does not close
that release prerequisite.
