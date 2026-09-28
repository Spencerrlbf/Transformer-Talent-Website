# Stage 1 writer-coverage checklist

Parent at inventory time: `1c02b23`. Read-only inventory of every path that writes
candidate-owned data, taken from source (no database or network access). This is
the stage 1 exit test Spencer accepted on 2026-09-28:

> Every writer to candidate-owned data runs on the checked or admitted path, or is
> explicitly out of scope by Spencer's decision. A retryable 503 pause is a safe
> interim state, not coverage.

Two switches decide behaviour and are referred to below:

- **S1 profile guard**: `person_write_guard_set(true)`
  (`20260926183000_person_publish_runbook.sql`). Hash-based; refuses profile-column
  changes without an audit operation in the same transaction.
- **S2 normalization fence**: controller armed via `transition_set('arm')`, or any
  session carrying work headers (`person_private.normalization_required()`,
  `20260927023000_person_normalization_fence.sql:18-24`). Almost every fence checks S2.
- App side: `PERSON_WRITE_MODE` (legacy|shadow|live) and `PERSON_TRANSITION_SUPPORT`
  (`on` enables the certified writers and the editor pauses).

Status legend: **done** = checked/admitted path exists and is reachable; **paused** =
503 before side effects; **legacy** = direct write, no new-path branch; **blocked** =
would fail once S2 is armed; **n/a** = workflow/status data outside the profile.

## 1. Blocking gaps (must be fixed before S2 can be armed)

| # | Gap | Evidence | Needed |
|---|---|---|---|
| G1 | S2 refuses **every** unframed `candidates` UPDATE, including workflow columns (status, follow_up_at, role_preferences, visa_status, resume_text, matching_embedding, sync hashes). Rechecked 2026-09-28: this is intended; every post-cutover writer already uses a frame (application details via `person_application_candidate_details`, directory/refresh/recruiter certified saves). The legacy direct writes (`refresh.ts:397`, `directory.ts:407-563`, `intake.ts:342-411`, `applicants.ts:266`, `future-interest:178`, `applicant-pipeline:536`) run only with support off. | `20260927052000_person_intake_mutations.sql`; `intake.ts:156`, `:374` | Frames for the writers that remain: the paused TT editors' follow-up/preference mirror (`candidates-unified.ts:1155,1200,1231`) and `matching_embedding` publication for directory and refresh saves (certified paths defer derivatives; `directory.ts:742` is legacy-only) |
| G2 | No Actions workflow sets `PERSON_TRANSITION_SUPPORT`; certified refresh/directory/application workers are unreachable from Actions | `grep PERSON_TRANSITION_SUPPORT .github/workflows` → none | Wire the flag (per workflow, not shared) |
| G3 | No per-dispatch override; three workflows share `vars.PERSON_WRITE_MODE` (refresh-queue:32, review-queue:32, sync-candidates:38); the other six pass nothing | workflow inputs list only cap/dry_run/max/full/limit | Per-dispatch mode + support inputs for an isolated canary |
| G4 | Runbook steps that must run while S2 is armed are refused: historical catch-up (`person_backfill_save*` via the `save_person` wrapper, `person_backfill_flag_missing_employers` raw conflict insert), `person_reconcile_record_many` and `person_audit_anchor_commit` (`audit_proof_maintenance`), and bulk publish/undo (`save.ts` writes `candidates` and `identity_conflicts` directly unless inside application processing; the candidates guard admits projection only through `person_application_project`). From code; not yet reproduced locally | `20260927025000:67-72,148`; `20260927110000:66-67`; `save.ts:403` | A maintenance admission (the `maintenance` work family already reserved in `transition_work`) that opens frames for these named runbook steps only, usable only in the controller state the runbook specifies. The transition README already lists this as required |
| G5 | `identity_conflicts` has no UPDATE/DELETE under S2, so conflicts cannot be resolved while armed | `20260927110000` | Accept (resolve after cutover) or add an admitted resolver |
| G6 | `companies/schools/skills` accept only framed lookup inserts/updates under S2; any app code that maintains companies directly is refused | `20260927120000:16,26-27` | Confirm no live app writer (enrichment status, logos) or admit it |
| G7 | Derivative journal (`20260928010000`) refuses unframed `person_derivative_jobs` writes for any candidate with journal history **even when disarmed**; there is no admitted consumer, so claim/complete are refused | `20260928010000:196-201`; `150000:490-492` | Admitted consumer, and install order that cannot break today's drain |
| G8 | Runbook section 2 lists 31 migrations; 13 more exist (`20260927130000` … `20260928010000`) | migration directory | Append in dependency order; `20260927190000` fails if any directory execution already completed |
| G9 | `20260927170000` builds `candidates(lower(linkedin_username))` with a plain `create index` inside the migration (30 s timeout), blocking candidate writes | line 7 | Quiet window or a separately validated concurrent build (release doc already warns) |

