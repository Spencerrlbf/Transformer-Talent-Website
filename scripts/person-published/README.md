# Published profile checks

Build the worker bundle, then run against a disposable local PostgreSQL server:

```sh
node scripts/build-worker-lib.mjs
PSQL=/path/to/psql bash scripts/person-published/run-local-tests.sh 55487
```

Only `person_published_test` is recreated. Tests reject remote database URLs and
seal REST requests to synthetic fixtures. They cover checked publication hashes
and revisions, provenance holds, concurrent reads, explicit empties, employment
dates, actual drawer/Network/Send paths, recipient precedence and tenant access.
No enrichment, email or production HTTP requests are made.
