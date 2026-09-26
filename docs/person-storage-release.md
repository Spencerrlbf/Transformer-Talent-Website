# Candidate storage release prerequisites

The application feature stays off until Spencer approves the parent feature PR.
The overnight backfill only populates normalized storage; existing candidate
fields continue serving the deployed application.

## Atomic writer

`savePerson(doc, { mode: 'shadow' | 'live' })` uses one PostgreSQL connection for
source persistence, normalized reads, the existing TypeScript `project()` and
compatibility writes. Shadow mode never changes candidate profile fields.
Live mode records protected before-images and a semantic hash. Neither mode
calls paid providers or enqueues embedding/judging work.

Configure `PERSON_DATABASE_URL` with the **website project's** server-only
transaction-pooler connection before enabling the application writer. Never use
the communications database URL. The Node pool is limited to two connections per
process and does not use named prepared statements. Supply the pooler's verified
TLS configuration in the connection string; TLS verification is not disabled by
this module. Keep this secret out of browser/public environment variables.

Apply the reviewed additive `20260926033900_person_atomic_projection.sql` before
using live mode. It creates storage for projection hashes and before-images and
does not project any candidate automatically. This migration is prepared in the
feature branch; its presence in Git does not mean it has been applied live.

The writer preserves engagement/source labels, workflow state, notes, curated
contact visibility and existing computed experience fields. It uses the same
`project()` calculation and source precedence already exercised by the trial.
Absent lists retain existing columns; explicitly owned empty lists clear them.
A legacy unique email collision retains the old compatibility address and adds a
review item rather than merging people. Newer unprojected legacy changes fail
closed and must be reconciled.

`undoPersonProjectionOnConnection` restores only the profile fields in its
before-image, after checking both the normalized revision and the current
profile hash. Workflow changes are preserved. A newer profile edit, later
normalized revision or email uniqueness conflict prevents restoration. Source
records and normalized facts are retained.

Before release, complete source catch-up and writer integration, run the whole
branch tests and preview tenancy test, verify connection/configuration on the
approved deployment, then perform a bounded live canary. Do not enable the
restrictive legacy-write guard until every active writer supports this path.

## Shadow backfill throughput

The backfill reads at most four REST responses concurrently, including their
response bodies. It saves at most ten people in one transaction and audits a
whole checked page before advancing its checkpoint. An exclusive database gate
keeps each short bulk transaction clear of other normalized writers; individual
writers take the shared gate first and can otherwise run concurrently. The
atomic application writer acquires that gate before its candidate lock too.

Migration `20260926040300_person_backfill_bulk.sql` installs this coordination
and the service-only batch RPCs without changing fact precedence or projecting
legacy candidate fields. Transient transport/lock failures get at most three
attempts with backoff. Integrity errors stop the run, and a lost committed
response can be replayed without incrementing the person's normalized revision.

## Reconciliation and final accounting

Dispatch the existing person-trial workflow at the reviewed commit with
`backfill` containing `reconcile: true`, an explicit run-id/limit/batch-size, and
`scope: all` for the full source scan. `scope: queue` drains captured writes and
pending normalized revisions; `scope: directory` is a bounded directory scan.
The dry-run default remains on. A complete, stable full scan is required before
a queue-only pass can establish global completion. Resumption retains the
original external-source boundary hash.

Every source is reread and checked against normalized storage. Exact sources
skip redundant saves. New dated sources go through the same writer; an altered
historical snapshot with no trustworthy newer fact date is recorded as
`review`, and its captured evidence stays pending. The runner never labels an
automated old-writer change as a recruiter edit, changes fact dates to force
precedence, or deletes event evidence. Older transient source snapshots are
also inspected so a contact added and removed during migration is not silently
forgotten. `person_reconcile_people` records the checked source hash, normalized
revision, capture version and result. `person_reconcile_pending` includes both
legacy changes and later normalized revisions.

The directory fingerprint covers translated facts; historical `_v2` emails are
read only. Matching observations at both scan boundaries are required. A changed
external source requires another scan. This is a migration checkpoint, not a
promise that outside systems will stop changing after it. Run final catch-up
again before the later approved application cutover.

A completed source scan pauses with `source_scan_complete` and an external
boundary result. Finalize locally using the already-linked website CLI project:

```sh
node scripts/person-reconcile-finalize.mjs --run-id=<run-id> --workdir=<linked-website-workdir>
```

This executes `SET LOCAL statement_timeout='8s'` before the finish statement.
Finish rejects an unbounded caller and briefly gates normalized/capture commits
while checking current queue and revision counts. A PostgreSQL function's own
`SET statement_timeout` does not arm a timer for the statement already running.
The final status is `reconciled`, `review_required`, or `catchup_pending`; a
source scan or baseline copy alone must never be reported as fully reconciled.

## Application intake preparation

`PERSON_WRITE_MODE` defaults to `legacy`. The `shadow` and `live` application
paths require the website's server-only `PERSON_DATABASE_URL`, the prepared
projection migration, and `20260926044800_person_application_intake.sql`.
Neither migration is applied and no intake flag is enabled by preparing code.
Review-queue Actions reads the same flag and DSN after an approved release.

Applications, referrals, future interest and queued retries share the same TT
pool helper. The helper verifies the application's organization and resolves
LinkedIn identity under a transaction lock; email is never an identity lookup.
Creation, all normalized documents, the application link and receipt commit
together. An existing person must already have normalized state before this
path can update them. Claimed public contact details cannot replace incumbent
contacts. Shadow leaves existing compatibility profiles alone; a newly created
person receives its initial usable profile in the creation transaction.

`person_application_receipts` keeps the creation decision, exact normalized
documents, original application snapshot and Harvest ledger reference. Retries
reuse those inputs. A new Harvest result is stored before later parsing;
cached results retain their original source date. Failures queue the retained
application for the existing review worker. Existing application review budgets
and paid service limits remain in force.

The resume parser currently returns independent school, degree and field arrays.
School names are normalized; degree/field associations are used only when there
is one school and one value. The entire original parse remains in the private
receipt and application, including unpaired values. No dates or associations
are invented. Structured Harvest education retains its full relationships.

Tenant applicants and tenant resume uploads remain in their organization-owned
application/sourcing tables. This branch does not enable all pool writers:
directory sync, refresh claims/retries and recruiter contact integration must
also be completed before a live cutover. Post-cutover audit must include intake
receipts rather than reconstructing these new sources as historical legacy
imports. The overnight reconciliation runner is pinned to the shadow sources.


## Uncertain cached source dates

Legacy Harvest cache-hit rows store when a payload was reused, which does not
prove when its facts were fetched. Migration
`20260926050355_person_source_date_holds.sql` retains these rows in the private,
service-only `person_source_holds` table. Holds survive deletion of the ledger
row. New successful TT cache-hit payloads automatically create a hold. Tenant
application data is excluded.

The baseline skips held people, the normalized writer refuses their updates,
and reconciliation records them for review. Final accounting cannot report
`reconciled` while any hold is unresolved. Previously normalized held evidence
remains preserved in shadow storage; it must not be published. Resolve a hold
only after establishing original fetch provenance and reviewing the affected
normalized facts. Merely clearing the hold or changing a timestamp is not a
repair. Hold counts are separate from migrated/verified counts.
