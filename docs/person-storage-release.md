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

## Cutover runbook scripts: publish, undo, write guard

Prepared migration `20260926183000_person_publish_runbook.sql` adds a `run_id`
to `person_projection_history`, the service-only `person_publish_runs` and
`person_publish_results` tables, and the profile write guard on
`public.candidates`, created DISABLED. Nothing in it rewrites a candidate row.
It is not applied in production.

`scripts/person-publish.mjs` publishes already-migrated people's compatibility
columns from the normalized tables (plan task 10, step 16 of the cutover). It
needs the website's server-only `PERSON_PUBLISH_DATABASE_URL`, the projection and audit
migrations, and a valid audit anchor even when a person's projection is unchanged.
Use the website's **direct or shared session-pooler connection on port 5432**
for these publish/undo/guard CLIs; they refuse port 6543 and unknown proxy hosts.
They never fall back to the app's `PERSON_DATABASE_URL`. Their run mutex is a
session advisory lock, which transaction pooling cannot retain across commits
([Supabase connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres)).
Keep this separate secret server-side; no production connection was provisioned
or used during local preparation. Each person is
one audited transaction through `publishPersonProjectionOnConnection`: candidate
lock, hold check, drift check against the last projection, a before-image tagged
with the run id, then the same profile update path as `savePerson`. `--mode=dry`
(the default) computes every change and writes nothing; its `--out` file holds
ids, statuses and the names of changed columns only. Per-person outcomes are
`projected`, `unchanged`, `held`, `unmigrated`, `drift`, `audit_blocked` and
`review_skipped`; `--review=skip|publish` carries Spencer's decision on people
with an open identity or contact review record. Pages are bounded (at most 500),
the checkpoint follows the page, and a crash between a person's commit and the
checkpoint is safe: the original per-person outcome commits atomically with
the projection and is reused on replay. Totals are derived from these distinct
durable outcomes. Resume requires the same commit, exact candidate ID set and
review policy. Publish and undo share a per-run database mutex. Capacity gates
match the other runners. A refused person remains recorded in that run; use a
new reviewed run after resolving its evidence problem. An unattributed edit
requires a separately reviewed evidence repair: immutable anchors cannot be
replaced by rerunning the anchor pass on today's profile.

`scripts/person-publish-undo.mjs --run-id=<publish run> [--apply]` restores the
profile columns from that run's before-images through
`undoPersonProjectionOnConnection`: only when the person still has the
normalized revision the run wrote, the exact history ID still belongs to that
run and is the newest unrestored publication, and the current profile hash
equals what publish produced. A newer edit, later publication (including one
at the same revision), later revision or unique-email clash is a
`conflict` and is left alone. Restored rows and their result commit together;
reruns retain the original cumulative totals. Derived undo run IDs are bounded
and cannot overwrite a publish run with the same name.

`scripts/person-guard.mjs` reads and toggles the write guard through
`person_write_guard_status()` / `person_write_guard_set()`. While enabled,
prepared migration `20260926201342_person_publish_review_guards.sql` requires
each candidate source-contract mutation to have its exact validated event,
field and same-transaction attribution at commit. This includes compatibility
profiles, contact, identity, source and enrichment-date fields. Creation needs
a real application or directory receipt and its creation anchor. Workflow-only
edits remain allowed. `--test-rejected=<id>` and `--test-allowed=<id>` force
deferred checks before rolling back. Enable the guard only after
every legitimate writer runs in live mode (step 17).

Local proof: `bash scripts/person-publish/run-local-tests.sh <port>` covers dry
run, publish, resume idempotency, crash between commit and checkpoint, drift,
exact undo and undo conflict, review and hold skips, the guard's three cases,
and scan paging with pause and resume. Additional regressions cover same-revision
cross-run undo, unchanged unanchored/stale profiles, atomic result failure,
exact resume IDs, concurrent runs, unattributed second writes, and real
application/directory creation while the guard is enabled. All fixtures are
local and synthetic; the migrations and guard remain unapplied in production.

## Directory connection recovery

The directory reader absorbs idle connection failures and reconnects read-only
before the next complete source-read scope. Within a repeatable-read scope,
connection loss, a failed query or an unfinished query rejects the entire
callback. Cleanup uses the original backend and never reconnects to roll back.
The caller may retry the whole read from its beginning; statements are never
transparently replayed inside a lost snapshot. Raw transaction control must use
`readOnly`/`withReadOnly`, and instrumentation proxies must forward that method.
Concurrent calls cannot join another callback's transaction.

Local recovery tests terminate only their own exact PostgreSQL backend PID in
the test database. The completed historical run remains pinned to `c4d0e4e`;
this prepared repair does not change that run or its retained accounting.

## Bounded projection comparison

`scripts/person-publish-preview.mjs` compares normalized projections with the
current profile and reports held, missing and previously published-but-drifted
people separately. It requires the prepared `person_projection_state` table;
unavailable tables or metrics stop the scan. It does not validate anchors,
receipt admission or a consistent snapshot across all reads, and does not certify
publication eligibility or source reconciliation.

