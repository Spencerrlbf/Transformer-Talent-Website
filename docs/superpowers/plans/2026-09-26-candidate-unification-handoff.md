# Candidate storage unification: handoff and remaining work

Updated 2026-09-27 (application normalization boundary prepared). Plan:
`docs/superpowers/plans/2026-09-26-overnight-candidate-unification.md`.
Use the corrected cutover runbook and review worklist beside this document.

## Safe current state

The historical normalized copy and bounded source catch-up have completed their
traversal. Latest accounting is **422,925 verified plus 125 unresolved source
reviews**, including two date holds. This is not a completed live cutover.

Production still serves the legacy candidate fields. Main remains
`0c2b9a8463f902737fd6e7e35aea724fa31755a8`; no application activation, compatible
profile publication or restrictive guard was performed. Candidate IDs, links,
legacy fields and original source evidence remain preserved.

Feature parent `feat/person-00-storage-unification` / draft PR #2 includes PR40
at `7dc7354c641504b5480f0e9b6ef43cdc3b9ac086`. The current sequential child
`feat/person-39-normalized-write-fence` requires exact receipt documents and a
private execution frame for claimed normalized writes. Read GitHub for the latest full SHA before release;
no production transition or queue integration is enabled.

## Exact database accounting

Website Supabase project: `kmuihequfurvjxpnugxf`. No communications or `_v2`
writes were performed.

| Latest observation at 22:39:19 UTC | Count |
|---|---:|
| Pool candidates | 423,050 |
| Verified at the current normalized revision | 422,925 |
| Same-snapshot source mutation reviews | 123 |
| Unknown original Harvest date holds | 2 |
| Missing / pending checks | 0 / 0 |
| Normalized profile states | 423,049 |
| Open identity/contact/employer conflict records | 5,483 |
| Distinct pool people with open conflicts | 9,346 |
| People in both source review and open conflicts | 5 |

Both holds are included in the 125 source reviews. One held person already has
normalized state; the other does not. The 124 review checks without a matching
normalized revision are an overlapping subset of reviews, not extra people.
All verified checks match their observed normalized revision.

Open conflict records comprise 4,515 identity-taken, 511 email-owned-by-other,
416 missing-employer, 40 job-identity and one company-identity record. No people
were merged. Duplicate email ownership records review without automatically
changing contact eligibility; explicitly shared/ineligible contacts cannot rank.

**Historical copy:** `person-full-phones-20260926`, frozen runtime
`c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc`, parser `person-v3`, completed at
17:04:41 UTC: 423,048 copied/audited, two held, 491,056 catalog rows at that
boundary. Prior failed full runs remain records and must not be resumed.

**Full reconciliation:** `person-reconcile-full-20260926`, same frozen runtime,
finalized at 19:52:54 UTC: 423,050 scanned, 422,963 verified, 85 source mutations
plus two date holds. Its external fingerprint changed; status `review_required`.

**Later directory catch-up:** `person-reconcile-directory-20260926-evening`,
same frozen runtime, batch 500, 900-second slices, 34 GB database cap. Actions
36272786709, 36273846591, 36274733400 and 36275707737 completed successfully.
All 62,208 directory-linked people were traversed: 62,083 verified, 125 reviews
including both holds. Source traversal finished 22:32:03 UTC. Finalized once at
22:38:55 UTC, status `review_required`, zero queue pending.

The directory fingerprint changed from `9ad8fa890b1ef85711f4364fe882f543` to
`7ba8c0068fada0e9ba497ada50fca6ca`. These runs do not establish a stable external
boundary. Do not resume or refinalize any of these completed IDs. A later bounded
pass requires a fresh run ID, accepted runtime, idle-run check and retained config.

The first directory finalization attempt rolled back at its eight-second limit.
Read-only query-plan diagnosis found an expensive incremental-sort/index path.
The identical aggregation with transaction-local `enable_incremental_sort=off`
completed in 2.37 seconds; the unchanged finalizer then succeeded with that local
setting and the original eight-second statement/two-second lock limits. No schema,
global configuration, code pin or timeout was relaxed. Private metadata artifacts
`directory-finalization.json` and `directory-final-accounting.json` retain evidence.

