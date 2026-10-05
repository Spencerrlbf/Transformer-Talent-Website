# Candidate storage migration: Spencer's manual test plan

**Status: READY for manual testing — October 5, 2026. Production is not released.**

Tested deployment: **`13f1b308f4e6a43b03cda752a001897c3295dbce`**, branch
`fix/person-90-release-remediation`, Node 24. Application/migration fixes include
`79af7eb`; `13f1b30` also confines operator fixture preparation to owned IDs.
Use this fixed deployment URL throughout the test, including after any later
documentation-only commits:

- [TT Network: prepared roles only](https://transformer-talent-website-87oyi44go.vercel.app/dashboard/network?job=99101)
- [TT applications: job #99101 → Pipeline](https://transformer-talent-website-87oyi44go.vercel.app/dashboard/jobs/99101?tab=pipeline)
- [Suggested TT job #99102](https://transformer-talent-website-87oyi44go.vercel.app/dashboard/jobs/99102)
- [TT Network: Client B-linked match for M12](https://transformer-talent-website-87oyi44go.vercel.app/dashboard/network?job=99102)
- [Client Pipeline: job #9001](https://transformer-talent-website-87oyi44go.vercel.app/dashboard/jobs/9001?tab=pipeline) — same URL, company determined by the signed-in account.
- [Private sign-in links and refresh instructions](.superpowers/manual-acceptance/TEST_ACCESS_PRIVATE.md) — local, ignored by Git. Use distinct browser profiles or different browsers for the three accounts; if using one profile, sign out before switching accounts. Separate private windows may share the same session. These one-use links send no email; request fresh links if they expire. Do not use the normal email-link form for these synthetic addresses.
- [Synthetic PDF for M15](output/pdf/Riley-Morgan-Synthetic-Resume.pdf)

Database: existing hosted **`tt-test-copy`**, project **`qsqlgibgsxzlimoegcjx`**,
cluster **`7550817586112808987`**. Controller left **armed/open**, revision 17,
generation 13. Keep this copy and these fixtures running while testing.

This plan checks the behavior you see in the browser. Codex separately checks
database upgrades, catch-up, recovery, exact accounting and tenant isolation.
Passing this plan is one release gate, not confirmation that the real migration
has completed.

## What Codex must prepare before handing this to you

- [x] Confirm the approved hosted copy and record its identity. Production is excluded.
  Copy cluster: `7550817586112808987`; the previous baseline-only restriction was
  superseded by Spencer's October 5 setup approval.
- [x] Install and verify the required schema through `20261005120000`, including
  the prerequisite legacy schema. The current bootstrap and smoke seed are
  explicitly local-only; they must not simply be pointed at a hosted database.
- [x] Deploy/build this branch with Node 24 and the new target's browser, REST,
  storage and PostgreSQL credentials. Change only this branch's preview settings.
  Block messaging and enrichment providers and use synthetic provider settings.
- [x] Verify the actual server's database identity, login and write path; verify
  the deployed commit. The same-source isolated hosted canary refused a wrong selection; the testing deployment refused Resend in-process. See HOSTED_TEST_READINESS.md.
- [x] Run the tenancy sweep against this exact build and target, both disabled and
  armed. Record both results and complete owned fixture cleanup.
- [x] Prepare the named synthetic people, jobs and test accounts listed below,
  then verify their starting state through the UI and the database. Leave the
  controller armed/open for manual testing. Do not reset while you are testing.
- [x] Supply a working URL, private sign-in instructions, direct fixture links,
  a small synthetic PDF, the deployed commit, and a READY confirmation. Credentials
  and sign-in tokens stay out of this document and out of Git.

The test application will run on Vercel against the existing Supabase copy.
No additional Supabase project was created for this setup; the existing copy stays
available for testing under its existing hosting arrangement.

## Test data Codex will supply

These fixtures are created and verified. Click the person's name in the filtered Network list or job #99101 Pipeline. There are **four** rows there: Jordan, Riley and Taylor are yours to test; **Casey Morgan is a completed setup probe**, whose audit history is retained. Leave Casey unchanged. The two client Pipelines start empty.

| Fixture | Starting state / purpose |
|---|---|
| TT recruiter account | Can access Network, candidates, contact editing and the two TT jobs |
| Test Client A account | Owns the linked client job for normal Send tests; cannot see TT's private report-card evidence or Client B's applicants |
| Test Client B account | Owns a separate linked job, using the same external job number as A to exercise organization scoping |
| Jordan Avery | Published pool person, full profile, linked TT application, current and historical email, phone; matched to two TT roles |
| Riley Morgan | Normalized but unpublished pool person with a linked TT application, email history and a phone; exercises the other contact-read path |
| Taylor Reed | Published person reserved for normal Send; complete contacts and a match to the TT job linked to Client A |
| Senior Backend Engineer, TT job #99101 | Linked to Client A's test job; Jordan and Taylor have matches |
| Staff Platform Engineer, TT job #99102 | Linked to Client B's test job; Jordan appears under "Also a match" before being sent |
| Synthetic PDF | Contains only the same fake profile data; no real CV or candidate details |

Jordan's expected profile: Senior Backend Engineer at Northwind Analytics,
Austin, Texas; work history at Northwind Analytics, Harbor Logistics and Lakeside
Software; two education entries; skills including TypeScript, Go and PostgreSQL.
Starting email: `jordan.avery@example.test`; historical alternative:
`javery.old@example.test`; phone: `+15125550142`.
Riley starts at `riley.morgan@example.test`, alternative `rmorgan.old@example.test`,
phone `+15125550146`. Taylor starts at `taylor.reed@example.test`, alternative
`treed.old@example.test`, phone `+15125550145`. All three have three employers,
two education entries and ten skills. Riley has no publication row and no recruiter
edit receipt at handoff; the first live save can publish Riley as part of the edit.
This is expected. Do M07 before any other save on Riley.

## How to record results

Allow about 30–45 minutes. Use a full-width desktop browser. Open the client
accounts in distinct browser profiles or different browsers so you do not confuse
the current organization. Separate private windows in the same browser may share
a login. If using one profile, sign out before each account switch. Run the cases in order; later cases deliberately use changes
made earlier. Ask Codex to reset only these fixtures if you need a fresh attempt.

For every case mark **PASS**, **FAIL** or **BLOCKED**. BLOCKED is not a pass.
On failure record the case number, account, person, exact steps, expected result,
actual result and a screenshot. A sign-in URL or browser token is private: do not
paste it into an issue or commit. All screenshots should show synthetic data only.

## Manual cases and acceptance criteria

| ID | What you manually do | Acceptance criteria |
|---|---|---|
| M01 — Correct environment and login | Open the supplied READY URL, sign in as the TT test recruiter, and open **Network**. Check the fixture names against the handoff. | The dashboard loads, the account is TT, and Jordan, Riley and Taylor are available. The supplied URL and build match the handoff. The copy contains existing candidates too: edit only the named synthetic fixtures. Stop if the URL or signed-in company differs from the handoff. |
| M02 — Profile drawer | Open Jordan. Select **Profile**. Read About, Experience, Education and Skills. Resize the browser once, then reopen the drawer. | The prepared profile is present and readable. All three employers and both education entries appear in the correct chronology; skills and text do not overlap or become inaccessible. Closing/reopening does not lose profile content. |
| M03 — Fit and suggested role | Open Jordan's linked TT application from the supplied link. Select **Fit**. Find **Also a match**, then use **View job** on Staff Platform Engineer #99102. | The existing role and its report card are shown; #99102 appears as a suggestion with the correct title/review. **View job** opens the panel for #99102 (with an optional **Open full page** link). Merely viewing a suggestion creates no application or Pipeline entry. |
| M04 — Choose a primary email | In Jordan's contact area, use **Make primary** beside `javery.old@example.test`. Close the drawer, reload, and open Jordan from both Network and the linked TT application. | The selected address is the primary in both places after reload. The other valid address remains available as an alternative; it is not silently deleted or displayed as the primary. The phone is unchanged. |
| M05 — Clear email only | In Jordan's contact **Edit** form, empty **Email**, keep the phone, and click **Save**. Close/reopen and reload. Check Network and the linked TT application. | Primary email remains empty in every checked view. Neither the old selected address nor the other historical address becomes the primary again. The phone remains `+15125550142`. This is a deliberate clear, not a temporary missing display value. |
| M06 — Clear phone only | Edit Jordan: enter `jordan.avery@example.test` as Email, empty **Phone**, and **Save**. Reload and check both entry points again. | Email is restored and remains visible. Phone remains empty after reopening/reloading, without the old scalar phone returning. The unrelated profile and role information are unchanged. |
| M07 — Clear both on an unpublished person | Open Riley from Network. Note the starting values, then empty Email and Phone and save. Reload, then open Riley's linked TT application from job #99101 → Pipeline. | Both fields remain empty in Network and the linked drawer. A historical email or phone does not return. Saving this unpublished person succeeds; there is no false "saved" followed by old values on reload. |
| M08 — Restore an intentional contact | On Riley, set Email to `riley.manual@example.test` and Phone to `+15125550144`. Save, close, reload and reopen through the linked application. | Both newly chosen values persist across the two views. The former clear does not permanently prevent a later intentional choice. Phone formatting may be normalized, but the number is equivalent. |
| M09 — Cancel an edit | On Riley, open Edit and type `riley.unsaved@example.test`, then choose **Cancel**. Close/reopen and reload. | The saved email from M08 remains. The cancelled value appears nowhere as the selected email. |
| M10 — Reject invalid values | On Riley, try Email `not-an-email` and save. Dismiss the draft and confirm M08's values. Separately try Phone `not-a-number` with the valid email and save. Dismiss and reload. | Each invalid input gives a visible validation error and no successful-save claim. Neither invalid value persists; both previously saved valid contact values remain. |
| M11 — Normal Send | Find Taylor in the prepared Network list. Close the person drawer if open. In the table row, click the match chip or **▸** to expand matched roles, then choose **Send to job** for Senior Backend Engineer #99101 (Client A). Switch to Client A and open that job's Pipeline and Taylor's drawer. | Exactly one Taylor application appears at **New**, with the Transformer Talent referral attribution. Profile, email and phone match Taylor's prepared values. Client A sees the allowed summary/tag/reason, without TT's internal Q&A evidence, prompts or private report-card details. This test creates an application; it does not send a real candidate email. |
| M12 — Send after an explicit clear | Back as TT, clear both Jordan contact fields and save. Reload and confirm they are empty. Open the supplied **TT Network: Client B-linked match for M12** link (job #99102), close the person drawer if open, then click the table row's match chip or **▸** and choose **Send to job** for #99102. The original #99101 filter hides this match. Open the resulting application as Client B. | Jordan's application is created successfully with the profile, while email and phone remain empty. Historical contacts are not revived in the recipient's drawer. This checks a new Send; it does not require earlier sent snapshots to change retroactively. |
| M13 — Duplicate prevention | Return to TT Network and reload Taylor's match used in M11. Attempt the same Send again if the UI still offers it. Check Client A's Pipeline. | The role is marked sent or repeat Send is safely handled. Client A still has exactly one application for Taylor on that job, with no duplicate role or candidate entry. |
| M14 — Organization separation | As Client A search for Jordan; as Client B search for Taylor. Check that each account still sees the person sent to its own job. Try opening the TT Network page as a client. | A sees Taylor but not Jordan; B sees Jordan but not Taylor. Matching job numbers do not cross company boundaries. Client accounts cannot browse TT's pool or private report-card evidence. A hidden page or clear access refusal is acceptable; disclosed foreign data is a failure. |
| M15 — Resume and persistence | On the linked TT application for Riley, open **Resume**, upload the supplied synthetic PDF if none is attached, and reopen it. Reload, then recheck Riley's saved contacts and profile. | The PDF can be opened and is the supplied file. Riley's existing selected contact values are preserved. Upload/reload does not erase the profile, replace a deliberate choice with historical data, or create a duplicate person. Provider-based enrichment is outside this manual test. |
| M16 — Final persistence check | Sign out of the TT test account and sign back in using the supplied test-login method. Revisit Jordan, Riley and Taylor, plus the two client Pipelines. | Jordan remains cleared, Riley retains M08's values, Taylor remains sent once, and the clients retain only their own expected applications. No duplicate person or application appears after a new session. |

**If a menu, fixture or sign-in method described here is missing, mark that case
BLOCKED and tell Codex. Do not improvise using a real person or a different database.**

## Results sheet

| Case | Result: PASS / FAIL / BLOCKED | Notes / screenshot reference |
|---|---|---|
| M01 | Not run | |
| M02 | Not run | |
| M03 | Not run | |
| M04 | Not run | |
| M05 | Not run | |
| M06 | Not run | |
| M07 | Not run | |
| M08 | Not run | |
| M09 | Not run | |
| M10 | Not run | |
| M11 | Not run | |
| M12 | Not run | |
| M13 | Not run | |
| M14 | Not run | |
| M15 | Not run | |
| M16 | Not run | |

## Acceptance and next step

Manual acceptance requires all sixteen cases to pass, or an explicit recorded
decision about any remaining cosmetic issue. Contact revival, lost data, duplicate
applications, foreign-company disclosure, broken saves or a blocked core case
cannot be treated as cosmetic. After a fix, rerun the failed case and any dependent
cases on the newly identified build.

Codex must also supply the automated hosted/local verification report. Database
upgrade/catch-up recovery, full-population counts, source-conflict disposition,
the 23 legacy experience rows, paid integrations, real email delivery and the
production configuration are not established by these browser cases.

Record "manual testing accepted" only for the tested build. Main merge and
production migration/cutover remain a separate release decision.

After testing, tell Codex whether to retain the fixtures for fixes or retire the
synthetic fixtures. Keep the test report before cleanup; this existing copy is not
a new disposable project and must not be deleted as part of fixture cleanup.

## Setup recovery record — October 5

The nine reviewed upgrades were applied to the copy with candidate IDs and
publication counts unchanged: 423,052 candidates and 2,008 published profiles.
Three September 29 application attempts remain **parked for review**, with zero
recovered or completed. Their two owned Harvest ledgers, three selected enrichment
rows, input snapshots and allowance history are preserved in a restricted audit.
They are excluded from automatic retry. The normal queue summary does not fully
represent this quarantine; always include these three in outstanding accounting.

The armed test now restricts reconciliation and anchors to its exact owned
fixture IDs. Its regression kept an unrelated pending person and an unrelated
verified/unanchored person unchanged. Preparation also refuses a controller change
before an anchor commit and cannot borrow another operator's maintenance window.
The normal DB-size gate is 34 GB; the documented copy-specific 45 GB ceiling is
passed explicitly for this existing 38.8 GB copy. This is no change to production
capacity approval or historical catch-up accounting.

## Setup verification, separate from your results

Hosted disabled sweep: **913/913 PASS**. Hosted armed sweep: **913/913 PASS**.
Server contact saves, clears, restores and invalid-input refusals passed; receipts
were read back on the selected copy. The profile and Fit drawers were checked in
the browser, including the separate suggested role. Resend was blocked before
transport; the negative-target deployment logged `person_target:rest_mismatch`.
The correct branch configuration and preview alias were restored after that canary.

Riley is a fresh reserved fixture because the initial live-save probe published
Casey. Casey's records remain as honest setup evidence. No reset or deletion of
those audit records was used to manufacture an unpublished starting state.

At handoff: 423,059 candidates = 423,052 prior copy rows + three retained armed-sweep
people + three manual people + Casey setup probe. There are 2,011 published profiles
= 2,008 prior rows + Jordan, Taylor and Casey. Riley is unpublished. The three old
failed application attempts remain parked for review, with **zero recovered**.
See [HOSTED_TEST_READINESS.md](HOSTED_TEST_READINESS.md) for the evidence and release boundaries.
