# Hosted manual testing readiness — October 5, 2026

**READY for Spencer's manual testing. Production is not released.**

Use the [prepared Network](https://transformer-talent-website-87oyi44go.vercel.app/dashboard/network?job=99101)
and follow [MANUAL_ACCEPTANCE_PLAN.md](MANUAL_ACCEPTANCE_PLAN.md), which has 16 cases,
specific actions, acceptance criteria and a results sheet. Private one-use sign-in
links and their refresh command are in the ignored local file
`.superpowers/manual-acceptance/TEST_ACCESS_PRIVATE.md`. No login secrets are committed.

## Target and artifact

| Item | Verified value |
|---|---|
| Branch | `fix/person-90-release-remediation` |
| Tested deployed source | `13f1b308f4e6a43b03cda752a001897c3295dbce` |
| Vercel deployment | `dpl_42j5rpFpCzfCPbWtHYobAw6Tvo7C`, READY, Node 24.x |
| Fixed testing URL | `https://transformer-talent-website-87oyi44go.vercel.app` |
| Supabase target | Existing `tt-test-copy`, project `qsqlgibgsxzlimoegcjx`, us-east-2, PostgreSQL 17.6 |
| REST and PostgreSQL cluster identity | `7550817586112808987` |
| Controller at handoff | Armed/open, revision 17, generation 13 |
| Application/migration source | Includes `79af7eb`; operator scope fix is `13f1b30` |
| Worker bundle SHA256 | `29b7c96ab054fca3e5d9b0afbe209c7430b03646a8b440fbeb8fab0309ad3480` |
| Dependency lock SHA256 | `2c4ff8ad43b5cae55f06580afd4b7711f2beaeb2b0900f8c45acee2bd2fa51c5` |

Later handoff-document/PDF commits do not change the tested application artifact.
Use the fixed URL above, rather than assuming a moving branch alias is the same
deployment. The branch was pushed and deployed; `main` was not merged.

Spencer's October 5 approval authorized upgrading and using this existing copy as
the writable test environment. This supersedes the earlier baseline-only and
new-disposable-project proposals for this setup. No new Supabase project was
created. Production, communications and `_v2` data were not written.

## Recovery and schema

Before schema changes, three September 29 application attempts had uncertain
external effects and no completion receipt. Recovery preserved their inputs, two
owned Harvest ledgers, three selected enrichment rows and allowance history in a
restricted immutable audit. Their work was **parked for review**, with tokens
retired and no usable lease; the legacy queued retry path was excluded. Counts:
**3 parked, 0 recovered, 0 completed**. Deferred work is omitted by the ordinary
review-required summary, so these three must always be added to outstanding work.
No paid replay or fabricated completion was used.

The copy passed identity, recovery, load, lock and capacity gates. Its existing
38.8 GB size required an explicit copy-only 45 GB ceiling; the normal 34 GB default
was not relaxed. The normal controller drain/seal/disarm path was used. Recovery
regressions passed 11 checks locally before applying the copy-only procedure.

Nine reviewed forward migrations were installed together, recorded in history,
and PostgREST reloaded:

1. `20260928061000_person_resume_contact_fill`
2. `20261003090000_person_target_identity`
3. `20261003100000_person_forward_application_contact`
4. `20261003110000_person_forward_network_send`
5. `20261003120000_person_forward_identity_index`
6. `20261005090000_person_recruiter_explicit_clear`
7. `20261005100000_person_send_decisions`
8. `20261005110000_person_historical_shadow_clears`
9. `20261005120000_person_catchup_contact_snapshot`

The migration transaction preserved 423,052 candidate rows and 2,008 published
profiles. No historical numeric migration or local bootstrap was replayed.
Completed daily physical backups were confirmed through October 5; latest backup
was `2026-10-05T11:51:17.070Z`. PITR was disabled. **A fresh restore rehearsal was
not performed**, so backup availability must not be described as tested restoration.

## Hosted configuration and runtime evidence

Twenty-one branch-scoped preview overrides select copy browser/REST/storage keys,
the copy transaction pooler on port 6543, live person writes and transition support.
The previous direct IPv6 connection was replaced with the selected copy pooler.
Production environment settings were not changed. Copy Auth allows the fixed
preview redirect; prepared admin-generated links send no email.

Messaging/enrichment credentials are disabled or synthetic. The application deny
list is `.nylas.com,api.resend.com,.airtable.com,api.harvestapi.io,api.openai.com,api.cloud.llamaindex.ai,api.typesafe.ai`.
It guards application fetches, not all network activity in every hosted service.
Do not use the normal email-login form for synthetic addresses or infer that
Supabase Auth's own delivery has been disabled.

| Check | Result and scope |
|---|---|
| Disabled-controller tenancy sweep | **913 calls PASS**, 268 seconds, exact testing deployment and copy; temporary users, organizations and files cleaned up |
| Armed/open tenancy sweep | **913 calls PASS**, 274 seconds; actual controller checked during probes, own revision 9 → 12 cleanup only; three normalized synthetic audit people retained |
| Fixture isolation regression | Two database scope/race tests pass, including unrelated pending and verified/unanchored sentinels; original armed database suite 7/7 and sealed transport/cleanup suite 16/16 pass |
| Server target | Copy REST identity agrees with PG; anonymous identity call 401; authenticated profile and application reads 200 |
| Contact writes | Published email clear/restore and initially unpublished phone clear/restore succeeded; suppression decisions and receipts read back on copy; invalid email/phone rejected with 400 |
| Company separation | Both client accounts refused TT pool reads; exhaustive cross-organization sweep above passed |
| Provider boundary | Synthetic team resend request returned 502; hosted function log confirmed `outbound_denied:api.resend.com` before transport |
| Wrong selected target | Separate same-SHA hosted canary returned authenticated request 500 and logged `person_target:rest_mismatch`; public homepage remained 200 |
| Browser smoke | Signed-in prepared Network and linked application drawers; three jobs, two education entries and ten skills visible; separate suggested role opens the correct job panel; viewing it created no application |

The wrong-selection canary is deployment `dpl_67Nz9hAcfqjnMYaqjPHMVAgeZPRd`.
Only its selected project label differed; all credentials still belonged to the
copy. The correct branch selection and good deployment aliases were restored.
The fixed testing deployment remained unchanged. Do not use the deliberate
negative-test deployment for manual testing.

The armed sweep used the current translator for only its exact owned fixture IDs,
with a maximum of 100, preflight controller checks, per-write controller locking
and scoped anchor witnesses. It did not reconcile or anchor the copy's general
queue. This does not establish completion of the historical pinned catch-up.
Prior local catch-up and upgrade evidence remains in [RELEASE_MANIFEST.md](RELEASE_MANIFEST.md).
Hosted Resend denial is fresh evidence; the earlier Harvest/Nylas/Airtable tests
remain their separately labelled local/code evidence, not new hosted attempts.

## Manual starting state and exact setup accounting

At `2026-10-05T16:20:16.187Z`, before Spencer's manual tests:

| Measure | Exact state |
|---|---|
| Candidates | **423,059** = 423,052 prior + 3 retained armed-sweep + 3 manual + 1 setup probe |
| Published profiles | **2,011** = 2,008 prior + Jordan + Taylor + Casey setup probe |
| Riley | Unpublished; no recruiter edit receipt; Network and application read 200 with complete profile |
| Client A and B fixture applications | **0** across both prepared client Pipelines |
| Jordan application at suggested TT job #99102 | **0** |
| Unresolved controller work | **3 application attempts deferred for review**, no other unresolved work at observation |
| Database bytes | **38,799,617,171** |
| Installed setup upgrades | **9** |

Spencer's fixtures are **Jordan Avery**, **Riley Morgan**, and **Taylor Reed**.
TT job #99101 is linked to Client A's #9001; TT #99102 to Client B's separate #9001.
The repeated client job number deliberately checks organization boundaries. Three
synthetic accounts have private sign-in links. A synthetic PDF is provided for
Riley's resume test.

**Casey Morgan** remains visible as a fourth person because the initial live-save
probe published that person. That audit was preserved. Riley was created as a
fresh unpublished fixture and left untouched, rather than rewriting Casey's
history. Do Riley's M07 before any other save on Riley; that first live save can
publish Riley by design. Both client Pipelines are left empty for M11–M14.

## Evidence locations and remaining release gates

Private local evidence is under `.superpowers/manual-acceptance/`: sanitized final
aggregate state, schema/recovery results, disabled/armed sweep logs, hosted probes,
negative-target result and private function logs. Credentials, login links and
candidate-specific recovery records stay ignored and are not committed. Local
PG15 port 55821 and the isolated local Supabase project are stopped; their data
and volumes are retained. The hosted copy and testing preview remain available.
No GitHub Actions run was dispatched, duplicated or paused during this setup.

Ready for manual testing does not close these release gates:

- Spencer's 16 manual cases remain **Not run** in the results sheet. Automated
  smoke does not record acceptance on Spencer's behalf.
- RR-09: full source catch-up, conflict/completed/remaining accounting, anchors,
  publication and final audit at a declared cutoff. The fixture sweep did none of
  this for the full copy. Accept the reviewed compatibility artifact before using
  it for hosted historical catch-up and preserve that artifact on resume.
- RR-10: disposition of the 23 legacy experience rows, plus per-row decisions for
  remaining ambiguous historical live NULL choices. No bulk reinterpretation.
- The three parked application attempts remain owner-review work, not successes.
- Production's own migrations/configuration, recovery and release checks, PR
  review, and Spencer's approval for main merge/deploy/cutover remain required.
- Paid integrations and real email delivery are outside this isolated manual test.

Keep the prepared copy and fixtures available while Spencer tests. Do not delete
the existing project, reset the fixtures or rerun the sweeps during that testing.
