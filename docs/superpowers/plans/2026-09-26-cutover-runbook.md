# Candidate storage: release preparation and cutover runbook

This is a prepared runbook, not release approval. Main, application write flags,
profile publication and restrictive guards remain held for Spencer. The parent
is not ready to release until the prerequisites below are completed and tested.
A snapshot marked `ready` means inputs were collected; it is not an audit pass.

## Current database outcome

The historical backfill completed at its frozen runtime
`c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc`, parser `person-v3`. The full source
scan finalized at 19:52:54 UTC. A later directory catch-up checked all 62,208
linked people and finalized once at 22:38:55 UTC. Latest per-person accounting
at 22:39:19 UTC is:

| Measure | Retained result |
|---|---|
| Pool candidates accounted for | 423,050 |
| Verified at the observed normalized revision | 422,925 |
| Source reviews | 125: 123 same-snapshot mutations and 2 unknown cache dates |
| Missing or pending checks | 0 |
| Normalized profile states | 423,049 |
| Open identity/contact conflict rows | 5,483, affecting 9,346 distinct pool people |
| Overlap of source-review and identity-conflict populations | 5 people |
| Captured queue pending at finalization | 0 |
| External source fingerprint | Changed during both scans |
| Final historical status | `review_required`, not `reconciled` |

The earlier full scan reported 422,963 verified and 87 reviews (85 mutations
plus two holds). Those are historical observations, not extra people to add to
the latest totals. The directory run itself reported 62,083 verified and 125
reviews, including both holds. Review checks without matching revisions are
already inside that review population, not another unresolved population.

Counts are observations, not a guarantee that live sources stopped changing.
The five temporarily paused workflows were restored to their original active
states at 19:53 UTC; none was manually dispatched. Any new pause must record and
restore the exact original state. Public application acceptance must continue.

Seven additive storage/capture/backfill migrations are live. Application,
projection, receipt, audit, anchor and restrictive-guard migrations are prepared
only. Main remains `0c2b9a8463f902737fd6e7e35aea724fa31755a8`. Candidate IDs and live
legacy fields were preserved. No `_v2` or communications writes, paid migration
enrichment or duplicate-person merges were performed.

## Prerequisites before asking for release approval

1. The post-cutover auditor corrections are integrated through PR32 at parent
   `58e34f0e708696a44ee03ca6abf45dfc74a3c407`. Exact preview `ee55ee1` passed 913
   tenancy calls, with synthetic cleanup verified empty. The auditor now requires
   complete receipt/source evidence, measured external observations, committed
   boundary fencing and bounded restart/accounting. A snapshot marked `ready`
   remains insufficient; run and finalize the actual audit after activation.
2. Read the current parent and deployment SHAs before release. PR27 repaired
   whole-directory-snapshot reconnect, PR28 repaired projection-preview coverage
   and load gates, and PR32 repaired the auditor. All passed local suites/build
   and exact-preview tenancy. Complete the remaining transition/canary work
   below and verify that final combined code before seeking release approval.
3. The local rollback-only application-admission rehearsal is documented in
   `scripts/person-canary/README.md`. It uses the actual writer, deferred guard and
   precommit planner with a bounded local footprint and an independent rollback
   check. It does not authorize or implement a website canary. Finish and review
   the website scope/drain procedure that isolates one surface. All three
   Actions workers currently read the same repository `vars.PERSON_WRITE_MODE`;
   changing it is a shared rollout, not a review-queue-only canary. Use a reviewed
   per-dispatch override or an isolated worker invocation with explicit synthetic
   targets and cost controls before changing the shared variable. Do not describe
   a normal scheduled workflow as isolated when it uses that shared setting.
4. The disabled controller/admission foundation is documented in
   `scripts/person-transition/README.md`. It has no production source-table
   triggers or route opt-in; its presence is not a drain guarantee. Do not arm it
   until all writer fences, maintenance/recovery and
   maintenance-runtime handling are implemented and tested.
   The application-specific claim/reservation/snapshot primitive is prepared in
   `scripts/person-application-work/README.md`; no route uses it yet. Legacy files
   missing a content witness stay `input_review` without an allowance charge.
   Existing unlocked budget writers, provider interruption and callback intent
   compatibility remain integration gates. Never enable this partial chain alone.
   Prove a queue-only/drain transition for source mutations while public
   submissions remain durably accepted. Draining Actions does not drain Vercel
   requests or recruiter/contact writes. Legacy source edits after an immutable
   anchor can block later guarded writes; waiting through nightly cycles between
   anchoring and activation is unsafe. Do not invent a maintenance command or
   proceed until the actual drain/queued-retry path has been tested.
