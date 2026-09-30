# Candidate writer coverage and release evidence

Updated September 30, 2026 against the prepared feature stack. This replaces the
September 28 inventory of parent `1c02b23`; that inventory's open gaps are not the
status of today's code. **Prepared coverage is not production activation.** All
application/receipt/anchor/projection/guard SQL remains uninstalled. Main merge,
deployment, canaries, publication and restrictive guards require Spencer's approval.

The accepted stage 1 rule remains: every in-scope writer must have a reachable checked
or admitted path, or an explicit scope exclusion. A retryable 503 is a safe failure
mode, not evidence that the successful write path has been implemented.

## Switches and staging

- S1: `person_write_guard_set(true)` checks same-transaction audit attribution for
  profile changes. It is separate from the normalization fence.
- S2: the armed transition controller or admitted work headers make
  `person_private.normalization_required()` true and require exact write frames.
- `PERSON_TRANSITION_SUPPORT=on` selects checked TT application edits independently
  of whether the controller is armed. `PERSON_WRITE_MODE` selects legacy/shadow/live.
  Support-on public acceptance must be verified before arming. Legacy-mode TT
  processing leaves accepted applications queued; this does not stop paid tenant
  processing in the all-org review queue.
- Settle old Actions and Vercel callbacks before arming. Keep the review-queue
  workflow disabled during its scoped isolated canary. Caps limit volume, not
  candidate identity. Follow the [cutover runbook](2026-09-26-cutover-runbook.md).

## Website writer matrix

| Path | Prepared behavior or accepted boundary | Evidence |
|---|---|---|
| Public apply, referral application, future interest | Durable `person_application_accept`; held TT submissions retain inputs without work/budget reservation | Acceptance harness: 55 primitive+7 TT-fence tests; local controller rehearsal retains 12 synthetic submissions |
| TT after-response pipeline and review retry | Claimed work, exact source/normalization/projection/readiness proof, atomic completion; legacy/support-on refuses TT effects before claim | Application/enrichment/completion suites and full-chain cross-family tests |
| Tenant pipeline | Immutable tenant binding and atomic result/contact completion; no TT-pool admission | Tenant binding/completion suites and hosted tenancy |
| Pool contact edit (`net_`) | Certified recruiter transaction, source policy, projection and receipts | Recruiter and contact-route tests |
| TT application follow-up, preferences and add-role | Checked edit, exact candidate mirror and immutable edit receipts | #72/#76 full-chain edit and route tests |
| TT application resume upload | Checked path/hash edit; linked parser fill binds authenticated upload, candidate, actor and parsed contacts; retains submitted contact and recruiter choices | #76 SQL061000; real local upload route with sealed parser/storage fixtures, replay/stale/drain/tenant tests |
| Linked TT application contact edit (`app_`) | Routes to the pool's certified recruiter transaction; submitted application contact remains evidence | #76 contact/read-policy tests and real local drawer route |
| Unlinked TT application contact edit | Checked application copy edit | Application edit and route tests |
| Network Send into TT | Checked insertion with current effective-contact revalidation and exact stored-row/captured-event witness | #77 DB/route/audit tests, including later checked edit/resume fill |
| Network Send into a client | Accepted tenant-scoped copy path outside TT source capture/fence | Tenant scope decision and hosted tenancy; client-safe profile/verdict contract retained |
| Email-send follow-up clear | Uses checked TT follow-up/candidate mirror when support is on; no silent skipped clear | #72 checked-edit/route tests plus source inspection of email-follow-up orchestration; no `noteEmailSent` execution claim |
| Tenant-owned application edits and sourced people | Accepted organization-owned legacy paths; never moved into the TT pool | Organization filters and hosted tenancy |
| Notes, email logs and referral records | Accepted exclusions from the profile guard; retain their existing behavior | Source inspection; do not claim an armed live integration test |
| Status/stages/tasks/inbox/lists/attachments/tracked links | Existing workflow stores; no blanket authority to mutate candidate profile rows | Source inventory; TT candidate mirrors use the checked path above |
| Verdicts, judge caches, signals and shortlists | Accepted derived-data boundary; coordinate the nightly jobs for the approved migration sitting | Runbook pause/restoration/rebuild procedure; not a new database fence |

