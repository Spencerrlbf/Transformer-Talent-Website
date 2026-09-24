-- Person signals: facts about each person in the pool, worked out by code
-- from the data already stored on candidates (dated positions, education,
-- the current title) and the top-university and top-employer lists. Read
-- by the report card, the Network tab's filters and the per-role shortlist.
-- Recomputed only when the inputs change (source_hash). Additive.
create table if not exists public.person_signals (
  candidate_id uuid primary key references public.candidates(id) on delete cascade,
  years numeric,
  engineering_years numeric,
  current_tenure_months int,
  current_title text,
  title_family text[] not null default '{}',
  seniority text,
  top_university_tier smallint,
  top_university text,
  top_employer_tier smallint,
  top_employer text,
  has_descriptions boolean not null default false,
  positions int not null default 0,
  source_hash text not null,
  computed_at timestamptz not null default now()
);
create index if not exists person_signals_title_family_idx on public.person_signals using gin (title_family);
create index if not exists person_signals_tiers_idx on public.person_signals (top_university_tier, top_employer_tier);
create index if not exists person_signals_years_idx on public.person_signals (years);
alter table public.person_signals enable row level security;
