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
- **Hide the machinery from clients.** Client-facing surfaces (dashboard,
  boards, emails) must never expose Q&A evidence, scorecards, prompts, or
  internal shorthand. Clients see only a tag + plain-English reason, rendered
  via `lib/server/client-reason.ts`. This is a commercial rule, not styling.
- **Auth pattern:** `supabaseBrowser` is for Supabase Auth ONLY — never for
  table reads. All data access is server-side with the service-role key
  behind `requireMember` (`lib/server/dashboard-auth.ts`). RLS is a backstop,
  not the tenancy mechanism.
- **Single-source pipeline:** role artifacts (matching profiles, embeddings,
  facet texts) are generated only via `lib/server/roles-pipeline.ts`. Scripts
  and dashboard share it. If it changes, rebuild the worker bundle with
  `scripts/build-worker-lib.mjs`.
- **Verdict cache:** cache keys are prefixed `factsv6`. Changing screening
  prompts/logic without bumping the prefix serves stale verdicts; bumping it
  invalidates the cache and re-screening costs real money. Change it
  deliberately and tell the user.
- **Airtable coexists.** Airtable is the founder's private ops view and must
  keep working alongside the dashboard. Do not remove or break its sync
  paths.
- **Cost discipline:** anything that fans out LLM calls (screening,
  enrichment, sourcing) must have an explicit cap or budget in code.
- **Secrets** stay server-side (env vars). Never in client bundles, never
  committed. Browser code may read only `NEXT_PUBLIC_*` values.