The later main change adds `/api/internal/resumes/[id]`: deliberately token-authorized,
cross-organization and read-only for Spencer. It does not participate in candidate
writes. The normal tenant-authenticated sweep does not exercise that endpoint;
separate token/refusal/failure checks are required when recording final integration.

## Workers and operators

| Writer | Prepared path and operational boundary |
|---|---|
| Directory sync | Certified input/execution/publication/creation/outcome/suppression/readmission/current-source RPCs, including DNC and top-level fields; derivative work is durable |
| Harvest refresh | Certified top-up, lifecycle, source save and completion; legacy retry is skipped on the admitted path; repository-wide `refresh-queue` concurrency, no cancellation of an in-flight run |
| Application review queue | Support/mode dispatch inputs are wired; TT processing is admitted. Tenant processing can still have paid effects in legacy mode, so leave the scheduled workflow disabled for a scoped canary |
| Certified embeddings | #70 lifecycle, #78 checked publication/worker, #82 sole scheduled consumer at minute 20 each hour; separate group and explicit daily cap; no certified embedding drain remains in refresh |
| Compute signals / build shortlists / judge shortlists | Accepted temporary pause only for the approved migration sitting. Record original states, settle all nonterminal runs, restore only states changed by the migration |
| Sourcing resumer | Accepted tenant sourcing scope; not a TT normalized writer |
| Historical catch-up | Actual clean `c4d0e4e` checkout and fresh bundle, exact run-scoped held maintenance window; no code relabelling, no finalized-run resume |
| Anchor preparation | Held anchors window; exact evidence/ownership checks; CLI transaction-level server timeout |
| Publication | Named publish window while controller is open; source/anchor guard, revision-safe projection and evidence |
| Undo | Approved drain/seal/disarm sequence before conditional undo; never overwrite a newer legitimate revision |
| Trial undo and legacy maintenance | Old destructive trial undo is forbidden after shadow writes/cutover. Operator credentials do not authorize bypassing fences |

Publish/transition sessions require a verified direct/session endpoint and await
SET 20s on every checkout. Anchor RPCs use BEGIN/SET LOCAL 15s/RPC/COMMIT. The shared
checkout listener handles transport errors throughout a held session, prevents
further SQL after a broken connection or failed rollback, and disposes once.
Offline socket probes and real loopback database tests are distinct from actual
hosted-pooler verification.

## Database scope and resolved inventory gaps

Candidate facts, identities, normalized contacts/education/skills/experiences,
legacy email/website communication outcomes, source enrichments, TT application
rows, refresh attempts, shared lookups, identity conflicts, projection/audit proof,
derivative journals and directory/recruiter receipts have the applicable prepared
frames and proof guards. This does not authorize writes to `_v2` or the external
communications project; both remain read-only. No repository code bypasses triggers
with `session_replication_role=replica`; do not introduce such a bypass.

| Original gap | Current disposition |
|---|---|
| G1 candidate workflow mirrors / embeddings | Checked edits cover mirrors. Certified chunks provide embedding refresh; the search contract retains its existing matching_embedding/chunk selection |
| G2/G3 unreachable workers / dispatch overrides | #74 wires support and per-dispatch mode/support for the three writer workflows; #82 wires the hourly embedding worker |
| G4 maintenance/publish/undo refused | #71 held catch-up/anchors; #73 open publication; #79 deferred-work admission and truthful active/expired-window drain status; conditional undo after disarm |
| G5 conflict resolution while armed | Accepted post-launch checked-resolver work. Keep reviews retained; no implicit person merge or resolver bypass |
| G6 shared lookup maintenance | Repository source inspection found no independent companies/schools/skills writer outside the normalized writer. Other repositories were not audited |
| G7 missing derivative consumer | #70/#78/#82 supply lifecycle, publication and one scheduled consumer; no activation tonight |
| G8 incomplete migration inventory | Runbook lists the full dependency chain through 090000, including 061000; install only the reviewed whole chain |
| G9 blocking index install | Concurrent prebuild outside the migration, followed by validity/readiness/shape checks. Migration skips CREATE INDEX entirely when the acceptable index exists; invalid/incompatible names fail closed |

