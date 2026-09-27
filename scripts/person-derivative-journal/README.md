# Checked derivative job history

Prepared only. This migration records each authorized application, directory or
refresh enqueue as an immutable before/after certificate and advances a candidate
head in the same transaction. It does not enable derivative consumption or paid
requests. The later consumer must establish its own request and provider proof.

The current producer context supplies authority even when its application work is
still active. Certificates retain immutable work identity; later lease/token and
outcome changes do not rewrite history. Appends use existing candidate/job locks,
then the head, without locking another producer's work. Exact readback and deferred
checks cover the appended entry and the latest public job independently, allowing
multiple legitimate appends in one transaction. Both temporary authority frames
must be removed before return and commit; suppressed cleanup rolls back the producer.

A missing head with retained history is an error. Owned jobs remain protected when
the controller is disabled, including candidate-ID changes and head loss. Genesis
can preserve an existing legacy job as an untrusted before-image; its old consumer
token or attempt history is not proof of an admitted consumer or a known paid result.

Run from the repository root against disposable loopback Postgres with pgvector:

```sh
PSQL=/path/to/psql bash scripts/person-derivative-journal/run-local-tests.sh 55487
```

This resets only the `person_directory_worker_test` fixture database. It runs the
existing cross-family chain, new journal fault/concurrency/lease tests and SQL
normalizer regressions. The missing-head test deliberately damages and restores a
synthetic private head with privileged fixture access. No production or provider
request is used. Hosted tenancy must wait until the active full-source scan and
its database work have stopped.
