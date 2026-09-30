# Certified directory worker

Prepared only. Keep production flags off until the complete migration and release
are approved. Migration `20260927200000` adds a private current-result reader; it
is not installed by this test runner anywhere except its local fixture database.

With transition support on and normalized write mode selected, the worker uses the
certified directory save. It verifies the actual input, latest private completion
head, work/admission evidence and retained normalized or outcome proof before
skipping completed input. Promotion uses the completed execution's mode: a newly
created shadow person already has projected fields but still requires live work.
The old direct save and embedding-consumer entry points remain blocked under
support-on. Main reports derivative work deferred and makes no paid API calls.

The worker keeps one execution UUID and result per receipt within an invocation.
Recovery and source-page overlap therefore cannot process the same review twice.
A different source receipt can still be staged and processed within the existing
three-attempt bound. Failures leave the cursor before the failed contact. After
process death, normalized completion is verified and skipped; reviewed/suppressed
inputs may be reconsidered once under a new UUID. Receipt and candidate IDs remain
stable. Support-off legacy behavior and paid-work caps are retained.

Run all prepared and legacy regressions on PostgreSQL 15:

```sh
PSQL=/path/to/psql bash scripts/person-directory-worker/run-local-tests.sh PORT
```

Only loopback `person_directory_worker_test` is reset. The suite includes actual
CLI execution against synthetic local communications tables, with HTTP blocked,
plus receipt corruption, real recovery, changed-source overlap, expired scan leases,
response/checkpoint loss, dry runs, held scans and created-shadow promotion.