## Applied and prepared migrations

Seven additive migrations are live:

- `20260926011500_072_person_tables`
- `20260926025355_person_writer_corrections`
- `20260926031057_person_backfill_capture`
- `20260926032752_person_missing_employer_review`
- `20260926040300_person_backfill_bulk`
- `20260926042200_person_reconcile`
- `20260926050355_person_source_date_holds`

Application, atomic projection, receipts, derivative queue, audit anchors,
snapshots, publication and restrictive-guard migrations remain **prepared only**.
The reviewed chain, including reference ownership, disabled transition support
and application work primitives, plus the separate concurrent directory lookup
index, is listed in the cutover runbook. All-writer fences, website/worker canaries and runtime
maintenance remain unfinished. Do not install or enable an incomplete chain.

The application normalization boundary is described in
`scripts/person-normalization-fence/README.md`. It protects normalized facts and
shared lookup mutations, preserves disabled legacy behavior, and does not yet
fence candidates, source/projection/audit proof rows, conflicts or derivatives.
All other writer families still need admission before controller activation.

## Verification and recovery evidence

PR25 corrected publication, exact-history undo and deferred attribution; PR27
fixed silent loss of a directory read snapshot; PR28 fixed preview drift, target
coverage and load/time limits. Their exact previews passed 913 tenancy calls each.

PR32 corrected the post-cutover auditor, immutable receipt reconstruction,
recruiter prior-contact proof, historical calculation dates, source checks,
commit-order fencing, bounded restart and full-population finalization. Validation:
66 auditor tests, 39 publish/preview tests, 23 isolated recruiter tests, eight
connection-failure tests, 51 translator checks and a production build passed.
A local 423,050-person synthetic accounting probe finalized in 4.1 seconds under
the eight-second bound; it tests scale, not real-person source correctness.

Exact PR32 preview `ee55ee10044dff5048a588bb9570b5834aca23ad` passed all 913 tenancy
calls in 265 seconds. Run `z2me73366` was fully cleaned, leftovers verified empty.
Default cleanup hit the existing organization-delete timeout; a bounded fallback
removed only that run's synthetic organizations and children. Afterwards the DB
was 31,940,775,059 bytes, with zero blocked sessions, queue entries or capture events.
No source scan overlapped the hosted fixtures.

PR35 added a rollback-only local application-admission canary (15 checks); it
is not a website or whole-worker canary. PR36 added candidate-owned reference
proof and attribution fencing (85 auditor checks). Each passed build and exact
913-call tenancy with cleanup verified empty. PR36's current 423,050-person
accounting-scale probe timed out at eight seconds, then passed unchanged in
7.23 seconds. No tuning was adopted; actual production capacity remains a gate.
The earlier PR32 4.1-second fixture is not current capacity proof.

PR37's disabled controller/admission foundation passed 19 PostgreSQL checks,
12 HTTP/PG bridge checks, 15 canary checks, 27 intake regressions, production build,
and exact 913-call preview tenancy in 250 seconds. Run `25aasa84a` cleanup was
verified empty. It installs no production source-table triggers or route opt-in.
PR38's application-work primitive passed 26 database checks, 13 transport checks,
15 canary checks and build. Exact head `186a9f66c94b96ba95d8de8e9746f8f3a4de4fcb`
passed 913 preview tenancy calls in 252 seconds; completed and earlier stopped
fixture runs both cleared 18 strict cleanup checks. The cleanup harness now
uses exact owned job IDs, retains ownership on failures and has two regressions.

PR39 adds queued public acceptance, resume hashes, semantic future
intent dedupe, shared atomic allowance/claim, stage renewal, input-review holds
and safe pre-effects owner recovery. TT contact/name/preferences commit with
normalized facts and immutable receipts; the audit proves historical preference
ordering, including pending unlinked requests. Required tenant contact writes
and source finalization fail closed. Legacy queued work with unknown prior effects
remains in explicit review. Support remains off; no new migration is live.
Local coverage includes lifecycle/queue concurrency, actual bundled public routes
and processing with mocked network, real claimed intake/rollback/ordering, the
85-check auditor, 27 existing intake checks, 15 local canary checks and build.
Exact PR39 head `def05d243f329c4e47d03d0984ed0aee1d85bd20` passed all 913
preview tenancy calls in 251 seconds; run `5w9zg881e` passed 18 strict cleanup
checks with zero leftovers after bounded exact-run fallback.

