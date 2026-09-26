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
A legacy unique email collision retains a usable old compatibility address and
adds a review item rather than merging people. If the old address was explicitly
invalidated, it is cleared even when the replacement collides. Newer unprojected legacy changes fail
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
only original cache-miss ledger rows can supply a dated cached result. Retries
read the receipt before extracting a PDF and reuse its immutable Harvest payload.
Concurrent attempts use the transaction's winning resume and parse for later
matching and application updates. A vector from a superseded parse is never
stored as the winning person's embedding. Failures queue the retained
application for the existing review worker. Existing application review budgets
and paid service limits remain in force.

The resume parser currently returns independent school, degree and field arrays.
School names are normalized; degree/field associations are used only when there
is one school and one value. The entire original parse remains in the private
receipt and application, including unpaired values. No dates or associations
are invented. Structured Harvest education retains its full relationships.

Tenant applicants and tenant resume uploads remain in their organization-owned
application/sourcing tables. Recruiter contact integration and the remaining writer
coverage checks must also be completed before a live cutover. Post-cutover audit must include intake
receipts rather than reconstructing these new sources as historical legacy
imports. The overnight reconciliation runner is pinned to the shadow sources.


## Refresh worker preparation

The refresh workflow uses the same `PERSON_WRITE_MODE` flag and website-only
`PERSON_DATABASE_URL`. Its prepared additive migration is
`20260926054500_person_refresh_intake.sql`; it is not applied by preparing code.
The service-only attempt receipt retains the original Harvest ledger snapshot,
claim token, paid reservation, and normalized documents.

Queued work and failed saves are claimed atomically. Free cached work has
priority over requests that need paid enrichment, including with a zero daily
budget. Each queue item has at most three processing attempts. A lost or
uncertain paid response requires review instead of another automatic purchase;
a late successful response can still be saved against its original reservation.
Expired claims cannot commit a candidate save. A successful normalized save,
compatibility projection in live mode, and queue completion share one transaction.
Old terminal queue rows are retained with an archive status and their original
contents in the receipt.

Shadow refresh leaves deployed profile fields and derived embeddings unchanged.
Live refresh derives years and embedding text from the canonical profile and
keeps refresh dates monotonic. Embedding work is claimed at most once after a
semantic profile change; derivative failure does not mark a committed profile
save as failed. No paid refresh worker is dispatched as part of the migration.

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


## Directory intake preparation

Normalized directory sync needs the prepared
`20260926061600_person_directory_intake.sql` after the projection migration.
Before enabling normalized intake, run
`scripts/person-directory/prepare-lookup.sql` against the website database with
`psql -v ON_ERROR_STOP=1 -f` outside a transaction. It creates and validates the
case-folded LinkedIn lookup index concurrently, avoiding a long write lock on
the pool. This operational prerequisite has not been applied in production.

The legacy mode is still the default. Shadow/live modes read complete bounded
pages in a read-only repeatable-read communications transaction. Email and
identifier rows have no reliable change clock, so these modes always use a
resumable full scan; the legacy `SINCE` shortcut does not apply. A workspace
lease fences concurrent scanners. Unchanged completed snapshots are checked
in batches. Pending immutable receipts are recovered before reading the
external directory, including when a contact has subsequently disappeared.

Admission uses directory, LinkedIn, URN and Airtable identities, never email.
Conflicting owners are held for review; a final ownership check also catches
older writers racing admission. DNC is sticky and works for an existing person
even when their profile is held or not migrated. New suppressed contacts do not
create pool people. Source saves, projection, linkage and workflow metadata
commit together; a failed transaction leaves its original input retryable.

Historical snapshots already saved by the backfill keep their original owners
and row IDs. New Harvest facts use the original fetch date. Only proven manual
board edits receive their own fact clock; a generic board update or imported
fact's recorded time is not evidence of a newer profile. Changed components
with uncertain chronology stay in scoped review while safe contact/workflow
changes proceed. Reviews survive subsequent workflow-only snapshots.
Enrichment metadata advances only for exact admitted source evidence, and
experience years are recomputed from the canonical profile.

