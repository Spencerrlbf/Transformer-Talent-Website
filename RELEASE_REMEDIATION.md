# Candidate storage release remediation

Ledger for the fifteen findings of `RELEASE_READINESS_REVIEW.md` (review date
2026-10-02; that file is unchanged). Remediation branch
`fix/person-90-release-remediation`, started 2026-10-03 from the prepared parent
`feat/person-00-storage-unification` at `c8fda5bfd50e8c40f22a3083e38c6eea71d0a803`
(which already contains current `main` `9a3240c`, including the private internal
resume endpoint). Status words: **implemented**, **verified** (evidence on the final
source in this branch), **blocked** (needs an action outside this branch's
authorization), **obsolete** (shown no longer applicable).

Three statements this ledger keeps apart:

- **Implementation complete** for RR-01 through RR-08 and RR-11 through RR-15.
- **Verification complete** on the loopback disposable PostgreSQL and in sealed
  offline tests for RR-01, RR-02, RR-03, RR-04, RR-05, RR-06, RR-11, RR-12, RR-13,
  RR-15; RR-07/RR-08 are verified in code and offline tests but their deployment
  evidence needs a deployment this branch is not authorized to make.
- **Release approved: no.** RR-09 (completed reconciliation, publication and
  final audit at a declared cutoff), RR-10 (owner's disposition of 23 rows),
  RR-14 (hosted tenancy run on the exact artifact) remain owner actions.

A second review (`RELEASE_REMEDIATION_REVIEW_2026-10-04.md` in the
`candidate-unification` checkout, unchanged) found five further defects, R2-01 to
R2-05. All five are **implemented and locally verified** on this branch (section
"Second review" below). The 2026-10-05 follow-up (section "Pre-release follow-up")
adds explicit clears across publication (forward migrations `20261005090000` and
`20261005100000`), the reviewed runner for the pinned catch-up, the declared Node 24
runtime and a local browser smoke; the follow-up review's F1–F6 are corrected in
`0ffa133`, the final executable source, on which the integrated matrix and the local
HTTP sweeps were rerun. **Locally verified is not deployment verified**:
hosted runtime attestation, RR-09 migration completion/accounting, RR-10 disposition
and release approval remain open.

## Baseline refreshed on 2026-10-03

| Item | State on 2026-10-03 |
|---|---|
| Testing branch `verify/stage2-combined` | `23d7860`, unchanged; local checkout clean |
| Prepared parent `feat/person-00-storage-unification` | `c8fda5b` on origin, unchanged (local branch pointer lags; the `candidate-unification` checkout is detached at `8da8341`, same tree, with an uncommitted `packageManager` line and 43 untracked duplicate-name files, all left untouched) |
| `main` | `9a3240c`, unchanged |
| Remediation branch | `fix/person-90-release-remediation`, worktree `pl/remediation`, 11 commits on top of `c8fda5b` (last executable change `8bd8fd3`; the docs commit on top adds no executable file) (see manifest) |
| Test copy `qsqlgibgsxzlimoegcjx` | read-only snapshot at 15:16 UTC: 423,052 candidates; 38,798,797,971 bytes; controller enabled/open gen 4 rev 5; no live work; `person_network_send(p_row jsonb)` one-argument body; witness table with 5 columns; 1 witness; no `20261003*` migrations; publish runs canary complete (5), full paused (1,986 + 13 + 1); 0 audit runs; cluster identifier `7550817586112808987` |
| Original project `kmuihequfurvjxpnugxf` | not queried, not written |
| Local disposable PostgreSQL | 127.0.0.1:55487 (Homebrew 15.13, loopback only, `person_*_test` databases) used for every database test below |

No workflow was dispatched, no deployment made, nothing pushed.

## Scope decisions carried into the artifact

- `main`'s internal resume endpoint: present (inherited from `c8fda5b`); its 13 offline
  access tests pass on this branch.
- Testing-branch drawer improvements: **kept**. `origin/fix/drawer-profile-layout`
  (#85) and `origin/feat/drawer-also-a-match` (#86) merged; the one conflict in
  `lib/server/candidates-unified.ts` resolved by keeping both the `alsoMatches`
  computation and the storage branch's `sentSnapshot`/`profileBits` lines, the same
  way as on the testing branch. `tsc --noEmit` and `next build` pass.
- Testing-branch diagnostics (`app/api/diag/person-db`, the two `console.error`
  diagnostics in `person-transition/application.ts` and `applicant-pipeline.ts`):
  **excluded**; they are not on this branch. A proper, redacted pipeline-failure
  log line is a follow-up, not part of this release.

## Findings

### RR-01 Linked application recipient falls back to stale submitted email

- **Applicability**: the defect is in `T`; the parent already carries `f0e1fd6`.
  Branch content: `lib/server/email-compose.ts`, `candidates-unified.ts` (list fallback
  exposes no address, detail throws `pool_contact_unavailable`), `pool-contact.ts`.
- **Fix**: inherited; no rebuild.
- **Tests / results**: `scripts/person-application-edits/test-contact-recipient.mjs`
  13/13 (sealed: empty, cleared, missing, read-failure, present canonical, unlinked,
  tenant, support-off); route-level cases inside `test-edits.mjs` 61/61 on the clean
  install and on the upgraded install.
- **Status: verified.**

### RR-02 Checked Send does not validate the current contact under lock

- **Applicability**: code fix in parent `63386a8` (`network.ts` mode-aware caller,
  `20260928070000` effective-contact recheck). Database gap: the copy has the old
  one-argument body installed (confirmed 2026-10-03).
- **Fix**: forward migration `20261003110000_person_forward_network_send.sql`:
  drops `person_network_send(jsonb)`, installs the release `(jsonb, text default
  'live')` body byte-identical to the chain file (proved by
  `scripts/person-release-upgrade/test-forward-definitions.mjs`).
- **Tests / results**: `test-edits.mjs` Send cases (stale snapshot after certified
  recruiter save → `contact_changed`; racing recruiter commit; duplicate Send →
  `already_sent`; draining/tenant/status/extra-column refusals; two concurrent Sends
  create one row) pass on the clean install (61/61) and on an older install after the
  forward migration (61/61).
- **Database implications**: upgrade removes the one-argument overload; callers that
  pass one argument resolve to the default `'live'`.
- **Status: verified.**

### RR-03 Audit accepts incomplete insertion evidence; copy has the old snapshot export

- **Fix**: same forward migration. Witness table gains `inserted_row`, `event_id`,
  `event_hash`; existing witnesses get their proof **only** when the captured INSERT
  event in the witness's own transaction reproduces the recorded `row_hash` exactly
  (payload plus every other `website_applications` column as null); anything else keeps
  NULL proof under an all-or-none check constraint and `sentApplication()` then treats
  the Send as an unproved raw application (pending, never admitted). Snapshot export
  upgraded to the release fragment (`inserted_row`, `insert_event`, size limit).
- **Tests / results**: upgrade harness (5 phases): `recovered=1, unresolved=1`; the recovered
  witness's `inserted_row` reproduces the original hash, its event hash recomputes,
  and the planner reports the person `verified` again; the altered witness stays
  NULL, is still immutable, and its person is not `verified`; a half-proved row is
  refused by the constraint; the planner reports the unresolved Send as exactly one
  unadmitted application. A clean release-chain install and the upgraded database
  have identical catalogs for every touched object (phase 5). Pure verifier cases:
  `scripts/person-audit/test-sent-application.mjs` within the audit suite (101/101).
  Reconstruction uses exactly the four columns the capture trigger strips.
- **Database implications**: on the copy, the single existing witness would be
  recovered or left unresolved by the same rule; the result is reported by the
  migration's NOTICE. No row is deleted or rewritten beyond the three proof columns.
- **Status: verified** (clean and upgrade paths on the disposable database).

### RR-04 Catch-up trusts a supplied commit label and an unverified bundle

- **Applicability**: parent `112ec10` verifies real HEAD, clean tree, rebuilds and
  hashes the bundle. Its dependency on the original host (RR-06) is removed here.
- **Tests / results**: `test-start-catchup.mjs` 32/32 and `test-start-catchup-cli.mjs`
  1/1 (wrong checkout with historical `GITHUB_SHA` label → `catchup_start:not_pinned`,
  zero clients); maintenance suite 10/10 current runner and 10/10 with
  `PINNED_RUNNER_DIR` = the frozen `c4d0e4e` checkout; transition rehearsal 8/8 current
  and 8/8 pinned.
- **Status: verified.**

### RR-05 Retained PostgreSQL clients emit unhandled transport errors

- **Applicability**: parent `cd1b78c` (`scripts/person-db-session.mjs`, both adapters).
- **Tests / results**: `scripts/person-db-session/test-transport.mjs` 16/16 on this
  branch; **new** `scripts/person-transition-cli/test-recovery.mjs` case 5: the
  publishing session's backend is terminated (`pg_terminate_backend`) at COMMIT
  through the CLI's own `openDatabase` wrapper → the run fails with a sanitized
  reason, no `uncaughtException`, no history/result/frames; `--resume` publishes the
  person once and its profile equals an uninterrupted control person's. Case 5b
  (COMMIT durable, acknowledgement lost): resume reuses the durable outcome, one
  history row, one result row.
- **2026-10-04 (R2-05)**: the armed leak-test orchestration had reintroduced a raw
  `pg.Pool`; it now uses the same hardened adapter (see R2-05 below).
- **Status: verified.**

### RR-06 Copy procedures tied to the original project

- **Fix**: `scripts/person-target.mjs` (one authority for the selected project),
  `PERSON_TARGET_PROJECT_REF`; `person-reconcile-finalize.mjs` rewritten (explicit
  destination via 5432 URL or linked workdir, REST/PG identity agreement, no original
  restriction); `start-catchup.mjs` host check replaced by the selection, comms URL
  may not name the website project, REST identity recorded; `sync-org-roles.mjs` and
  `embed-roles.mjs` require `SUPABASE_URL` and have no default; publish/undo/guard/
  transition and anchor CLIs require the selection for hosted URLs. Migration
  `20261003090000_person_target_identity.sql` adds the identity RPC.
- **Tests / results**: `scripts/person-target/run-offline-tests.sh` 44/44 including
  sealed child processes for the role utilities and finalizer (zero sockets on
  missing/mismatched destinations); start-catchup mismatch cases; publish and anchor
  config regressions updated to the explicit contract.
- **Status: verified** (offline and unit level). The copy itself was not finalized
  or started again: the closed runs stay closed.

### RR-07 Browser Auth target does not establish server/worker isolation

- **Fix**: `lib/server/person/target.ts` gates `sbRest` and `withPersonConnection`:
  with shadow/live mode or transition support on and any hosted client, the selection
  is required and `SUPABASE_URL`, the service key claim and `PERSON_DATABASE_URL`
  (pooler username) must all name it, before any pool or request. Workflows pass
  `vars.PERSON_TARGET_PROJECT_REF` to the four normalized writers. Legacy mode with
  no selection is unchanged (production today).
- **Tests / results**: `test-server-target.mjs` 10/10: REST-copy/PG-original,
  same-length key swap misses the gate cache;
  PG-copy/REST-original, foreign key claim, missing selection with support on → all
  refused with zero pools and zero requests; consistent configuration proceeds.
  The workers with their own REST helpers (`review-queue.mjs`, `refresh-worker.mjs`,
  `sync-directory.mjs`) call the gate before any request: sealed process tests show
  zero requests under a mixed configuration.
- **Evidence, kept apart** (2026-10-04):
  1. *Browser bundle*: the branch preview
     (`transformer-talent-website-1e0ofstyx.vercel.app`, commit `310c9af`) compiles
     only `qsqlgibgsxzlimoegcjx.supabase.co` into its `/dashboard` bundle. This proves
     the browser Auth target and nothing about the server.
  2. *Configuration validation*: 17 branch-scoped variables exist (names listed;
     sensitive values are not retrievable through Vercel's API); the gate's rules are
     proven offline (44 cases) and the same module validated the copy's own file
     values as all naming one project.
  3. *Server/database runtime* (2026-10-04, disposable local stack, exact commit
     `6df67d8`'s production build): `person_target_identity()` through REST and
     through PostgreSQL returned the same cluster identifier (`7692807888100020262`;
     the baseline copy is `7550817586112808987`, the local fixture server
     `7689662122152206805`, so the check tells clusters apart). With the correct
     selection a signed-in dashboard read through `sbRest` answered 200; the same
     build started with `PERSON_TARGET_PROJECT_REF` naming another project refused
     the same request (500, server log `person_target:rest_mismatch`) while public
     pages still served. The anon role cannot call the identity RPC (401).
  3b. *Server/database runtime, final source* (2026-10-04, third run, exact commit
     `75684a5`'s production build on a freshly reset local stack, cluster
     `7692835274743853093`): `person_target_identity()` through REST (service role)
     and through PostgreSQL returned that same identifier; anon → 401; signed-in
     dashboard read under the correct selection → 200; the same build started with
     `PERSON_TARGET_PROJECT_REF=abcdefghijklmnopqrst` → 500 with server log
     `person_target:rest_mismatch` (1 occurrence), public page 200. The same
     sequence had the same outcome on `6c9168b` (cluster `7692827053218816039`);
     the first run's figures (cluster `7692807888100020262`, commit `6df67d8`) and
     the `6c9168b` run are historical.
  4. *Not established*: the Vercel-hosted deployment's own effective configuration.
     The branch preview is still configured for the read-only baseline copy and must
     not be signed into; the same identity comparison and gate probe have to be run
     against whichever deployment will serve traffic (a disposable hosted project, or
     production at the sitting once the identity migration is installed).
- **Status: implemented; runtime behaviour verified on the exact artifact against a
  disposable database; hosted-deployment attestation outstanding.**

### RR-08 Copied grants and inherited provider credentials

- **Fix**: `lib/server/outbound-guard.ts` + `instrumentation.ts` + worker-bundle
  install: `OUTBOUND_DENY_HOSTS` denies listed provider hosts at `fetch` before the
  request leaves; counted; no-op when unset.
- **Tests / results**: `test-outbound-guard.mjs` 4/4 (Nylas/Resend/Airtable/Harvest
  denied incl. `Request`/`URL` inputs, Supabase/OpenAI pass, reinstall replaces).
- **Runtime (2026-10-04, first run, commit `6df67d8`, historical)**: with placeholder
  provider keys and the deny list set, the team-invite route tried to send through
  Resend and the server refused it before the request left the process (route 502
  `email_failed`, server log `outbound_denied:api.resend.com`). That run's deny list
  named `api.harvest-api.com` (R2-04): it proved Resend's path only, and no Harvest
  route was exercised, so the earlier phrase "every provider denied" was over-broad
  for Harvest.
- **Runtime (2026-10-04, final source `75684a5`; identical outcome on `6c9168b`
  earlier the same day)**: deny list with `api.harvestapi.io`, placeholder
  Harvest/Resend/Nylas/Airtable keys, `SOURCING_PROVIDER_MODE=live`: team invite → 502, log
  `outbound_denied:api.resend.com`; company search (`/api/dashboard/sourcing/companies`,
  the real `searchCompanies` client) → 200 `{companies:[]}`, log
  `outbound_denied:api.harvestapi.io`. Nylas and Airtable were not exercised through
  a route on the server (no mailbox grant, no apply pipeline in the sweep); their
  denial is proved at code level by `test-provider-denial.mjs` (real clients, recording
  transport). Proof is per provider; one provider's refusal is not another's.
- **Remaining**: the copy still holds one mailbox grant; the testing preview inherits
  a live Harvest key from the project; Supabase Auth SMTP on the copy is a project
  setting outside this repo and was not changed.
- **Deployed value**: the branch preview's `OUTBOUND_DENY_HOSTS` was set on 2026-10-03
  from the then-documented example, i.e. with `api.harvest-api.com`; it was not read
  back in this task (sensitive values are not retrievable) and remote configuration
  was not changed under this instruction. It must be corrected to `api.harvestapi.io`
  before any effectful hosted testing (owner action).
- **Status: implemented; verified offline and at runtime on the exact artifact
  (Resend and Harvest at runtime; Nylas and Airtable at code level);
  hosted-deployment attestation outstanding.**

### RR-09 Copy does not establish complete migration or preservation

- **Refreshed counts** (one repeatable-read snapshot, 2026-10-03T15:16:55.992118Z,
  8 indexed ranges, 8 s per statement, read-only): population **423,052** =
  current counted verified **420,781** + missing normalized **1** + missing counted
  check **2** + review **273** + stale revision **4** + queued change **1,991**;
  remaining **2,271**; unexplained difference **0**. Reasons: `same_snapshot_mutation`
  272, `harvest_cache_date_unknown` 2, no reason 1,997. Overlaps: queue 2,160; holds
  2/2; open conflicts 5,488 over 9,352 people; events 2,412 / unreconciled 2,237;
  no baseline receipt 3; unpublished 421,044; anchors 422,778. Identical to the
  review's 2026-10-02 figures: the copy has not moved.
- **New observation**: of the 2,008 people with projection state, only 11 are
  "current counted verified"; 1,997 are the queued-change people, because publishing
  captured one change event per person. A post-publication queue catch-up (the runbook
  already prescribes one) is part of any complete sequence.
- **What closes it**: a separately approved rehearsal on the final artifact: install
  the forward migrations, explain the single `audit_blocked` person, fresh queue
  catch-up with the explicit target, anchors for the 274, complete publication, final
  audit; restore provenance for the copy; a before-manifest for production.
- **Status: open (owner-approved rehearsal/sitting required).** No run was resumed.

### RR-10 Twenty-three experience rows without an owner

- **Investigation (read-only, 2026-10-03T15:19Z)**: 23 rows, 3 owner ids
  (11/6/6 rows), `source='harvest'`, no `source_id`, created 2026-08-21 03:35 to
  13:13 UTC. Nothing else references the ids except 6 `match_verdicts` and 5
  `candidate_enrichments` rows; no sources, contacts, educations, skills, profile
  state, receipts, anchors or conflicts. Capture began 2026-09-27, so no deletion
  event can exist. Via each owner's own enrichment ledger row, exactly one **living**
  pool person has the same LinkedIn username, created 2026-08-22 07:36:56 UTC
  (sources `directory` and `airtable_sync`), normalized, carrying the same experience
  rows (22/22 and 12/13 matching by title, company, start). Owners 2 and 3 resolve to
  the same living person (two TT applications on 2026-08-21 for one person).
- **Conclusion**: pre-migration debris from the 2026-08-22 re-import that re-keyed
  these people; facts are preserved under the living owners; not migration-caused
  loss; invisible to the product (no `candidates` join).
- **Proposal (not executed)**: Spencer chooses (a) keep and document as a retained
  exception, or (b) a separate reviewed cleanup deleting the 23 rows plus the 6
  verdicts and 5 enrichment rows that reference the missing ids. A candidate-owner FK
  on `candidate_experiences` needs its own compatibility analysis.
- **Status: investigated; disposition is an owner decision.**

### RR-11 Linked resume contact fill absent

- **Applicability**: parent `e401d96` chain present (`resume-fill.ts`,
  `resume-fill-evidence.ts`, route, worker exports, `20260928061000`); contact-fill
  body with the phone extension installed by forward `20261003100000`.
- **Tests / results**: `test-edits.mjs` fill cases (once; replay no duplicate;
  submitted contact unchanged; recruiter choices and explicit clears kept; replaced
  resume, wrong linkage, tenant, draining refused; claimed value not promoted;
  concurrent recruiter save rechecked; extension survives) on clean and upgraded
  installs; upgraded install confirmed `resume_fill_begin` present and the extension
  regex in the installed `person_application_contact_fill`.
- **Status: verified.**

### RR-12 Drain ignores unresolved maintenance work

- **Applicability**: parent `7959171`.
- **Tests / results**: transition rehearsal cases "drain reports active/expired
  maintenance until explicitly closed" (`drained:false`, exit 2, seal refused, explicit
  close then seal) 8/8 current and pinned; **new** recovery case 6b closes an expired
  window explicitly after an aborted publication.
- **Status: verified.**

### RR-13 Index preparation validates existence instead of suitability

- **Applicability**: parent `7f90ccd` (`20260927170000` preflight); forward
  `20261003120000` applies the identical validation to an already-installed database
  without creating anything (static parity test).
- **Tests / results**: `scripts/person-directory-outcomes/test-index-preparation.mjs`
  within the directory-outcomes suite (valid prebuild keeps its OID without blocking a
  candidate writer; failed concurrent build, unique, partial and wrong-expression
  same-name indexes refused; fresh fixture still builds) 6/40/35/12 all pass; upgrade
  harness validates the index on the older install.
- **Status: verified.**

### RR-14 Exact artifact lacks complete current verification

- **Done on this branch** (final source, no live IO): `tsc --noEmit`; `next build`
  with an empty environment; offline suites (target 44, transport 16, start-catchup
  33, internal resume 13, forward definitions 4); database suites on the loopback
  fixture: application edits 61 + 13 (clean), upgrade harness 25 + 4 + 61 + 13 + 4 + 3,
  transition rehearsal 8 + recovery 7 (current and pinned), maintenance 10 (current
  and pinned), publish 10 + 18 + 4 + 8, post-cutover audit 15 + 9 + 13 + 25 + 20 + 19,
  directory outcomes 6 + 40 + 35 + 12.
- **Sweep adaptation done**: `scripts/test-tenancy.mjs --armed` (RR-14): seeding and
  teardown stay in the disabled state; the fixture's three pool people are
  reconciled and anchored and the controller armed before the probes; the probes
  run armed (reported from the database through REST); drain, close, seal, disarm
  before teardown; coverage labelled in the output. The orchestration is proven on
  the local full chain (`scripts/tenancy/run-armed-local-tests.sh`, 4 cases:
  normalized + anchored + armed/open; raw candidate write refused while armed while
  a public accept is admitted; disarm; normalized people are retained evidence).
- **Sweep on the disposable local stack, first run (2026-10-04, commit `6df67d8`,
  historical)**: exact commit's production build and the fixture pointing at the
  same loopback Supabase stack (Auth, REST, Storage, PostgreSQL; full chain
  `001…20261003*` installed by the CLI), live mode + support on, provider hosts
  denied (with the then-wrong Harvest hostname, see RR-08):
  - *controller disabled*: 913 calls, **PASS**, cleanup nothing left;
  - *controller armed* (`--armed`, pinned `c4d0e4e` runner, anchors, armed/open read
    back through REST during the probes, drained/sealed/disarmed before teardown):
    913 calls, **PASS**, cleanup nothing left, 3 normalized pool people retained as
    evidence in the disposable database. (The stack was then stopped with
    `supabase stop`, which keeps the data volumes; nothing was deleted. An earlier
    sentence here said "disposed", which was inaccurate: stopping and deleting
    volumes are separate actions, `supabase stop --no-backup` being the deletion.)
  These results pre-date the R2 fixes and are evidence for that commit only.
- **Sweep on the disposable local stack, final executable source `75684a5`
  (2026-10-04)**, procedure `scripts/tenancy/DISPOSABLE.md` as corrected, stack reset
  to a clean chain (133 versions incl. the local bootstrap) before each run, deny
  list with `api.harvestapi.io`:
  - *controller disabled*: run `z7yz2b645`, 913 calls in 29 s, **PASS**, cleanup
    `{"orgs":2,"poolPeople":3,"files":2,"users":3}`, nothing left;
  - *controller armed* (`--armed`, pinned runner): run `z9ftg637a`; preflight proved
    the fixture target (local, cluster `7692835274743853093`, controller disabled at
    revision 1) before the first write; reconciled 3, anchored 3; armed with
    ownership revision 2 / generation 2; 913 calls in 27 s, **PASS**; cleanup
    `drain, seal, disarm` owned revision 2 → 5, controller disabled; 3 normalized
    people retained; `transition_events` holds exactly the four rows
    `tenancy_sweep_{arm,drain,seal,disarm}_z9ftg637a` at revisions 2–5.
  The same two sweeps on the intermediate source `6c9168b` (runs `y2oeuc9b8` and
  `y4f6i2a5b`, cluster `7692827053218816039`) had the same results and are
  historical.
  Labels: the armed run is the armed-state acceptance; the disabled run is reported
  separately and does not substitute for it. Stack stopped afterwards with
  `supabase stop` (volumes `supabase_db_remediation`, `supabase_storage_remediation`
  retained, not deleted).
- **Not done**: browser smoke of the drawer changes; the sweep against the
  Vercel-hosted deployment itself. The baseline copy stays read-only: no fixture,
  controller change or migration was run against it.
- **Manifest**: `RELEASE_MANIFEST.md`.
- **Status: implementation complete; local HTTP verification complete on the final
  source; hosted verification blocked** (needs a deployment this instruction does
  not authorize).

### RR-15 Retired role-sync stage

- **Fix**: `sync-airtable-roles.mjs` removed from `npm run sync-roles`; both remaining
  stages refuse a missing/empty `SUPABASE_URL` before any request and honor the
  selection when set.
- **Tests / results**: `test-cli-targets.mjs` static resolution + sealed processes.
- **Status: verified.**

## Second review (2026-10-04): R2-01 to R2-05

Source: `RELEASE_REMEDIATION_REVIEW_2026-10-04.md` (reviewed `d6a1a3f`, inspected
`ae70f76`; unchanged). Each finding was confirmed against the current source with a
regression that failed on the pre-fix code before the fix was written, then passes.
Database tests ran on a **new** dedicated disposable PostgreSQL 15.13 cluster
(127.0.0.1:55811, cluster identifier `7692816301217905049`, created for this task,
nothing else on it; the 2026-10-03 cluster on 55487 was not reused). Commands ran with
a sanitized environment (`env -i PATH HOME LC_ALL`): no hosted credentials, no
hosted connection, no provider call. The baseline copy, the original project, the
communications database and the `_v2` tables were not touched.

### R2-01 PostgreSQL URL options bypass target validation (P1)

- **Confirmed** with the installed driver (`pg` 8.x, `pg-connection-string`), offline:
  `new pg.Client({connectionString}).connectionParameters` for
  `…pooler…?user=postgres.B`, `db.A…?host=db.B…`, `127.0.0.1…?host=db.B…`,
  `…?port=6543`, `…?%68ost=…`, `…?sslmode=require&sslmode=disable` all differ from
  the authority; the validator accepted every one and classified the loopback case
  as local.
- **Fix** `4aa9845`: `databaseIdentity()` accepts a single `sslmode` only; `host`,
  `port`, `user`, encoded names, duplicates, empty names and every other option are
  `person_target:database_options`, raised before the server gate, the worker writer
  (`withPersonConnection`) or the finalizer construct a client, and
  `isLoopbackDatabaseUrl()` is false for them (so a loopback authority with a hosted
  override no longer disables the hosted checks). The publish/anchor adapters already
  refused these options; they are unchanged.
- **Regression**: `test-target.mjs` "PostgreSQL query options cannot change the
  validated destination" (11 override shapes refused; 6 accepted URLs compared with
  the driver's effective host/port/user; refused overrides shown to move the driver);
  `test-server-target.mjs` "PostgreSQL URL overrides are refused before any pool"
  (zero pools, zero requests; loopback-with-override requires a selection and is
  refused under `local`); `test-cli-targets.mjs` "finalizer refuses PostgreSQL URL
  overrides before opening anything" (zero connects, zero fetches, with and without
  REST credentials).
- **Red → green**: `bash scripts/person-target/run-offline-tests.sh`: before the fix
  44 pass / 3 fail (the server case showed the sealed pool being constructed with the
  override URL); after: 47/47 (50/50 after R2-04's suite joined).
- **Limitation**: code-level and offline; the guard applies wherever the selection is
  required (legacy mode with no selection is unchanged, as the review scoped it).

### R2-02 Failed tenancy setup can disarm an unrelated controller (P1)

- **Confirmed** by running the real CLI sealed (`pg` replaced by a controller double,
  `fetch` failing the first fixture POST, controller enabled/open with an operator
  window): the pre-fix finally block performed `transition_set drain`,
  `maintenance_close <operator window>`, `transition_set seal`, `transition_set disarm`
  and printed "controller drained, sealed and disarmed before teardown".
- **Fix** `52a5d29`: `preflightArmedSweep()` before the first fixture write (REST and
  PostgreSQL URLs name the selection offline and report the same cluster through
  `person_target_identity()`; controller disabled, no windows, no unresolved work);
  `armForSweep()` arms by CAS and hands an ownership record (database identity, run,
  exact revision/generation read inside the arm's transaction) to the caller the
  moment the arm commits; `disarmAfterSweep({ownership})` requires that record, CASes
  every step on the recorded values, closes only windows opened under the sweep's run
  id, refuses foreign windows / stale state / another database and reports; lost
  commit acknowledgements are resolved only from the `transition_events` row written
  under the sweep's unique reason code (`tenancy_sweep_<action>_<run>`), never from
  `enabled=true`. The CLI skips teardown when the target was never proved and skips
  raw teardown when the controller could not be safely disarmed (fixtures retained,
  reported).
- **Regression**: `scripts/tenancy/test-armed-safety.mjs` (sealed, 12 cases): the real
  CLI with --armed and with --armed --keep against an enabled controller + window →
  refused before any fixture write, zero transitions/closes; setup failure while
  disabled → zero transitions, "did not arm it"; REST ≠ PG identity → refused before
  any write; hosted URL under `local` → refused offline without the secret in output;
  in-process: missing/stale/foreign-window/other-database records change nothing;
  two operators (drain+reopen → same phase, generation+1) → stale, refused; owned
  happy path (drain, own window closed, seal, disarm with the exact CAS values);
  unresolved work → drain then controlled stop; lost acknowledgement → resolved from
  the event, or unresolved and stopped when the controller moved meanwhile.
  `scripts/tenancy/test-armed.mjs` (database, 7 cases) adds preflight, ownership
  equality with the control row, `recoverArmOwnership` from the real events table,
  two-operator refusal by the real SQL CAS (`transition_stale`), and the owned
  sequence with the four event rows.
- **Red → green**: sealed suites 0/14 before (every case) → 14/14 after; database
  suite 7/7 (current and pinned runner).
- **Limitation**: the sealed CLI cases stop at setup (no probes); the full armed
  sequence through the CLI is the second HTTP run above (RR-14), which left exactly
  the sweep's own four event rows.

### R2-03 Shadow-mode reads revive an explicitly cleared email (P2)

- **Confirmed** on the disposable cluster: a legacy person with a verified
  `candidate_emails` row (`historical@example.test`), reconciled and anchored the
  supported way, linked by a shadow intake; the real certified
  `saveRecruiterContact(mode:'shadow', email:null)` returned NULL, the overlay email
  was NULL and `person_recruiter_primary` held `chosen_value NULL`; the linked
  detail, list and compose reads (REST answered from those rows, `PERSON_WRITE_MODE=
  shadow`) all returned `historical@example.test`; with a stale non-NULL scalar they
  returned the scalar.
- **Fix** `902cf11`: `poolContacts()` reads `person_recruiter_primary` for the batch
  (one query per 100 ids): absent row → permitted fallback (overlay, then verified
  history); row with NULL → email NULL and no history fallback for the other
  addresses; non-NULL → the overlay's spelling of the chosen address; a failed
  lookup is `pool_contact_unavailable` (compose null, detail 503, list null). No
  address is deleted; the published live path is unchanged.
- **Regression**: `test-edits.mjs` "R2-03: a certified shadow clear stays NULL on
  linked detail, list and compose" × 2 variants (NULL scalar, stale scalar), each
  with the control (no decision → history fallback), the clear, a later choice that
  supersedes it, a second clear, the history row still present, audit `verified`;
  `test-contact-recipient.mjs` gains `cleared`, `chosen`, `preferences-unavailable`.
- **Red → green**: `bash scripts/person-application-edits/run-local-tests.sh 55811`:
  61 pass / 2 fail before → 63/63 + 16/16 after.
- **Limitation**: shadow mode and unpublished people, as the review scoped it; the
  Send snapshot and resume-fill paths were not changed and keep their own tests.

### R2-04 The Harvest denial configuration names the wrong hostname (P2)

- **Confirmed**: every Harvest call in the code goes to `api.harvestapi.io`
  (`lib/server/sourcing/harvest.ts`, `lib/server/applicants.ts`,
  `scripts/refresh-worker.mjs`); the documented list and `test-outbound-guard.mjs`
  named `api.harvest-api.com`. Under the old documented list the real
  `harvestProfile()` reached the recording transport (`GET api.harvestapi.io`).
- **Fix** `6c9168b`: `api.harvestapi.io` in `scripts/person-target/README.md`,
  `scripts/tenancy/DISPOSABLE.md`, the cutover runbook and the guard test; new
  `scripts/person-target/test-provider-denial.mjs` drives the real Harvest (3 clients),
  Resend, Nylas (2) and Airtable clients with synthetic credentials under the
  documented list: nothing reaches the transport, counts
  `{harvestapi 3, resend 1, nylas 2, airtable 1}`, a control request passes, the
  worker's URL is read from its source. README states the per-provider scope of proof.
- **Red → green**: offline suite 48 pass / 2 fail with the old documented value →
  50/50. Runtime (RR-08 above): Resend and Harvest refused inside the final build.
- **Limitation**: the deployed preview's value was set from the old example and has
  not been re-read or changed (owner action; remote configuration is out of scope).

### R2-05 Armed tenancy uses an unhardened PostgreSQL pool (P2)

- **Confirmed**: `operatorPool()` returned `new pg.Pool(...)` with no `error`
  listener; emitting an idle error threw.
- **Fix** `52a5d29`: `operatorPool()` returns `openDatabase(env,'tt-tenancy-armed')`
  (the publish/transition CLIs' adapter: pool error listener, checkout-time
  `statement_timeout`, bounded connection/query waits, broken-client disposal via
  `person-db-session.mjs`); `ownedTransition` releases an in-doubt client with its
  error and never reports a step it cannot prove.
- **Regression**: `scripts/tenancy/test-armed-transport.mjs` (sealed, 2 cases: error
  listener present and an idle error not uncaught; a checked-out session that loses
  its backend rejects, is disposed, leaks no listener, and the adapter serves the next
  checkout); `test-armed.mjs` "transport loss during orchestration" (real
  `pg_terminate_backend` of the idle operator session and of a checked-out session;
  no `uncaughtException`; controller untouched).
- **Red → green**: sealed 0/2 → 2/2; database 7/7.
- **Limitation**: `pgSite` (reconcile) and the anchor adapter inside `armForSweep`
  keep their own handling (already covered by their suites).

### Upgrade guidance (older install)

The copy's artifact `23d7860` has 127 migration files and no
`20260928061000_person_resume_contact_fill.sql`; the runbook now states that an
older install must install that **missing** version before the four `20261003*`
forward files, that this is not a replay of an installed version, and that an
install from the prepared parent skips it. The upgrade harness already performs
exactly that sequence (`run-upgrade-tests.sh` `upgrade()`), followed by catalog
parity against a clean install: 25 + 4 + 63 + 16 + 4 + 3 on the final source.

### Integrated verification on the final executable source (`75684a5`, 2026-10-04)

Sequential, sanitized environment (Node v24.1.0), dedicated cluster 55811. Counts
are test executions as reported by the runners. The same matrix had the same counts
on `6c9168b` before the review follow-ups; a run under the shell's default Node 20
was discarded (its node:test semantics differ) and is not evidence.

| Check | Result |
|---|---|
| `tsc --noEmit --incremental false` | exit 0 |
| `next build` (empty environment) | exit 0 |
| `bash scripts/person-target/run-offline-tests.sh` | 50/50 |
| `node --test scripts/person-db-session/test-transport.mjs scripts/tenancy/test-armed-transport.mjs` | 18/18 |
| `node --test scripts/tenancy/test-armed-safety.mjs` | 12/12 (13 cases incl. the deferred-work case) |
| `node --test scripts/person-maintenance/test-start-catchup*.mjs` | 34/34 |
| `bash scripts/person-internal-resume/run-offline-tests.sh` | 13/13 |
| `bash scripts/person-application-edits/run-local-tests.sh 55811` | 63 + 16 |
| `bash scripts/person-release-upgrade/run-upgrade-tests.sh 55811` | 25 + 4 + 63 + 16 + 4 + 3 |
| `bash scripts/person-transition-cli/run-local-tests.sh 55811` (current; pinned) | 8 + 7; 8 + 7 |
| `bash scripts/tenancy/run-armed-local-tests.sh 55811` (current; pinned) | 7; 7 |
| `bash scripts/person-publish/run-local-tests.sh 55811` | 10 + 18 + 4 + 8 |
| `bash scripts/person-maintenance/run-local-tests.sh 55811` (current; pinned) | 10; 10 |
| `bash scripts/person-audit/run-postcutover-audit-tests.sh 55811` | 15 + 9 + 13 + 25 + 20 + 19 |
| `bash scripts/person-directory-outcomes/run-local-tests.sh 55811` | 6 + 40 + 35 + 12 + 237 + 25 + 3 + 20 |

All pass; 872 executions in the matrix plus 32 in the pinned reruns. The review's
769 and the earlier 913-call sweeps are historical figures for earlier commits, not
evidence for the changed code; the HTTP sweeps on the final source are in RR-14.

## Pre-release follow-up (2026-10-05): clears across publication, the production catch-up path, the runtime, browser smoke

Executable commits `63111d0` (explicit clears, forward migration `20261005090000`),
`16f34d4` (pinned catch-up runner), `12eadcf` (Node 24); the smoke seed script and
this documentation follow on top. Every database result below is from the dedicated
disposable cluster 127.0.0.1:55811 or the disposable local Supabase stack
(`remediation`, cluster identifiers quoted per run), Node v24.1.0, sanitized
environment. Baseline copy and original project: not queried, not written.

### 1. Explicit contact clears survive publication

- **Behaviour before**: `person_recruiter_primary` had one NULL. The 2026-09-26 ranking
  (`person_contact_ranks`) read it as "withdraw the manual preference, use the
  eligible fallback", so after a clear the live save returned the submitted address,
  the published drawer/list showed it and Send carried it; only the unpublished
  reads (R2-03) treated the NULL as a clear. Reproduced red on the pre-change chain:
  `test-edits.mjs` "live mode: an explicit email and phone clear survives publication"
  failed at *"the live save reports the clear, not a fallback"* with
  `'synthetic@example.test'` instead of `null`.
- **Change** (`63111d0`): forward migration `20261005090000_person_recruiter_explicit_clear.sql`
  adds `suppressed boolean not null default false` (+ check `chosen_value is null or
  not suppressed`); redefines `person_contact_ranks` so a suppressed kind gets no rank;
  patches the certified writer in place (`recruiter_normalize` target row and
  `recruiter_write` validation, through `person_private.recruiter_primary_suppressed()`
  so the body stays valid where the resume-fill tables are absent). States: absent row
  = no decision (ranking); `NULL, suppressed` = explicit clear; `NULL, not suppressed`
  = automatic (the historical meaning, now explicit); value = chosen. Recruiter saves
  write `suppressed=true` for an emptied kind; a resume fill preserves the row's flag;
  `contact.automatic` (library-level, no drawer control) writes `suppressed=false`.
  `poolEmails()`/`recruiterContactDecisions()` read the flag; the post-cutover audit's
  `one_primary_email/phone` expect zero primaries for a cleared kind.
- **Historical NULL rows (ambiguity, not reinterpreted)**: every NULL written so far
  came from a recruiter saving an empty field, but in live mode that save then showed
  the recruiter the fallback address, so whether they meant "clear" or accepted the
  fallback cannot be established from the data. They stay `suppressed=false`
  (behaviour unchanged) and the migration's NOTICE counts them. **Proposed treatment**
  for the owner before the sitting: run
  `select rp.candidate_id, rp.kind, r.edited_at, r.actor_id from person_recruiter_primary rp join person_recruiter_receipts r on r.id=rp.receipt_id where rp.chosen_value is null and not rp.suppressed order by r.edited_at`
  on the copy (read-only), confirm each with the recruiter who made it, and either
  re-save the clear through the drawer (writes `suppressed=true` with a new receipt)
  or leave it automatic. No bulk reinterpretation is proposed. On the disposable
  fixture the NOTICE reported 5 such rows (all synthetic test saves).
- **Regression evidence**: `test-edits.mjs` (live mode: clear both kinds → save result
  NULL/NULL, all contact rows kept with no rank, published contact NULL, Send snapshot
  `''`, audit `verified`; choose again → that address leads; `automatic` → the
  submitted address ranks first again): 61 → 64 pass; `test-contact-recipient.mjs`
  gains `automatic` (17); `test-recruiter.mjs` "clearing all fields is an explicit
  clear; automatic selection withdraws the preference" (13); server-paths mock serves
  the decision table (6). Upgrade path: old install → `20260928061000` → `20261003*`
  → `20261005090000` equals a clean install for `person_contact_ranks`,
  `recruiter_normalize`, `recruiter_write`, the helper and the table
  (`test-catalog-parity.mjs` 4/4; `run-upgrade-tests.sh` 25+4+64+17+4+4).
  Harnesses that run the recruiter writer install the new version
  (application-edits, transition-cli, upgrade, publish, postcutover-audit, audit,
  recruiter, recruiter-admission); the rest of the staged suites run older partial
  chains and are unaffected.
- **Runtime (browser smoke, below)**: on a *published* person the drawer clear →
  header, list, compose recipient and `net_` drawer all empty; `person_recruiter_primary`
  `email NULL,true` / `phone NULL,true`; three contact rows retained with no rank;
  re-selecting the historical address → rank 1 again.
- **Limitation**: the drawer has no "automatic" control; the state is reachable from
  the library only. Published-state semantics for the copy's historical rows are the
  owner decision above.

### 2. Connection-failure handling in the actual production catch-up path

- **The path, precisely**: the start helper (`start-catchup.mjs`, REST + a read-only
  directory client) creates the checkpoint; the pages run the **pinned** translator
  `c4d0e4e` `scripts/person-reconcile.mjs` main — website over REST (`restSite`,
  bounded `fetch`, errors caught), communications directory over `openComms`'s
  `pg.Client`; checkpoints are SQL (`person_reconcile_start/page/record_many`:
  `last_id` advances only inside `record_many`'s transaction). The pinned directory
  client has no `error` listener: an idle loss is an uncaught exception (process dies,
  run left `running`, the pinned loop's own `failed`/`reconcile_stopped` path never
  runs). Reproduced: `test-run-catchup.mjs` "without the helper" (child process:
  listeners 0, process dies).
- **Change** (`16f34d4`): `scripts/person-maintenance/run-catchup.mjs` runs the pinned
  main from the release checkout after the start helper's pin/clean-tree/bundle
  verification and a configuration contract (reconcile, queue, not dry, resume,
  selection), and attaches an `error` listener to every `pg.Client` the pinned tree
  creates (`catchup_comms_connection_lost:<SQLSTATE>` logged; the client stays
  unusable; the pinned loop fails the run at its next directory read). **What stays
  pinned**: the translator bundle (rebuilt from the clean pinned tree, hash recorded
  per run), `reconcilePage`, the external fingerprint, `restSite`, `openComms`, every
  SQL checkpoint. **Adapter used**: pinned `openComms` (`pg.Client`) + the listener;
  pinned `restSite` for the website.
- **Evidence** (`run-catchup-local-tests.sh`, real pinned runner on the local stack,
  REST website + loopback directory, 6/6): the directory connection terminated between
  pages → exit 1, `reconcile_stopped`, run `failed` with `reconciliation_pending`,
  `processed 1 of 4`, exactly one record, listener code `57P01`, no false success;
  resume with the identical configuration → `source_scan_complete`, 4 of 4 recorded
  once, `external_stable: true`, queue drained for them. The pinned loop's own
  sanitized note is `operation_failed:UNKNOWN` (its `safeErrorCode` sees no SQLSTATE on
  the dead client); the SQLSTATE is in the helper's log line.
- **Limitation**: the pinned checkout's own GitHub workflow (`person-trial.yml`) still
  names Node 20 and would run the bare client; the runbook's procedure is the helper
  from the release checkout (README updated). The local test's website REST is the
  local stack, not Supabase's hosted PostgREST.

### 3. Supported Node runtime

- **Declared and enforced** (`12eadcf`): `package.json#engines.node = 24.x`, `.nvmrc`
  24, `.npmrc engine-strict=true`, `setup-node` 24 in all eleven workflows,
  `scripts/check-node.mjs` run from `scripts/build-worker-lib.mjs` (every harness and
  worker builds the bundle first) → `node_runtime:unsupported:<version>` on any other
  major; `test-check-node.mjs` (offline suite now 52) checks the declarations agree.
- **The Node 20 failure, explained**: on 2026-10-04 one matrix run used the shell's
  default Node 20.19.2 by mistake. Under Node 20 `scripts/person-directory/test-directory.mjs`
  (sequential `await test()` registrations after asynchronous module work, one
  top-level `after(() => pool.end())`) ran its `after` hook after the first test and
  the remaining 24 cases failed with "Cannot use a pool after calling end on the pool"
  (with a `MaxListenersExceededWarning` for abort listeners, i.e. the remaining tests
  were started together). The same file under Node 24.1.0 runs sequentially and the
  hook runs last. The first test passes and the failures occur before any application
  code is exercised: an unsupported test environment (node:test lifecycle), not an
  application defect. A minimal reproduction without the real module graph did not
  reproduce it, so the root cause is recorded as observed on the real suite, not
  isolated further. Applicability to hosted runtimes: none established either way;
  the hosted runtime was never Node-24-verified and is now pinned by `engines`.
- **Hosted runtime check, prepared, not run**: `scripts/person-release/hosted-runtime-check.sh`
  (read-only: project `nodeVersion`, the deployment's build-log Node lines, the
  workers' setup-node version). Note that `engines.node=24.x` changes the hosted
  runtime on the next deployment (Vercel honours it over the project setting), and the
  workers move from Node 20 to 24 when the workflow changes land: a release decision,
  listed under external actions.

### 4. Local browser smoke on the final build

Exact production build of `12eadcf` (`next build` with the disposable environment,
`next start` on 127.0.0.1:3400), local Supabase stack reset to the full chain (134
versions incl. the local bootstrap), `PERSON_TARGET_PROJECT_REF=local`, live mode,
transition support on, provider hosts denied (`api.harvestapi.io`, Resend, Nylas,
Airtable, OpenAI, LlamaIndex), placeholder provider keys. Synthetic data from
`scripts/tenancy/smoke-seed.mjs`: TT login `smoke+tt@example.com` (local Auth magic
link, the app's own sign-in flow), roles #99101 "Senior Backend Engineer" and #99102
"Staff Platform Engineer", pool person "Jordan Avery" with three positions, two
education entries, ten skills, two verified addresses and a phone, linked TT
application for #99101, report-card verdicts for both roles; the person normalized and
anchored (reconcile + anchors), controller armed, published through the publish CLI
inside a publication window (projected 1), controller left armed/open.

| Step | Observed (real clicks/typing in the built-in browser; DOM/computed-style read where the pane was too small to see) |
|---|---|
| Sign-in | magic link → `/dashboard`, member of Transformer Talent |
| Candidates list | one row: Jordan Avery, Applied, Contact now, email and phone shown ("click to copy") |
| Drawer, Fit tab (#86) | "ALSO A MATCH · 1 ROLE — Staff Platform Engineer #99102 suggested — Worth a message", below the applied role's report card |
| Drawer, Profile tab (#85) | at an 825 px drawer width: `display: grid`, `grid-template-columns: 496.97px 247.03px`; Experience (Northwind Analytics, Harbor Logistics, Lakeside Software) in the left column; the side column reads EDUCATION (State University — Bachelor of Science, Computer Science, 2011-2015; Community College of Travis County) then SKILLS (TypeScript … Mentoring) |
| Contact clear (published person) | Edit → email, phone, other emails emptied → Save: `PUT /api/dashboard/candidates/v2/app_…/contact` 200; header "+ Add email / + Add phone", the old secondary address not revived; database: `email NULL,suppressed` / `phone NULL,suppressed`, three contact rows retained with no rank, projection present, live receipt effective email/phone NULL |
| List after reload | "No email — add it in the profile", "No phone — add it in the profile" |
| Recipient selection | `POST /api/dashboard/email/context` → `candidate.email: null`; `net_` drawer detail contact all null |
| Choose again | Edit → `javery.old@example.test` + phone → Save 200; header shows both; database: chosen values, `suppressed=false`, ranks 1 (old address) / 2 |
| Leak test while armed by the smoke | the plain sweep refused its first raw seed (`candidate_mutation_frame`), cleaned its own partial rows, **left the controller untouched** (rev 2 / gen 2) |
| Final sweeps on this build | after clean resets: disabled run 913 calls PASS; armed run `4apmfef71` 913 calls PASS with the four owned event rows (rev 2→5), cluster `7692871593400872999`; attestation: REST = PG identity, anon 401, correct selection 200, wrong selection 500 `person_target:rest_mismatch` (public 200), `outbound_denied:api.resend.com` (502), `outbound_denied:api.harvestapi.io` (route 200, empty) |

Limitations: the desktop app's browser pane was 280 px wide, so the emulated
1100 px viewport was scaled ~4× down; layout was verified from the DOM and computed
styles plus a low-resolution screenshot, not by eye at full size; the compose panel
requires a connected mailbox (Nylas, denied here), so the recipient was taken from the
same endpoint the panel calls; the Network list was empty (its fit view needs
matcher data not seeded) — the `net_` drawer was read through its API. The sign-in
used the local Auth's magic link with `site_url` set to the smoke server in the
uncommitted local `supabase/config.toml`. Evidence class: local runtime, synthetic
data; nothing here is hosted evidence.

### 5. Verification on `12eadcf` (superseded by section 7)

Integrated matrix (Node v24.1.0, cluster 55811, sequential) 879 + 32; `run-catchup-local-tests.sh`
6/6; `person-recruiter` 13+4+6; `person-recruiter-admission` 72+5;
`person-audit/run-local-tests.sh` 21+68+28+23+10. Historical: the F1–F6 changes
(`0ffa133`) came after; see section 7 and the manifest for the final figures.

### 6. Follow-up review (2026-10-04, `RELEASE_FOLLOWUP_REVIEW_2026-10-04.md`): F1–F6

Reviewed executable head `12eadcf`; the review file is in this session's uploads and is
unchanged. All six corrected in `0ffa133`; each regression ran red on the prior source
(the review's own reproductions) and green after. Database evidence on cluster 55811
and the local stack (clusters quoted), Node v24.1.0.

- **F1 (P1) catch-up wrapper validated different settings from those executed.**
  `run-catchup.mjs` now refuses CLI arguments (`catchup_run:arguments`) and
  `BACKFILL_*` aliases (`catchup_run:aliases`) before anything else; refuses a pinned
  tree carrying `.env`/`.env.*` (`catchup_run:pinned_env_file`, since the pinned
  loader fills *missing* variables such as `LOCAL_DATABASE_URL`, which would switch
  `openSite()` from the validated REST destination to PostgreSQL); snapshots the eight
  pinned-visible variables, re-reads them after importing the pinned modules
  (`catchup_run:environment_changed`), parses the pinned `options([], env)` and
  compares run, commit (= pin), dry, resume, limit, batch and bounds with the
  validated JSON (`catchup_run:options_mismatch`); prints the effective options it
  will consume. Evidence: `test-run-catchup-inputs.mjs` (sealed: inputs, env-file
  tree, ordering before verification) and `test-run-catchup.mjs` "late inputs against
  the real pinned tree" (aliases, `--dry-run=true`, `--commit=…` → exit 1 before any
  transport; the run row untouched).
- **F2 (P1) upgrade revived historical unpublished clears.** `20261005090000` now
  classifies existing NULL decisions by what every reader showed before the upgrade:
  unpublished person → `suppressed=true` (proven clear: the receipt recorded and
  returned the requested NULL and all readers resolved it as a clear), with stored
  ranks recomputed for those people; published person → `suppressed=false`
  (automatic; the ranking showed the fallback and the live save showed the recruiter
  that fallback), counted by the NOTICE for per-row owner review. Nothing is restored
  or hidden by the upgrade itself. The recruiter guard triggers and the epoch trigger
  are suspended for exactly these statements (the epoch trigger ignores `suppressed`
  and `rank` is not an epoch column). Evidence: `test-upgrade-clears-before/after.mjs`
  in the upgrade harness — historical rows created on the pre-migration schema
  (A: unpublished shadow clear + history + stale scalar; B: published live NULL;
  C: unpublished phone-only clear + stale scalar phone), upgraded, then A has no email
  on linked detail/compose/`net_`/ranking and the real checked Send admits a blank
  snapshot (stale one refused); B keeps the fallback; C has no phone and keeps its
  email. NOTICE on the harness: "3 … are clears (suppressed), 1 left automatic".
- **F3 (P2) unpublished phone clears bypassed by readers and Send.** `poolPhone()`
  (decision → overlay → scalar; failed lookup reads as cleared) is used by the Network
  list, the `net_` drawer, Send's `bestPhone` and the linked reads; `poolEmails()`
  accepts pre-fetched decisions so each surface reads them once. Evidence: upgrade
  case C; edits suite; browser: an unpublished person's phone cleared in the real
  drawer with the scalar still `+1512555…` → linked detail, list, `net_` drawer and
  compose show no phone while the email stays.
- **F4 (P2) checked Send disagreed with the suppression-aware caller.** Forward
  migration `20261005100000_person_send_decisions.sql` patches `person_network_send`'s
  unpublished branch in place to apply the same semantics (cleared → none, chosen →
  leads, else overlay/scalar/history); the published branch, the locked stale-snapshot
  comparison, the witness and the insertion are unchanged; a clean install and an
  upgraded install converge (catalog parity). Evidence: the real `person_network_send`
  executed after shadow and live clears in the edits suite (`sent`, `email ''`,
  `contact` without the cleared kind, `already_sent` on repeat, stale snapshot →
  `contact_changed`), and in upgrade cases A and C.
- **F5 (P2) pinned verifier rejects legitimate suppressed contacts.** Two parts.
  (a) Current translator: `readNew()` loads `person_recruiter_primary` so
  `checkStored`'s one-primary rule recognises a clear; a cleared person pending in the
  queue is reconciled by the current translator without an integrity complaint
  (edits suite). (b) Pinned translator: it cannot verify such a person (its rule
  predates clears) and would fail `post_save_integrity:one_primary_*` before any
  checkpoint; `run-catchup.mjs` now reads the queue first and refuses the run with the
  candidate ids (`catchup_run:suppressed_pending`) instead of failing mid-page
  (`test-run-catchup.mjs`). **Owner decision**: a queue containing cleared people
  (any recruiter edit after the historical catch-up re-queues the person) cannot be
  completed by the pinned translator; options are (1) run those people — or the
  final catch-up — with the current translator under a reviewed exception to the
  `c4d0e4e` pin, or (2) re-save their decisions before the sitting. The review's
  acceptance "valid clears pass and checkpoint once" is met by the current
  translator, not by the pinned one.
- **F6 (P2) runtime declaration not enforced at the real entry points.** `checkNode()`
  is the first statement of `run-catchup`, `start-catchup`, the finalizer, publish,
  transition, anchors and the leak test; every harness runs `node scripts/check-node.mjs`
  before any fixture DDL (`test-check-node.mjs` checks order ignoring comments); the
  CLI sanitizers pass `node_runtime:unsupported:<version>` through. Evidence:
  `test-run-catchup-inputs.mjs` spawns the seven entry points and the offline harness
  under the actual Node 20.19.2 interpreter (each stops with the code and no phase
  output) and the runner under Node 24 (proceeds to its own input check).

### 7. Final verification on `90ebc0b`

Integrated matrix (Node v24.1.0, cluster 55811, sequential): **892 executions**, all
pass (`tsc`, `next build`, offline 57, transport 18, tenancy safety 12, catch-up
helper offline 34, internal resume 13, application edits 64 + 17, upgrade
25 + 4 + 4 + 4 + 64 + 17 + 4 + 4, transition 8 + 7, armed SQL 7, publish 10 + 18 + 4 + 8,
maintenance 10, post-cutover audit 15 + 9 + 13 + 25 + 20 + 19, directory
6 + 40 + 35 + 12 + 237 + 25 + 3 + 20); pinned-runner reruns 8 + 7, 7, 10; stage
harnesses recruiter 13 + 4 + 6, recruiter-admission 72 + 5, audit
21 + 68 + 28 + 23 + 10. On the local stack (build of `0ffa133`; `90ebc0b` differs only
by a no-op guard clause in `20261005100000`, identical function body on the release
chain): catch-up suite 8/8; disabled sweep 913 PASS; armed sweep `a1xbyb042` 913 PASS
with the four owned event rows; attestation unchanged (REST = PG
`7692913108189810727`, anon 401, correct selection 200, wrong selection 500
`rest_mismatch`, `outbound_denied:api.resend.com`, `outbound_denied:api.harvestapi.io`);
browser: phone-only clear on an unpublished person through the drawer (F3; scalar
phone still stored, no surface shows it) and the section-4 flows unchanged.

## Disposable environment for the hosted sweep (option 1 executed, option 2 proposed)

The sweep needs Supabase Auth + REST + PostgreSQL. Two ways to get a disposable one:

1. **Local Supabase stack (zero cost)**: `supabase start` in the branch checkout,
   `supabase db reset` to install `001…20261003*`, `next build && next start` with
   loopback URLs, `PERSON_TARGET_PROJECT_REF=local`, `OUTBOUND_DENY_HOSTS`, no provider
   keys; run `test-tenancy.mjs --base http://127.0.0.1:3000` disabled and `--armed`.
   **Used on 2026-10-04** after Spencer raised Docker Desktop's disk limit from 60 GB
   to 120 GB (its virtual disk was full; settings backed up first, nothing deleted).
   Procedure in `scripts/tenancy/DISPOSABLE.md`. Results above.
2. **New Supabase project (only if the Vercel-hosted deployment must be attested
   before the sitting)**: in organization
   "Transformer Talent" (`nanvovpwibjdlhhfmfix`), region `us-east-2`, Micro compute:
   `supabase projects create tt-disposable-tenancy --org-id nanvovpwibjdlhhfmfix --region us-east-2 --size micro --db-password <generated, never printed>`.
   Cost: Micro compute is billed hourly (about $0.0134/hour, $10/month equivalent);
   two days of testing is under $1; delete with `supabase projects delete <ref>` when
   done. Then: install `001…20261003*` with `supabase db push` (schema only, no
   data), repoint the branch preview's 17 variables at it (REST URL/keys, pooler
   URLs, `PERSON_TARGET_PROJECT_REF=<new ref>`, `OUTBOUND_DENY_HOSTS`, no live
   provider keys), redeploy, run `test-tenancy.mjs --base <preview>` disabled and
   `--armed` with the fixture pointed at the same project, compare
   `person_target_identity()` through REST and PostgreSQL, record the results, delete
   the project. Requested action: approve the project creation (the CLI is signed in
   as Spencer; I will not create a paid resource without the word).

## Independent review

### Second round (2026-10-04, R2 changes `ae70f76..6c9168b`)

Two read-only reviewers, separate areas (A/B: target parsing and the contact clear;
C/D: cleanup ownership/CAS and transport), with the installed driver, the sealed
suites and the dedicated cluster. Neither found a defect in the delivered fixes'
core claims; their follow-ups and the fixes (`75684a5`, with regressions):

- *A1 (P2)* a database URL with a leading/trailing space or malformed `%xx` passed
  the validator (WHATWG `URL` trims) while pg re-encodes it and resolves it against
  `postgres://base`, connecting to host `base` with the whole URL, password included,
  as the database name → refused (`database_url`), verified with
  `connectionParameters.host === 'base'`.
- *A2 (P3)* URL without port/username/database let pg take `PGPORT`/`PGUSER`/
  `PGDATABASE` from the environment → explicit port, username and database required
  (`database_port`, `database_role`, `database_url`).
- *A3 (P3)* `sslmode=disable|allow|no-verify|prefer` accepted on hosted hosts →
  hosted URLs accept `require`/`verify-ca`/`verify-full` only.
- *B1 (P2)* the clear was honoured on linked (`app_`) reads only; the pool person's
  own drawer (`net_`), the Network list and Send's `bestEmail` still ranked the scalar
  and history and Send would persist the revived address → the decision now lives in
  `poolEmails()`, the ranking all of those use; regression extended to the `net_`
  drawer and the Send ranking.
- *B2 (P3)* a cleared phone was revived from `candidates.phone` → decisions read for
  both kinds; sealed case added.
- *B3 (P3, not changed, owner decision)* for a **published** person in live mode the
  SQL ranking (`person_contact_ranks`, 2026-09-26 design) treats a NULL choice as
  "withdraw the manual preference, fall back to the eligible ranking", so a clear
  made while unpublished flips to the fallback address when the person is published.
  The live save already reports that fallback to the recruiter, so nothing is silent;
  but the two states disagree and should be decided deliberately (release question,
  not changed here).
- *B4 (P3)* a stale non-NULL choice would show if a legacy writer nulled the overlay
  without touching the decision → the overlay spelling now leads only when the
  ranking admits it; otherwise the ranking's first address.
- *C/D (P2)* the reconcile shim's pool (`pgSite`) had no error listener: an idle loss
  during step 1 of the armed sweep would die uncaught (controller untouched, but the
  CLI's `finally` would not run) → listener added to the current shim; the armed sweep
  uses the current shim (superset of the pinned one) with the pinned translator.
  Reviewer note kept: the pinned checkout's own `pgSite` still has no listener; the
  production catch-up runs it as the historical runner (owner item).
- *C (P3)* preflight refused `deferred` work, which the SQL treats as resolved →
  aligned (double aligned too); the partial-disarm message now names the owned state.
- Confirmed correct by the reviewers: every finally path of the CLI; revision
  uniqueness makes same-phase foreign changes detectable; recovery never adopts
  foreign state; reason codes fit for every run id; lossless text bigints; the
  hardened adapter's disposal and `end()`; REST reads of `person_recruiter_primary`
  under service role; failure handling of all three linked consumers.

### First round (2026-10-03)

Two reviewers (read-only, separate areas) examined the integrated changes after
implementation. Neither found a blocking defect. Their findings and the fixes:
gate cache keyed on the full key hash; worker scripts gated before their own REST
helpers; trailing-dot hostnames in the guard; finalizer selects the finish result by
content and captures CLI stderr; start-catchup reports an unrecognizable comms URL
as a credentials failure; recovery reconstruction uses the trigger's exact stripped
set; catalog parity phase; in-doubt commit case; pre-publication profile comparison
in the undo case; Send-specific pending assertions. All are in commits `315918d` and
`8bd8fd3` with regression tests. Noted but not changed: the guard covers `fetch` only;
clean harnesses other than application-edits do not install the `20261003*` files
(the upgrade harness's phase 5 does); the `DISABLE TRIGGER` step takes a share-row-
exclusive lock and belongs in the held phase.

## Hosted-preview validation plan (prepared 2026-10-05; NOT executed; needs approval)

Purpose: the one evidence class still missing, the deployed server's own runtime and
destinations, on a separate disposable target, never the baseline copy or production.

1. **Disposable target**: new Supabase project `tt-disposable-tenancy` in organization
   "Transformer Talent" (`nanvovpwibjdlhhfmfix`), region `us-east-2`, Micro compute
   (`supabase projects create … --size micro --db-password <generated, never printed>`).
   Cost: Micro is billed hourly (about $0.0134/h, ≈$10/month); a two-day window is
   under $1. Schema only: `supabase db push` of the full chain `001 … 20261005090000`
   (134 files; the local bootstrap `000` is replaced by the project's own base tables
   as in production), `resumes` bucket, Auth `site_url` = the preview URL.
2. **Preview configuration** (branch `fix/person-90-release-remediation`, a fresh
   deployment after the push): `PERSON_TARGET_PROJECT_REF=<new ref>`;
   `SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_URL`/keys of the new project;
   `PERSON_DATABASE_URL` (pooler 6543, user `postgres.<new ref>`) and
   `PERSON_PUBLISH_DATABASE_URL` (5432) of the new project;
   `OUTBOUND_DENY_HOSTS=api.us.nylas.com,api.resend.com,.airtable.com,api.harvestapi.io`
   (correcting the `api.harvest-api.com` value set on 2026-10-03); placeholder
   `RESEND_API_KEY`, `NYLAS_*`, `HARVEST_API_KEY` (so the routes take their live path
   into the deny list), `SOURCING_PROVIDER_MODE=live`; no Airtable token, no OpenAI key;
   `PERSON_WRITE_MODE=live`, `PERSON_TRANSITION_SUPPORT=on`; Turnstile test keys.
   Variable names only; values set in Vercel, never printed.
3. **Server identity and runtime** (read-only against the preview):
   `scripts/person-release/hosted-runtime-check.sh <project> <deployment>` (project
   `nodeVersion`, build log "Node.js 24.x", workers' setup-node);
   `person_target_identity()` through the preview's REST (service role) must equal the
   new project's PostgreSQL `pg_control_system()`; a signed-in dashboard read 200; the
   same deployment redeployed with `PERSON_TARGET_PROJECT_REF` naming the copy must
   answer 500 `person_target:rest_mismatch` to the same request (then restored).
4. **Provider denial on the deployment**: team invite → 502 with
   `outbound_denied:api.resend.com` in the function log; company search →
   `outbound_denied:api.harvestapi.io`; both logs read through `vercel logs`.
5. **Tenancy sweep from a machine with the fixture pointed at the new project**:
   `node scripts/test-tenancy.mjs --base <preview>` (disabled), then
   `PINNED_RUNNER_DIR=… node scripts/test-tenancy.mjs --base <preview> --armed`
   (preflight proves REST = PG on the new project before the first write; owned
   drain/seal/disarm afterwards). Expected: 913 calls PASS each; the four
   `tenancy_sweep_*` event rows only.
6. **Browser smoke on the preview**: `scripts/tenancy/smoke-seed.mjs` against the new
   project (`PERSON_TARGET_PROJECT_REF=<new ref>`, its 5432 URL), the same steps as the
   local smoke (sign-in by the preview's magic link, drawer #85/#86, clear, list,
   recipient, choose again), in a full-width browser.
7. **Cleanup**: `--cleanup` sweep, delete the smoke login, remove the branch's
   preview variables for the disposable project (or repoint them), `supabase
   projects delete <new ref>`; record the project id, the hours billed and the
   deletion time in the ledger.

What it will not prove: production's own configuration (the same checks are repeated
at the sitting, after the identity migration is installed there), RR-09 accounting,
RR-10 disposition.

## Remaining external actions (prepared; none performed under the 2026-10-04/05 instructions)

1. **Push** the branch (`origin` is at `ae70f76`; 10 commits ahead); pushing triggers a
   preview deployment that will build and run on Node 24 (`engines`).
2. **Approve the hosted-preview validation** above (disposable project under $1) or
   defer it to the sitting against production.
3. **Correct the branch preview's `OUTBOUND_DENY_HOSTS`** to `…,api.harvestapi.io`;
   keep that preview unused while it points at the baseline copy.
4. **Copy upgrade** (write to `qsqlgibgsxzlimoegcjx`): `20260928061000` (missing there),
   the four `20261003*` files, then `20261005090000` and `20261005100000`, in order;
   the NOTICEs report the witness recovery and the classification of historical NULL
   decisions (clears kept / published rows left automatic).
5. **Historical NULL decisions of published people** (left automatic by the upgrade):
   run the read-only listing query (section 1 above) on the copy and decide per row
   with the recruiter; no bulk reinterpretation.
5b. **Cleared people in the catch-up queue (F5)**: decide between running them (or
   the final catch-up) with the current translator under a reviewed exception to the
   `c4d0e4e` pin, or re-saving their decisions before the sitting; the pinned runner
   refuses such a queue with the ids.
6. **Runtime change decision**: the next deployment and the workers move to Node 24.
7. **RR-10 disposition** of the 23 experience rows; **RR-09** rehearsal (catch-up via
   `run-catchup.mjs`, anchors, publication, final audit at a declared cutoff) and the
   production sitting. Counts in this ledger remain historical observations.
8. **PR review** of the branch.

Disposable resources, state at the end of the 2026-10-05 work (after the F1–F6 round):
the dedicated cluster 127.0.0.1:55811 is **stopped** (`pg_ctl stop`; data directory under this session's
scratchpad, deletable); the local Supabase project `remediation` is **stopped with its
volumes retained** (`supabase_db_remediation`, `supabase_storage_remediation`; last
state: the clean 135-version chain plus the final armed sweep's three retained
synthetic people, earlier smoke and catch-up fixtures having been reset away; `supabase stop --no-backup` in the branch checkout
deletes them); nothing was deleted; the uncommitted local `supabase/config.toml` now
has `site_url = http://127.0.0.1:3400` for the smoke sign-in; the
`.claude/launch.json` entries remain. No other local service was touched (another
local Supabase project, `replyops-c13-recovery`, ran on this machine throughout and
was left alone).
