# Candidate storage migration: Spencer's manual test plan

**Status: preparation in progress. Do not use the old preview for these tests.**

Branch: `fix/person-90-release-remediation`.
Application/migration fixes: `79af7eb`; release evidence: `adae577`.
The URL, test accounts, fixture links and final deployed commit will be supplied
after the selected environment passes the checks below. The existing hosted
preview is older than these fixes. The hosted/local environment choice is pending.

This plan checks the behavior you see in the browser. Codex separately checks
database upgrades, catch-up, recovery, exact accounting and tenant isolation.
Passing this plan is one release gate, not confirmation that the real migration
has completed.

## What Codex must prepare before handing this to you

- [ ] Create or start a separate disposable test database; record its identity.
  The original project and `tt-test-copy` baseline are excluded.
- [ ] Install and verify the required schema through `20261005120000`, including
  the prerequisite legacy schema. The current bootstrap and smoke seed are
  explicitly local-only; they must not simply be pointed at a hosted database.
- [ ] Deploy/build this branch with Node 24 and the new target's browser, REST,
  storage and PostgreSQL credentials. Change only this branch's preview settings.
  Block messaging and enrichment providers and use synthetic provider settings.
- [ ] Verify the actual server's database identity, login and write path; verify
  the deployed commit and repeat the mismatch/denial checks on that deployment.
- [ ] Run the tenancy sweep against this exact build and target, both disabled and
  armed. Record both results and complete owned fixture cleanup.
- [ ] Prepare the named synthetic people, jobs and test accounts listed below,
  then verify their starting state through the UI and the database. Leave the
  controller armed/open for manual testing. Do not reset while you are testing.
- [ ] Supply a working URL, private sign-in instructions, direct fixture links,
  a small synthetic PDF, the deployed commit, and a READY confirmation. Credentials
  and sign-in tokens stay out of this document and out of Git.

If you choose a local preview, it works on this Mac while its services are running;
it does not establish Vercel runtime readiness. A hosted preview also requires the
approved temporary Supabase project and its operating window.

## Test data Codex will supply

These are the fixture requirements, not a claim they have already been created.
The handoff will confirm each one and provide its links.

| Fixture | Starting state / purpose |
|---|---|
| TT recruiter account | Can access Network, candidates, contact editing and the two TT jobs |
| Test Client A account | Owns the linked client job for normal Send tests; cannot see TT's private report-card evidence or Client B's applicants |
| Test Client B account | Owns a separate linked job, using the same external job number as A to exercise organization scoping |
| Jordan Avery | Published pool person, full profile, linked TT application, current and historical email, phone; matched to two TT roles |
| Casey Morgan | Normalized but unpublished pool person with a linked TT application, email history and a phone; exercises the other contact-read path |
| Taylor Reed | Published person reserved for normal Send; complete contacts and a match to the TT job linked to Client A |
| Senior Backend Engineer, TT job #99101 | Linked to Client A's test job; Jordan and Taylor have matches |
| Staff Platform Engineer, TT job #99102 | Linked to Client B's test job; Jordan appears under "Also a match" before being sent |
| Synthetic PDF | Contains only the same fake profile data; no real CV or candidate details |

Jordan's expected profile: Senior Backend Engineer at Northwind Analytics,
Austin, Texas; work history at Northwind Analytics, Harbor Logistics and Lakeside
Software; two education entries; skills including TypeScript, Go and PostgreSQL.
Starting email: `jordan.avery@example.test`; historical alternative:
`javery.old@example.test`; phone: `+15125550142`.
The handoff must list Casey's and Taylor's exact contact values as well.

## How to record results

Allow about 30–45 minutes. Use a full-width desktop browser. Open the client
accounts in separate browser profiles/private sessions so you do not confuse the
current organization. Run the cases in order; later cases deliberately use changes
made earlier. Ask Codex to reset only these fixtures if you need a fresh attempt.

For every case mark **PASS**, **FAIL** or **BLOCKED**. BLOCKED is not a pass.
On failure record the case number, account, person, exact steps, expected result,
actual result and a screenshot. A sign-in URL or browser token is private: do not
paste it into an issue or commit. All screenshots should show synthetic data only.

## Manual cases and acceptance criteria

