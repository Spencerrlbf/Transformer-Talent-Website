# Release manifest: candidate storage remediation branch

Identifies the exact artifact the evidence in `RELEASE_REMEDIATION.md` refers to.
Any change to source, dependencies, migrations or configuration invalidates the
rows that depend on it until re-verified. The executable head is `12eadcf`
(2026-10-05: explicit clears `63111d0`, pinned catch-up runner `16f34d4`, Node 24
`12eadcf`, on top of the R2 fixes `4aa9845`…`75684a5`); the smoke seed script
(`scripts/tenancy/smoke-seed.mjs`, local tooling, no application code) and the
documentation commit on top add no application or migration change. Evidence classes used below:
*code-level* (static or offline test), *local runtime* (the artifact's build or a
database on this machine), *deployed runtime* (none recorded; see "Not executed").

## Source

| Item | Value |
|---|---|
| Branch | `fix/person-90-release-remediation` (worktree `pl/remediation`) |
| Base | `c8fda5bfd50e8c40f22a3083e38c6eea71d0a803` (`feat/person-00-storage-unification`, tree `d43305e1…`, includes `main` `9a3240c`) |
| Merged in | `origin/fix/drawer-profile-layout` `dad9549`, `origin/feat/drawer-also-a-match` `c042c21` |
| Head (executable content) | `12eadcf` (Node 24); `16f34d4` (pinned catch-up runner); `63111d0` (explicit clears, migration `20261005090000`); R2 series `4aa9845`, `52a5d29`, `902cf11`, `6c9168b`, `75684a5`. Historical executable heads: `6df67d8`, `132e6a6`, `8bd8fd3` |
| Commits on top of base | 25 at the documentation head (incl. the two merged drawer commits `dad9549`, `c042c21`): `47005c2`, `4ecdffb` (UI merges), `3862042` (target isolation), `4f23107` (forward migrations), `924f233` (recovery tests), `0617a92` (docs), `2033980` (ledger/manifest), `315918d` (review fixes), `8bd8fd3` (review hardening), `310c9af` (docs), `132e6a6` (armed mode), `d6a1a3f` (docs), `6df67d8` (anchors with current code), `ae70f76` (docs), `4aa9845`, `52a5d29`, `902cf11`, `6c9168b` (R2 fixes), `75684a5` (review follow-ups), `b6021e4` (docs), `63111d0`, `16f34d4`, `12eadcf` (2026-10-05 follow-up), the smoke-seed commit and the documentation commit carrying this manifest |
| Diff vs base | 100 files, +5,777 / −95 (at the executable head `12eadcf`) |
| Excluded testing-branch content | diagnostic route and diagnostic log lines (`5db31f1`, `ce72331`, `8bc18b9`) |

## Dependencies and worker bundle

