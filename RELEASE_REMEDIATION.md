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
- **Deployment evidence (read-only, 2026-10-03)**: the testing preview branch has
  15 branch-scoped variables; `PERSON_WRITE_MODE=live`, `PERSON_TRANSITION_SUPPORT=on`
  are readable; sensitive values are not retrievable through Vercel's API (as the
  review found). The preview also inherits project-level `HARVEST_API_KEY`,
  `TYPESAFE_API_KEY` and `TURNSTILE_SECRET_KEY`. Runtime destination proof on an
  exact deployment therefore comes from deploying this branch with
  `PERSON_TARGET_PROJECT_REF` set: the gate itself refuses a mixed configuration.
- **Status: implemented; verified offline; deployment attestation blocked** (no
  push/deploy authorized in this task).

### RR-08 Copied grants and inherited provider credentials

- **Fix**: `lib/server/outbound-guard.ts` + `instrumentation.ts` + worker-bundle
  install: `OUTBOUND_DENY_HOSTS` denies listed provider hosts at `fetch` before the
  request leaves; counted; no-op when unset.
- **Tests / results**: `test-outbound-guard.mjs` 4/4 (Nylas/Resend/Airtable/Harvest
  denied incl. `Request`/`URL` inputs, Supabase/OpenAI pass, reinstall replaces).
- **Remaining**: the copy still holds one mailbox grant; the testing preview's
  provider keys are `disabled-on-test-copy` placeholders set earlier but inherits a
  live Harvest key from the project. For the rehearsal deployment set
  `OUTBOUND_DENY_HOSTS` on the branch; Supabase Auth SMTP on the copy is a project
  setting outside this repo and was not changed.
- **Status: implemented; verified offline; deployment attestation blocked.**

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
- **Not done**: hosted `scripts/test-tenancy.mjs --base <preview>` (creates users/
  orgs/data; needs a deployed preview of this exact branch with a disposable fixture
  database selected separately); browser smoke of the drawer changes on that preview.
- **Manifest**: `RELEASE_MANIFEST.md`.
- **Status: implementation complete; hosted verification blocked** (needs push +
  preview deployment approval).

### RR-15 Retired role-sync stage

- **Fix**: `sync-airtable-roles.mjs` removed from `npm run sync-roles`; both remaining
  stages refuse a missing/empty `SUPABASE_URL` before any request and honor the
  selection when set.
- **Tests / results**: `test-cli-targets.mjs` static resolution + sealed processes.
- **Status: verified.**

## Independent review

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

## Remaining owner actions (in order)

1. Approve pushing `fix/person-90-release-remediation` and its preview deployment;
   set `PERSON_TARGET_PROJECT_REF=qsqlgibgsxzlimoegcjx` and `OUTBOUND_DENY_HOSTS` on
   that branch's Vercel environment (the gate then attests the destination).
2. Approve installing `20261003090000`–`20261003120000` on the copy (migration
   NOTICE reports the witness recovery result), then run the hosted tenancy test and
   the drawer smoke on that preview.
3. Decide the RR-10 disposition (keep/document or reviewed cleanup).
4. Approve the rehearsal that closes RR-09 (catch-up, anchors, publication, audit) and
   pick the production sitting; production needs the same four variables/settings.
5. Review the PRs: this branch (into the parent or main per the release decision),
   with #85/#86 already merged into it.
