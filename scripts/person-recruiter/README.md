# Recruiter contact checks

Run from the repository root with a disposable local PostgreSQL server. The
runner recreates only `person_recruiter_test`; never point it at a remote host.

```sh
node scripts/build-worker-lib.mjs
PSQL=/path/to/psql bash scripts/person-recruiter/run-local-tests.sh 55487
```

The PostgreSQL cases exercise real transactions, receipts, manual authority,
contact eligibility and RLS. The server cases use that local database and seal
all HTTP requests to synthetic fixtures; no production or paid requests occur.

The drawer test bundles the actual React component with synthetic child
components and HTTP responses. Install its runtime outside application
dependencies (use a React version matching the application lockfile):

```sh
npm install --prefix .superpowers/ui-runtime --no-save --package-lock=false react@19.2.8 react-test-renderer@19.2.8 esbuild@0.28.2
node --test scripts/person-recruiter/test-drawer.mjs
```

`UI_TEST_RUNTIME` may specify another private runtime directory. React's test
renderer deprecation notice is expected. The tests cover pending navigation,
late response bodies, overlapping saves and stable retry receipt IDs.