5. Resolve the runtime/evidence policy for final historical catch-up. The current
   anchor policy accepts only verification from the frozen `c4d0e4e...` runtime.
   A newer run at a different `GITHUB_SHA` cannot simply replace that latest
   verification. Until a compatibility-policy change is independently tested,
   historical catch-up must stay on the accepted pin, with bounded slices and
   the same run/configuration on resume. Never relabel a new runtime as the old
   pin. Never use the historical reconciler after compatible profiles are published.
6. Preserve the distinction between identity reviews and source-proof failures.
   Spencer's recorded preference is to publish identity-review people while
   retaining their reviews. `--review=publish` only bypasses that identity filter;
   it does not provide an anchor for the 123 source-mutation people, clear a hold or
   bypass a broken evidence chain. Those people remain `audit_blocked` until a
   separately reviewed provenance/replay policy supports them. Report them as such.

Two source-date holds stay excluded and are already included in the 125 reviews.
Fresh evidence does not prove the old cache payload’s missing date. Hold resolution
and anchor eligibility need separately reviewed provenance handling. Fresh Harvest
pulls and duplicate resolution remain outside the overnight scope.

## Final-auditor capacity gate

PR36 integrated the reference-ownership correction at parent `d335638a6e52735b2e7af3a34e513e1a06125d38`; its exact preview passed all 913 tenancy calls with cleanup verified empty.

The reference-correction branch passed 85 local auditor cases and 15 rollback
canary cases. Its 423,050-person synthetic accounting probe initially reached
the unchanged eight-second finalizer limit; a repeated unmodified finalizer took
7,230 ms. This fixture is an accounting load test, not a full-content production
benchmark. It does not establish safe production capacity. Narrower rows, a
relational variant and a 16 MB local memory probe did not establish useful margin;
no memory or query-plan setting was adopted.

Keep the eight-second/lock/load gates. After the reviewed schema is installed,
measure the actual complete evidence population under the release load gate. If
it times out, stop that audit/publication stage, retain the run, diagnose the plan
and continue only independent work. Do not raise the timeout or treat a warm local
pass as the missing production capacity proof.

## Projection comparison and expected changes

The retained read-only comparison (Actions 36263047493) scanned 423,049 normalized
profiles: 420,207 changed, 2,841 unchanged and 1 held within that population. The
other held person has no normalized state. It flagged 9,345 conflict-affected
people in that population and 272 legacy-email collisions; 7 desired emails also
had another owner in `_v2` (informational, no writes).

This comparison is not publication eligibility. It does not prove anchors or
stable cross-table reads. Counts may change after live intake and final catch-up;
recompute them on the exact reviewed release and report the population and cursor.
PR28 adds explicit drift/missing accounting, duration and health gates. Its reader
requires the prepared `person_projection_state` schema and fails closed if absent.

Major differences are normalized company references, consistent job/education
lists, and filling previously empty profile fields from retained sources. Email
collision handling keeps today's address and records review; invalidated current
addresses may be cleared under the tested contact rule. Do not add the old
filled/different/case/cleared observations together: those intermediate comparison
counts overlapped. Use the final per-person change results for release accounting.

## Approval and execution sequence

Complete prerequisites first. Then present Spencer with the exact parent commit,
preview, test evidence, source/review accounting, migration inventory and rollback
steps. **Wait for approval before merging the parent to main or changing production
behavior.** A main merge deploys automatically. Each later expansion/publication/
guard action below must be covered by explicit release approval before execution.

### 1. Deploy the approved code with write flags off

Verify that Vercel production and the GitHub repository write variable are still
unset/legacy. Merge the approved parent only after Spencer's go. Verify the exact
production deployment succeeded and the public/application routes remain healthy.
Keep application submissions durably accepted throughout.

Rollback before activation: revert the approved merge through a reviewed PR and
verify the previous deployment. Once restrictive guards are active, do not switch
back to legacy writers without coordinating guard state and queued work.

### 2. Install the complete reviewed additive schema

Use the verified website project `kmuihequfurvjxpnugxf`, an active statement/lock
budget, and the exact migration inventory from the released commit. The currently
prepared chain is listed below in dependency order. Later migrations replace
earlier function bodies; do not move publication/review helpers to the end:

```
20260926033900_person_atomic_projection.sql
20260926044800_person_application_intake.sql
20260926054500_person_refresh_intake.sql
20260926061600_person_directory_intake.sql
20260926065300_person_recruiter_contacts.sql
20260926072840_person_derivative_jobs.sql
20260926074407_person_audit_evidence.sql
20260926080238_person_audit_anchor_preparation.sql
20260926082012_person_audit_writer_guards.sql
20260926172608_person_postcutover_snapshots.sql
20260926183000_person_publish_runbook.sql
20260926201342_person_publish_review_guards.sql
20260926213000_person_postcutover_audit.sql
20260926233000_person_audit_reference_ownership.sql
20260926235140_person_transition_foundation.sql
20260927001258_person_application_work.sql
20260927004931_person_application_queue.sql
20260927013100_person_application_finalization.sql
20260927020700_person_application_ownership.sql
20260927023000_person_normalization_fence.sql
20260927025000_person_application_proof.sql
20260927035000_person_application_projection.sql
20260927052000_person_intake_mutations.sql
20260927060000_person_intake_ready.sql
20260927065000_person_tenant_binding.sql
20260927070000_person_application_completion.sql
20260927080000_person_application_acceptance.sql
20260927090000_person_application_enrichment.sql
20260927100000_person_legacy_source_fence.sql
20260927110000_person_conflict_evidence.sql
20260927120000_person_lookup_mutations.sql
```

The chain includes the prepared reference-ownership correction: candidate-indexed
attribution references, source ownership checks and committed reference epochs.
Older snapshots/planners/results lack versioned proof and must be revisited. Append any subsequently reviewed
transition migrations before execution. Apply each reviewed file atomically
and record its exact version. Run the reviewed directory lookup index preparation
outside a transaction. Verify installed objects, service-only permissions and site
health after each stage. Only call `person_write_guard_status()` after the migration
that creates it; it must remain disabled. Refresh live candidate counts rather than
requiring a stale count while applications are arriving.

Rollback: leave unused additive objects in place with flags off. Do not drop
receipt, anchor or attribution evidence as a routine rollback.

### 3. Configure connections and complete the coordinated transition

Supply secrets through server-only configuration, never chat or committed files:

- `PERSON_DATABASE_URL`: website app/worker PostgreSQL URL, transaction pooler
  supported; also used by the anchor CLI.
- `PERSON_PUBLISH_DATABASE_URL`: dedicated website direct/session endpoint on
  port 5432 for publish/undo/guard CLIs; these refuse transaction poolers on 6543.
- Existing private website API credentials for the hosted tenancy fixture.

Verify configuration without printing credentials. Use the tested queue-only/drain
procedure from prerequisite 4. Inspect active Actions and database checkpoints
before any dispatch; do not duplicate an active migration or overlap a source
scan with tenancy fixtures. Record any temporary schedule pauses.

Run bounded final catch-up under the accepted historical policy before publication;
retain new run IDs and resume the same pin/configuration. Account exact verified,
pending, review, queue and external-boundary outcomes. An unstable external
observation is reported explicitly; Spencer's tolerance for drift does not turn it
into a verified stable fingerprint or authorize bypassing the writer's guard.

While the controller is armed, the catch-up and anchor steps need operator
maintenance windows (`scripts/person-maintenance/README.md`). Arm, drain and seal
to `held`. Open a `catchup` window for the exact catch-up run ID, run the pinned
catch-up, and close the window. Then open an `anchors` window, run the anchor CLI
below, and close it. Only then reopen. The controller refuses `reopen` while a window is
open or expired. Publication and undo are not admitted by these windows.

Then prepare anchors using the unchanged translator and installed audit chain:

```sh
# PERSON_DATABASE_URL is already securely configured for this process.
node scripts/person-audit-anchors.mjs --limit=1000 --batch=20
node scripts/person-audit-anchors.mjs --save --limit=1000 --batch=20
```

Advance only from the last completed cursor, within time/load gates. Verify every
reported review/pending outcome. Anchors are immutable; do not recreate them to
legitimize an unexplained edit. Keep the drain effective through activation.

### 4. Canary, audit, then expand writers

**Obtain approval before the first live canary.** An isolated worker canary is a manual dispatch of one of
`review-queue`, `refresh-queue` or `sync-candidates` with `write_mode=live` and
`transition_support=on` (and its own bounds, for example `max`, `cap` or `limit`).
Scheduled runs and the other workflows keep the repository variables, which stay
`legacy`/`off` until the expansion step. Run the tested isolated canary,
validate its actual receipts and queued derivatives, and run the completed
receipt-aware auditor. A snapshot-ready result is insufficient. Verify the allowed
and disallowed write paths, application retry behavior and read contracts.

**Report the canary and wait for approval before expanding all writers.** Only then
change the shared Actions variable and Vercel mode in the tested order, drain old
in-flight code, and verify each surface's receipt-backed writes. Restore temporarily
paused schedules promptly once migration load and transition coordination end.
Do not wait for another full nightly cycle while old writers mutate anchored rows.