The default time budget is 600 seconds, checked before every page; an already
started page finishes before a duration pause. Size at or above 34 GB, more than
five blocked sessions, invalid health metrics, or three metric probes above
twice the initial median (250 ms floor) stop further pages. `--max-seconds`
(1–18,000) and `--max-db-bytes` also propagate through the Actions dispatcher.
Existing request and retry limits remain in force within each page.

`preview_finished` includes `status` (`exhausted`, `limit_reached` or `paused`),
the scope and `last_id`. `preview_stopped` retains only fully accounted pages
and has a nonzero process exit. Resume by passing that cursor as `--after`;
each invocation's counters are separate. A bounded sample, an explicit ID list
or a resumed suffix never claims full-pool coverage. Even `full_migrated_scan:true`
means traversal of normalized profiles only, and every summary is labeled
`comparison_only`. People without normalized state are outside that scan; the
`population` field identifies normalized profiles or an explicit requested set.
Missing IDs in an explicit list are counted without hiding later valid IDs.

## Post-cutover auditor: planner, accounting, finalization

Prepared migration `20260926213000_person_postcutover_audit.sql` adds service-only
audit runs/results, append-only shared-lookup markers, bounded snapshots and
fenced record/finalize RPCs. This schema has not been applied in production.
The auditor writes its own bookkeeping; source, candidate and communications
records remain unchanged.

The pure planner reconstructs documents from the frozen legacy anchor, raw
sources and exact immutable writer receipts. It checks the complete captured
candidate chain and transient source changes, tenant ownership, document hashes,
list owners and content, header winners, contacts and identities. Recruiter edits
retain their requested contacts' prior eligibility flags in the immutable audit
operation, captured after the person lock. This input survives later historical
replays and transactions whose start predates their actual admission. Missing
prior evidence requires review. Request hashes and retries remain unchanged.
Metadata checks use the captured event clock, so running the audit in a later
year does not change the meaning of an earlier experience calculation.

The runner reads full communications provenance, including facts, identifiers
and source-version payloads. It records complete start/end fingerprints over
all linked contacts and the website scope and `_v2` witness. Missing access or
coverage stays pending. There is no operator boolean that can substitute for
source observations. This is an observed cross-database boundary, not a
transaction locking both projects; new source changes still require catch-up.

Snapshot and recording calls use an armed 15-second statement timeout. The
record RPC takes gates 72005 then 72006 exclusively, checks committed candidate,
directory and shared-lookup boundaries, and turns changed evidence into
`pending/boundary_moved`. Overflow snapshots stay compact review results and do
not trigger uncapped follow-up calculations. Three baseline load probes precede
scanning; size, blocking, sustained latency and duration gates stop safely.
Communications startup and queries have bounded timeouts that URL parameters
cannot disable. A session mutex prevents concurrent invocations of one audit run.

Resuming retains the commit, batch and durable cursor. A new pending pass gets a
new generation and revisits stale results, including a changed external
fingerprint. Old checkpoints and observations cannot mutate the new generation.
Counts are distinct durable outcomes; limits and suffix scans report partial
coverage explicitly. Finalization uses one set-based statement with an eight-
second timeout, checking current candidates against verified results and exact
boundaries. It reports `audited`, `catchup_pending` or `review_required` with the
remaining counts. Open identity conflicts are retained and counted separately;
they do not override source-proof failures or holds.

Local verification includes actual first writes and retries for all four intake
paths in both modes, receipt-created candidates, publication and undo, source
and content counterexamples, delayed commits, restart generations, external
proof, capacity limits and a stalled PostgreSQL endpoint. A separate accounting
load test used 423,050 synthetic empty candidates and finished finalization in
4.1 seconds under the eight-second bound. That synthetic accounting test is not
a production data audit. Run the disposable PostgreSQL suite with:

```sh
node scripts/build-worker-lib.mjs
bash scripts/person-audit/run-postcutover-audit-tests.sh LOCAL_PORT
# Optional local-only full-size accounting probe, after installing the suite:
LOCAL_DATABASE_URL=postgresql://postgres@127.0.0.1:LOCAL_PORT/person_postcutover_test node scripts/person-audit/test-audit-scale.mjs
```

Production use requires the reviewed prepared migration chain, anchors, source
catch-up and Spencer's release approval. The isolated canary and queue/drain
transition remain separate release prerequisites in the cutover runbook.


## Queued public application processing (prepared)

The public apply/referral/future routes and nightly review queue now share the
optional `PERSON_TRANSITION_SUPPORT` path described in
`scripts/person-application-queue/README.md`. Support stays off by default.
Apply the complete reviewed chain only at the approved release stage; these
queued-intake migrations have not been installed in the production database.

New submissions remain durable when TT processing is held or an organization's
allowance is exhausted. Supplied resumes must be stored with verified content
hashes. Original acceptance notices stay independent of paid processing, and
queue recovery never resends them. A reservation alone does not prove completion.
Only pre-effects work can automatically recover; uncertain paid attempts and
legacy queued rows with unknown processing history remain visible for review.

TT normalized admission persists contact/name and current future preferences
with the receipt. Future intent ordering is serialized and independently auditable
using immutable sequence evidence. Required source writes and lease renewal must
succeed before processing completes. The pipeline's auxiliary mirrors retain
best-effort behavior. All source/normalized/derivative writer fences and the
historical-runner maintenance policy are still required before activation.