## 2. Website routes (Vercel)

74 route files; no server actions; pages only read.

| Writer | Tables | Status |
|---|---|---|
| Public apply, referral application row, future interest (`app/api/apply`, `referral:180`, `future-interest:261`) | website_applications | done (`person_application_accept`) |
| Applicant pipeline, TT org (after response) | candidates, sources, contacts, identities, enrichments, results | done (`runApplicationWork` → claim/complete RPCs); legacy mode + support on leaves the row queued |
| Applicant pipeline, tenant org | tenant binding, results, contacts | done (tenant bind/complete RPCs) |
| Network contact edit, `net_` key (`candidates/v2/[key]/contact` PUT) | recruiter receipts, candidate_contacts, candidates.contact | done (`saveCertifiedRecruiter`) |
| add-role (`apply/add-role:71`) | website_applications roles | paused |
| TT application contact edit, resume upload, follow-up edits (`contact`, `resume`, `followup` routes, `app_` key) | website_applications, candidates mirror | paused |
| Network Send to a TT job (`network/send`) | website_applications | paused |
| Network Send to a **client** job (`network.ts:440-493`) | website_applications copy of pool profile, match_verdicts | **legacy** (pause check uses the client org, which is never paused) |
| Email send clears a due follow-up (`inbox.ts:702`) | website_applications.follow_up_at (+candidates for TT) | **paused silently**: error swallowed, email still sends, date not cleared |
| Referral record (`referral:154,211`) | referrals (candidate email/LinkedIn) | **legacy** |
| Candidate notes (`timeline` POST, `notes/[id]` PATCH/DELETE) | candidate_notes | **legacy** (no fence) |
| Email log (Nylas webhook, email send) | candidate_email_log | **legacy** (fence covers candidate_communications only) |
| Tenant application contact/resume/follow-up (`app_` tenant keys) | website_applications | legacy by design (release doc: tenant writers stay available) |
| Sourced people (`src_` keys, sourcing runs advance) | sourced_candidates, sourcing_run_candidates | legacy; tenant sourcing pool, no person path |
| Verdicts and judge caches (pipeline, rolecard review/feedback/relabel, eval) | match_verdicts, verdict_cache, verdict_feedback, person_role_types, candidate_profiles.confirmed_facts, verdict_evals.person | legacy, unguarded derived data |
| Talent refresh enqueue, JD telemetry | refresh_queue (fresh TT queued rows allowed), anonymous enrichment row | n/a (enqueue failure is swallowed at `spine.ts:430`) |
| Status, stages, no-reply, tasks, inbox, lists, attachments, tracked links | workflow tables keyed by candidate key | n/a |

Note: `applicationEditsPaused` returns false when `person_transition_status` reports
`enabled:false`, so edits use raw writes while the controller is disarmed. That is
consistent with S2 being off, but must flip together with arming.

## 3. Actions workers and scripts

| Workflow (UTC) | Legacy path | Shadow/live, support off | Support on (certified) |
|---|---|---|---|
| refresh-queue 08:00 → `refresh-worker.mjs` | direct candidates/enrichments/experiences/embeddings/refresh_queue; legacy retry re-patches failed rows (30 days) | savePerson path; queue top-up still direct | certified RPCs, derivatives deferred; **unreachable (G2)** |
| sync-candidates 07:00 → `sync-directory.mjs` | direct candidates PATCH/POST incl. DNC; matching_embedding | savePerson path; directory embeddings via own guard | certified RPCs; **unreachable (G2)** |
| review-queue 06:30 → `review-queue.mjs` | direct applications/candidates/enrichments/experiences/embeddings, verdicts | profile via savePerson, but follow-up/preferences/visa PATCH, resume-parse enrichment, application name/contact still direct | admitted work RPCs; **unreachable (G2)** |
| compute-signals 07:30 | person_signals upsert | same | no guard, no journal |
| build-shortlists 08:15 | role_shortlists delete+insert | same | no guard |
| judge-shortlists 08:45 | match_verdicts, verdict_cache, network_matches (copies name/title/company) | same | no guard |
| sourcing-resumer every 15 min | sourced_candidates, sourcing rows, orphan heal | same | tenant sourcing, no guard |
| person-trial (manual) | new-path tools (save_person, backfill, trial undo hard-deletes) | reads neither switch | trial undo must never run after cutover |

