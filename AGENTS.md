# Agent Rules — Transformer Talent Website

Rules for any AI agent (Claude Code, Codex, etc.) working in this repo.
`main` auto-deploys to production (transformertalent.com) via Vercel — treat
every merge as a production release.

## Workflow

1. **Never commit directly to `main`.** Every task gets its own branch:
   `feat/<area>-<nn>-<slug>` (or `chore/…`, `fix/…`). Build, commit, and push
   on the branch; Vercel produces a preview deployment for review.
2. **Merge to `main` only after the user confirms the task** — on the preview
   deployment where the change is visible in the browser.
3. **Small, self-contained tasks.** Propose → user confirms scope → build →
   commit → push → test → stop and wait for confirmation. One task at a time.
4. **After merging, verify the production deploy went green:**
   `gh api repos/Spencerrlbf/Transformer-Talent-Website/commits/<sha>/status --jq '.state'`

## Migrations

- **Additive only on feature branches** (new tables, new columns with safe
  defaults). Never alter or drop existing schema before merge — the Supabase
  database is shared between preview and production.
- The Supabase project is also shared with other systems (see below). Any
  migration touching tables this repo does not own must be flagged to the
  user before it is applied.

## Modularity

- New features live in their own module folders: `lib/server/<feature>/`,
  `components/dashboard/<feature>/`, `app/api/dashboard/<feature>/`.
- Existing code is **called, not modified**, except at touch-points agreed
  with the user. No monolith scripts; pipelines are small composable stage
  functions.

## Project facts & guardrails

- **Two table families share one Supabase project.** This site owns
  `candidates`, `candidate_experiences`, `org_roles`, `website_applications`,
  `organizations`, `org_members`, and related tables. The `_v2` tables
  (`candidate_profiles_v2`, `candidate_experiences_v2`, `companies_v2`, …)
  belong to the separate recruitment-ai-platform project — **read-only at
  most; never migrate, alter, or write to them.**
- **Hide the machinery from clients.** Client-facing surfaces (client
  boards, emails) must never expose Q&A evidence, scorecard rows, prompts, or
  internal shorthand. Clients see only a tag + plain-English reason, rendered
  via `lib/server/client-reason.ts`. This is a commercial rule, not styling.
  The recruiter dashboard is the exception by design: it shows the role's
  scorecard, each row's status and the quoted lines behind it (the report
  card in the candidate drawer). Recruiters see the machinery; clients never.
- **Auth pattern:** `supabaseBrowser` is for Supabase Auth ONLY — never for
  table reads. All data access is server-side with the service-role key
  behind `requireMember` (`lib/server/dashboard-auth.ts`). RLS is a backstop,
  not the tenancy mechanism.
- **Tenancy: organizations are sealed, and code is the only wall.**
  - Every read and write of an organization's table filters on
    `member.org.id`. Any id, job number or candidate key that comes from a
    request is proven to be the caller's before it is read or written
    (`candidateInOrg` in `lib/server/tasks.ts`, `keysInOrg` in
    `lib/server/lists.ts`, or the organization filter on the lookup). Job
    numbers repeat across organizations.
  - Transformer Talent's pool (`candidates` and everything keyed to it) is
    TT's. A client company's applicants never enter it: the apply pipeline
    keys them by the company's own application. Client actions never write
    to it either.
  - The only thing that crosses from TT to a client is a Send
    (`lib/server/network.ts`). It carries the person's profile, email and
    phone (Spencer's rule), and only `clientSafeVerdict` of TT's verdict (the
    tag and reason). TT-only routes return 404 to every other organization,
    on the server.
  - One organization per login. `requireMember` refuses a login that has
    two memberships.
  - Before merging anything that touches data access, run
    `node scripts/test-tenancy.mjs --base <preview url>`. It must print PASS.
  - Public forms (apply, referral, future interest) can't prove who is
    typing. A submission links to an existing pool person only when its
    email is one TT already has for them (`lib/server/pool-emails.ts`);
    otherwise it stands on its own, keyed by the application like a client
    company's applicant, and writes nothing to that person. A duplicate
    needs both the same email and the same LinkedIn. Run
    `node scripts/test-public-forms.mjs` after touching them.
- **Single-source pipeline:** role artifacts (matching profiles, embeddings,
  facet texts) are generated only via `lib/server/roles-pipeline.ts`. Scripts
  and dashboard share it. If it changes, rebuild the worker bundle with
  `scripts/build-worker-lib.mjs`.
- **Verdicts:** the nightly chain (directory sync → signals → shortlists →
  the light judge, `scripts/judge-shortlists.mjs`) writes `match_verdicts`
  rows as `{v2}` from the role's scorecard; the Network tab and the report
  card read those. The old question-sheet screening (`factsv6` cache keys)
  is retired from the nightly refresh; its rows only remain for applicants.
  Re-judging costs real money only when a profile or a card changes.
- **The directory is the source of engaged people.** The communications
  Supabase project (the reply-ops repo) holds the engaged directory;
  `scripts/sync-directory.mjs` copies it nightly into `candidates` (source
  `directory`, linked by `directory_contact_id`). It is read-only against the
  directory: never write to that project from this repo. Airtable is closing
  and its sync scripts are gone; rows with source `airtable_sync` are the
  same people before the move and stay engaged.
- **Cost discipline:** anything that fans out LLM calls (screening,
  enrichment, sourcing) must have an explicit cap or budget in code. Public
  forms have no shared cap: every application is kept and the paid review
  comes out of the company's own daily allowance
  (`lib/server/review-budget.ts`, `organizations.daily_review_limit`, 300 by
  default); over it, applications are queued and reviewed nightly.
- **Email built from outside text** (form fields, company names, job titles)
  goes through `lib/server/html.ts` (`escapeHtml`, rebuilt links). Run
  `node scripts/test-email-escaping.mjs` after touching any email.
- **Secrets** stay server-side (env vars). Never in client bundles, never
  committed. Browser code may read only `NEXT_PUBLIC_*` values.
