# Candidate storage release remediation

Ledger for the fifteen findings of `RELEASE_READINESS_REVIEW.md` (review date
2026-10-02; that file is unchanged). Remediation branch
`fix/person-90-release-remediation`, started 2026-10-03 from the prepared parent
`feat/person-00-storage-unification` at `c8fda5bfd50e8c40f22a3083e38c6eea71d0a803`
(which already contains current `main` `9a3240c`, including the private internal
resume endpoint). Status words: **implemented**, **verified** (evidence on the final
source in this branch), **blocked** (needs an action outside this branch's
authorization), **obsolete** (shown no longer applicable).

**Current status — October 5: READY for hosted manual testing, not released.**
The tested source is `13f1b308f4e6a43b03cda752a001897c3295dbce`, deployed to
[the fixed preview](https://transformer-talent-website-87oyi44go.vercel.app/dashboard/network?job=99101)
against the approved existing `tt-test-copy`. See
[HOSTED_TEST_READINESS.md](HOSTED_TEST_READINESS.md) for exact runtime/recovery
accounting and [MANUAL_ACCEPTANCE_PLAN.md](MANUAL_ACCEPTANCE_PLAN.md) for the 16
manual cases, criteria and unfilled results sheet.

- **Implementation:** `79af7eb` closed the receipt-based historical-clear upgrade
  gap, introduced the bounded compatible historical verifier, and removed the
  capped decision scan. `13f1b30` confines armed rehearsal preparation to owned IDs
  and refuses controller races before writes. Prior evidence below remains tied
  to its stated source.
- **Hosted setup:** branch pushed/deployed on Node 24; copy recovered to a safe
  review state, nine upgrades applied, branch-only target/provider settings fixed.
  Both disabled and armed tenancy sweeps passed 913 calls. Hosted contact probes,
  target refusal and provider denial are evidenced in the hosted report.
- **Recovery:** three old application attempts remain parked for review, with zero
  recovered/completed. The copy is available and armed/open for manual testing.
- **Release approved: no.** Manual acceptance, full declared-cutoff migration
  accounting/publication/audit (RR-09), RR-10 disposition, production configuration
  checks, PR review and Spencer's release approval remain open. No main merge,
  production write/deploy, paid enrichment or real candidate message occurred.

The earlier statement that F1–F6 were all closed on `0ffa133` / `90ebc0b` was too
broad: F2 missed published-then-shadow clears and F5 still refused legitimate clears.
Section 8 records the subsequent local corrections. Dated sections below are
historical observations; the October 5 hosted report supersedes their unpushed,
copy-untouched and unverified-hosting statements.

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
- **Historical live NULL rows (ambiguity, not reinterpreted)**: in the old live
  mode, an empty field could return an eligible fallback, so intent cannot be
  inferred for every such row. The `79af7eb` forward correction first preserves
  provable completed shadow clears, including people with an older publication.
  Remaining ambiguous rows stay automatic. **Proposed treatment**
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
- **F5 (P2) pinned verifier rejects legitimate suppressed contacts — prior
  workaround superseded.** `90ebc0b` refused a queue containing a clear and scanned
  only a capped first page of global decisions. It did not meet the acceptance
  criterion. The current-translator test also allowed `review`, which is not proof
  of verified/drained clears. `79af7eb` replaces that workaround with a separately
  identified historical runtime; see section 8 for real verified outcomes,
  checkpoint failures, races and the source-review boundary. Do not re-save a
  recruiter's choice to make a migration verifier pass.
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

### 8. Local closure of F2/F5 and capped-scan review (`79af7eb`, 2026-10-04)

Scope: local implementation, synthetic local databases, tests, review and commits.
The baseline copy and original project were not queried or written. Existing
installed migration files and the historical pinned tracked tree are unchanged.

**F2 — current receipt evidence, including after publication.** New forward version
`20261005110000_person_historical_shadow_clears.sql` repairs the classification left
by `20261005090000`. A current NULL choice becomes suppressed only when its own
completed shadow receipt records explicit requested/effective JSON NULL and no
explicit automatic selection. An old clear cannot override a later chosen value.
Receipts, legacy fields, candidate IDs and projection rows are preserved. A stale
publication still refuses live reads/Send until certified republishing. The
migration uses `NOWAIT` table locks and restores exact trigger modes; contention
refuses atomically instead of waiting in a save/migration lock cycle.

The regression runs the real certified old-schema writer: publish, then shadow
clear email, phone or both; upgrade; inspect linked detail, recipient, `net_` drawer
and ranking; replay the old receipt; republish; run real checked Send. The old chain
failed the suppression assertion, the correction passes. A superseded-clear control,
ambiguous live-NULL control, immutable receipt/projection checks, two-connection
lock refusal, idempotence and disabled/replica/always trigger restoration also pass.

**F5 — compatible historical verification, with exact artifact approval.**
`run-catchup.mjs` derives an isolated runtime from the clean
`c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc` checkout. The translator bundle,
reconcile loop, backfill/engine and checkpoint semantics remain byte-identical.
Only contact evidence loading and the suppression rule in the historical verifier
change. Unsuppressed contacts retain the old eligibility rule, including an eligible
fallback after a selected address bounces. Explicit clears require every rank to be
NULL; contact history remains intact.

New `20261005120000_person_catchup_contact_snapshot.sql` is a read-only,
service-role-only STABLE/SECURITY INVOKER scalar RPC. Contacts, decisions, summary,
revision and per-person counts come from one statement snapshot. It accepts at most
500 IDs, checks at most 10,001 contact rows to enforce a 10,000-row limit, and refuses
a conservative 8 MiB serialized budget before aggregation. It never truncates
proof. Missing, malformed, duplicate or incomplete evidence stops verification.
There is no global suppression scan. Hosted use requires both the compatibility ID
and the exact reviewed composite SHA256 before imports/transport. The complete
input/output manifest is `docs/person-catchup-compatibility-manifest.json`:
`0d30436b535ffc015624b7f8f0153c6cf769908ed6e6a31597f8e71659407250`.

**Actual outcomes, kept separate.** On a fresh local Supabase stack, the wrapper's
interrupted run resumed with exactly seven verified/count-once people: four
synthetic directory people plus email-only, phone-only and combined clears. A
certified scalar clear racing after the snapshot became pending at the revision/
capture comparison; a new bounded run verified it and drained its queue entry. A
certified clear of curated legacy contact also became pending, but its new run
remained `review` with `same_snapshot_mutation`. That review stays queued and does
not count as verified. The historical cursor advances for pending/review outcomes;
same-run resume cannot revisit an already-visited ID. Start a new bounded queue run
and retain source conflicts for disposition. This is unchanged historical policy.

The real PostgREST table response capped 1,500 contacts at 1,000; the scalar RPC
returned all 1,500 and the wrapper verified a target beyond 1,002 unrelated global
suppression decisions. Missing/partial snapshots and actual suppressed rank-1/rank-2
corruption recorded no person result and advanced no checkpoint; valid retries
verified. Row/byte overflow refused without removing evidence; a 10,000-row
near-budget case passed below the bound and refused after crossing it.

Fresh verification (Node v24.1.0, sanitized environment; no skipped tests):

| Evidence | Result |
|---|---|
| Upgrade: old install, actual historical clears, full edits/recipient tests, clean-install parity | 132/132 (`25 + 6 + 4 + 8 + 64 + 17 + 4 + 4`) |
| Target/provider/runtime/input + derived-verifier offline matrix | 64/64 |
| Start helper and transport regressions | 52/52 |
| Actual REST website + PostgreSQL directory catch-up | 14/14, fresh stack |
| Production build and TypeScript | both exit 0; build ID `2Bg1PIpILfNk5vLzVzxcn` |
| Local identity and new RPC privilege probe | REST = PostgreSQL; anonymous snapshot call 401 |
| Final built-app tenancy sweeps | disabled 913 PASS (`d9ll8b3c9`); armed 913 PASS (`dfssp6368`), exact owned four events and final disabled revision 5 |

The first disabled sweep reported 38 `email_off` responses because the local
synthetic setup lacked `NYLAS_CLIENT_ID`. That failed run remains recorded; adding
the synthetic client ID and restarting the unchanged build produced the passing
913-call run above, with provider blocking retained. A separate ad hoc privilege
probe initially used the wrong RPC parameter and returned 404; the corrected
`p_candidate_ids` request returned service-role 200 and anonymous 401.

Final armed-run identity: REST = PostgreSQL cluster `7692936694211489829`.
Preflight found disabled revision 1; arm owned revision 2/generation 2; cleanup
performed only its own drain/seal/disarm through revision 5. A subsequent read-only
check found exactly its four event rows, disabled controller, zero Auth users and
three retained normalized synthetic people. Ordinary fixture rows were removed;
the three immutable normalized people remain in the stopped disposable volume.

The worker bundle hash remains `29b7c96ab054fca3e5d9b0afbe209c7430b03646a8b440fbeb8fab0309ad3480`;
application source and dependency lockfile are unchanged by this closure. The
historical translator bundle remains `c04e8c18657ffc03bac75f03a34b6772b8d8d878958635ff03b9ca0717f197a5`.
Earlier 892-test and browser figures above are historical evidence, not newly run
counts. This pass does not attest a hosted deployment, decide ambiguous historical
live NULLs, dispose of RR-10 rows, or complete RR-09 against real data.

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

### Local closure review (`a9d14b1..79af7eb`, 2026-10-04)

Independent reviewers inspected F2's receipt-based correction/upgrade tests and
F5's derived runtime/snapshot/wrapper separately. A separate design review checked
revision races, cursor advancement and historical source-conflict semantics.
Findings incorporated before closure: migration lock refusal; preserving the
ordinary selected-then-bounced fallback; complete snapshot validation; bounded
row/byte aggregation; qualified correlated SQL aliases; and approval bound to
artifact bytes. Final rereads reported no remaining code findings within scope.
Reviewers used source inspection and sealed probes; fresh database/build evidence
is recorded separately in section 8, not attributed to their review.

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

## Historical new-project proposal (superseded; do not execute)

This unexecuted proposal is retained as history. Spencer subsequently authorized
using the existing copy; the hosted setup in HOSTED_TEST_READINESS.md replaces this
procedure. In particular, the local bootstrap/smoke seed must never be pointed at
a hosted database and this proposal does not authorize deleting the existing copy.

1. **Disposable target**: new Supabase project `tt-disposable-tenancy` in organization
   "Transformer Talent" (`nanvovpwibjdlhhfmfix`), region `us-east-2`, Micro compute
   (`supabase projects create … --size micro --db-password <generated, never printed>`).
   Cost estimate retained from the earlier plan: about $0.0134/h for Micro;
   verify current pricing and the approved budget before creating any resource.
   Schema only: `supabase db push` of the full chain `001 … 20261005120000`
   (136 tracked migration files; the local bootstrap `000` is replaced by the
   project's own base tables as in production), `resumes` bucket,
   Auth `site_url` = the preview URL.
2. **Preview configuration** (branch `fix/person-90-release-remediation`, a fresh
   deployment after the push): `PERSON_TARGET_PROJECT_REF=<new ref>`;
   `SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_URL`/keys of the new project;
   `PERSON_DATABASE_URL` (pooler 6543, user `postgres.<new ref>`) and
   `PERSON_PUBLISH_DATABASE_URL` (5432) of the new project;
   `OUTBOUND_DENY_HOSTS=api.us.nylas.com,api.resend.com,.airtable.com,api.harvestapi.io`
   (correcting the `api.harvest-api.com` value set on 2026-10-03); synthetic placeholder
   `RESEND_API_KEY`, `NYLAS_API_KEY`, `NYLAS_CLIENT_ID`, `HARVEST_API_KEY` (so the routes
   take their live path into the deny list), `SOURCING_PROVIDER_MODE=live`;
   no Airtable token, no OpenAI key;
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

## Historical external-action list (before hosted setup; see current report)

1. **Push** the reviewed branch (`origin` was left at `ae70f76`); pushing triggers a
   preview deployment that will build and run on Node 24 (`engines`).
2. **Approve the hosted-preview validation** above (disposable project under $1) or
   defer it to the sitting against production.
3. **Correct the branch preview's `OUTBOUND_DENY_HOSTS`** to `…,api.harvestapi.io`;
   keep that preview unused while it points at the baseline copy.
4. **Copy upgrade** (write to `qsqlgibgsxzlimoegcjx`): `20260928061000` (missing there),
   the four `20261003*` files, then `20261005090000`, `20261005100000`,
   `20261005110000` and `20261005120000`, in order;
   the NOTICEs report the witness recovery and the classification of historical NULL
   decisions, including the new receipt-based correction. Apply after recovery/load
   and drain checks; NOWAIT refusal requires settling conflicting activity first.
5. **Remaining ambiguous historical live NULL decisions** (after receipt-based correction):
   run the read-only listing query (section 1 above) on the copy and decide per row
   with the recruiter; no bulk reinterpretation.
5b. **Accept the reviewed compatibility artifact for hosted catch-up (F5)**:
   `c4d0e4e-explicit-contact-clear-v1`, composite SHA256
   `0d30436b535ffc015624b7f8f0153c6cf769908ed6e6a31597f8e71659407250`.
   Preserve the same accepted artifact on resume. Source-history conflicts remain
   review outcomes requiring disposition; changing valid clear decisions is not a
   migration workaround.
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

Resource disposition after the local closure (`79af7eb`): app on 3451, dedicated
PG15 cluster55821 and isolated Supabase project `candidate-closure-90ebc0b` are
verified stopped. The cluster data directory and Docker volumes
`supabase_db_candidate-closure-90ebc0b` / `supabase_storage_candidate-closure-90ebc0b`
are retained. The final stack retains three normalized synthetic people, zero Auth
users and the sweep's four owned controller events; controller disabled. The
previous build output and all other local projects were preserved. No push,
hosted configuration/database change or deployment occurred in this closure.

## 9. October 5 hosted manual-testing handoff

The approved existing copy was upgraded, the branch pushed and the fixed Node 24
preview attested. The complete current record is
[HOSTED_TEST_READINESS.md](HOSTED_TEST_READINESS.md). The prior new-project proposal
was not used. Nine forward upgrades preserved the pre-fixture population; fixture
additions and publication counts are reconciled exactly in the report. Three
uncertain application attempts remain parked for review, zero recovered/completed.

Disabled and armed hosted sweeps each passed 913 calls on `13f1b30`; current-runner
fixture reconciliation was limited to exact owned IDs, not the general catch-up
queue. Hosted contact receipts, wrong-target refusal and Resend denial were checked.
The correct branch settings/aliases are restored. Manual fixtures and private
sign-in access are ready; Riley is the reserved unpublished person, Casey a retained
setup probe. No main merge, production cutover or RR-09 completion is claimed.

The local PG15 cluster55821 and isolated local Supabase stack are stopped with data
retained. The hosted preview and existing copy remain available for Spencer's tests.
Use MANUAL_ACCEPTANCE_PLAN.md in order; its results remain Not run until performed.

## 10. October 13 read-only migration-history comparison (production vs copy)

Authorized by Spencer on 2026-10-13 ("run the read-only migration comparison on both").
Read-only `select` statements only; nothing was written to either project. Production
was read through the Supabase connector (scoped to `kmuihequfurvjxpnugxf`); the copy
through its PostgreSQL URL from the rehearsal env file. Observed at 12:51 UTC.

| | Production `kmuihequfurvjxpnugxf` | Copy `qsqlgibgsxzlimoegcjx` |
|---|---|---|
| Versions in `supabase_migrations.schema_migrations` | 96 | 157 |
| Last version | `20260926050355` | `20261005120000` |
| Versions the other side lacks | 0 | **61** |
| `pg_control_system()` identifier | `7550817586112808987` | `7550817586112808987` |
| Postmaster start | 2026-09-25 23:46 UTC | 2026-09-28 19:02 UTC |
| Database size | 33,773,358,227 bytes | 38,799,920,275 bytes |
| `person_private` schema (072) | present | present |
| `person_target_identity()` | absent | present |

Findings:

1. **The gap is exactly 61 versions**, confirming the figure in Spencer's plan. The copy's
   history is a strict superset of production's. All 61 correspond to tracked repo files,
   from `20260926033900_person_atomic_projection.sql` through
   `20261005120000_person_catchup_contact_snapshot.sql` (composite MD5 of the 61 files in
   order: `56d8fb28ec15066bef227a75e2389842`). Production already records three versions
   inside that window (`20260926040300`, `20260926042200`, `20260926050355`, merged on
   `main`); they must not be replayed. Versions to install on production:
   `20260926033900,20260926044800,20260926054500,20260926061600,20260926065300,20260926072840,20260926074407,20260926080238,20260926082012,20260926172608,20260926183000,20260926201342,20260926213000,20260926233000,20260926235140,20260927001258,20260927004931,20260927013100,20260927020700,20260927023000,20260927025000,20260927035000,20260927052000,20260927060000,20260927065000,20260927070000,20260927080000,20260927090000,20260927100000,20260927110000,20260927120000,20260927130000,20260927140000,20260927150000,20260927160000,20260927170000,20260927180000,20260927190000,20260927200000,20260927210000,20260927220000,20260927230000,20260928000000,20260928010000,20260928020000,20260928030000,20260928040000,20260928050000,20260928060000,20260928061000,20260928070000,20260928080000,20260928090000,20261003090000,20261003100000,20261003110000,20261003120000,20261005090000,20261005100000,20261005110000,20261005120000`
2. **`supabase db push` is not usable against either hosted project.** Both histories record
   the legacy numeric files `001 … 072` under 90 timestamp versions that do not exist in the
   repo; the CLI would treat the numeric files as unapplied. Production must be upgraded the
   way the copy was (section 9): the 61 files applied in order with `psql -v ON_ERROR_STOP=1`,
   each version then recorded in `supabase_migrations.schema_migrations`, PostgREST reloaded.
3. **The system identifier does not distinguish production from the copy.** The copy is a
   physical clone, so `pg_control_system()` returns the same identifier on both. The
   `person_target_identity()` REST-vs-PostgreSQL agreement and the sweep's `database_changed`
   check (`scripts/tenancy/armed.mjs`) therefore prove "same cluster" only in the sense that
   both paths reach one of the two clones; only the URL/key project-ref checks separate them.
   Earlier ledger lines that cite `7550817586112808987` as the copy's identity are true but
   not distinctive. Before the production sitting, the identity should gain a project-specific
   component (recorded at install time and compared with `PERSON_TARGET_PROJECT_REF`), or the
   operator must rely on the ref checks and record that explicitly. Not implemented here.
4. **Production is within 0.7% of the sweep's default size ceiling** (`TENANCY_MAX_DB_BYTES`
   34,000,000,000 bytes). The armed sweep on production will refuse once the database crosses
   it; an explicit, approved production ceiling will be needed at the sitting, as the copy
   needed its 45 GB ceiling.
5. **Backups on production were not checked** (dashboard setting, not visible by SQL). Section 9
   records PITR disabled on the copy; the migrations are forward-only, so production needs a
   confirmed backup (and ideally PITR) immediately before the install.
6. **Repository integrity note (local only).** The shared repository
   `pl/transformer-talent/.git` carries an `objects/info/alternates` entry pointing at a deleted
   session scratchpad; `git fsck` reports 925 refs with missing objects, including the local
   `main` ref (`0c2b9a8`) and many `origin/*` refs; the branch head `7d2c1a3` (equal to
   `origin/fix/person-90-release-remediation`) itself lacked 79 trees and 223 blobs. Repaired
   the same day without touching refs or working files: `git fetch --refetch origin` restored
   every object from the remote (all refs connected again, `fsck` clean), the two top-level
   blobs were re-hashed from identical working files, and the dead alternates file was removed.
   The other session.s uncommitted edits (four files, `output/browser-acceptance/`) were left as found.

## 11. October 13 project-label fix: the identity now separates production from its clone

Authorized by Spencer on 2026-10-13 ("implement the project-specific identity fix first …
This authorizes the fix and its test-copy verification"). Finding 3 of section 10: the copy
is a physical clone and reports production's `pg_control_system()` identifier, so the
runtime identity proof could not tell the two apart. Only the offline URL/key checks did.

### Design

- `20261013090000_person_target_label.sql` (MD5 `a281577cf4f57241a8ab6fd6157031e0`) adds
  `person_private.target_identity` (one row: `project_ref`, `labelled_at`, `labelled_by`),
  RLS on, all grants revoked from `public`, `anon`, `authenticated` and `service_role`; a
  statement trigger refuses update, delete and truncate (`target_identity_immutable`);
  `person_private.target_label(text)` inserts the label once with an explicit value, returns
  the row when it already names the same project, refuses any other value
  (`target_label_exists`) and any malformed value (`target_label_invalid`); not reachable
  through PostgREST. `public.person_target_identity()` now also returns `project_ref` and
  `labelled_at` (null until labelled). The migration never writes a label.
- `scripts/person-target.mjs`: `verifyRuntimeIdentity({readRest, readDatabase, ref})`
  requires identifier and label in every payload, agreement across clients on both, and
  label = selected ref; codes `identity_unlabelled`, `identity_label_mismatch`,
  `identity_target`; `verifyDatabaseIdentity(db, ref)`; `identityKey` = `<label>:<identifier>`.
- Coverage (all refuse before any write; nothing relabels): the application gate
  (`assertServerIdentity`, once per client kind per configuration per process, before the
  first REST request in `sbRest` and before the first operation in `withPersonConnection`;
  a failed proof is not cached; legacy mode without a selection and sealed loopback fixtures
  without a selection are not checked, as before); the shared operator pool opener
  (`openDatabase`, every CLI and the sweep, whenever a selection is set);
  `start-catchup.mjs` (REST, label recorded with the run); `person-reconcile-finalize.mjs`
  (REST + PostgreSQL); the sweep's `verifySweepTarget`/`preflightArmedSweep` (REST + PG,
  returns `project_ref` and the key), `armForSweep` (`database_changed` on the key),
  `recoverArmOwnership` and `disarmAfterSweep` (`tenancy_armed_ownership:database` when the
  ownership record names the other clone). The ownership record's `database` field is now
  the key; `test-tenancy.mjs` prints the label with the proved target.
- Harnesses that install the chain tail install the new file; the transition-CLI harness
  labels its fixture `local` (its suites select `local`). Docs: target README, runbook
  section "Project label (20261013090000)" (install order, the restore-into-a-new-project
  consequence, the deliberate relabel path), DISPOSABLE.md, maintenance README, manifest.

### Local evidence (Node v24.1.0, synthetic data only)

| Suite | Command | Result |
|---|---|---|
| Offline target/gate/CLI/runtime/catch-up inputs | `bash scripts/person-target/run-offline-tests.sh` | 67/67 (new: library label cases; REST gate: other label, unlabelled, 404, sealed, cache-after-failure; finalizer: label/unlabelled/clone pairs) |
| Sealed sweep, transport, starter, forward definitions | `node --test scripts/tenancy/test-armed-safety.mjs scripts/tenancy/test-armed-transport.mjs scripts/person-maintenance/test-start-catchup.mjs scripts/person-release-upgrade/test-forward-definitions.mjs` | 58/58 (new CLI cases: same cluster + different labels, unlabelled, foreign label; helpers: other clone's ownership, foreign/unlabelled database before any controller read) |
| Three databases in one cluster | `bash scripts/person-target/run-identity-tests.sh 55811` | 8/8: identical identifier, label decides; REST on A + PG on B refused; pool opener refuses B and C; relabel/update/delete/truncate refused; API roles denied; the production bundle's `withPersonConnection` runs no operation on B or C and proceeds on A |
| Database harness matrix (sequential, cluster 55811) | identity, transition-cli (default and `TRANSITION_SUITE=armed` with the pinned runner), upgrade, application-edits, publish, audit, postcutover-audit, recruiter, recruiter-admission | 10/10 harnesses PASS (upgrade 133 ok-lines incl. catalog parity on `target_label`/`target_identity_immutable`) |
| Real sweep CLI, same cluster, different labels | local stack REST (label `local`) + `LOCAL_DATABASE_URL` = `person_other_test` (same cluster, label `abcdefghijklmnopqrst`), `--armed` | `CRASH person_target:identity_label_mismatch`, "cleanup skipped: fixture target not proved; nothing was written"; no rows for the run id in either database; controller revision unchanged |
| Read-only preflight on the labelled stack | `preflightArmedSweep` with REST + PG | passes: `project_ref local`, key `local:7692913108189810727`, controller disabled |
| Fresh install + catch-up combination | `supabase db reset` (000 … `20261013090000`, 138 versions, `project_ref` null until `target_label('local')`), `bash scripts/person-maintenance/run-catchup-local-tests.sh 55811` | 14/14. A first run on the previous, re-used stack data gave 11/14 (`post_save_integrity:jobs_accounted` on this suite's fixture people): state pollution from running the suite twice on one stack, not the label; recorded here, the suite expects a clean stack |
| Type check | `npx tsc --noEmit -p tsconfig.json` | no errors outside the stale `.next/types` artifacts |

Sealed-suite correction: the server test's `pg` recorder never intercepted the server's
dynamic `import("pg")`, so a PostgreSQL case written there reached a real driver (and would
have opened a socket to the pooler host with a fictional ref). That case was removed from
the sealed suite and lives in `test-server-identity-db.mjs` against loopback databases.

### Hosted evidence on the copy `qsqlgibgsxzlimoegcjx` (authorized; production untouched)

1. Before: history lacked `20261013090000`; `project_ref` null; controller enabled/open
   revision 17 generation 13 (left for the manual tests; not changed).
2. Installed `20261013090000` with `psql -1` on the 5432 session endpoint, recorded it in
   `supabase_migrations.schema_migrations` (version `20261013090000`, name
   `person_target_label`, one statement = the file without its trailing newline, MD5
   `ba2b1c27680c1d4e4c9338c6889af98e`; 158 versions), `notify pgrst, 'reload schema'`.
3. Before labelling, with the copy selected: `verifyRuntimeIdentity` (REST + PG),
   `openDatabase`, `preflightArmedSweep`, `recoverArmOwnership` all refused
   `person_target:identity_unlabelled`; nothing written.
4. Labelled with the explicit value `qsqlgibgsxzlimoegcjx` (`created: true`,
   `labelled_by postgres`). Relabel to production's ref refused (`target_label_exists`).
5. After: REST and PG agree on `qsqlgibgsxzlimoegcjx:7550817586112808987`; `openDatabase`
   opens; `verifyRuntimeIdentity` with `ref` = production refused
   `identity_label_mismatch` (the production-process-reaching-the-copy case);
   `preflightArmedSweep` refused `tenancy_armed_precondition:controller_enabled` (identity
   passed, controller armed as found); `recoverArmOwnership` with an ownership recorded on
   production's label refused `tenancy_armed_ownership:database`; with the copy's label and
   a run that never armed returned `null`. No sweep was run (controller left armed/open).

Not done here, by scope: production is unlabelled (its label is a release step after its
migration install: `select person_private.target_label('kmuihequfurvjxpnugxf')`); the hosted
preview still runs `13f1b30`, so the deployed application gate has not exercised the label
(needs a push/redeploy of this branch and a signed-in request against the copy); the
HOSTED_TEST_READINESS and MANUAL_ACCEPTANCE_PLAN lines that cite the cluster identifier as
the copy's identity remain true but are not distinctive; those files carry another session's
uncommitted edits and were not touched. The local stack was reset and re-seeded only with the
catch-up suite's fixtures (the earlier smoke-seed data is gone; `smoke-seed.mjs` recreates
it); it is stopped with volumes retained, labelled `local`. Cluster 55811 is stopped.

## 12. October 13 follow-up: finalizer CLI path, catch-up resumes, preview verification of the label

Authorized by Spencer on 2026-10-13 ("close the two remaining identity-check gaps …
push the remediation branch for preview verification … test-copy preview verification
only"). Production migration, main merge and production deployment remain separate.

### Gaps closed (`0b5ca3a`)

- `person-reconcile-finalize.mjs --workdir`: the identity is read through the same linked
  Supabase CLI (`db query --linked --output json --agent no -f identity.sql`), parsed by
  `parseCliIdentity`, and proved with `verifyRuntimeIdentity` (REST too when configured)
  before the finish file is sent; the offline REST URL/key checks now run on both paths.
- `run-catchup.mjs`: every resume proves the REST destination's label (validated
  credentials, `restIdentityReader`) after the input/config/compatibility checks and
  before pinned verification, bundle derivation, transport listener or any import. The
  pinned translator is unchanged; the run output records the identity key.
- `saveRecruiterContactMapped`: a target refusal from the PostgreSQL session is logged as
  `person_contact_target_refused:<code>` and answered `temporarily_unavailable` (503)
  instead of a generic `save_failed`.

Regression tests: finalizer CLI path with unlabelled, foreign, clone (same identifier,
other label), unreadable and envelope-wrapped identities, REST/CLI disagreement, offline
refusal before any CLI call, correct label → identity then finish; `parseCliIdentity`
cases; catch-up resume with unlabelled, foreign, cloned, 500 and unreachable REST
identities refused before `verify` is called, the correct label proceeding, and a hosted
selection refusing another project's label. Offline suite 71/71, sealed sweep/transport/
starter/forward 58/58, `tsc --noEmit` 0 errors after `next build` (exit 0) regenerated
`.next/types`; worker bundle rebuilt (`scripts/dist/worker-lib.mjs`, ignored artifact,
SHA256 `b2c0a1092939650e155295a75f3aecde080dbb6fddeae4d911a3af067ce2bd38`).

### Preview verification on the copy (deployment of `0b5ca3a`)

Pushed `0b5ca3a`; Vercel's git integration built preview
`transformer-talent-website-1cjzu323b.vercel.app` (`dpl_8Mtx3rvUYDTVgQnkoFBkGse6Lb3F`,
source git, ref `fix/person-90-release-remediation`, commit `0b5ca3a316b0…`, READY, branch
preview variables). Signed in as the synthetic TT recruiter (copy Auth admin magic link
verified by token hash; no email, no redirect):

| Path | Call | Result |
|---|---|---|
| public | `GET /` | 200 |
| REST gate + REST | `GET /api/dashboard/me`, `GET /api/dashboard/network?job=99101` | 200, org `transformer-talent`; 200, 4 people |
| PostgreSQL gate + reads | `GET /api/dashboard/candidates/v2/net_<Jordan>` | 200 |
| PostgreSQL gate + writes | `PUT …/contact` twice (live mode) | 200, 200 (the writes themselves are discussed below) |

Wrong-label canary (a runtime label rejection, not a URL mismatch; the copy was not
relabelled): a scratch database `person_canary_label` was created from `template0` in
the copy's cluster (the copy's `postgres` role has CREATEDB; `template1` has a collation
version mismatch there), given `person_private` plus `20261003090000` and
`20261013090000`, and labelled with the fictional ref `abcdefghijklmnopqrst`; both
poolers reach it by database name. Canary deployment
`transformer-talent-website-muu8vj93s.vercel.app` (CLI, same commit, meta
`canary=person-label-explicit-env`) received the branch's preview variables explicitly
plus `PERSON_DATABASE_URL` pointing at that database; every offline URL/key check names
the copy. Results with the same recruiter token: `GET /` 200; `GET /api/dashboard/me`
200 (REST gate passed: the copy's label); `GET /api/dashboard/network?job=99101` **502
`load_failed`** with runtime log `network list failed
person_target:identity_label_mismatch`; `PUT …/contact` **503 `temporarily_unavailable`**
with runtime log `person_contact_target_refused:person_target:identity_label_mismatch`;
`GET …/candidates/v2/net_<Jordan>` 500. Nothing was written: the session is refused
before the operation. A first canary attempt deployed without git metadata and without
explicit variables received the project's default Preview environment (no `PERSON_*`
variables); it was removed within minutes and never called. Afterwards the canary
deployment was removed and the scratch database dropped (`with (force)`, a pooled
session lingered); the copy's own database still reports `qsqlgibgsxzlimoegcjx`.

### Side effect on a fixture, and its correction

The verification script's drawer read (`GET …/candidates/v2/net_<Jordan>`, 200) returned
`contact.email` and `contact.phone` as null although the fixture's candidate row holds an
email and a phone; the script treated those nulls as "current values" and sent them back,
so its two `PUT …/contact` calls at 16:52 UTC recorded **explicit email and phone clears**
on the synthetic Jordan Avery fixture (receipts and two `suppressed=true` decisions, live
mode). Why the read returned nulls is **not established by evidence**: the response body
was not kept, and the unpublished `net_` detail path at that commit tolerated a failed
secondary lookup (decision or verification-history read) by returning blanks, so either an
incomplete read or the drawer's representation of "no explicit choice" is consistent with
what was observed. Section 13 closes the incomplete-read path regardless. At 17:02 UTC the clears were withdrawn with the library's
`automatic` option (`saveRecruiterContact` run locally against the copy with the branch
configuration, same actor id): the latest decisions are now `NULL, suppressed=false`
(automatic ranking), the preview shows Jordan's email and phone again, and the three
receipts remain as immutable evidence of the test. No other person was written. The
manual-plan fixtures are otherwise as the October 5 handoff left them; the controller
stayed armed/open (revision 17).

Remaining: production is unlabelled (release step); `HOSTED_TEST_READINESS.md` and
`MANUAL_ACCEPTANCE_PLAN.md` still cite the cluster identifier as the copy's identity and
carry another session's uncommitted edits (untouched); the manual plan's fixed URL still
serves `13f1b30`.

## 13. October 13: complete contact reads behind the editable drawer

Confirmed defect (Spencer's review of the Jordan incident): the unpublished `net_` detail
path in `lib/server/candidates-unified.ts` called `recruiterContactDecisions` and
`poolEmails` without `requireComplete`, so a failed decision lookup or
verification-history read produced an editable contact block with blanks, which an
unrelated save (GitHub, another email) would write back as explicit clears.

Fix: the published-view read, the decision lookup and the email ranking behind the `net_`
drawer now all require complete results; any failure is `pool_contact_unavailable`, which
the detail route answers as 503 `temporarily_unavailable` with no contact block. A generic
contact-save failure is logged by its application code or SQLSTATE only.

Regression coverage (`scripts/person-application-edits/test-edits.mjs`, database-backed,
66/66 with the recipient suite 17/17):

- unpublished person (shadow mode): a failed `person_recruiter_primary`, `candidate_emails`
  or both → library rejects `pool_contact_unavailable`, route 503 with no `contact`, no
  decision row written; a GitHub edit from a complete read preserves the untouched email
  and phone (choices, never a clear); an `otherEmails` edit preserves them too; a genuine
  explicit clear stays cleared through complete reads and through a later GitHub edit made
  from the cleared drawer; history kept; the library's automatic selection shows the
  effective contact again;
- published person (live mode): the drawer equals the published contact, the same failed
  secondary reads change nothing, a GitHub edit preserves email and phone, and the drawer
  and published view agree.

The Jordan incident's wording in section 12 was corrected: the cause of the null read is
not proven; this fix removes the incomplete-read path either way.

## 14. October 13 final-artifact verification and copy rehearsal (RR-09)

Authorized by Spencer on 2026-10-13 ("Complete the remaining candidate-storage release
preparation end to end … This authorizes local/branch fixes, preview deployment and the
existing test-copy rehearsal"). Production was read only; the copy was written only through
the operator CLIs and the sanctioned fixture paths described below.

### Final artifact and tenancy verification

- Application source `68a77db` (last code change `331b64a`, section 13), deployed by Vercel's
  git integration as `transformer-talent-website-3bd5n2xmy.vercel.app`
  (`dpl_BcedVHnrtxUSwSzmTXusCmENnFnn`). Later commits add one forward migration
  (`20261013100000`, below) and documentation; the application code is unchanged.
- Controller coordination through the transition CLI, with expected phases and reason codes:
  the manual-test arming (revision 17, generation 13) was drained, drain-waited, sealed
  (revision 19) and disarmed (revision 20, generation 15, `final_preview_sweeps_*`).
- Disabled sweep run `2ed5h7f3e`: 913 calls PASS in 328 s, cleanup nothing left.
- Armed sweep run `2lehn2a98`: fixture target proved by label, armed at revision 21 /
  generation 16, 913 calls PASS in 286 s, own drain, seal, disarm (revision 24, generation
  18), three normalized synthetic people retained, cleanup nothing left.
- Documentation reconciled: the October 12 session's notes (HOSTED_TEST_READINESS.md,
  MANUAL_ACCEPTANCE_PLAN.md, RELEASE_MANIFEST.md) were committed unchanged from its working
  tree; its `packageManager` addition to `package.json` is left uncommitted for review
  (it would switch Vercel's installer to pnpm without a lockfile). The manifest and manual
  plan identify the current SHA, deployment, label and the completed 16/16 acceptance.

### Rehearsal state before the run (read-only inspection)

Active runs/checkpoints: no running catch-up (the September runs are `review_required` or
`paused`; the three `tenancy-*` fixture runs `paused`); publication runs `rehearsal-publish-
canary` (5) and `manual-mamuvg2pz3` (2) complete, `rehearsal-publish-full` paused after 2,000
people (1,986 projected, 13 unchanged, 1 audit_blocked) in 2,374 s; no post-cutover audit run
has ever been recorded on the copy; 423,062 candidates, 422,785 anchors, 2,012 projection
states, 2,277 pending; controller armed/open revision 17 with three deferred application
attempts; 5,488 open identity conflicts over 9,352 people (unchanged since October 2).

### Catch-up (pinned translator, reviewed compatibility artifact, held windows)

Sequence: arm (revision 25) → drain → seal (held, revision 27) → `start-catchup.mjs`
(fingerprint over 62,208 directory-linked people ≈ 6 min; identity label recorded) →
`maintenance_open('catchup', run, 240)` → `run-catchup.mjs` → close → anchors window.

| Run | Result | Finding |
|---|---|---|
| `rehearsal-catchup-20261013` | 2,000 processed in 9 min (142 verified, 1,858 review `same_snapshot_mutation`), then `operation_failed:57014` | the queue pager (`person_reconcile_page`, 20260926042200) probed the pending view per candidate past the cursor; in a sparse region one page exceeded PostgREST's 8 s statement timeout. The 2026-09-28 rehearsal failed the same way after 274 people. Fixed by forward `20261013100000_person_reconcile_page_plan.sql` (same results; ids gathered once per page); verified by the catch-up suite 14/14 on a fresh local stack, the upgrade/parity harness 136/136 and the forward-definition tests; installed and recorded on the copy (159 versions). |
| `rehearsal-catchup-20261013b` (after the pager fix) | 1,900 processed in 8 min, all review (published people), then `post_save_integrity:jobs_accounted` | the page contained an unpublished person the armed sweep retained (`fc347915…`, run `2lehn2a98`; the same holds for `355deede…`, run `frnum168f` of 2026-10-05): the sweep's teardown deletes the fixture organization's `candidate_enrichments` rows, which leaves the retained normalized person with a source the translator can no longer account for. The pinned loop stops the whole run on a post-save integrity failure by design. |

Attempts to clear the two sweep leftovers, all unsuccessful: the current translator for
exactly those ids (as the sweep does for its own fixtures) → `jobs_accounted`; restoring the
deleted synthetic enrichment rows from their captured before-images (the capture trigger
keeps the full row; controller disabled) → still `jobs_accounted`; a source hold cannot be
placed by an operator (holds are written only by the audited writers, with proof frames).
They are **copy-only synthetic residue** (`source='leaktest'`, usernames `zzlk…`), recorded
here as an exception. Consequence for production: **do not run the armed sweep against
production before the pinned catch-up has completed**, or amend the sweep's teardown to keep
(or anchor-delete) the enrichment rows of retained people; filed as a follow-up.

Queue composition after these runs: 2,135 pending = 1,859 published people whose only change
is the publication's own captured event (the pinned rule records them `same_snapshot_mutation`
review; the post-cutover auditor, not the reconciler, attributes publication events) + 274
source-review holds from the 2026-09-27 stable scan + the 2 sweep leftovers. 142 genuine
legacy changes were verified and left the queue.

### Anchors

`person-audit-anchors.mjs --save --limit=5000 --batch=20 --max-bytes=45000000000` inside an
anchors window: scan complete, 274 scanned, 0 created, 274 `review` (the held people cannot
be anchored until their holds are resolved). Coverage 422,788 of 423,062 (unanchored = the
274 held). The CLI's default 34 GB ceiling refused the 38.8 GB copy (`audit_capacity`); the
explicit copy ceiling was used.

### Publication and post-cutover audit (throughput measurements)

Publication (`rehearsal-publish-20261013`, armed/open, publish window 720 min, `--batch-size=500
--limit=500 --review=skip`): 500 people in 549 s (**0.91 people/s**): 487 `unchanged`, 12
`review_skipped`, 1 `audit_blocked`, 0 `projected`; database size unchanged (38.80 GB). A
publication window is bound to one run id and only one maintenance window may be open, so
publication is a single stream: 423,062 people ≈ 129 h ≈ **5.4 days of wall time** at this rate
(the 2026-09-28 run measured 0.84 people/s while projecting). The release plan must either
schedule publication over several days of 720-minute windows (resumable, `--resume`) or add a
reviewed server-side or parallel publication path before the sitting; neither exists today.

Post-cutover audit (`person-postcutover-audit.mjs --record --scope=all`): `--batch-size=20
--limit=200` stopped after 17 s with `operation_failed:57014` before any person (statement
timeout on a startup statement); `--batch-size=5 --limit=20 --max-seconds=600` paused after
600 s with **0 people processed** (the startup fingerprint over the directory provenance of
62,208 linked contacts did not finish within the budget); a `--batch-size=1` run is recorded
below. The auditor's per-person rate on the copy therefore remains **unmeasured**; the audit at
a declared cutoff could not be completed in this session.

### Exact accounting at the end of the session (2026-10-13 ≈ 20:45 UTC)

| Measure | Count | Explanation |
|---|---|---|
| Candidates | 423,062 | 423,059 + the armed sweep's 3 retained synthetic people |
| Anchors | 422,788 | 423,062 − 274 held people (cannot be anchored while held) |
| Pending in the reconcile queue | 2,135 | 1,859 published people (publication-captured events, `same_snapshot_mutation` review by the pinned rule) + 274 source-review holds (2026-09-27) + 2 armed-sweep leftovers (unreconcilable, copy-only) |
| Verified in this session's catch-ups | 142 | genuine legacy changes, run `rehearsal-catchup-20261013` |
| Review records written this session | 1,858 + 1,900 | the same published people, recorded by runs a and b |
| Published (projection states) | 2,012 | unchanged by this session's 500-person batch (487 unchanged) |
| Deferred application attempts | 3 | synthetic, 2026-09-29, no receipts; not in production |
| Open identity conflicts | 5,488 | over 9,352 people, unchanged since October 2 (disposition pending with the owner) |
| Unexplained differences | **0** | every pending person is in one of the three classes above |
| Controller | armed/open, revision 29, generation 22 | the handoff state; the three `rehearsal_20261013_*` reason codes and windows are in `transition_events`/`maintenance_events` |
| Copy history | 159 versions through `20261013100000` | both October 13 forwards recorded with exact file bytes |

What this rehearsal did **not** complete: the queue catch-up to `source_scan_complete` (blocked
by the two sweep leftovers; the pinned translator stops the run), full publication (5.4 days at
the measured rate), the post-publication catch-up and the final audit at a declared cutoff.
RR-09 therefore remains open; the measured rates and the two defects found (pager plan, sweep
leftovers) are the output of this rehearsal.

## 15. October 14 release engineering: installer, Storage export, teardown, profiles, second rehearsal

Authorized by Spencer on 2026-10-14 ("Please complete the remaining release engineering before
requesting production approval … Use existing approved environments and budgets. Keep production
read-only during preparation"). Production was read only (migration history digests, Storage
inventory counts). The copy was written only through the operator CLIs, the fixture paths, and
the one evidence repair described below.

### 15.1 Migration installer (`scripts/person-release/apply-upgrade.sh`, commit `5ea8fae`)

Defects found in the October 13 script and fixed:

| Defect | Fix |
|---|---|
| The migration file ran in one transaction (`psql -1`) and the history row was inserted in a second; a failure between them left an applied version that a resume would replay | one transaction per version holds the file (`\i`) and the row; an error or a lost connection before `commit` leaves neither |
| Destination check was a shell `case` on the URL text | the hardened validator (`checkDatabaseUrl`, 5432 only, no option overrides, selection must match) runs first; the database-held label is read at run time (unlabelled or own label pass, any other label refuses) |
| Recorded versions were skipped by version number only | every window version already recorded is verified by digest (trailing whitespace trimmed) before anything is applied: installer rows against the file, the three CLI-recorded production rows against the digests observed on production (`recorded_in_window`); a different body stops the run (`history_mismatch`); a row recorded without a body is counted (`unverifiable_bodies`, 52 such rows on the copy from the September 28 rehearsal, none on production) |
| `20260927170000` builds the case-folded identity index inside its transaction when absent (ShareLock on `candidates` for the build, under that file's 30 s statement timeout) | the installer builds `candidates_person_username_idx` `CONCURRENTLY` in autocommit before that file; an invalid leftover build stops the run for the operator |

Production's recorded body of `20260926050355` differs from the repository file by two bytes
inside the body (7,262 vs 7,260 bytes), so its observed digest is what the installer verifies; the
other two CLI-recorded rows equal the files after trimming. The copy's row for `20261013090000`
lacks the file's final newline (recorded on October 13 by hand), which is why the comparison trims
trailing whitespace.

Proof on an isolated loopback database carrying production's history
(`scripts/person-release/test-apply-upgrade-resume.sh`, PostgreSQL 15.13, port 55811): the 96
history rows were exported read-only from the copy, whose matching rows carry the same per-row
and whole-table digests as production (`production-history-digests.json`, whole-table digest
`b7ca867bf59bbe2bf9cc3af24b0536c4`, compared with production through the connector); the base
schema is the local fixture schema plus production's pre-window person migrations and the three
recorded window versions. Results: foreign selection refused before any connection
(`person_target:database_mismatch`); an error injected before the commit of `20260926183000`
left 96 + 10 versions, no `person_publish_runs` table, no row for the version; a connection
terminated before the commit of `20260926213000` left 96 + 12 versions and no audit tables; the
resume built the identity index concurrently, skipped every recorded version after verifying it,
and ended at 159 versions with every installed version recorded once with the exact file bytes;
a tampered recorded body was refused (exit 5); the labelled database was accepted for its own
selection. Dry run on the copy: 63 skipped (52 bodies unverifiable), 3 recorded-in-window verified,
nothing to apply.

### 15.2 Storage export (`scripts/person-release/export-storage-objects.mjs`, commit `e98407c`)

The October 13 script skipped folder entries, and **every object of production lives in a folder**
(55 objects: `company-assets` 1, `recruiter-photos` 1, `resumes` 53; all nested, all with plain
MD5 eTags, read-only count 2026-10-14). It would have exported nothing. The new export walks
folders recursively, rejects any non-2xx listing, compares the REST listing with the independent
`storage.objects` inventory over the 5432 endpoint (same bucket/name set and sizes), verifies
every body's size and, where the eTag is a plain MD5, its MD5, records SHA256 and MD5 in the
manifest and re-hashes the export with `--verify`. Offline tests: 6/6. On the copy: inventory
38 = 38 (3 buckets), then `storage_download_failed` for the first object. Diagnosis (read-only):
the copy carries production's `storage.objects` rows but **not production's blobs** (the physical
clone restored the database, not the object store); the 28 objects uploaded before the clone
answer `NoSuchKey`, the 10 uploaded to the copy afterwards download and verify (sizes 10/10,
MD5 10/10). The export therefore stops on the copy by design and needs production's object store
to complete; the download/verification path is proven on the copy's 10 real blobs.

### 15.3 Armed-sweep teardown (`scripts/tenancy/fixture.mjs`, commit `9c3b83b`) and the two leftovers

Cause of the two unreconcilable people (section 14): the fixture's pool people were normalized by
the armed sweep (baseline reconcile), so their `candidates` rows could not be deleted (RESTRICT
references from sources, profile state, anchors); the raw teardown nevertheless deleted their
derived job rows (`candidate_experiences` with source `person`), which the writer had derived
from the legacy row and which the pinned translator accounts for (`jobs_accounted`: expected 1
job from the owning `legacy_import` source, stored 0). The deletion of derived rows is not
captured (no change event), so nothing re-queued them until the enrichment deletes did.

Fix: teardown now detects normalized pool people (`candidate_profile_state`) and retains them
whole: only their verdicts and their applications in the fixture companies are removed; their
rows are excluded from the company-wide deletions and from the leftover check; the sweep reports
them as `retained`. Loopback proof on the reset disposable stack (139 versions, labelled `local`,
production build of the branch, `next start` on 3400): armed sweep run 913 calls PASS in 45 s,
3 pool people retained each with 1 derived job row, 1 source, 1 anchor, 0 pending; pinned queue
catch-up `source_scan_complete` (0 pending, external stable); pinned **full source scan**
(`scope: all`, the production workflow's path, run `local-fullscan-1791985938`): 3 processed, all
3 `verified` with `integrity_ok`, `source_scan_complete`, external stable.

Disposition of the two existing copy leftovers (`fc347915…`, `355deede…`), evidence preserving:
with the controller disabled (drain → wait-drained → seal → disarm through the CLI, revisions
30–32, reason codes `rehearsal2_20261014_*_for_repair`), their missing derived rows were
re-derived from the stored owner source exactly as `save_person` writes them (same
`legacy_import` source id as `jobs_source_id`, same row key, company resolved through
`person_company` with no creation and no conflict, TT organization, source `person`), one
transaction per person, after asserting the stored source hash equals the translator's document
hash, `applied_lists` is true and no active derived row existed. Nothing was deleted; sources,
anchors, events and audit rows are untouched. Before/after: 0 → 1 active derived job row each
(row digests `119ec4e7…`, `56673d1c…`). The pinned catch-up then recorded both as **verified**
(15.5).

### 15.4 Profiles (copy, from this machine; round trip 44 ms to the copy, 43 ms to the directory)

Publication, dry projection of 30 unpublished people: **17 queries per person, every query ≈ 46 ms,
801 ms per person**: publication is network-latency bound (server time per query 1–2 ms). A real
publication adds the projection RPC, the result insert and the commit (≈ 20 round trips, the
0.91 people/s of section 14). Fix without changing the per-person path: `--concurrency` (1..8,
commit `4b9e004`) publishes people of one page on that many sessions; each person keeps its own
transaction, lock, checks and durable result; the first failure stops the page after each session
finishes its person. Regression: `test-publish.mjs` 11/11 including concurrency (6 people on 4
sessions, outcomes identical, resume a no-op, a failing session marks the run failed and leaves no
session idle in transaction); review regressions 18/18, preview 4/4, gates 8/8.

Post-cutover audit startup: the scope statement (`person_postcutover_audit_external_inputs()`,
all candidate/receipt/primary/state links and 283,732 `_v2` rows) takes **9.8 s** on 423,062
candidates (its 15 s bound had no margin; now 60 s); the directory fingerprint reads full
provenance for 62,208 linked contacts in chunks, **1.1–2.7 s per 100 contacts** (data volume, not
round trips: 7–8 queries per chunk), so the fingerprint takes about 10–13 minutes at the start and
again at the end of a run. The October 13 probes' 600-second budgets ended inside that fingerprint
with 0 people processed; that is the measured startup cost, not a defect. `--external-chunk`
(default 250) is now an option; the budget must leave room for both fingerprints.

### 15.5 Second copy rehearsal (October 14): the whole sequence, with findings

Controller coordination entirely through the transition CLI with expected phases and the reason
codes `rehearsal2_20261014_*` (revisions 30–40 so far). Preview deployment for the copy:
`PERSON_TRANSITION_SUPPORT=on`, `PERSON_WRITE_MODE=live` (support on before arming). No worker
targets the copy, so nothing had to be settled; production's procedure is in the package (3.5).

| Step | Result |
|---|---|
| Evidence repair of the two leftovers (15.3) | controller disabled through drain → wait-drained → seal → disarm; 2 transactions |
| arm → drain → wait-drained → seal | held at revision 35 |
| `start-catchup.mjs` run `rehearsal-catchup-20261014` (`max-db-bytes` 45 GB, the copy's approved ceiling; the default 34 GB refused the 38.8 GB copy first) | fingerprint ≈ 6 min; started |
| catch-up window (240 min) + `run-catchup.mjs`, one pass | **2,135 processed in 16.7 min**: 2 `verified` (the repaired leftovers), 2,133 `review` (1,859 published people whose only change is a publication-captured event, 274 holds from 2026-09-27); `source_scan_complete`; window closed |
| `person-reconcile-finalize.mjs` | **`review_required`**, `external_stable=false`: the live communications directory moved during the 17-minute scan (`board.candidates` rows updated at 14:05 UTC by the directory's own writers; the copy reads production's communications project read-only). On production the same holds: the directory is written independently of this release, so a scan is externally stable only if nothing changes in it for the scan's duration; the finalizer's `catchup_pending`/`review_required` outcomes are the designed handling and a short final scan at the cutoff is the mitigation (owner decision below). The 2,133 reviews are a copy artefact of publishing before the catch-up (September 28 and October 13 runs); production publishes after its catch-up |
| anchors window + `person-audit-anchors.mjs` | the CLI needs `PERSON_DATABASE_URL` (not `PERSON_PUBLISH_DATABASE_URL`): `audit_database_url_required`; corrected in the package; coverage unchanged 422,788 of 423,062 (the 274 held people) |
| reopen; publish window; **benchmark** run `rehearsal-publish-bench-20261014`, `--concurrency=8`, 2,000 people after the October 13 cursor | **2,000 in ≈ 4.5 min (≈ 7.4 people/s, 8× the single-session rate)**: 486 `projected` (newly published), 1,463 `unchanged`, 50 `review_skipped`, 1 `audit_blocked`; window closed |
| **rollback rehearsal**: `person-publish-undo.mjs --run-id=rehearsal-publish-bench-20261014` | with the controller **armed** the apply stops at once with `audit_proof_frame` (the undo path is the legacy guarded writer, which an armed controller fences); after drain → seal → disarm: dry count 486 pending, apply **486 restored, 0 conflict, 0 missing** in 9 min (sequential), run `…-undo` complete; re-armed (revision 40). Rule for production: disarm before undo (package 3.5). **Consequence found in the full publication:** every undone person is then `audit_blocked` by the armed admission (`person_publish_project`: the undo's operation is attributed but has no certified operation, so the chain check raises `audit_proof_chain`); re-publication of undone people therefore needs the legacy guarded path with the controller disabled (rehearsed below as the re-publication step) or an armed-aware undo, which does not exist |
| full publication, first attempt `rehearsal-publish-full-20261014` (`--concurrency=8`) | interrupted deliberately by SIGINT after its first page (500: 487 unchanged, 12 review_skipped, 1 audit_blocked) for the rollback rehearsal; the window was closed by work id. Its resume was refused with `publish_run_commit_differs` because the branch had received a documentation commit meanwhile: **resume is pinned to the commit the run started at**, so the operator machine must not change HEAD during a multi-window publication. Rehearsal continued from a detached worktree pinned at `97c7cc6` with a new run id; the interrupted run stays recorded as `running` (nothing projected) |
| full publication `rehearsal-publish-full2-20261014` (`--concurrency=16`, one 720-minute window, `--max-seconds=18000`, from the pinned worktree) | **163,500 people in 3 h 28 min (13.1 people/s)**: 156,217 `projected`, 3,062 `unchanged`, 3,624 `review_skipped` (open identity conflicts), 597 `audit_blocked` (486 undone people, see the rollback row, plus 111 with pre-existing anchor/chain problems), 0 drift, 0 held. Stopped deliberately by SIGINT at 43.51 GB, 1.5 GB under the copy's approved 45 GB ceiling, to leave room for the catch-up and the audit (a `publish_capacity` stop at the ceiling would also have refused the audit); window closed; the run is resumable. Database 38.85 → 43.51 GB: **28.5 KB per published person net** (41 KB before autovacuum reclaimed the candidates churn at 15:22 UTC; durable evidence ≈ 20 KB: captured events 16 KB, projection history 4 KB, audit operations 1 KB). 160,111 projection states |
| re-publication of the 486 undone people (`rehearsal-publish-undone-20261014`, `--ids`, controller drained → sealed → disarmed, legacy guarded path, concurrency 8) | **486 `projected`, 0 blocked in 116 s** (4.2 people/s on that path); re-armed (revision 44) |
| post-publication catch-up, first attempt | drain → seal (held, revision 46); `start-catchup.mjs` stopped with `operation_failed:57014`: the `_v2` external fingerprint RPC (`person_reconcile_v2_fingerprint`) serializes and MD5-hashes all 283,732 `candidate_emails_v2` rows and sorts the digests, **6.5–7.0 s** through REST against the gateway's 8-second statement budget; it had passed on October 13 and at the end of the morning's scan with no margin. The pinned loop computes the same RPC at every scan end, so production would be exposed to the same failure. Fixed by forward `20261014120000_person_reconcile_v2_fingerprint_plan.sql`: same scope and result shape, hash = MD5 of the row count and the xor of 64-bit record hashes (`hash_record_extended`, every column), **1.1–1.2 s** measured on the copy as a temporary function; no timeout was changed. Registered in every harness and the manifest (64 versions to install); the installer applied it to the copy (its first real hosted use), then part 3 resumed |
| post-publication catch-up `rehearsal-catchup-post-20261014` (after the forward; start fingerprint now 1.3 s through REST) | started; **159,122 people pending** (every published person carries its publication-captured event, the pinned rule records them `same_snapshot_mutation` review, 2.1 people/s from this machine → ≈ 21 h for the copy's published subset, ≈ 56 h for 423k). Pass 1 stopped after 1,900 people (7 verified, 1,893 review) with `post_save_integrity:jobs_accounted`: two more synthetic pool people from the October 5 and October 13 sweeps (`0147d75c…`, `2a8bbcad…`) whose derived job rows the old teardown deleted; they were not queued until the publication captured them. Same class and same evidence-preserving disposition as 15.3 (re-derive from the stored owner source with the controller disabled); not applied while the final audit runs. Run `failed`, window closed; finalizer refuses a failed run (`P0001`) as designed |
| anchors (held window, `PERSON_DATABASE_URL`) | scan complete: 274 scanned, 0 created, 274 `review` (the held people), coverage unchanged |
| **declared cutoff: 2026-10-14 18:21:06 UTC** (close of the held post-publication window); reopen (revision 47) | |
| final audit `rehearsal-audit-20261014` (`--record --scope=all --batch-size=20 --external-chunk=250`, one 5-hour pass) | startup (scope statement + directory fingerprint) ≈ 7 minutes; **68,640 people in 5 h 00 min (3.8 people/s)**: 58,368 `verified` (85 %), 8,851 `pending` (`directory_snapshot_not_admitted`: linked contacts whose directory snapshot is not admitted), 1,421 `review` (1,243 `historical_owner_unavailable` = the `audit_blocked` publication outcomes, 118 `document_identity_missing`, 50 `anchor_required`, 7 `source_owner_unknown`, 2 `source_reconstruction_failed`, 1 `integrity:jobs_accounted`), 0 `boundary_moved`; paused at its time budget with a checkpoint. **Projection: ≈ 31 h for 423,062 people from this machine.** The second pass was refused with `audit_run_config_differs`: the audit, like publication, pins its run to the commit it started at and the branch had moved (`e2cf214` → `cb0aac6`) for documentation; resume needs a checkout at `e2cf214` (same rule as the publisher: run long audits from a detached worktree). `person-postcutover-finalize.mjs` on the paused run: refused as designed (the run is not exhausted; one attempt ended in `57014` before the refusal, under its 8-second statement bound) |
| end state (23:21 UTC) | controller armed/open revision 47, generation 35, no windows; copy 43.6 GB, 160 versions; runs: catch-up `review_required`, post catch-up `failed` (two more leftovers to repair), publication `running` (interrupted at the ceiling, resumable at `97c7cc6`), undone re-publication `complete`, audit `paused` (resumable at `e2cf214`) |

What the second rehearsal did **not** complete, and why: the full publication (stopped at
163,500 of 423,062 by the copy's approved 45 GB ceiling: 28.5 KB of durable evidence and churn
per published person), the post-publication catch-up (159,122 publication-captured people at
the pinned translator's 2.1 people/s, plus two more old-teardown leftovers to repair), and the
final audit (68,640 of 423,062 in its first 5-hour pass at 3.8 people/s; resumable). Every
integrity check stayed in force; no timeout was raised to pass a step (the two forwards change
plans, not budgets). The measured rates and the capacity figures are the input to the owner
decisions in the package (section 7).

## 16. October 15: armed-sweep teardown, the exact deletion that strands a retained person, and its regression test

Follow-up to 14 (`rehearsal-catchup-20261013b`) and 15.3. Local disposable PostgreSQL only
(a scratch 15.13 cluster on 127.0.0.1:55821 built by `scripts/person-transition-cli/run-local-tests.sh`,
`TRANSITION_SUITE=armed`, 139 versions, labelled `local`); no hosted database was read or written;
the pinned checkout at `pl/pinned` (c4d0e4e, worker lib already built) was used read-only through
`PINNED_RUNNER_DIR`.

### 16.1 Reproduction: which teardown deletion makes a retained normalized person unreconcilable

Method: after the armed suite (three `leaktest` people normalized by the sweep's baseline reconcile,
anchored, controller disarmed), the post-suite database was cloned once per experiment. Each clone
received the child rows the fixture writes for its pool people (an enrichment in TT's company with
provider `leaktest`, a fixture-company application linked to the person, an embedding, a
`person_signals` row, a `refresh_queue` row), a settling queue reconcile, then exactly ONE deletion
type of the pre-`9c3b83b` teardown, then two reconciles: the queue page the pinned catch-up pages
(`person_reconcile_page`) and the exact three ids paged as the sweep pages them. Each experiment ran
with the current translator; the decisive ones also with the pinned translator (c4d0e4e). The two
`person-reconcile.mjs` files are byte-identical; `person-trial.mjs` differs only in the recruiter-clear
rule.

| Deletion (per retained person) | Captured as a change event? | Queue page | Exact ids | Pinned translator |
|---|---|---|---|---|
| none | | empty | verified ×3 | same |
| `candidate_enrichments` (TT company, provider `leaktest`) | yes (TT-company rows are captured) | **verified** | verified ×3 | same |
| **`candidate_experiences` (the derived rows, source `person`)** | **no** | empty (nothing re-queues the person) | **`post_save_integrity:jobs_accounted`** | **same** |
| `candidate_embeddings` | no | empty | verified ×3 | |
| `person_signals` | no | empty | verified ×3 | |
| `refresh_queue` | no | empty | verified ×3 | |
| `website_applications` in the fixture company | no (non-TT rows are not captured) | empty | verified ×3 | |
| all of the above together (the old teardown) | enrichment delete only | **`jobs_accounted`** on the first person paged | `jobs_accounted` | same |

Conclusion. The cause is the deletion of the derived `candidate_experiences` rows alone: the
list owner (`candidate_profile_state.jobs_source_id`, the stored `legacy_import` snapshot) still
lists one job, zero are stored, and `checkStored` fails `jobs_accounted` before any record is
written. The deletion is not captured, so the person stays off the queue; the enrichment delete the
same teardown performed IS captured and is what put the person on the queue page in section 14.
Restoring the enrichment rows therefore could not help (they were never a translator input:
`readSources` takes only `provider=harvest, status=ok` ledger rows, and the event rule skips the
rest). The candidate row itself is refused by `candidate_sources_candidate_id_fkey` (RESTRICT),
which is why the person survives without its derived rows. All of this matches 15.3's diagnosis and
contradicts 14's first hypothesis (enrichment rows), now recorded as superseded.

### 16.2 Fix (this branch, on top of `9c3b83b`)

- `scripts/tenancy/pool-teardown.mjs` (new): the pool-person teardown plan as data and one function,
  shared by the REST fixture and the local regression test. Retention evidence =
  `candidate_profile_state`, `candidate_sources`, `person_audit_anchors`, and derived
  `candidate_experiences` (source `person`). A retained person loses only `match_verdicts` rows and
  fixture-company `website_applications` (tenant-only, read by no translator); sources, state,
  derived rows, anchors, enrichments and the rest are kept. **Fails closed**: if any evidence table
  cannot be read, no pool person's row is deleted.
- `scripts/tenancy/fixture.mjs`: `teardown()` uses the plan; the evidence reads are hard (no `soft`),
  chunked by 50 ids. Previously a failed `candidate_profile_state` read was treated as "nobody is
  normalized" and would have repeated the deletion.
- `scripts/test-tenancy.mjs`: a refused teardown prints `cleanup refused: …` with the `--cleanup`
  instruction and is recorded as a CRASH finding instead of aborting the report.
- `scripts/tenancy/armed.mjs`: the runner selection is exported as `sweepRunner()` so the test
  reconciles with the exact translator the sweep normalized with.

### 16.3 Regression test (`scripts/tenancy/test-armed.mjs`, 9 cases; `TRANSITION_SUITE=armed`)

Seeding now writes the fixture-shaped child rows above. After the disarm case: the shared plan runs
through SQL adapters on the harness database (tables the local chain lacks, `match_verdicts` and
`role_shortlists`, are reported as skipped, never assumed); inventory before/after proves only the
fixture-company application went; a synthetic evidence-read failure proves the refusal deletes
nothing; the current translator reconciles the three retained people exactly as the sweep pages
them, all `verified`, the catch-up queue page is empty; with `PINNED_RUNNER_DIR` the pinned
translator reconciles them `verified` too. The negative control then deletes the enrichment row
(captured, queue page = that person, `verified`) and the derived rows of another person (not
captured, queue empty; exact reconcile rejects with `post_save_integrity:jobs_accounted`).

`scripts/tenancy/test-pool-teardown.mjs` (new, mocked REST boundary, no database) covers the
fixture's own adapter: a person proved normalized by `candidate_sources` alone receives exactly two
DELETEs (`match_verdicts?candidate_id=eq.…`, `website_applications?organization_id=eq.<fixture
company>&candidate_id=eq.…`), a raw person receives every pool-child DELETE and its own row's, the
company-wide DELETEs carry `candidate_id=not.in.(<retained>)`, all four evidence tables are read
(derived rows with `source=eq.person`), and a 500 from any one of them rejects the teardown with no
pool DELETE issued.

Run record (2026-10-15, scratch cluster 127.0.0.1:55821, fresh chain per run):

| Command | Result |
|---|---|
| `TRANSITION_SUITE=armed PINNED_RUNNER_DIR=<c4d0e4e> bash scripts/person-transition-cli/run-local-tests.sh 55821` | 9/9 (teardown plan 180 ms, negative control 74 ms; pinned translator verified the retained people) |
| `TRANSITION_SUITE=armed bash scripts/person-transition-cli/run-local-tests.sh 55821` (current runner) | 9/9 |
| `node --test scripts/tenancy/test-pool-teardown.mjs` | 2/2 |
| `node --test scripts/tenancy/test-cleanup-scope.mjs` (unchanged) | 2/2 |

The first run of the new case failed on its own bookkeeping, not on the code: with every person
retained the plan attempts only `match_verdicts`, so only that absent table is reported skipped
(`role_shortlists` is never touched for a retained person); the assertion was corrected to the
tables the plan attempts.

### 16.4 Operating rule

Until this branch is released, **the armed sweep must not run against a database whose pinned
catch-up has not completed** (also written into `scripts/tenancy/DISPOSABLE.md`). Every earlier
sweep build deletes the retained people's derived job rows, the damage is invisible to the queue
until a captured delete surfaces it, and the pinned loop then stops the whole catch-up on that
person. Where an earlier sweep already ran (the copy: `fc347915…`, `355deede…` repaired in 15.3;
`0147d75c…`, `2a8bbcad…` still to repair, 15.5), re-derive the rows as in 15.3 before starting or
resuming the catch-up.

### 15.6 October 15: the two approved speed-ups

Authorized by Spencer on 2026-10-15 ("agree, both"): the package (a)–(e) with the revised
ceilings, and the two speed-ups for the long jobs.

**B. The publisher attributes its own captured event** (forward
`20261015120000_person_publish_capture_attribution.sql`). Every armed publication updates
`public.candidates`, and the capture trigger queues the person for the reconciler, which can only
record a same-snapshot review (no source changed); on the copy that queued 159,122 people, ≈ 56 h of
catch-up for production. The forward keeps `person_publish_project`'s signature, grants and every
check and adds one step after the projection: when the person had no unreconciled captured change
before the publication, the transaction's own `candidates` events are marked reconciled and the
queue row they advanced is released, exactly as a verified reconciliation does; a person with
anything pending before is left to the reconciler. The statement fence that refuses event and
queue writes while armed (`audit_proof_maintenance`, admitted only inside a catch-up frame since
`20260928030000`) now also admits the publish frame for the same two tables with the same
active-frame check. Tests: forward-definition tests 8/8 (signature, grants, every chain check
present verbatim, fence admits only those two tables); publish-admission suite 12/12 including two
new cases (a published person leaves the queue with its event reconciled and is not pending; a
person with an unreconciled captured enrichment change stays queued with both events waiting);
application-edits, transition CLI, publish, post-cutover audit and upgrade harnesses green; resume
proof all checks with 65 versions. Expected effect on production: the post-publication catch-up
shrinks from every published person to the people whose sources actually changed during
publication.

**A. A runner in the database's region.** Production is in AWS `us-east-2` (IPv6 direct host; the
session pooler `aws-0-us-east-2.pooler.supabase.com` on 5432 is the operator path). This machine's
round trip is 44–59 ms. A read-only latency probe workflow (`person-runtime-probe.yml`) was added,
but GitHub only dispatches workflows present on the default branch, so it has not run; the owner
chooses between a small cloud machine in `us-east-2` (his account) and a GitHub runner (needs the
ops workflow on `main`).

Production facts read for the plan (read-only, 16:40 UTC): PostgreSQL 17.6, 34.23 GB, 437,037
candidates, 423,588 profile states and 493,355 sources from the September normalization, 25,734
queued people, 84,499 directory-linked people, 96 recorded versions, `max_connections` 160. No
initial backfill is needed; the first catch-up covers the queue and the ≈ 13,000 newer candidates.

### 15.7 October 15: production sitting, step 0 (read-only)

Operator file created by the owner (`pl/.env.production.operator`, mode 600; production's session
pooler is `aws-1-us-east-2`, not `aws-0`; the direct host is IPv6-only from this machine). Service
role key verified (project claim and role; REST probe 437,037 candidates). **Storage export**
(`export-storage-objects.sh`): inventory REST = `storage.objects` 56 = 56 across 3 buckets, 56
downloaded, 56 sizes verified, 56 MD5s verified against plain eTags, 8,433,265 bytes, `--verify`
complete; kept private outside the repository. The export now opens its inventory connection under
the installer's rule (an unlabelled pre-install database passes, a foreign label refuses; tests
7/7), because production has no identity function before the install. **Installer dry run** on
production: 96 versions, the three recorded window versions verified, 65 to apply, the identity
index to be built concurrently before `20260927170000`, nothing applied.

### 15.8 October 15: production schema install (step 1)

Preconditions met: disk raised by the owner from 40 GB (33.06 GB used, spend cap on) to 80 GB
with the spend cap disabled; daily physical backup completed 2026-10-15 06:26 UTC (CLI); package
approved 2026-10-15 ("agree, both"). `apply-upgrade.sh` on production, 17:37:42–17:39:58 UTC:
`candidates_person_username_idx` built concurrently (autocommit) before `20260927170000`, then
**65 versions applied, 0 skipped, 0 unverifiable bodies, history 96 → 161**, each file and its
history row in one transaction, exit 0, PostgREST reloaded. The application stayed in legacy
mode throughout (no `PERSON_*` variables in production). Label statement and identity checks
recorded below.
Label written at 17:40:15 UTC (`person_private.target_label('kmuihequfurvjxpnugxf')`, created
true). Identity through PostgreSQL and through REST: project `kmuihequfurvjxpnugxf`, cluster
`7550817586112808987`; controller disabled, revision 1, generation 1; a further installer dry run
skips all 65 with verified digests. Step 1 complete; the application is still in legacy mode.

### 15.9 October 15: configuration and deploy (step 2), on the owner's "go step 2"

GitHub repository: variables `PERSON_TARGET_PROJECT_REF=kmuihequfurvjxpnugxf`,
`PERSON_WRITE_MODE=legacy`, `PERSON_TRANSITION_SUPPORT=on`; secret `PERSON_DATABASE_URL`
(transaction pooler, 6543). Vercel production environment: the same four (`PERSON_DATABASE_URL`
sensitive). Production deploy from a clean detached checkout of `e7a2ba7` (no local changes, no
`packageManager` line) with `vercel deploy --prod`: deployment
`transformer-talent-website-6hk8vyhln.vercel.app`. Note for the main merge: until PR #2 lands,
any push to `main` would redeploy the old code over this deployment.

### 15.10 October 15: step 3 on production, first held window, and two findings

Workers: `review-queue`, `refresh-queue` and `sync-candidates` schedules disabled for the sitting
(`derivative-worker` has no workflow on `main`). Controller armed (revision 2), drained, sealed
(revision 4); the first catch-up window was refused (`maintenance_run`: a window binds to an
existing running run, so the run must be started first) and the controller was reopened at once
(revision 5) so recruiter edits were refused for seconds only.

**Catch-up through GitHub Actions.** The communications connection string exists only as a
repository secret, so the catch-up (and later the audit) run as jobs of `person-trial.yml`
dispatched from the branch (`--ref`). Four refusals were found and fixed on the way, each by a
small workflow change: the secret carries `sslrootcert` and `connect_timeout` options the hardened
validator refuses (normalised inside the job, masked); the runner's `GITHUB_SHA` is the branch
head and cannot be overridden by step env (removed for the pinned helpers); the runner shell exits
on the first failing command (reported instead); and the derived runtime's **artifact identity
differs on the runner** (`16174c9a…` vs the reviewed `0d30436b…`). Review of the two manifests:
every translated source file identical by SHA256 (person-trial, person-reconcile,
person-backfill, engine, the contact snapshot output); only the pinned worker bundle differs,
built by the same `esbuild@0.28.2` from the same sources but with the pinned lockfile's
dependency versions on the runner (`npm ci`) versus this machine's 43 non-matching installed
packages. The runner's identity is the lockfile-exact one and is approved for the Actions runs;
this machine's identity stays approved for local runs. Run `release-catchup-20261015` started on
Actions (fingerprint over 84,499 linked contacts, 18:36 UTC).

**Anchors.** Production holds **6,801 audit anchors**, not the 422,785 the copy had: the
September anchor pass ran on the copy after it was cloned, never on production. The anchors step
therefore has to create about 427,000 before-images (≈ 5.4 GB, already in the capacity figure):
measured 1,120 per minute at batch 20 (≈ 6.5 h), estimated about 2 h at batch 100. The first
anchors window ran to the CLI's 15-minute default budget (9,595 anchors, 549 held people
`review`) and the controller was reopened. The held time the sitting needs is therefore the
catch-up (25,748 queued, ≈ 3.5 h at the pinned rate) plus anchors (≈ 2 h), scheduled as an
overnight window on the owner's word; recruiter edits and application processing are refused
while held, public pages and applications stay up.

## 17. October 15–16: production sitting (held window, publication, post-publication catch-up)

Spencer's approvals: package (a)–(e) with the 58 GB ceiling and both speed-ups (October 15); "now" for the
held window (19:37 UTC October 15); "go publication" (12:01 UTC October 16); "go catch-up" (21:39 UTC).
Production: `kmuihequfurvjxpnugxf`, 437,037 candidates, deployment `e7a2ba7` in legacy mode with support on,
schedules review-queue/refresh-queue/sync-candidates disabled for the sitting.

| Step | Result |
|---|---|
| Held window 1 (19:37–05:01 UTC; the Mac rebooted at 03:46 UTC and the script died at 00:39 UTC; resumed 04:18 UTC) | catch-up `release-catchup-20261015` on the GitHub runner (artifact `16174c9a…`): **25,748 processed in 1 h 40 min (4.3 people/s)**, 19,764 verified, 5,984 review (`same_snapshot_mutation` 5,982, `harvest_cache_date_unknown` 2; 211 of them in open identity conflicts, 485 without normalized state). Anchors: 16,439 → 349,784 (night pass, batch 100, 1,860/min) → **431,053** after the resume; the 5,984 review people stay unanchored. Finalizer: first attempt `operation_failed:57014` (cold cache; `person_reconcile_finish` requires `statement_timeout` ≤ 8 s and its latest-check query runs 5 s warm with a parallel worker, 10.8 s without), succeeded on a warm cache without any timeout change: **`review_required`**, `unverified` 5,984, `unresolved_review` 5,984, `queue_pending` 5,970, `external_stable` false, `open_identity_conflicts` 5,959 (over 10,067 people). Controller reopened revision 11. |
| Publication `release-publish-20261016` (12:01–21:00 UTC, from `pl/deploy` at `e7a2ba7`, `--concurrency=16`, two 720-minute windows, paused at 18,000 s, `vacuum (analyze) candidates` 2 min 51 s between them) | **436,552 processed in 9 h (14.4 people/s)**: 413,960 `projected`, 7,237 `unchanged`, 10,067 `review_skipped` (open identity conflicts, decision B5), 5,288 `audit_blocked` (exactly the unanchored review people), 0 held/unmigrated/drift, 3 email collisions. Growth 25.8–28.7 KB/person after the first 20 minutes (34.7 KB/person at the start); database 38 → 50.7 GB (ceiling 58). The change queue stayed at 5,970 throughout: `publish_project` attributed its own captured events (speed-up B, 20261015120000), so no publication-captured people entered the queue. |
| Post-publication catch-up `release-catchup-post-20261016` (held window 21:39–22:04 UTC) | run created on the runner (`catchup_started`); the `run` pass recorded 3,600 review and stopped `operation_failed:57014` at page 37: PostgreSQL's log names `person_reconcile_page` (20261013100000) cancelled at the REST layer's 8 s limit. Cause (EXPLAIN on production at that cursor): the pending view's latest-check `distinct on (candidate_id) … order by candidate_id, checked_at desc, run_id desc` has no index in that order; the planner's two paths — incremental sort on `(candidate_id, checked_at desc)` (231 ms) and a primary-key scan `(run_id, candidate_id)` with an external sort of the 553,732 rows past the cursor (698 ms warm, > 8 s cold) — have near-equal cost estimates and the choice flipped with the cursor. The window was closed and the controller reopened (revision 14); the finalizer did not run (the run is `failed`, resumable: `person_backfill_start` with resume sets it running again). |

Fix: forward `20261016230000_person_reconcile_people_latest_idx.sql` adds `person_reconcile_people_latest_idx
(candidate_id, checked_at desc, run_id desc)`, the exact distinct-on order, so the latest-check queries
(`person_reconcile_pending`, `person_reconcile_finish`) need no sort at all. No function, grant or
timeout changes. Verified: forward-definition tests 9/9 (new case: one index, exact order, nothing
else), upgrade harness (older chain + forwards = clean install) 4/4 with 139 passing checks, installer
dry run on production `applied=0 skipped=65 … would apply 20261016230000` (manifest 66 versions). The
same plan flip explains the 2026-10-13 copy failure's sibling (section 15, `rehearsal-catchup-20261013`)
only in part: that one was the pager probing the view per candidate, fixed by 20261013100000; this one
is the view's own sort. Install needs Spencer's approval (production change); then resume the run
(`run` passes), finalizer, reopen.

**October 19 (index installed, cutoff declared).** Spencer approved both (October 19): the installer applied
`20261016230000` on production in 55 s (`applied=1 skipped=65`, history 162, index valid); with the index
the pager at the failing cursor runs through `person_reconcile_people_latest_idx` and the finisher's
latest-check query takes 5.3 s without parallel workers (10.8 s before). Held window 14:47–16:20 UTC: new
run `release-catchup-post2-20261016` on the runner, `source_scan_complete` after 5,984 processed (all
`review`, the same people), finalizer **`review_required`** (`unverified` 5,984, `queue_pending` 5,970,
`open_identity_conflicts` 5,962) on its second attempt (the first, cold, still hit 57014). **Declared
cutoff: 2026-10-19T16:20:11Z** (close of that held window); controller reopened revision 17. Operator
note: the driver's `gh run watch` returned early on the first `run` pass, so a second pass was dispatched
while the first was still running; both resumed the same run (idempotent per-person upserts, per-candidate
advisory locks) and the end state is coherent. The audit driver polls run status instead.

**October 19–22: final audit.** Spencer "go audit" (October 19, 18:13 UTC). `release-audit-20261019` on the
GitHub runner (`--record --scope=all --batch-size=20 --limit=1000000 --max-seconds=18000 --max-db-bytes=58000000000
--external-chunk=250`, pinned to branch head `bc7cd2e`, resumed per dispatch with `audit_resume`): nine passes,
18:14 UTC October 19 → 02:40 UTC October 22, with a 13-hour gap after the Mac rebooted at 00:20 UTC October 20
and killed the local dispatcher (the audit itself checkpoints per page). Rate 7.4 people/s at first, 2 people/s
by the last passes (page queries steady at 120–150 ms; the slowdown is on the runner/directory side). **Scan
exhausted: 437,037 recorded** = 349,269 `verified` (79.9 %), 65,008 `pending` (`directory_snapshot_not_admitted`:
linked contacts whose directory record moved since the website admitted it; the directory sync has been paused
since October 15 while reply-ops keeps writing), 22,760 `review` (`historical_owner_unavailable` 6,560 = the
audit-blocked publication outcomes, `anchor_required` 5,984 = the unanchored review people, `source_owner_unknown`
5,793, `document_identity_missing` 4,416, `source_reconstruction_failed` 7), 0 `boundary_moved`. Database 51.9 GB.

**Finalizer at scale (measured read-only, 2026-10-22 02:50 UTC, rolled back):** `person_postcutover_audit_finalize`
requires `statement_timeout` ≤ 8 s because it holds the writer and capture gates for its one comparison statement.
On production that statement takes about 137 s (`person_private.postcutover_boundaries` for the 349,269 verified
people 97 s; the comparison join 40 s; `person_postcutover_audit_external_inputs()` another 19 s). The local scale
probe (`test-audit-scale.mjs`, 423,050 empty synthetic candidates) never exercised real-shaped people, and the
copy rehearsal's audit was not exhausted, so this was not measured before (checklist item 20 said "finalizer
refuses a non-exhausted run"). The 8 s rule is not a tunable: it protects live writers. The controller's held
phase with a leased maintenance window is the existing answer for long maintenance that must not meet live
writers (catch-up, anchors), so forward `20261022010000_person_audit_finalize_window.sql` adds the step
`audit_finalize`: admitted by `maintenance_open` only while held, with no unresolved work, for an audit run that
exists, is running or paused and has `scan_complete`; `person_postcutover_audit_finalize` keeps every check and
gate and takes the window's bound (240 minutes) only when the transaction holds an `audit_finalize` frame, 8 s
otherwise; `person_postcutover_audit_finalize_window(run, pass)` enters the frame, runs the unchanged finalizer
and leaves it, as the catch-up wrappers do; no grant widened. CLI: `person-postcutover-finalize.mjs --window`
(240-minute statement bound, the wrapper), transition CLI `--open-window=audit_finalize`. Tests: forward
definitions 10/10 (new case: signature, gates, every check and every other step's rule verbatim; the two-bound
rule; the wrapper's enter/run/leave), transition rehearsal suite (new case: refused before `scan_complete`,
refused without a frame or for another run, finalizes inside the window with a 20 s bound, no frame left behind,
finished runs refused), upgrade harness (older chain + forwards = clean install). Install needs Spencer's
approval; then: drain → seal → `--open-window=audit_finalize --run=release-audit-20261019 --minutes=30` →
`person-postcutover-finalize.mjs --run-id=release-audit-20261019 --window` → close → reopen (expected
`review_required`; about 5 minutes of paused edits).
