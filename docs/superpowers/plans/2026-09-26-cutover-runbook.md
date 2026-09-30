# Candidate storage: release preparation and cutover runbook

This is a prepared runbook, not release approval. Main, application write flags,
profile publication and restrictive guards remain held for Spencer. The parent
is not ready to release until the prerequisites below are completed and tested.
A snapshot marked `ready` means inputs were collected; it is not an audit pass.

## Current database outcome

The September 30 full source scan `person-reconcile-full-20260930` finalized once
at 03:49:26.195486 UTC as `review_required`. It ran at frozen runtime
`c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc`, parser `person-v3`, all sources,
shadow mode. Source traversal is complete; source stability and review are not.
Never resume or refinalize this closed run.

| Measure | Retained result |
|---|---|
| Pool candidates and counted outcomes | 423,590 |
| Verified at the observed normalized revision | 420,939 |
| Source reviews | 2,651: 2,649 same-snapshot mutations and 2 unknown cache dates |
| Missing, pending, uncounted or beyond-cursor checks | 0 |
| Verified outcomes with stale/missing normalized state | 0 |
| Open identity/contact conflict rows | 5,500, affecting 9,379 distinct counted people |
| Captured queue | 2,429 people, all counted with no newer capture version |
| Captured events | 4,622, of which 2,572 unreconciled; overlapping reviews |
| External fingerprint | Changed from 64260fbcb95b55cc3ff76443c521ca15 to 8ba8c8bfbe30715f7e8c98a4e6eb725d |
| Final status | `review_required`, `source_scan_complete=true`, `external_stable=false` |

**423,590 = 420,939 verified + 2,649 same-snapshot reviews + 2 date holds.**
The 540 arrivals since September 27 are included. Earlier 423,050-person
observations are historical and must not be added to these totals. Conflicts,
queue entries and events overlap the outcome partition. The two missing
normalized states and 2,649 revision mismatches belong to reviewed outcomes;
none is a verified outcome. Counts were checked in separate bounded read-only
sections between03:44:43 and03:48:07 UTC, not one MVCC snapshot.

The completed scan does not establish a stable full-scan anchor. A new dated
fact does not explain an altered historical same-timestamp snapshot or date an
old cache payload. Keep these people blocked by the existing provenance/anchor
rules until a separately reviewed resolution exists. Do not force dates, merge
people, buy enrichment or erase evidence to clear review. At approved cutover,
recheck current source deltas and the external boundary on the accepted pin.

All nine workflows were active at08:12 UTC; no workflow was paused during this
phase. Earlier temporary pauses were restored. Any new pause must record and
restore its original state, while public application acceptance continues.

Seven additive storage/capture/backfill migrations are live. Application,
projection, receipts, audit/anchors and restrictive-guard migrations remain
prepared only. Main was `9a3240c4198e4edbebc04248028a0fe104cfb9c8` at the last
check; reread main and the feature parent before release. Candidate IDs and
legacy fields were preserved. No `_v2` or communications writes, paid migration
enrichment or duplicate-person merges were performed.

## Prerequisites before asking for release approval

1. Finish the sequential feature integrations and review the final parent against
   current main. Retain the exact combined commit, green preview and hosted
   tenancy/cleanup result. Historical child previews do not prove a later app diff.
2. The prepared application acceptance, admitted workers, checked editors and Send,
   maintenance windows, publication admission and derivative worker must be installed
   as one dependency chain before support is enabled. Their local tests prove
   separate admission, concurrency, rollback and source-proof cases. The transition
   CLI rehearsal retains twelve synthetic submissions and tests parking/expiry,
   catch-up, anchors, publish and undo; it does not exercise an entire hosted
   application pipeline or finalize a production audit.
3. The three worker workflows have per-dispatch mode/support overrides. The hourly
   derivative worker is the only scheduled certified embedding consumer. Use the
   staged acceptance and legacy-invocation drain in section3 before arming; an
   inactive controller does not prove that old callbacks have stopped. An approval
   for one bounded canary is not approval to change shared modes or expand writers.
4. Retain backup/restore evidence, current disk and DB capacity measurements,
   normal latency and exact original workflow states. Pass the deployed database
   connection check and runtime inventory before a live canary. Never continue a
   failed load, recovery or tenancy gate to meet a deadline.
