# Post-cutover audit evidence (prepared)

This stage supplies the evidence schema for a separate future audit. It does
not enable a writer, prepare existing-person anchors, run an audit, change a
historical checkpoint, or certify migration completion.

`person_audit_anchors` will freeze the proven original legacy document and
candidate before-image. Receipt-created people have no invented legacy source.
`person_audit_operations` and `person_change_attributions` bind a covered change
to an explicit writer operation and the actual captured event. Attribution
checks candidate, table, transaction, operation and allowed field changes.
Application finalization also binds the application's receipt reference.

Future events gain their PostgreSQL transaction identity. Existing events stay
NULL: this migration cannot retrospectively assign them to a writer.

`person_audit_epochs` holds append-only markers for semantic candidate or
directory-contact changes. The future auditor counts committed markers instead
of using the highest sequence or transaction ID: a lower transaction can commit
after a higher one. Per-transaction scope deduplication avoids a shared counter
lock. Receipt-only changes take the existing capture gate; directory staging is
visible even before a candidate is assigned. Leases, attempts and derivative
bookkeeping do not renew evidence. Markers must never be deleted or reset.

All tables use RLS and exclude client roles. The service role receives only
SELECT and INSERT; default UPDATE, DELETE and TRUNCATE grants are removed.
Append-only triggers also reject accidental privileged rewrites.

Run against disposable local PostgreSQL 15+ with pgvector:

```sh
node scripts/build-worker-lib.mjs
PSQL=/path/to/psql bash scripts/person-audit/run-local-tests.sh 55487
```

The runner recreates only `person_audit_test`, checks the evidence schema, then
runs all four existing candidate-writer transaction suites against it. Fixtures
are synthetic; no external calls or paid enrichment run.

Before activation, the next stages must prepare verified anchors, integrate
writer guards/attribution, and implement the separate bounded audit with record
and finalization fences. Historical source holds, missing owner documents,
unexplained legacy edits and unresolved directory components must remain review
items. The existing historical reconciler cannot certify projected rows as new
legacy evidence. Main merge and live activation remain subject to approval.