Derivative entry guard (`requireLegacyDerivativeConsumer`, `derivatives.ts`) covers only
the refresh derivative drain; it does not reach signals, shortlists, judge, directory
embeddings or the REST embedding writers in `spine.ts`.

## 4. Database-side writers and fence coverage

- No pg_cron jobs.
- Fenced under S2: candidates, candidate_sources, candidate_profile_state, identities,
  educations, skills, contacts, experiences, legacy candidate_emails,
  candidate_communications, candidate_enrichments, website_applications (TT rows),
  refresh_queue and refresh attempts, companies/schools/skills, identity_conflicts,
  projection state/history, derivative jobs, directory and recruiter tables, audit evidence.
- **Not fenced:** candidate_emails_v2, candidate_embeddings, person_signals,
  network_matches, match_verdicts, role_shortlists, candidate_role_statuses,
  candidate_notes, candidate_list_members, stage_events, candidate_email_log,
  verdict_cache, candidate_profiles, person_role_types, sourced_candidates,
  sourcing_run_candidates, referrals.
- Legacy SQL writers still allowed under S2: `refresh_network_matches`,
  `refresh_network_matches_role`, trigger `match_verdicts_network` (all copy profile
  fields into network_matches), sourcing RPCs (tenant tables).
- Every fence is a trigger; an owner session with `session_replication_role=replica`
  bypasses all of them. No code does this; keep it that way.

## 5. Scope decisions for Spencer

Recorded here as they are made; until then the suggested default applies.

1. Tenant-owned data (tenant application edits, sourced_candidates): suggested
   **out of scope**, stays legacy; it is organization data, not the TT pool.
2. Derived data (verdicts, shortlists, signals, network_matches, embeddings chunks):
   suggested **no fence**; instead drain them with the other writers and rebuild
   network_matches after publication so copied name/title/company match.
3. candidate_notes, candidate_email_log, referrals: suggested **out of scope for the
   profile guard** (not profile fields), but they must keep working while S2 is armed.

## 6. Exit checklist

`[x]` done, `[~]` partly done (see PR), `[ ]` open. Updated 2026-09-28.


- [ ] G1 frames for the remaining candidates writers (editor mirrors, directory/refresh matching_embedding)
- [x] G2 support flag wired per workflow (#74)
- [x] G3 per-dispatch override for an isolated canary (#74)
- [x] G4 maintenance admission: catch-up, reconcile and anchors in #71; publish while open in #73; undo by drain, seal, disarm (tested, #73)
- [ ] G5 conflict resolution decision
- [ ] G6 lookup writers confirmed
- [~] G7 derivative consumer lifecycle in #70; worker integration and install order still open
- [x] G8 runbook migration list complete (#75)
- [x] G9 index pre-built concurrently; migration uses IF NOT EXISTS (#75)
- [~] Paused TT editors: follow-up, resume and add-role in #72; **contact (awaiting Spencer's decision) and TT-target Send still open**
- [ ] Client-target Send admitted
- [x] Email-send follow-up clear no longer silently skipped (#72)
- [ ] Review worker's remaining direct writes (follow-up/preferences/visa, resume-parse, application name/contact) on the admitted path
- [ ] Refresh top-up and legacy retry on the admitted path or disabled under S2
- [~] Scope decisions: 1 agreed (tenant data stays legacy); publish runs while open (agreed); 2-3 still to ask
- [ ] Tested queue-only drain with public submissions accepted throughout

## 7. Found while building

- The shared projection envelope lost the email-collision conflict for every family that used it (application family included). Fixed in #73; an application-path collision test is still to add.
- `scripts/person-application-acceptance/run-local-tests.sh` fails 5 tests on the unmodified parent: it does not install migrations the library now uses. Refresh it during stage 2.
- The publish harness uses whatever worker lib is built; rebuild first.