Rollback follows the tested queue/guard procedure and preserves submissions and
receipts. A flag flip alone is not proof that already-running legacy code stopped.

### 5. Publish compatible profiles under a separately tracked run

**Obtain approval before publishing the first profile.** Run the bounded dry
comparison/publish dry run and retain its exact counts and limitations. Do not
expect every historical source-review person to pass the anchor guard.

With the controller armed and open, open a `publish` maintenance window for the
run ID first, and close it after the invocation (`scripts/person-publish-admission/README.md`).
Other admitted writers keep running. Draining refuses publication.
Use an explicit ID set for the initial canary, with its own run ID:

```sh
node scripts/person-publish.mjs --run-id=publish-DATE-canary --mode=publish --ids=UUIDS --review=publish --max-seconds=600
```

Use only the approved concrete UUID list. Verify per-person results and history,
read the selected people in the drawer, Network and Send, then audit the canary.
**Wait for approval before expanding publication.**

Start the full scan with a different run ID; it cannot resume the explicit-ID run:

```sh
node scripts/person-publish.mjs --run-id=publish-DATE-full --mode=publish --limit=1000000 --batch-size=500 --review=publish --max-seconds=3600
# Later invocations of this same full-scan run only:
node scripts/person-publish.mjs --run-id=publish-DATE-full --mode=publish --limit=1000000 --batch-size=500 --review=publish --resume --max-seconds=3600
```

Retain the same runtime and target/review configuration on resume. Report durable
distinct outcomes, including held, drift and audit-blocked people; completion of
traversal does not mean all profiles were published. Canary people encountered by
the full scan normally become unchanged; do not double-count distinct people.
Keep both run IDs for separate reporting and exact-history undo.

While armed, undo is refused: first drain, seal and disarm (tested in
`scripts/person-publish-admission`), then undo, then arm again if the rollback keeps the new path.
Undo uses `person-publish-undo.mjs --run-id=EXACT_RUN` for a dry count, then `--apply`
only within approved rollback scope. Newer edits/publications remain conflicts.
Do not mass-trigger paid enrichment, embeddings or judging for storage-only changes.

### 6. Audit and restrictive guard

Run the reviewed receipt-aware audit with the website session/direct URL in
`PERSON_PUBLISH_DATABASE_URL` and read-only `COMMS_DATABASE_URL`. Start, resume
and pending passes must retain the exact reviewed runtime and batch size:

```sh
node scripts/person-postcutover-audit.mjs --run-id=audit-DATE-full --record --limit=1000000 --batch-size=10 --max-seconds=3600
# Resume a bounded unfinished pass:
node scripts/person-postcutover-audit.mjs --run-id=audit-DATE-full --record --resume --limit=1000000 --batch-size=10 --max-seconds=3600
# Only after traversal and complete end-source observation:
node scripts/person-postcutover-finalize.mjs --run-id=audit-DATE-full
# Revisit remaining, stale or externally invalidated results in a new pass:
node scripts/person-postcutover-audit.mjs --run-id=audit-DATE-full --record --resume --scope=pending --limit=1000000 --batch-size=10 --max-seconds=3600
```

The runner measures complete start/end source fingerprints; no external-stable
assertion is accepted. Finalization reports distinct verified/pending/review and
stale-boundary counts. Partial scans, unavailable sources and unresolved reviews
remain explicit. New communications changes can require another pass after the
observed boundary. Preserve unresolved reviews.
Test allowed/rejected guard behavior on a local/isolated fixture first; production
probe commands roll back. A rejected probe while the guard is disabled is not an
expected success assertion: report the actual guard state.

**Obtain approval before `person-guard.mjs --enable`.** Enable only after the audited
writer rollout and publication gates have passed. Then verify both the rejected
legacy write and allowed attributed write with the guard enabled. Report failures
immediately and follow the approved guard/queue rollback procedure.

Prepared ownership migration `20260927020700` supplies the claimed application
candidate/Harvest bridges and protects their receipts. It is insufficient to
arm a drain by itself. Prepared normalization migration `20260927023000` adds
exact-receipt save admission and private execution frames for normalized facts
and shared lookups. Prepared proof migration `20260927025000` makes claimed audit
authority database-derived and protects capture/anchor/operation/attribution evidence.
Prepared projection migration `20260927035000` binds claimed compatibility updates,
audit attribution and projection history/state to one synchronous operation.
Prepared intake migration `20260927052000` adds exact seed/metadata/preferences
frames and receipt-derived application finalization, including actual-row validation
and private metadata replay witnesses. Prepared readiness migration `20260927060000`
requires private metadata/projection/finalization/preference proof before a first
binding commits and retains original preference ordering on replay. All remain uninstalled. The subsequent prepared migrations described below cover
pipeline completion, public/tenant acceptance and conflict evidence. Remaining
recruiter/directory/refresh/derivative writers and
historical maintenance still require complete admission coverage. Do not use existing
mutable identities or old unbound receipts as standalone write authorization.