5. Historical catch-up must use a clean checkout and freshly built bundle from
   frozen `c4d0e4e...`; the start helper checks the actual Git state, not its label.
   Use a new queue run, then resume only that same run/configuration. Never resume
   a finalized source run, relabel newer code with the old pin, or run historical
   reconciliation after compatible profiles have been published.
6. Identity reviews and source-proof failures are separate. Spencer accepted
   publication of identity-review people while retaining their reviews.
   `--review=publish` only bypasses that identity filter; it does not give the
   2,649 same-snapshot review people valid anchors, date the two held cache payloads,
   or repair broken source proof. Those outcomes remain blocked until separately
   reviewed provenance handling exists. Fresh paid enrichment and person merges
   remain outside the overnight scope.

Prepared code is not a deployed canary. Retain the distinction between the local
rehearsals, legacy-mode hosted tenancy checks and the owner-approved live gates
below. A `ready` evidence snapshot is not a finalized auditor pass.

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
20260927130000_person_directory_input.sql
20260927140000_person_directory_execution.sql
20260927150000_person_directory_publication.sql
20260927160000_person_directory_creation.sql
20260927170000_person_directory_outcomes.sql
20260927180000_person_directory_suppression.sql
20260927190000_person_directory_readmission.sql
20260927200000_person_directory_current.sql
20260927210000_person_refresh_lifecycle.sql
20260927220000_person_refresh_save.sql
20260927230000_person_refresh_worker.sql
20260928000000_person_recruiter_admission.sql
20260928010000_person_derivative_journal.sql
20260928020000_person_derivative_lifecycle.sql
20260928030000_person_maintenance_window.sql
20260928040000_person_application_edits.sql
20260928050000_person_publish_admission.sql
20260928060000_person_application_contact.sql
20260928061000_person_resume_contact_fill.sql
20260928070000_person_network_send.sql
20260928080000_person_derivative_publish.sql
20260928090000_person_maintenance_deferred.sql
```

Before applying the chain, build the directory identity index without blocking
candidate writes. Run this block with `psql -X -v ON_ERROR_STOP=1`, outside a
transaction, and require successful exit before installing any of the chain.
The bounds apply to this prerequisite separately from each migration:

```sql
set lock_timeout='3s';
set statement_timeout='5min';
create index concurrently if not exists candidates_person_username_idx on public.candidates(lower(linkedin_username));
do $$ begin
 if not exists (
  select 1 from pg_index i join pg_class c on c.oid=i.indexrelid
  join pg_am a on a.oid=c.relam
  where i.indexrelid=to_regclass('public.candidates_person_username_idx')
   and i.indrelid='public.candidates'::regclass and i.indisvalid and i.indisready
   and not i.indisunique and i.indpred is null and i.indnatts=1 and a.amname='btree'
   and pg_get_expr(i.indexprs,i.indrelid) in ('lower(linkedin_username)','lower((linkedin_username)::text)')
 ) then raise exception 'candidate identity index is not ready'; end if;
