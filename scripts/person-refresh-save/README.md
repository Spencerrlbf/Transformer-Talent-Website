# Certified refresh atomic save

Prepared only: no worker routing, paid provider calls, production migration install,
or transition activation. This completes a source-backed certified lifecycle in one
transaction through normalization, audit, optional live projection/metadata/derivative
queueing, and checked queue/attempt/work completion. Shadow saves leave the serving
candidate unchanged. Failed saves retain the previously committed source for free retry.

The original request/token and first save mode bind replay. Completed requests return
their historical result after subsequent legitimate writers; shadow facts require a new
live request or the release publisher to publish. The public audit receipt keeps the
existing `refresh:<queueId>` format, with request/work binding in private certificates.

Current-transaction completion verifies retained normalization/source, projection
state/history, candidate, derivative job and attribution evidence, empty mutation
frames, and an unexpired lease. Historical replay checks immutable evidence without
requiring the current candidate or derivative row to equal an old result.

Run only against the disposable loopback databases named by these scripts:

```sh
PSQL=/opt/homebrew/opt/postgresql@15/bin/psql bash scripts/person-refresh-save/run-local-tests.sh 55487
PSQL=/opt/homebrew/opt/postgresql@15/bin/psql bash scripts/person-refresh-lifecycle/run-local-tests.sh 55487
PSQL=/opt/homebrew/opt/postgresql@15/bin/psql bash scripts/person-directory-worker/run-local-tests.sh 55487
```

The first suite covers 68 persistence, rollback, fault-injection, replay, source,
lease, ACL and nested-frame cases. The lifecycle suite covers 70 legacy/certified
refresh and entry checks. The directory runner applies this migration and includes
484 Node checks plus 48 SQL checks, including real application→refresh→directory
compatibility, receipt-created candidates and identical UUIDs in different families.
All provider work in fixtures is synthetic; no external HTTP or paid calls are needed.
