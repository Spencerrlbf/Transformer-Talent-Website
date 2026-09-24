-- Phase 2: per-role shortlists, rebuilt nightly by code (no model).
-- Applied 2026-09-24.
create table if not exists public.role_shortlists (
  org_role_id uuid not null references public.org_roles(id) on delete cascade,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  rank int not null,
  score numeric not null,
  similarity numeric,
  keyword_hits int not null default 0,
  checks jsonb not null default '{}'::jsonb,
  reasons text[] not null default '{}',
  built_at timestamptz not null default now(),
  primary key (org_role_id, candidate_id)
);
create index if not exists role_shortlists_role_rank on public.role_shortlists (org_role_id, rank);
create index if not exists role_shortlists_candidate on public.role_shortlists (candidate_id);
alter table public.role_shortlists enable row level security;