| Item | Value |
|---|---|
| `package-lock.json` SHA-256 | `2c4ff8ad43b5cae55f06580afd4b7711f2beaeb2b0900f8c45acee2bd2fa51c5` (identical to `c8fda5b`) |
| Node | **24.x declared** (`package.json#engines`, `.nvmrc`, `.npmrc engine-strict`, all workflows' `setup-node`, `scripts/check-node.mjs` from the bundle builder); every result here on v24.1.0 (`/opt/homebrew/bin/node`). Hosted runtime: not yet read (prepared check `scripts/person-release/hosted-runtime-check.sh`) |
| `pg` / `pg-connection-string` (the driver whose option precedence and re-encoding R2-01 is about) | 8.23.0 / 2.14.0 (locked) |
| `scripts/dist/worker-lib.mjs` SHA-256 (rebuilt from `12eadcf` by `scripts/build-worker-lib.mjs`, esbuild 0.28.2) | `96f75bfcabc7840fb5cb8c0627e9fe2f75da8f0beeba096ae8f7783d16f4ea46` (at `75684a5`: `860402fa…b0a7`; at `6c9168b`: `be152d03…cfb8`; at `6df67d8`: `0de4ecff…5338`) |
| Pinned catch-up translator bundle (clean `c4d0e4e` checkout, rebuilt by the runner helper per run) | `c04e8c18657ffc03bac75f03a34b6772b8d8d878958635ff03b9ca0717f197a5` |
| Catch-up runtime pin | `c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc`; `start-catchup.mjs` rebuilds and hashes its bundle at run time |

## Migrations

133 tracked files under `supabase/migrations` (the local-only `000_local_bootstrap.sql`
of the disposable stack is not tracked). The release chain is the 53 files
`20260926033900` … `20260928090000` listed in the cutover runbook, followed by the
five forward files below. An install from the copy's artifact `23d7860` lacks
`20260928061000_person_resume_contact_fill.sql` and must install that missing version
before these (runbook, "Older-install prerequisite"); `20261005090000` comes last:

| Version | Purpose | MD5 of file |
|---|---|---|
| `20261003090000_person_target_identity.sql` | `public.person_target_identity()` cluster identity RPC (service_role, read-only) | `f8e1a230eb081172bc05e84e28cc0335` |
| `20261003100000_person_forward_application_contact.sql` | release `person_application_contact_fill` body (phone extension) | `dd3a0c37536ce9b4860f03e2d20bdeab` |
| `20261003110000_person_forward_network_send.sql` | witness proof columns + hash-proven recovery; two-argument `person_network_send`; snapshot export | `dda7e083bc64ea6686eb4bb65616fc1b` |
| `20261003120000_person_forward_identity_index.sql` | validation-only identity index preflight | `d63ff3b6a035ef6b6840291e8ab54e62` |
| `20261005090000_person_recruiter_explicit_clear.sql` | `person_recruiter_primary.suppressed` (explicit clear vs automatic), `person_contact_ranks` ignores a suppressed kind, certified writer patched in place; historical NULL rows left automatic and counted | `9ec4476818c5d07ca3af697d225bbcc7` |

Older bodies the copy installed (fixtures used by the upgrade harness, captured
from `23d7860`): `old-20260928070000_person_network_send.sql` MD5
`8871cbec547a7f6129406111231b4157` (its installed function body MD5 on the copy
is `d6b75f860741aad94c10b1dfc8350c6c`, per the review's Q06).

Static parity: the 2026-10-03 forward bodies equal the chain bodies
(`scripts/person-release-upgrade/test-forward-definitions.mjs`, 4/4). Catalog parity:
an upgraded database and a clean release-chain install have identical function
definitions (incl. `person_contact_ranks`, the patched `recruiter_normalize` /
`recruiter_write` and the new helper), witness columns/constraints/triggers,
identity index, privileges and the `person_recruiter_primary` columns/constraints
(`scripts/person-release-upgrade/test-catalog-parity.mjs`, 4/4).

## Effective configuration and destinations

| Setting | Required value / rule |
|---|---|
| `PERSON_TARGET_PROJECT_REF` | the one project ref (production `kmuihequfurvjxpnugxf`; copy `qsqlgibgsxzlimoegcjx`; `local` for loopback fixtures). Required for shadow/live or transition support with any hosted client, and for every hosted operator URL |
| `SUPABASE_URL` / keys | `https://<ref>.supabase.co`; JWT `ref` claim = selection |
| `PERSON_DATABASE_URL` | shared pooler, user `postgres.<ref>` (6543 for the app/workers) |
| `PERSON_PUBLISH_DATABASE_URL` | 5432 session/direct endpoint of the same ref |
| `OUTBOUND_DENY_HOSTS` | rehearsal deployments only; unset in production. Value: `api.us.nylas.com,api.resend.com,.airtable.com,api.harvestapi.io` (the branch preview still carries the old `api.harvest-api.com` spelling set on 2026-10-03; not re-read, not changed) |
| GitHub Actions | repository variable `PERSON_TARGET_PROJECT_REF` consumed by review-queue, refresh-queue, sync-candidates, derivative-worker |
| Verified destinations | 2026-10-03: loopback 127.0.0.1:55487; copy `qsqlgibgsxzlimoegcjx` read-only (cluster id `7550817586112808987`). 2026-10-04: new loopback cluster 127.0.0.1:55811 (`7692816301217905049`) for every database test; local Supabase stack `remediation` (127.0.0.1:59321/59322; clusters `7692834777418768423` / `7692835274743853093` for the final runs, earlier `7692826394889285670` / `7692827053218816039`) for the HTTP runs; copy not queried; original project: no query, no write |

## Tests executed on this artifact (`12eadcf`, 2026-10-05, all pass)

Local evidence only. Sanitized environment (`env -i PATH HOME LC_ALL`, Node v24.1.0), sequential, cluster 55811 unless noted. An earlier attempt of this matrix under Node 20 (the shell default) was discarded: its results are not evidence.

| Suite | Command | Result | Class |
|---|---|---|---|
| Type check | `node node_modules/typescript/bin/tsc --noEmit --incremental false` | clean | code |
| Production build (empty env) | `node node_modules/next/dist/bin/next build` | exit 0 | code |
| Target/guard/provider/runtime offline | `bash scripts/person-target/run-offline-tests.sh` | 52/52 | code |
| Transport (CLI adapter + armed adapter) | `node --test scripts/person-db-session/test-transport.mjs scripts/tenancy/test-armed-transport.mjs` | 18/18 | code |
| Tenancy cleanup safety (real CLI, sealed) | `node --test scripts/tenancy/test-armed-safety.mjs` | 12/12 | code |
| Start-catchup | `node --test scripts/person-maintenance/test-start-catchup*.mjs` | 34/34 | code |
| Internal resume access | `bash scripts/person-internal-resume/run-offline-tests.sh` | 13/13 | code |
| Application edits, clean install incl. forward files | `bash scripts/person-application-edits/run-local-tests.sh 55811` | 64 + 17 | local runtime |
| Upgrade path (old install + missing version + forward files; catalog parity) | `bash scripts/person-release-upgrade/run-upgrade-tests.sh 55811` | 25 + 4 + 64 + 17 + 4 + 4 | local runtime |
| Recruiter writer suites (stage harnesses that now install `20261005090000`) | `bash scripts/person-recruiter/run-local-tests.sh 55811`; `bash scripts/person-recruiter-admission/run-local-tests.sh 55811`; `bash scripts/person-audit/run-local-tests.sh 55811` | 13 + 4 + 6; 72 + 5; 21 + 68 + 28 + 23 + 10 | local runtime |
| Production catch-up combination (pinned runner, REST website, pg directory, loss + resume) | `bash scripts/person-maintenance/run-catchup-local-tests.sh 55811` on the local stack | 6/6 | local runtime |
| Transition rehearsal + recovery | `bash scripts/person-transition-cli/run-local-tests.sh 55811` (current; `PINNED_RUNNER_DIR=pl/pinned`) | 8 + 7; 8 + 7 | local runtime |
| Leak test armed orchestration (SQL) | `bash scripts/tenancy/run-armed-local-tests.sh 55811` (current; pinned) | 7; 7 | local runtime |
| Maintenance windows | `bash scripts/person-maintenance/run-local-tests.sh 55811` (current; pinned) | 10; 10 | local runtime |
| Publish/undo/guard | `bash scripts/person-publish/run-local-tests.sh 55811` | 10 + 18 + 4 + 8 | local runtime |
| Post-cutover audit | `bash scripts/person-audit/run-postcutover-audit-tests.sh 55811` | 15 + 9 + 13 + 25 + 20 + 19 | local runtime |
| Directory outcomes / index | `bash scripts/person-directory-outcomes/run-local-tests.sh 55811` | 6 + 40 + 35 + 12 + 237 + 25 + 3 + 20 | local runtime |
| Leak test, disabled controller (local Supabase stack, this build) | `node scripts/test-tenancy.mjs --base http://127.0.0.1:3400` | 913 calls, PASS, nothing left | local runtime |
| Leak test, armed controller (same, after `supabase db reset`) | `PINNED_RUNNER_DIR=… node scripts/test-tenancy.mjs --base http://127.0.0.1:3400 --armed` | run `4apmfef71`: preflight proved; 913 calls, PASS; owned drain/seal/disarm rev 2→5; 3 retained pool people | local runtime |
| Leak test started against a controller armed by someone else (the smoke seed) | `node scripts/test-tenancy.mjs --base http://127.0.0.1:3400` | refused at its first raw seed, cleaned its own rows, controller untouched | local runtime |
| Runtime attestation (same build) | identity RPC REST = PG (`7692871593400872999`), anon 401; correct selection 200; wrong selection 500 `person_target:rest_mismatch`, public 200; `outbound_denied:api.resend.com` (502), `outbound_denied:api.harvestapi.io` (route 200, empty) | as expected | local runtime |
| Browser smoke (built-in browser, synthetic data, provider blocking on) | `scripts/tenancy/smoke-seed.mjs` + the steps in the ledger ("Pre-release follow-up", 4) | sign-in, list, drawer Fit (#86) and Profile (#85), clear on a published person, list/recipient/`net_` empty, choose again | local runtime (DOM/computed-style evidence; pane too small for full-size visuals) |

Matrix totals on `12eadcf`: 879 executions plus 32 pinned-runner reruns, all pass.
Historical results for earlier commits (`75684a5`, `6c9168b`, `6df67d8` and before)
are recorded in the ledger as such and are not evidence for the changed code.

Not executed: the same sweep, smoke and attestation against a hosted deployment
(plan prepared in the ledger; the branch preview's deny-list value predates R2-04 and
its runtime has not been read); Nylas and Airtable denial at runtime through a server
route (code-level only); the compose panel itself (needs a connected mailbox).

## Retained data exceptions and remaining approvals

- 23 `candidate_experiences` rows / 3 absent owners: pre-migration debris, facts
  preserved under living owners; disposition pending (RR-10).
- Copy publication paused at 2,000 outcomes with 1 `audit_blocked`; 421,044 without
  projection state; 2,271 remaining under the partition; 5,488 open identity conflicts
  (retained by G5); 2 source-date holds.
- The copy's single Send witness is in the old shape until `20261003110000` is
  installed there.
- Historical NULL recruiter decisions on the copy: left automatic by the migration;
  per-row owner review proposed (ledger, follow-up section 1).
- Approvals outstanding: push (nothing pushed since `ae70f76`), hosted-preview
  validation on a disposable project, preview deny-list correction, copy upgrade
  (`20260928061000`, `20261003*`, `20261005090000`), Node 24 runtime change, RR-10
  disposition, rehearsal and production sitting, PR review (see ledger).