end $$;
reset statement_timeout;
reset lock_timeout;
```

An interrupted concurrent build can leave an invalid index; `IF NOT EXISTS` on a
retry does not prove success. A wrong expression, unique or partial index is also
refused. If creation or validation fails, stop installation. Have the operator
inspect the failed or conflicting index and arrange its approved repair, then
repeat the whole prerequisite and require successful validation. Do not silently
drop an existing index or continue after the notice that its name exists.

The candidates heap was 660 MB on 2026-09-28; no production build duration is
assumed. With a validated prebuild, `20260927170000` checks the catalog and never
executes `CREATE INDEX`, avoiding its write-blocking lock even on the skip path.
Its missing-index fallback is for fresh local fixtures; production must pass the
prebuild gate above. `20260927190000` refuses to install
if any directory execution already completed. Install the whole chain before any
certified directory writer runs. The parent already includes #82, which moves
embedding work out of refresh into the one hourly worker. Include only files in
the exact approved parent: 020000 (#70), 030000–050000 (#71–73), 060000/061000
(#76), 070000 (#77), 080000 (#78), and 090000 (#79). All remain prepared.

A September 28 local-copy comparison reportedly found equivalent catalogs for
production-first and harness install orders. It predates the September 30 fixes
and does not prove this release against the live schema. Revalidate the exact
inventory and installed objects; retain its separately dated evidence.

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

Verify configuration without printing credentials. `PERSON_DATABASE_URL` must be
the shared pooler (`aws-0-<region>.pooler.supabase.com:6543`, user `postgres.<ref>`),
not the IPv6-only direct host `db.<ref>.supabase.co`, which Vercel and GitHub runners
cannot resolve. The 2026-09-28 rehearsal preview had the direct host: every admitted
application saved its row and paid its Harvest call, then failed at the pool-person
save (`person_save_failed:operation_failed`, underlying `ENOTFOUND`) and was left
`uncertain`. Before any canary, prove the connection from the deployed runtime itself
(a guarded one-off check, or one synthetic admitted write), not only from a laptop. Use the tested queue-only/drain
procedure from prerequisite 4. Inspect active Actions and database checkpoints
before any dispatch; do not duplicate an active migration or overlap a source
scan with tenancy fixtures. Record any temporary schedule pauses.

Before arming, establish durable public acceptance and retire old invocations:

1. After the approved code and complete schema are installed, record the exact
   deployment, all relevant workflow IDs/paths/states, current repository variables
   and Vercel mode/support settings in a private release record. Include
   `review-queue`, `refresh-queue`, `sync-candidates`, `derivative-worker`,
   `compute-signals`, `build-shortlists` and `judge-shortlists`. A workflow that was
   disabled stays disabled when this procedure finishes.
2. Temporarily disable scheduling only for workflows that were active; record each
   change. Enumerate all nonterminal runs (`in_progress`, `queued`, `requested`,
   `waiting`, `pending`) after disabling and repeat after settlement to catch races.
   Let effectful runs finish or use their reviewed recovery path; cancellation does
   not prove a paid call or source save did not happen. No old writer invocation may
   remain when the fence is armed. Derived jobs stay paused for the approved
   publication sitting so they do not score a mixture of old and new profiles.
3. Deploy Vercel with `PERSON_TRANSITION_SUPPORT=on` and
   `PERSON_WRITE_MODE=legacy` while the controller is disabled. Public TT apply,
   referral and future-interest requests now use the durable acceptance RPC;
   TT processing refuses legacy mode before claim or paid effects, retaining the
   accepted row for later queue processing. Some synchronous TT edits return a
   retryable pause in this staging mode. Keep tenant behavior and public acceptance
   checked. Verify this exact deployed configuration with approved synthetic
   submissions and receipt/row inspection before arming. Legacy-mode tenancy
   sweeps with support off do not prove this staging gate.
4. Route public traffic only to that verified deployment. Account for invocations
   started by the old deployment, including after-response callbacks; retain the
   deployed runtime's actual maximum duration and invocation evidence, and wait for
   those old invocations to finish. The controller tracks admitted work only; it
   cannot certify that support-off callbacks drained. If settlement cannot be
   established, stop before arming and keep durable public acceptance available.
5. Set the repository support variable to `on`, leaving its write mode `legacy`.
   Keep the writer schedules paused: directory and refresh reject support-on/legacy
   configuration rather than processing safely through the drain. Arm, drain,
   verify `--wait-drained`, then seal. Verify approved synthetic public submissions
   remain retained in each phase. No global live mode or paid worker is enabled by
   this step.

After the canary and approved writer expansion, restore only schedules whose
recorded state this procedure changed, at the specified end of migration load.
Carry the same state record through failures and rollback; do not unconditionally
run `gh workflow enable` over the list. Confirm final states against the record.
If the sitting is aborted, restoring legacy schedules requires a compatible
controller/guard/deployment state first; durable acceptance remains available.

Run bounded final catch-up under the accepted historical policy before publication;
retain new run IDs and resume the same pin/configuration. Account exact verified,
pending, review, queue and external-boundary outcomes. An unstable external
observation is reported explicitly; Spencer's tolerance for drift does not turn it
into a verified stable fingerprint or authorize bypassing the writer's guard.

Every controller change and window opening names the phase you expect (`--expect-phase`).
Before seal, `--wait-drained` must report drained. Retire expired pre-effects application
work by re-claiming it; parked (deferred) work is fine to hold. Use `scripts/person-transition.mjs` for every controller and window change (see
`scripts/person-transition-cli/README.md`); the controller/maintenance/publication sequence is rehearsed locally by
`scripts/person-transition-cli/run-local-tests.sh`. This does not exercise the
full application pipeline, hosted traffic or complete release audit. Closing an
exact maintenance work ID is idempotent and takes no expected phase. Active or
expired windows block `--wait-drained`; stop their owner and close them explicitly
before sealing.
While the controller is armed, the catch-up and anchor steps need operator
maintenance windows (`scripts/person-maintenance/README.md`). Arm, drain and seal
to `held`. Open a `catchup` window for the exact catch-up run ID, run the pinned
catch-up, and close the window. Then open an `anchors` window, run the anchor CLI
below, and close it. Only then reopen. The controller refuses `reopen` while a window is
open or expired. Publication and undo are not admitted by these windows.

The catch-up window requires a running checkpoint, but the pinned CLI normally
starts and pages in one invocation. Use the reviewed helper from the release
checkout with `PINNED_RUNNER_DIR` pointing to an absolute, clean Git checkout of
`c4d0e4e...` and queue-scoped `BACKFILL_CONFIG`. Verify disk/recovery/load prerequisites before invoking it. The helper rebuilds
its bundle, checks DB capacity,
computes the pinned external fingerprint, and starts one checkpoint without pages.
It rejects existing run IDs and emits only operational status. The frozen archive
used for local tests is not a Git checkout accepted by this helper. See
`scripts/person-maintenance/README.md` for invocation and offline tests.

Inspect durable state after every unsuccessful or ambiguous start:

- If no run exists, no checkpoint was committed. Diagnose the bounded fingerprint,
  connection or capacity failure, then retry the start helper after gates pass.
  Do not request resume for a nonexistent run.
- If a matching running checkpoint exists after a lost response, do not start a
  second run. Check its exact pin, parser, limit, batch and scope; open the window
  for that run and invoke the actual pinned CLI with the same configuration plus
  `resume:true`. Recover failed/paused runs only after their cause is diagnosed and
  the same durable configuration is verified.
- A finalized run stays closed. An active or expired maintenance window is retained
  until its owner is stopped/settled and its exact work ID is explicitly closed.

Once the window is open, run the bounded pinned queue catch-up, then its finalizer
inside that same window, inspect its exact outcome, and close the window. Neither
an unstable boundary nor a review outcome is converted into a stable audit anchor.
Historical copy observations reported cold fingerprint timeouts and faster warm
queries. Those observations do not establish production capacity or justify
raising timeouts, blind resumes, repeated warm-up scans or ignoring failed gates.

Then prepare anchors using the unchanged translator and installed audit chain:

```sh
# PERSON_DATABASE_URL is already securely configured for this process.
node scripts/person-audit-anchors.mjs --limit=1000 --batch=20
node scripts/person-audit-anchors.mjs --save --limit=1000 --batch=20
```

Anchors cover every person (about 423,000; about 13 KB each, 5.65 GB in total on the
copy). One process runs at about 25 people per second from a laptop; four processes
over the four quarters of the ID range (`--after=` `3fffffff-…`, `7fffffff-…`,
`bfffffff-…`, each `--limit` just above its quarter's count) finished in about 60
minutes. Overlap is harmless: an existing anchor is `unchanged`. Both the anchor and
publish CLIs stop at `--max-bytes` / `--max-db-bytes` (default 34 GB); the database
grows from about 32 GB to about 38 GB, so the default limit may stop the operation. These are historical copy estimates,
not current production measurements. Retain actual storage/recovery headroom and
obtain approval for any larger capacity ceiling before changing it; the copy
report of a 45 GB limit is not approval to raise the production gate. Advance only from the last completed cursor, within time/load gates. Verify every
reported review/pending outcome. Anchors are immutable; do not recreate them to
legitimize an unexplained edit. Keep the drain effective through activation.

### 4. Canary, audit, then expand writers

**Obtain approval before the first live canary.** An isolated worker canary is a manual dispatch of one of
`refresh-queue` or `sync-candidates` (the review queue instead requires the isolated invocation below) with `write_mode=live` and
`transition_support=on` (and its own bounds, for example `max`, `cap` or `limit`).
The embeddings those writers queue are written by the hourly `derivative-worker`
workflow (#82): dispatch it with the same overrides to embed the canary people, and
validate their published chunks. Its schedule remains paused during staging.
Dispatch every canary from `main` after the release merge, never from a stack
branch: a branch with #78 but without #82 still runs embeddings inside
`refresh-queue`, in a different concurrency group, and the two runs would each see
the same remaining daily cap.
For an approved Actions canary, temporarily enable only a workflow whose scheduled
path is independently proven to refuse all effects in `legacy`/`on`, recording that
change. **Keep `review-queue` disabled throughout its canary** and use an isolated
invocation with a concrete approved application scope: its scheduled all-org path
can still process paid tenant applications in legacy mode. If that scoped entry
point is not available, prepare and review it before dispatch; a volume cap is not
candidate isolation. For any temporarily enabled workflow, its manual dispatch
must use the exact approved main SHA, explicit overrides, concrete target scope
and spending bounds. Inspect the run ID/event/inputs and all nonterminal runs; do
not duplicate it. Re-disable that workflow after the canary until expansion is
approved. Other schedules remain paused. Repository variables stay `legacy`/`on`,
and Vercel stays in the verified support-on acceptance stage until expansion. Do
not assume a scheduled run is harmless or treat it as the canary. Run the approved
isolated canary,
validate its actual receipts and queued derivatives, and run the completed
receipt-aware auditor. A snapshot-ready result is insufficient. Verify the allowed
and disallowed write paths, application retry behavior and read contracts.

**Report the canary and wait for approval before expanding all writers.** Only then
change the shared Actions write mode and Vercel mode to the approved mode while
keeping support on; verify each surface's receipt-backed writes. Legacy invocations
must already have been settled before arming, rather than waiting for this step. Restore temporarily
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

Throughput, rehearsed on the copy from a laptop: about 0.84 people per second (each
person is about 20 round trips at about 55 ms), so the full scan takes days from a
laptop. It runs while the controller is open, so this is background work, not
downtime: resume the same run across windows (720 minutes at most each). Run it from a
host close to the database to cut the round trips. A single run cannot be split
across processes (one run lock and one maintenance window at a time).

Retain the same runtime and target/review configuration on resume. Report durable
distinct outcomes, including held, drift and audit-blocked people; completion of
traversal does not mean all profiles were published. Canary people encountered by
the full scan normally become unchanged; do not double-count distinct people.
Keep both run IDs for separate reporting and exact-history undo.

After the full publication, rebuild the Network list so its copied name, title
and company match the published records. It rebuilds from the current verdicts,
shortlists and signals (unchanged while the jobs are paused), costs nothing, and
replaces the rows in one transaction, so readers see the old list until commit.
Transformer Talent is the only organization with rows (94,952 across 450 roles on
2026-09-28). On the direct session:

```sql
begin;
set local lock_timeout = '2s';
set local statement_timeout = '10min';
select count(*) from public.network_matches where organization_id = '801865a7-6533-41d2-9c45-e4a90e6ad51a';
select public.refresh_network_matches('801865a7-6533-41d2-9c45-e4a90e6ad51a');
commit;
```

On the copy the rebuild took 20 seconds. Its first run once reported an in-transaction
`after` count above the rebuilt count that a recount and a second run did not
reproduce; recount a minute after commit. Report the before and after counts; a large drop means verdicts are missing and
needs investigation before resuming. Spot-check published people on the Network
tab. Restore the derived workflows to the exact original states recorded in
section3, and verify the restoration. Re-enable only those originally active and
temporarily disabled by this sitting. Preserve any original disabled state and do
not manually dispatch paid jobs merely to prove restoration.

While armed, undo is refused: first drain, seal and disarm (tested in
`scripts/person-publish-admission`), then undo, then arm again if the rollback keeps the new path.
Undo uses `person-publish-undo.mjs --run-id=EXACT_RUN` for a dry count, then `--apply`
only within approved rollback scope. Newer edits/publications remain conflicts.
After any applied undo, run the same Network rebuild so it shows the restored records.
Do not mass-trigger paid enrichment, embeddings or judging for storage-only changes.

Audit outcomes rehearsed on the copy (dry, 300-person sample after anchors): 246
verified, 53 `pending` (`directory_snapshot_not_admitted`: directory contacts, about
15% of the pool, until a certified directory sync records their current contact),
1 `review` (`anchor_required`, one of the catch-up reviews). An applicant who is also a
directory contact without a certified directory receipt reviews as
`historical_owner_unavailable`. The nightly directory sync covers only recent changes,
so covering every directory contact needs a separate decision.

The cross-organization leak test (`scripts/test-tenancy.mjs`) cannot run while armed:
its fixture writes candidates directly and the fence refuses it
(`candidate_mutation_frame`). Run it before arming or while disarmed, with the new
write paths on.

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
