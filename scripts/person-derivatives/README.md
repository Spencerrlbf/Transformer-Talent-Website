# Canonical candidate derivatives

`lib/server/person/derivatives.ts` queues all three managed chunk sources from
the checked published profile and retained candidate resume. Only live intake
transactions enqueue work. Backfill and shadow updates do not enqueue it.

The server and refresh worker share durable ten-minute claims, three attempts
per content generation, and a 90-second embedding request deadline. New text
invalidates an old claim; a contact-only revision can rebase an otherwise exact
result. Expired third attempts become review items. An unchanged enqueue cannot
reset this budget. No configured key leaves work pending without an attempt.

Each request has at most 18 inputs, six per source, each at most 2,800 characters
and 7,500 UTF-8 bytes. Responses must match the model, all indices and 1,536 finite
dimensions. Vector generation happens outside transactions. Replacement verifies
the claim and complete canonical text again, then removes obsolete managed chunks
and inserts new chunks in one transaction. Empty canonical sources remove their
old chunks; cached identical chunks keep their IDs. Failure retains the old set.

An application processes only its candidate. Each refresh invocation drains at
most 50 pending/expired jobs, even when there are no Harvest rows. This is future
operational work, never part of the historical migration.

Run with a disposable **local** Postgres 15+ with pgvector:

```sh
node scripts/build-worker-lib.mjs
PSQL=/path/to/psql bash scripts/person-derivatives/run-local-tests.sh 55487
```

The script recreates only `person_derivative_test`. Tests use synthetic profiles,
real transactions and a sealed fake embedding endpoint. No paid API request runs.
Run intake, refresh and directory suites for caller regression coverage.

Activation requires applying the prepared migration and draining older deployed
REST embedding writers before turning on the normalized live path. Those older
writers cannot honor the new transaction fences. Public intake remains accepted
and durably queued/captured throughout the deployment transition.
