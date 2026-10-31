# Boards v1 — scope and extraction plan

Written 2026-10-31. Decisions agreed in planning; this file is the guidance
the fresh product repo is built from. `main` of this repo stays as it is
(the Transformer Talent site and recruiter CRM).

## 1. Decisions

| Question | Decision |
| --- | --- |
| Code | **Fresh repo.** This repo is reference material, not the base. |
| Database | **Fresh Supabase project** for the product, with a local Supabase (CLI) for dev. Not the shared TT project. |
| Deploy | Own Vercel project and domain. |
| Release window | One week. One task per branch, preview deploy, user confirms, merge. |
| AI review of applicants | *Open* — default is on, within a per-company daily budget. |
| Product name / landing page | *Open.* `handoff/Hirepage Landing.dc.html` holds three landing explorations. |
| Design kit | *Open* — format decides effort (tokens-only ≈ 1 day; Tailwind/React component kit ≈ 3 days). |

## 2. What the product is

A company's public job board and about page, a linked public recruiter
page, and just enough dashboard to run them. No CRM.

### Public
- `/board/[slug]` — company board: Jobs tab (table, inline JD, 3-role apply
  rail, referral) and About tab (company page).
- `/r/[slug]` — recruiter page: person header, roles, three doors (resume /
  hear from me later / refer), referral block, OG image.
- `widget.js` embed (iframe, auto-resize).
- APIs: apply, apply/add-role, referral, future-interest, analytics beacon.
- `/` — product landing page with sign-in entry.

### Dashboard
- Sign in (Supabase Auth magic link), one organization per login.
- Jobs: list, new / edit with JD paste-to-prefill, close. Job detail:
  Overview, Pipeline (applicants), Past.
- Applicants: table + drawer with Profile, Pipeline (stage), Resume tabs.
- Company page editor (own nav item).
- My page (recruiter page editor + publish).
- Team (owners): seats, invites, roles.
- Settings: interview stages, referral amount, board link + embed snippet.

### Not in v1
Home/KPIs, Inbox, email (Nylas), tasks, notes, lists, Network, sourcing,
credits, shortlists, verdict eval, tracked links, client-orgs / client
requests, the TT agency pages (home, about, roles, apply, talent,
market-index), all nightly workflows and `person-*` scripts.

## 3. Why fresh, and what "guidance" means

The kept surface in this repo transitively imports 186 of 303 source files
(110k lines), including the whole candidate store, inbox, email composer,
network matcher and sourcing — via a few hub files (`lib/server/supabase.ts`
imports person-transition; the drawer imports email/notes; the candidates
loader imports network). With a new database the server layer is rewritten
anyway, so the tangle is left behind rather than untangled.

**Lift (copy and adapt to the new tables)** — self-contained, carries
months of product decisions:

| Area | Files |
| --- | --- |
| Board / recruiter page | `components/board/BoardClient.tsx`, `CompanyAbout.tsx`, `SocialIcons.tsx`, `app/board/[slug]/page.tsx`, `app/r/[slug]/page.tsx`, `app/r/[slug]/opengraph-image.tsx`, `public/widget.js`, `public/embed-demo.html` |
| Loaders | `lib/server/org-board.ts`, `recruiter-page.ts`, `recruiter-profile.ts`, `company-page.ts`, `interview-stages.ts`, `publish-role.ts` (minus embeddings if dropped) |
| Dashboard UI | `components/dashboard/DashShell.tsx` (nav trimmed), `JobForm.tsx`, `CompanyPageEditor.tsx`, `jobs/StageEditor.tsx`, `jobs/InterviewStagesCard.tsx`, `app/dashboard/jobs/*`, `app/dashboard/my-page/page.tsx`, `app/dashboard/team/page.tsx`, `app/dashboard/settings/page.tsx` (cards trimmed) |
| Shared primitives | `components/MultiSelect.tsx`, `components/Turnstile.tsx`, `lib/role-options.ts`, `lib/future-options.ts`, `lib/socials.ts` |
| Server guardrails | `lib/server/dashboard-auth.ts`, `html.ts`, `turnstile.ts`, `ratelimit.ts`, `review-budget.ts`, `lead-notify.ts`, `email.ts`, `jd-extract.ts`, `job-body.ts`, `locations.ts`, `team.ts` |
| Styling | `app/globals.css` redesign layer, screens 1, 3 (public board + recruiter), 7 (job workspace) and the shell; `handoff/README.md` §2–3 for tokens — superseded where the design kit says otherwise |
| Tests | `scripts/test-tenancy.mjs`, `scripts/test-email-escaping.mjs` (adapted) |

**Reference only (rewrite small)**: `app/api/apply/route.ts` +
`lib/server/applicant-pipeline.ts` → one short route: validate, store
application + resume, optionally one review within budget, notify
recruiter. `lib/server/candidates-unified.ts` + `CandidatesTable.tsx` +
`CandidateDrawer.tsx` → a simple applicants list and drawer.
`supabase/migrations/*` → consulted for column semantics only.

## 4. Rules that carry over (new repo AGENTS.md, day one)

- `main` auto-deploys; never commit to it directly; one task per branch.
- All data access server-side with the service-role key behind a member
  check. Browser talks to Supabase for Auth only.
- Every read and write filters on the caller's organization; any id from a
  request is proven to belong to that organization before use.
- Clients see a tag and a plain-English reason — never prompts, scorecards
  or evidence.
- Outside text (form fields, company names, titles) is escaped before it
  reaches an email.
- Secrets stay in env vars; browser reads `NEXT_PUBLIC_*` only.
- Anything that fans out LLM calls has an explicit cap in code.

## 5. Schema draft (new project, ~10 tables)

organizations · org_members · org_roles · interview_stage_templates ·
recruiter_profiles · website_applications · applicants (the product's own
candidates) · applicant_role_statuses · referrals · future_interest ·
page_events. Storage buckets: resumes (private), company-assets (public),
recruiter-photos (public). One RPC if role suggestions are kept
(`match_org_roles`, pgvector). Full SQL is task 2 in the new repo.

## 6. Build order (new repo)

1. Repo skeleton, AGENTS.md, Next.js + TypeScript, Vercel project.
2. Schema + migrations + local Supabase; seed script.
3. Auth + dashboard shell + `/api/me`.
4. Jobs: list, new/edit (JD prefill), detail, stages.
5. Board + recruiter page + apply/referral/future-interest + widget.
6. Applicants list + drawer + stage changes + resume view.
7. Company page editor, My page, Team.
8. Settings (stages, referral amount, board link/embed).
9. Landing page.
10. QA: tenancy test on preview, email escaping, end-to-end apply on a board
    and a recruiter page, embed, magic-link sign-in. Domain + Auth redirect
    URLs.

Design kit applied as each screen lands, not at the end.

## 7. Needed from the user

GitHub repo created and added to the session · new Supabase project with
keys set in Vercel env (not in chat) · AI review on/off · product name ·
design kit files.