Accepted scope decisions (September 28): tenant-owned data stays legacy; notes,
email logs and referrals stay outside the profile guard; the three derived nightly
jobs pause for the approved sitting, and `network_matches` rebuilds from candidates
after publication and after any undo. The old observations of 5,483 conflicts and
94,952 Network rows are dated historical measurements, not current release counts.

## Current source accounting

`person-reconcile-full-20260930` is closed `review_required`, with complete traversal
and `external_stable=false`. **423,590 = 420,939 verified + 2,649 same-snapshot
reviews + 2 date holds.** No missing, pending, uncounted or beyond-cursor candidates
remain in that recorded scan. The 5,500 conflict rows / 9,379 people, queue 2,429 and
2,572 unreconciled events overlap these outcomes; they are not extra missing people.
Do not resume/refinalize the closed run, infer dates or clear reviews through paid
enrichment or person merges. Fresh source-boundary checks and reviewed provenance
handling remain release gates. See the runbook for timestamps and limitations.

## Verification retained for this prepared stack

- Full-chain cross-family tests: 504 Node cases and 48 SQL assertions passed. Relevant
  child modules also ran their own fault/concurrency suites; these overlap and must
  not be added together as distinct population coverage.
- Contact/resume/Send integration:61 edit+13 contact-read+20 route tests,101 audit cases
  including 14 Send-witness cases, and 23 recruiter tests passed on #77's combination.
- Acceptance harness #80:55 primitive acceptance cases before later schema, then
  7 TT-fence and 20 route cases with the complete prepared chain. Existing test guards
  and assertions remain intact.
- Application projection collision regressions already cover preexisting and racing
  unique-email owners, a real index wait, fallback hashes and exact conflict evidence
  in `scripts/person-application-projection/test-projection.mjs:90`. Their presence
  closes the old missing-test TODO; this is not a claim that every old harness was
  rerun on the final full chain.
- #79/#83 controller/maintenance rehearsal: 8 current and 8 frozen-c4 cases. It tests
  direct synthetic acceptance, parked/expired work, windows, anchors, publication
  and undo. Incomplete processing is explicitly refused then parked; it does not
  successfully exercise the entire hosted application pipeline.
- #81 helper:27 offline pin/privacy/acquisition/capacity/recovery/endpoint/deadline
  cases passed. #83: 16 offline transport cases plus 150 audit, 40 publish and 10 maintenance
  cases passed on loopback Postgres. Actual production connections remain unverified.
- Reviewed application child previews through #77 passed 913 hosted tenancy calls each
  with strict 18 fixture checks and zero leftovers. Operator/workflow/harness-only
  children retain that evidence only where app/library/package content is identical.
  The final integration plus current main requires its own exact-preview gate.
  The added offline internal-resume harness passes 13 token/refusal/storage-failure
  and no-store checks with sealed synthetic transports; it does not access real resumes.

## Historical stage 2 results and remaining live gates

September 28's report compared a copy installed in production order with one in
harness order and reported equal catalogs. It predates September 30 review fixes;
do not treat it as current schema-equivalence proof. That report recorded 47 suites
as written (15 older harnesses missing later schema),36 passing after added schema,
48 trial assertions, 7 older suites expecting now-refused legacy writes, and 3 stub
schemas not suitable for the full chain. The 7 also failed against the then-parent;
no write expected to be refused became allowed. These are retained historical
limitations, not a claim of an all-green global suite or a reason to weaken fences.

Before release, retain the final exact commit/preview/tenancy cleanup, independently
verify the deployed database transport and capacity, install the approved complete
schema, and prove support-on acceptance plus settlement of old callbacks before
arming. Where an approved canary's exact target cannot be expressed, prepare and
review a scoped invocation before dispatching it. No canary, paid expansion,
publication, guard activation or final production audit is claimed here.