Directory primary selection is tracked independently from email verification.
It does not renew verification or profile dates. Invalid, bounced or suppressed
contacts remain ineligible, and usable manual choices still rank first. An
undated current negative places that contact on hold for review while retaining
its older dated verification evidence. Curated contact JSON remains intact.

Optional matching embeddings are queued in receipts and capped at 50 requests
per invocation. They commit only if the receipt, canonical text and person
revision remain current. A retry keeps unfinished work; three failed attempts
require review. No Harvest calls or migration embedding fanout are introduced.

## Recruiter contact preparation

Prepared migration `20260926065300_person_recruiter_contacts.sql` adds private,
service-only edit receipts and explicit email/phone primary authority. It is
not applied in production. The normalized pool edit path requires TT membership,
a stable request UUID and an already migrated, unheld person. Tenant application
and sourced-candidate contact edits retain their organization-scoped storage.

The edit, its original server timestamp, source document, nullable primary
selection, curated display fields and optional live projection commit in one
transaction. Repeating an old request returns the current contact state without
reapplying the older edit. Reusing its ID for another actor, person or payload
fails. Clearing a primary withdraws the recruiter's preference while retaining
historical facts and allowing an eligible source fallback. Hiding alternate
emails changes their display selection without deleting source evidence.
Invalid, bounced, suppressed, shared or otherwise ineligible contacts cannot
be promoted by this endpoint.

In live mode, published pool contact reads in the drawer, Network and Send use
persisted eligible ranks. Curated alternate emails are filtered against that
same eligible set. Manual preference never implies independent verification.
A normalized read failure does not fall back to a stale legacy override;
unpublished people and legacy/shadow modes retain their existing reads.

The drawer keeps the same receipt ID for an unchanged failed retry. Navigating
to another person clears pending UI state, and late responses cannot overwrite
that person's details or finish a newer save. Local checks include PostgreSQL
rollback/concurrency, server-path parity, tenant scoping and actual React
navigation/retry cases. This release still requires the separate canonical
profile-history and derived-data integration checks before cutover.

## Published profile reads

Live published profiles now use one bounded, consistent database snapshot for
profile fields and eligible contacts across the pool drawer, Network cards and
Send. The reader checks the published profile hash, normalized revision and
source holds. A profile awaiting publication or carrying unexplained drift is
unavailable; it cannot fall back to an older raw Harvest response. Unpublished
people and legacy/shadow modes retain their current read behavior.

Send stores that canonical snapshot in its existing application profile shape.
It preserves structured employment dates, explicit current/ended status,
headline, skills and intentional empty lists. A marked canonical Send remains
authoritative in the recipient's drawer even when the recipient already has
an older sourced copy; empty sent contacts cannot revive that copy's unusable
addresses. Recipient edits still apply within their own organization. Only
client-safe verdict information crosses the organization boundary.

This change requires no database migration. The pooled connection wrapper
preserves a fixed allowlist of application error codes needed for contact
validation and unavailable-profile handling; all other driver messages remain
redacted. Main deployment and live activation are still separate release gates.
# Canonical derivative activation

The prepared `20260926072840_person_derivative_jobs.sql` adds a service-only
durable queue. Apply it before enabling the live application/refresh/directory
writers. Historical backfill does not enqueue or purchase embeddings.

Applications and workers derive chunk vectors from the checked current profile
and retained resume, with bounded claims, retries and HTTP deadlines. Refresh
invocations also recover pending work when no Harvest work exists. Inspect
`person_derivative_jobs.status='review'` for exhausted or unavailable profiles;
repeated identical writes cannot silently reset the attempt budget.

Drain older deployed application and worker embedding writes before enabling
the new live path: the legacy REST updater does not participate in the new
transaction locks. Keep public submissions accepted and durably queued during
this transition. Main merge, flag activation and existing profile publication
remain separately gated by Spencer's approval.