### 7. Release report and follow-up

Verify the exact production commit, public application intake, tenancy cleanup,
recruiter reads, Network/Send, schedules, queue health and bounded query latency.
Spencer owns token rotation from the incident documented in the overnight handoff.
Never reproduce that token in logs or messages.

Report historical copying, source reconciliation, writer activation, publication
and derivative refresh separately, each with its actual run/commit/count. Include
unresolved source reviews, identity conflicts and both holds. Keep April retirement,
legacy deletion, duplicate-person merging and paid follow-up work outside this release.

Prepared tenant binding migration `20260927065000` freezes a company-owned
application key per company/LinkedIn identity. The first eligible application
visible at binding wins, with deterministic date/ID ordering; subsequent late
commits cannot retarget it. Missing identities stay on their own application.
Both current and retained anchor ownership are rechecked under locks, and work
must be admitted, started and unexpired. TT-held processing does not hold client
applications. This migration is uninstalled; atomic results/contact completion
must consume this binding before release. See `scripts/person-tenant-binding/README.md`.

Prepared atomic completion migration `20260927070000` must follow tenant binding
and TT readiness. Its private completion witness is required by all completed
claim/finish/replay paths. Claimed workers stage one result and commit results,
tenant contact additions and work completion together. General source fences,
other families, derivatives, maintenance and complete canary/drain coverage remain
unfinished. Do not install or activate this partial chain before release approval.

Prepared acceptance/source migration `20260927080000` follows completion. Held
public forms retain queued inputs without a work/budget reservation; duplicate
future requests retain original immutable evidence. The TT source fence accepts
only exact insertion/finalization/result frames, including previously unlinked
rows. Editor pauses occur before storage or mirrors. Tenant raw writers and
client-target Send are explicitly outside this TT-only fence; their broader
admission, other source families, derivatives and maintenance remain prerequisites.
Do not install or activate this partial chain. Verification and Unicode parser
version are documented in `scripts/person-application-acceptance/README.md`.

Prepared enrichment/source migration `20260927090000` follows acceptance. Checked
Harvest writes retain exact private ownership and the first cache selection;
historical cache reuse preserves original evidence, date and spend. Resume parser
telemetry derives its identity from admitted TT readiness. OLD/NEW enrichment
sources and legacy email writes are fenced while required; tenant spend without
candidate links and exact anonymous JD INSERT telemetry remain compatible.
Truncation is refused after installation even while disabled. See
`scripts/person-application-enrichment/README.md`. This does not complete the
other-writer, derivative, maintenance or production canary gates. Do not install
or activate the partial chain before approval.

Prepared legacy-source migration `20260927100000` follows enrichment. It fences
website communication-outcome rows and non-person experience writes while
normalization is required. Normalized experience rows retain TT/candidate scope
through AFTER checks, while source replacement and historical soft-removal remain
valid. No external communications project or _v2 schema changes occur. Disabled
legacy upserts and tenant completion remain compatible. See
`scripts/person-legacy-sources/README.md`; other admissions and complete canaries
remain prerequisites. Do not install this partial chain before release approval.

Prepared conflict migration `20260927110000` follows the legacy-source boundary.
Required writes must prove their exact normalized source or synchronous checked
application projection. Raw conflict insertion/resolution/deletion and truncate
are refused. Genuine global kind/hash dedup preserves the existing row and
returns zero, retaining conflict counters; suppressed inserts without retained
evidence fail. Missing-employer maintenance remains compatible while disabled
and refused while required until maintenance admission is implemented. No
existing conflicts are resolved or removed. This remains an uninstalled partial
chain; shared lookups, other writers, derivatives, maintenance and full canaries
still block activation. See `scripts/person-conflict-evidence/README.md`.

Prepared lookup migration `20260927120000` follows conflict evidence. The writer
uses private resolvers only at the existing winning-source loop sites; required
public resolver calls refuse. Exact one-use OLD/NEW proof and readback protect
company/school/skill mutations. Existing matching, tier rules and skill dedup
remain compatible. Typed primary-key predicates and FOR NO KEY UPDATE retain
index access and FK-lock compatibility. See `scripts/person-lookup-mutations/README.md`.
Other writer admissions, derivatives, maintenance and full canaries still block
activation; this is not permission to install or enable the partial chain.
