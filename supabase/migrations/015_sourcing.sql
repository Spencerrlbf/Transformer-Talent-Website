-- Sourcing module schema (Sourcing Task 2). Additive only — three new
-- tables, nothing existing touched. All org-scoped; service-role access
-- only (RLS on, no policies — same model as the rest of the spine).
--
-- Flow these tables serve: search builder → preview count → Harvest run
-- imports ALL matches → hybrid rank per run → deep-screen top slice.
-- sourced_candidates is the org's growing pool (deduped per org on the
-- LinkedIn identity); sourcing_run_candidates is run membership + per-run
-- rank/screening state; usage_events is the metering ledger billing reads.

-- One row per sourcing run (a client pressing "Import all N").
create table if not exists public.sourcing_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  org_role_id uuid not null references public.org_roles(id),
  created_by uuid, -- auth user id (no FK into auth schema by design)
  -- The exact Harvest lead-search query this run executed (titles,
  -- locations, companies, exclusions, freetext...). Replayable.
  search_params jsonb not null,
  status text not null default 'previewed'
    check (status in ('previewed','importing','ranking','screening','done','failed','cancelled')),
  error text,
  -- Counts the progress UI reads. match_estimate comes from the preview.
  match_estimate int,
  pages_fetched int not null default 0,
  imported_count int not null default 0,
  duplicate_count int not null default 0, -- already in the org pool: no charge
  screened_count int not null default 0,
  screen_target int not null default 0,   -- how many the run intends to screen
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists sourcing_runs_org_idx
  on public.sourcing_runs (organization_id, created_at desc);
create index if not exists sourcing_runs_role_idx
  on public.sourcing_runs (org_role_id);

-- The org's sourced-candidate pool: one row per person per org, first
-- imported by some run, reused (free) by every later run that matches them.
create table if not exists public.sourced_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  first_run_id uuid references public.sourcing_runs(id),
  -- LinkedIn identity for dedupe: username is the stable public handle.
  linkedin_username text not null,
  linkedin_url text,
  full_name text,
  headline text,
  location text,
  current_title text,
  current_company text,
  skills text[],
  years_experience numeric,
  -- Raw Harvest payload (server-side only, never sent to the client whole).
  profile jsonb,
  -- Matching-text embedding, computed once at import, reused by every run.
  embedding vector(1536),
  -- Set if/when this person also exists in the site candidates spine.
  candidate_id uuid references public.candidates(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, linkedin_username)
);
create index if not exists sourced_candidates_org_idx
  on public.sourced_candidates (organization_id, created_at desc);

-- Run membership: which candidates a given run surfaced, with per-run
-- ranking and screening state (scores are against that run's job).
create table if not exists public.sourcing_run_candidates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.sourcing_runs(id) on delete cascade,
  sourced_candidate_id uuid not null references public.sourced_candidates(id),
  organization_id uuid not null references public.organizations(id),
  -- LinkedIn's own ordering (page, position) — kept for debugging rank quality.
  source_page int,
  source_position int,
  -- Hybrid ranking outputs.
  embed_score real,
  keyword_score real,
  rank_score real,
  rank int,
  -- Deep-screening state + client-safe output (tag/reason rendered by
  -- client-reason.ts; full verdict jsonb stays server-side).
  screen_status text not null default 'none'
    check (screen_status in ('none','pending','done','failed')),
  verdict jsonb,
  tag text check (tag in ('strong','possible','stretch')),
  reason text,
  screened_at timestamptz,
  -- Client working state.
  shortlisted boolean not null default false,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  unique (run_id, sourced_candidate_id)
);
create index if not exists sourcing_run_candidates_run_idx
  on public.sourcing_run_candidates (run_id, rank);
create index if not exists sourcing_run_candidates_cand_idx
  on public.sourcing_run_candidates (sourced_candidate_id);

-- Metering ledger: one row per billable event. Billing/credits (Task 6)
-- reads this; the pipeline writes it as it goes. unit_cost_usd is OUR cost
-- (margin analysis); credits is what the client's balance is charged.
create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  run_id uuid references public.sourcing_runs(id),
  event_type text not null
    check (event_type in ('search_preview','search_page','profile_import','deep_screen')),
  quantity int not null default 1,
  unit_cost_usd numeric(10,5),
  credits int not null default 0,
  meta jsonb,
  created_at timestamptz not null default now()
);
create index if not exists usage_events_org_idx
  on public.usage_events (organization_id, created_at desc);
create index if not exists usage_events_run_idx
  on public.usage_events (run_id);

-- Service-role only, same as the rest of the spine: RLS on, no policies.
alter table public.sourcing_runs enable row level security;
alter table public.sourced_candidates enable row level security;
alter table public.sourcing_run_candidates enable row level security;
alter table public.usage_events enable row level security;
