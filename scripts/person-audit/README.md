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

## Verified legacy anchor preparation

The next prepared migration, `20260926080238_person_audit_anchor_preparation`,
adds bounded snapshot/commit RPCs and an immutable auxiliary-source proof.
`prepareLegacyAuditAnchor` uses the unchanged legacy translator. A source must
match its existing identity, original date, parser, metadata and actual content
hash. SQL validates the exact hash envelope before recording the anchor.

The latest historical reconciliation record must be counted and verified at
the current revision/capture boundary, with successful integrity/external
checks. This release accepts only the reviewed historical runtime commit
`c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc`. A newer pending/review result cannot
fall back to an older success. Existing publications, normalized receipts and
unresolved source holds require review instead of retrospective anchoring.

After prerequisites are installed and the historical pass has verified the
person's boundary, configure the website project's server-only
`PERSON_DATABASE_URL` (also required for the normalized app writers):

```sh
node scripts/build-worker-lib.mjs
node scripts/person-audit-anchors.mjs --limit=1000 --batch=20
node scripts/person-audit-anchors.mjs --save --limit=1000 --batch=20
# Resume from the last complete checkpoint's UUID:
node scripts/person-audit-anchors.mjs --save --after=UUID --limit=1000 --batch=20
```

The default is read-only. A dedicated PostgreSQL connection arms a 15-second
statement timeout before every RPC; the RPCs reject unbounded callers. REST
request cancellation is not used as a database execution bound. Tests use a
localhost-only `LOCAL_DATABASE_URL`. Missing connection configuration stops
preparation. Logs contain counts/cursors, never raw documents.
Review items still advance the scan; recording uses batches of at most 10.
Capacity checks stop at the configured byte cap, more than five blocked
sessions, or three metric probes above twice the initial median latency
(with a 250ms floor).
A failure leaves the previous complete checkpoint available, and committed
anchors are immutable/idempotent. Rerun without `--after` to revisit earlier
review or pending items after their evidence has been resolved. `scan_complete`
only means this scan reached its end; it does not certify migration completion.

Legacy/v2 emails and relevant website outreach outcomes are bounded at 1,000
rows per person; overflow requires review. The frozen document retains their
facts, and hashes retain the observed input boundary. The v2 reread proves an
observed snapshot, not stability through commit: a later external edit must be
reported by the subsequent writer guard/auditor. The preparation command never
writes or locks external tables, rewrites candidate facts, calls `save_person`,
or clears historical capture/acknowledgement state.

Caller guard/attribution integration and the separate post-cutover auditor
remain required before activating normalized writers. This migration and the
anchor pass have not been applied to production by preparing these files.
