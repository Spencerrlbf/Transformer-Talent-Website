# Release manifest: candidate storage remediation branch

Tested hosted source: **`13f1b308f4e6a43b03cda752a001897c3295dbce`**.
Application/migration source includes **`79af7eb1f233edb6cb6369f50971eea2f0528769`**;
`13f1b30` additionally scopes armed operator preparation to owned fixtures.
The handoff documentation/PDF update changes no executable content.
This records local and hosted testing evidence, not release approval. Changes to source,
dependencies, migrations or configuration invalidate the evidence that depends on
those changes until re-verified. The detailed history is in `RELEASE_REMEDIATION.md`.

Evidence classes: **code** (static/offline), **local runtime** (this machine's
synthetic databases and production build), **deployed runtime** (October 5 hosted
copy; see [HOSTED_TEST_READINESS.md](HOSTED_TEST_READINESS.md)).
Earlier results are labelled historical and are not included in the fresh totals.

## Current hosted testing state — October 5

**READY for manual testing** at
[the fixed preview](https://transformer-talent-website-87oyi44go.vercel.app/dashboard/network?job=99101),
Vercel `dpl_42j5rpFpCzfCPbWtHYobAw6Tvo7C`, Node 24.x, source `13f1b30`.
The existing approved `tt-test-copy` is upgraded through `20261005120000`, selected
consistently by browser, REST, storage and PG, and left armed/open revision 17 /
generation 13. Production remains untouched. No new Supabase project was created.

Hosted disabled and armed sweeps each passed **913 calls** on this artifact.
Server clear/restore/validation probes, copy receipt readback, wrong-target hosted
canary refusal and Resend in-process denial passed. Branch configuration/aliases
were restored after the negative canary. Prior limitations saying the copy was
untouched, the branch unpushed or hosted attestation absent are historical below.

The exact setup accounting, recovery limits and runtime evidence are in
[HOSTED_TEST_READINESS.md](HOSTED_TEST_READINESS.md). Spencer's 16 cases and criteria
are in [MANUAL_ACCEPTANCE_PLAN.md](MANUAL_ACCEPTANCE_PLAN.md), all still Not run.
Three old application attempts are parked for review (zero recovered/completed).
RR-09 full migration accounting, RR-10 disposition and production release approval
remain outstanding. Fixture completion is not full migration completion.

## Source and dependencies at the earlier local closure

| Item | Value |
|---|---|
| Branch / checkout | `fix/person-90-release-remediation`, `pl/remediation` |
| Base | `c8fda5bfd50e8c40f22a3083e38c6eea71d0a803` (`feat/person-00-storage-unification`, includes `main` `9a3240c`) |
| Earlier local executable head | `79af7eb1f233edb6cb6369f50971eea2f0528769`: receipt-based historical-clear correction, bounded contact snapshot, compatible historical catch-up verification and regression tests |
| Previous executable / documentation heads | `90ebc0b` / `a9d14b1` |
| Commits after base at executable head | 31, including the two merged drawer commits `dad9549`, `c042c21` |
| Diff vs base at executable head | 116 files, +7,369 / -115 |
| Pushed tested artifact | `13f1b308f4e6a43b03cda752a001897c3295dbce`; subsequent handoff-only commits do not change the fixed tested URL |
| Excluded testing-branch content | diagnostic route/log commits `5db31f1`, `ce72331`, `8bc18b9` |
| Lockfile SHA256 | `2c4ff8ad43b5cae55f06580afd4b7711f2beaeb2b0900f8c45acee2bd2fa51c5` (unchanged) |
| Current worker SHA256 | `29b7c96ab054fca3e5d9b0afbe209c7430b03646a8b440fbeb8fab0309ad3480` (unchanged application source) |
| Historical translator bundle SHA256 | `c04e8c18657ffc03bac75f03a34b6772b8d8d878958635ff03b9ca0717f197a5` |
| Node | 24.x required by engines, `.nvmrc`, engine-strict, workflows and entry-point guards; fresh checks used v24.1.0 |
| PostgreSQL driver | `pg` 8.23.0 / `pg-connection-string` 2.14.0, locked |
| Local production build ID | `2Bg1PIpILfNk5vLzVzxcn` |

Application source and dependency lockfile did not change in this closure. The
historical pinned checkout's tracked tree is unchanged; the existing runner may
rebuild its ignored translator bundle. Hosted Node/runtime/configuration was subsequently attested on October 5, as
recorded above; these earlier local measurements remain tied to `79af7eb`.

## Catch-up artifact

The accepted historical DB checkpoint pin remains
`c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc`. The wrapper derives a separate runtime:
only the historical verifier's contact evidence loading and suppression rule
change. The translator bundle, reconcile loop, backfill and engine are identical
to their pinned inputs. Ordinary contact eligibility, source-conflict handling and
checkpoint rules remain intact.

| Item | Value |
|---|---|
| Compatibility ID | `c4d0e4e-explicit-contact-clear-v1` |
| Composite artifact SHA256 | `0d30436b535ffc015624b7f8f0153c6cf769908ed6e6a31597f8e71659407250` |
| Snapshot migration SHA256 | `b863803a57191122db842b63fe8dbdba3575a838f8beb4af3187f253fed8fb17` |
| Complete input/output hash manifest | [`docs/person-catchup-compatibility-manifest.json`](docs/person-catchup-compatibility-manifest.json) |
| Hosted execution gate | Both `PERSON_CATCHUP_COMPATIBILITY_ID` and `PERSON_CATCHUP_ARTIFACT_SHA256` must match the reviewed artifact before imports/transport; hosted acceptance is still pending |

Resume with the same accepted artifact. The checkpoint cursor advances for pending
and review outcomes. A later edit to an already-visited person needs a new bounded
queue run; genuine `same_snapshot_mutation` conflicts remain review outcomes and
must not be counted as verified. Re-saving valid recruiter decisions is not a
migration workaround.

## Migrations

**136 tracked migration files**. Disposable bootstrap `000_local_bootstrap.sql` is
local only. The release chain in the cutover runbook (`20260926033900` through
`20260928090000`) is followed by all eight forward files below, in order. An older
install from the copy's `23d7860` artifact first needs the missing
`20260928061000_person_resume_contact_fill.sql`. Previously installed historical
versions were not edited.

| Version | Purpose | MD5 |
|---|---|---|
| `20261003090000_person_target_identity.sql` | Service-role cluster identity RPC | `f8e1a230eb081172bc05e84e28cc0335` |
| `20261003100000_person_forward_application_contact.sql` | Application contact-fill body with phone support | `dd3a0c37536ce9b4860f03e2d20bdeab` |
| `20261003110000_person_forward_network_send.sql` | Witness proof/recovery, two-argument Send, snapshot export | `dda7e083bc64ea6686eb4bb65616fc1b` |
| `20261003120000_person_forward_identity_index.sql` | Validation-only identity-index preflight | `d63ff3b6a035ef6b6840291e8ab54e62` |
| `20261005090000_person_recruiter_explicit_clear.sql` | Explicit suppression versus automatic ranking; initial historical NULL classification and certified writer | `03381096b2593c378d2febd8bda1819c` |
| `20261005100000_person_send_decisions.sql` | Unpublished checked Send uses the same contact decisions | `86e72e9e509d0cb2383da6b0785c34bc` |
| `20261005110000_person_historical_shadow_clears.sql` | Correct current receipt-proven shadow clears, including after publication; preserve superseding decisions and exact trigger modes | `e4270cf400a81fbf02cc39de23f398c8` |
| `20261005120000_person_catchup_contact_snapshot.sql` | Complete, bounded, same-statement contact evidence for compatible historical verification | `e1dd9b33a2d606366d113a232bf7fc39` |

The receipt correction uses NOWAIT table locks. Apply after recovery, load and
drain gates; contention refuses atomically and requires settling the conflicting
activity before retry. Production-scale lock duration was not measured locally.
It preserves receipts, legacy fields, candidate IDs and publication rows. Stale
publication remains unavailable to live reads/Send until certified republishing.

The snapshot RPC is service-role-only, STABLE and SECURITY INVOKER. It allows at
most 500 unique IDs, refuses over 10,000 contact rows and a conservative 8 MiB
serialization budget, and returns scalar JSON to avoid table response caps. It
includes contacts, decisions, summary, revision and per-person counts in one
statement snapshot; incomplete evidence cannot certify or advance a checkpoint.

Upgrade fixtures retain the copy's older Send body from `23d7860`:
`old-20260928070000_person_network_send.sql` MD5
`8871cbec547a7f6129406111231b4157`. Fresh upgrade/clean-install checks establish
function, column, constraint, trigger and privilege parity, including both new
forward migrations.

## Earlier local configuration and destinations (superseded for hosted testing)

| Setting | Rule |
|---|---|
| `PERSON_TARGET_PROJECT_REF` | One selected project; `local` only for loopback fixtures. Historical labels: production `kmuihequfurvjxpnugxf`, copy `qsqlgibgsxzlimoegcjx` |
| REST / keys / PostgreSQL | Must select the same project; REST and PG cluster identities must agree before operator writes |
| `PERSON_DATABASE_URL` | Same-ref application/worker pooler URL |
| `PERSON_PUBLISH_DATABASE_URL` | Same-ref session/direct endpoint for transaction/session operations |
| Rehearsal provider deny list | `api.us.nylas.com,api.resend.com,.airtable.com,api.harvestapi.io`; local closure also denied OpenAI and the other configured enrichment hosts |
| Local test credentials | Synthetic provider placeholders, including Nylas API key and client ID; local Supabase keys in ignored mode-0600 file, never committed |
| Fresh local destinations | Dedicated PG15 cluster `127.0.0.1:55821`; isolated Supabase project `candidate-closure-90ebc0b` on API59421/PG59422; app `127.0.0.1:3451` |
| Hosted destinations | Neither baseline copy nor original project queried or written in this closure; preview configuration not re-read or changed |

The earlier preview restriction and Harvest-host typo were corrected by the
approved October 5 hosted setup. Use the fixed tested URL above. Repository GitHub
Actions target variables and production runtime/configuration still require
verification at release; hosted preview success does not establish them.

## Fresh verification of `79af7eb` (2026-10-04)

Sanitized environment, Node v24.1.0, synthetic local data only. **262 passing test
executions**, zero skipped, plus build/typecheck and the HTTP sweeps below. Logs
are ignored local evidence in `.superpowers/closure-90ebc0b/`.

| Suite / evidence | Command or method | Result | Class |
|---|---|---|---|
| Historical upgrade and clean-install parity | `bash scripts/person-release-upgrade/run-upgrade-tests.sh 55821` | 132/132 (`25+6+4+8+64+17+4+4`) | local runtime |
| Target/provider/runtime/input and compatible verifier | `bash scripts/person-target/run-offline-tests.sh` | 64/64 | code |
| Starter and transport regressions | `node --test scripts/person-maintenance/test-start-catchup*.mjs scripts/person-db-session/test-transport.mjs scripts/tenancy/test-armed-transport.mjs` | 52/52 | code |
| Actual REST website + PostgreSQL directory catch-up | `bash scripts/person-maintenance/run-catchup-local-tests.sh 55821` with isolated Supabase fixture | 14/14 | local runtime |
| Production build | `node node_modules/next/dist/bin/next build`, local fixture configuration | exit 0 | local runtime |
| Type check | `node node_modules/typescript/bin/tsc --noEmit --incremental false` | exit 0 | code |
| Identity and snapshot privilege | REST identity = PostgreSQL; anonymous snapshot request | identity agrees (`7692936694211489829`); service role 200, anonymous 401 | local runtime |
| Disabled-controller tenancy | `node scripts/test-tenancy.mjs --base http://127.0.0.1:3451` | 913 calls PASS; fixtures removed | local runtime |
| Armed-controller tenancy | Same build, clean stack, `--armed` and pinned runner | 913 calls PASS; own arm/drain/seal/disarm only; final disabled revision 5; three normalized people retained | local runtime |

The F2 regression first failed on the historical chain, then passed with the
receipt correction. It includes real old-schema publish-then-shadow email/phone/
both clears, superseded choices, replay, stale publication, republish, real checked
Send, idempotence, lock refusal and trigger-mode restoration.

The catch-up suite proves loss/resume with exactly seven people verified once,
email/phone/both clears, certified edits racing the snapshot, preserved source
review outcomes, a capped 1,500-contact table response versus complete scalar
snapshot, a target beyond 1,002 unrelated suppression decisions, near-bound byte
and row refusals, and actual suppressed rank-1/rank-2 corruption. Failed evidence
records no result or checkpoint; valid retries verify.

The first disabled HTTP attempt returned 38 `email_off` responses because the
local synthetic environment lacked `NYLAS_CLIENT_ID`. It was retained as a setup
failure, the placeholder was added, and the unchanged build's sweep reran green.
Outbound providers remained blocked. This is not counted as a passing run. An ad
hoc privilege probe first used the wrong parameter name and returned 404; the
corrected `p_candidate_ids` request established the 200/401 privilege result above.

## Historical evidence and limits

The previous `90ebc0b` matrix (892 executions, pinned/stage reruns), its browser
smoke, provider-route refusal probes and its 913-call sweeps remain historical
evidence in the ledger. They were not rerun wholesale or added to the fresh 262
count. This closure's independent reviewers inspected source/sealed probes; the
local database and HTTP results are recorded separately.

The earlier local closure did not establish hosted identity/configuration/runtime,
tenancy or browser smoke. Those preview checks were subsequently completed on
October 5 as recorded above. Runtime Nylas/Airtable route denial, full source
catch-up/publication/audit at a declared cutoff, disposition of legacy debris and
genuinely ambiguous historical live NULL decisions remain outside that evidence.

## Remaining release gates

1. Spencer's manual acceptance on the fixed tested deployment: all 16 cases are
   prepared and still Not run. Hosted setup, branch push, copy upgrades and the
   automated preview checks have completed under his approval.
2. Acceptance of this exact catch-up compatibility artifact for hosted historical
   catch-up; use
   the same accepted bytes on resume. No source-conflict policy override.
3. Per-row owner review of historical live NULL decisions still ambiguous after
   the receipt correction; RR-10 disposition of 23 experience rows / three absent
   owners; RR-09 catch-up, publication and final audit at a declared cutoff.
4. Disposition of the three copy application attempts parked for review, with
   zero recovered/completed; they are not removed from outstanding accounting.
5. Production recovery/schema/configuration/runtime checks, PR review and explicit release approval before
   main merge, deployment/projection cutover or restrictive write guards.

Prior copy counts (2,000 publication outcomes, one audit-blocked; 421,044 without
projection state; 2,271 under the partition; 5,488 identity conflicts; two source-date
holds) are the earlier review's observations, not current migration measurements.
The October 5 hosted report records schema and exact setup additions; it does not
refresh full-population migration accounting. The original project remains untouched.

## Local resource disposition

Verified stopped: owned app on 3451, isolated Supabase project
`candidate-closure-90ebc0b` and PG cluster55821. Its database/storage Docker volumes
and PostgreSQL data directory are retained. The final stack contains the armed
sweep's three immutable normalized synthetic people, zero Auth users, a disabled
controller and exactly the sweep's four owned transition events. Existing projects,
previous cluster55811 and the previous build output were preserved.