The current ownership child adds a frozen work-to-candidate binding, minimal
atomic seed and exact receipt/source completion proof. Claimed Harvest storage,
cache selection and attachment retain first-owner evidence and reject stale or
transferred scope. Bound receipt rename/replacement/deletion and owned raw-ledger
mutation fail even without caller context. All guards here remain prepared;
this is not coverage of every source, normalized, shared-lookup or derivative
write. Existing unbound legacy receipt/ledger behavior remains compatible while
the controller is disabled. Full writer coverage is still required before any
activation. See `scripts/person-application-queue/README.md` for commands.

Retain the private recovery exports (12 JSON files, approximately 441 MB),
row-restoration proof `RECOVERY_CHECK_PASSED`, and the known physical backup from
2026-09-25 23:52:51. The physical backup was available but was not restore-tested.
Do not use the old destructive trial undo against the migrated normalized store.

## Schedules and security

The five originally paused workflows were restored at 19:53 UTC and reverified
active after catch-up: build-shortlists, compute-signals, judge-shortlists,
refresh-queue and sync-candidates. No paid workflow was manually dispatched.
Other schedules remain active. Record and restore exact original states for any
future pause; do not blindly dispatch jobs to test restoration.

The independent session recorded a separate one-shot nightly check; inspect it
before creating any duplicate. This task's heartbeat stays active while authorized
preparation remains unfinished.

A Supabase MCP token appeared in private tool output earlier. It was not used or
committed. Spencer owns rotation and coordination of dependent access; never
reproduce the token in reports.

## Remaining work before release approval

1. **Finish website canary and queue/drain integration.** Local canary,
   disabled controller and application reservation primitives are prepared.
   Public queued acceptance, file verification, shared processing claims,
   pre-effects recovery and receipt-bound finalization are prepared in the current
   child. Late-writer fences, whole-worker canaries and maintenance remain. All
   three Actions workers currently share one write-mode variable. A shared flag
   is not a single-worker canary, and draining Actions does not drain Vercel or
   recruiter writes. The private `transition-preparation-findings.md` inventory
   identifies public submission crash/retry, resume persistence, duplicate
   future-interest, contact extraction, worker staging and paid-reservation gaps.
   Root owns sequential implementation; no such transition is active. Current
   processing uses its retained first input instead of mutable callback fields.
   Legacy queued rows require prior-effect review (files also need hashes), and old unlocked budget
   writers must be replaced/drained before claiming a strict system-wide cap.
   Preserve best-effort acceptance notifications without retry-driven resends.
2. **Retain explicit source-proof policy.** Publish identity-review people only
   when their immutable anchor and evidence chain are valid. The 123 same-snapshot
   source mutations and two date holds are unresolved; `--review=publish` does
   not supply proof. A fresh pull does not prove an old cache date. Further source
   repair requires reviewed provenance handling, never invented dates/anchors.
3. **Keep historical and post-cutover runtimes separate.** Anchor preparation
   accepts the frozen c4 verification. Do not relabel a newer runtime or use the
   historical reconciler after compatible profile publication. The new auditor
   measures complete external observations and verifies actual receipt chains.
4. **Verify the final combined release.** Complete remaining code children,
   review/tests/build and required preview tenancy, then update draft PR #2 with
   the exact commit, counts, prepared migration chain and rollback sequence.
5. **Obtain Spencer's release approval.** Main merge/deployment, application and
   worker activation, profile publication and restrictive guards remain held.
   Follow the corrected runbook's approval and expansion order. Continue durable
   public acceptance and restore any temporarily paused schedules promptly.

Report historical copying, source reconciliation, writer activation, profile
publication and derivative refresh separately. None implies the others. No paid
migration enrichment, bulk judging, duplicate-person merges, communications writes,
`_v2` writes, old JSON deletion or destructive retirement is authorized here.