| ID | What you manually do | Acceptance criteria |
|---|---|---|
| M01 — Correct environment and login | Open the supplied READY URL, sign in as the TT test recruiter, and open **Network**. Check the fixture names against the handoff. | The dashboard loads, the account is TT, and Jordan, Casey and Taylor are available. The supplied URL and build match the handoff. If you see real candidates or the wrong company, stop and report it. |
| M02 — Profile drawer | Open Jordan. Select **Profile**. Read About, Experience, Education and Skills. Resize the browser once, then reopen the drawer. | The prepared profile is present and readable. All three employers and both education entries appear in the correct chronology; skills and text do not overlap or become inaccessible. Closing/reopening does not lose profile content. |
| M03 — Fit and suggested role | Open Jordan's linked TT application from the supplied link. Select **Fit**. Find **Also a match**, then use **View job** on Staff Platform Engineer #99102. | The existing role and its report card are shown; #99102 appears as a suggestion with the correct title/review. **View job** opens #99102. Merely viewing a suggestion creates no application or Pipeline entry. |
| M04 — Choose a primary email | In Jordan's contact area, use **Make primary** beside `javery.old@example.test`. Close the drawer, reload, and open Jordan from both Network and the linked TT application. | The selected address is the primary in both places after reload. The other valid address remains available as an alternative; it is not silently deleted or displayed as the primary. The phone is unchanged. |
| M05 — Clear email only | In Jordan's contact **Edit** form, empty **Email**, keep the phone, and click **Save**. Close/reopen and reload. Check Network and the linked TT application. | Primary email remains empty in every checked view. Neither the old selected address nor the other historical address becomes the primary again. The phone remains `+15125550142`. This is a deliberate clear, not a temporary missing display value. |
| M06 — Clear phone only | Edit Jordan: enter `jordan.avery@example.test` as Email, empty **Phone**, and **Save**. Reload and check both entry points again. | Email is restored and remains visible. Phone remains empty after reopening/reloading, without the old scalar phone returning. The unrelated profile and role information are unchanged. |
| M07 — Clear both on an unpublished person | Open Casey from Network. Note the starting values, then empty Email and Phone and save. Reload, then open Casey's linked TT application. | Both fields remain empty in Network and the linked drawer. A historical email or phone does not return. Saving this unpublished person succeeds; there is no false "saved" followed by old values on reload. |
| M08 — Restore an intentional contact | On Casey, set Email to `casey.manual@example.test` and Phone to `+15125550144`. Save, close, reload and reopen through the linked application. | Both newly chosen values persist across the two views. The former clear does not permanently prevent a later intentional choice. Phone formatting may be normalized, but the number is equivalent. |
| M09 — Cancel an edit | On Casey, open Edit and type `casey.unsaved@example.test`, then choose **Cancel**. Close/reopen and reload. | The saved email from M08 remains. The cancelled value appears nowhere as the selected email. |
| M10 — Reject invalid values | On Casey, try Email `not-an-email` and save. Dismiss the draft and confirm M08's values. Separately try Phone `not-a-number` with the valid email and save. Dismiss and reload. | Each invalid input gives a visible validation error and no successful-save claim. Neither invalid value persists; both previously saved valid contact values remain. |
| M11 — Normal Send | Open Taylor in Network, expand the matched roles, select the prepared Client A-linked match and confirm **Send to job**. Switch to Client A and open that job's Pipeline and Taylor's drawer. | Exactly one Taylor application appears at **New**, with the Transformer Talent referral attribution. Profile, email and phone match Taylor's prepared values. Client A sees the allowed summary/tag/reason, without TT's internal Q&A evidence, prompts or private report-card details. This test creates an application; it does not send a real candidate email. |
| M12 — Send after an explicit clear | Back as TT, clear both Jordan contact fields and save. Reload and confirm they are empty. In Network, send Jordan to the match linked to Client B. Open the resulting application as Client B. | Jordan's application is created successfully with the profile, while email and phone remain empty. Historical contacts are not revived in the recipient's drawer. This checks a new Send; it does not require earlier sent snapshots to change retroactively. |
| M13 — Duplicate prevention | Return to TT Network and reload Taylor's match used in M11. Attempt the same Send again if the UI still offers it. Check Client A's Pipeline. | The role is marked sent or repeat Send is safely handled. Client A still has exactly one application for Taylor on that job, with no duplicate role or candidate entry. |
| M14 — Organization separation | As Client A search for Jordan; as Client B search for Taylor. Check that each account still sees the person sent to its own job. Try opening the TT Network page as a client. | A sees Taylor but not Jordan; B sees Jordan but not Taylor. Matching job numbers do not cross company boundaries. Client accounts cannot browse TT's pool or private report-card evidence. A hidden page or clear access refusal is acceptable; disclosed foreign data is a failure. |
| M15 — Resume and persistence | On the linked TT application for Casey, open **Resume**, upload the supplied synthetic PDF if none is attached, and reopen it. Reload, then recheck Casey's saved contacts and profile. | The PDF can be opened and is the supplied file. Casey's existing selected contact values are preserved. Upload/reload does not erase the profile, replace a deliberate choice with historical data, or create a duplicate person. Provider-based enrichment is outside this manual test. |
| M16 — Final persistence check | Sign out of the TT test account and sign back in using the supplied test-login method. Revisit Jordan, Casey and Taylor, plus the two client Pipelines. | Jordan remains cleared, Casey retains M08's values, Taylor remains sent once, and the clients retain only their own expected applications. No duplicate person or application appears after a new session. |

**If a menu, fixture or sign-in method described here is missing, mark that case
BLOCKED and tell Codex. Do not improvise using a real person or the baseline copy.**

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
disposable environment. Keep the test report before cleanup. A paid environment
must remain within its approved operating window and budget.
