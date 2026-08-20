-- EM judge support (additive).
--
-- 1. Global company-context cache: public facts about employers (industry,
--    size, one-liner) fetched once from Harvest ($0.004) and shared across
--    every run and tenant — so a no-name Series B gets judged on what it
--    is, not on whether the model has heard of it. No PII, not org-scoped.
create table if not exists public.company_context (
  id uuid primary key default gen_random_uuid(),
  linkedin_slug text not null unique, -- linkedin.com/company/<slug>
  name text,
  industry text,
  employee_range text,
  description text,
  founded int,
  raw jsonb,
  fetch_failed boolean not null default false, -- negative cache: don't re-pay for misses
  fetched_at timestamptz not null default now()
);
alter table public.company_context enable row level security;

-- 2. Sourcing tags widen to the 4-tier outreach scale (legacy 3 stay valid
--    so old runs keep rendering).
alter table public.sourcing_run_candidates drop constraint if exists sourcing_run_candidates_tag_check;
alter table public.sourcing_run_candidates add constraint sourcing_run_candidates_tag_check
  check (tag = any (array[
    'strong'::text, 'possible'::text, 'stretch'::text,          -- legacy
    'strong_yes'::text, 'yes'::text, 'worth_message'::text, 'not_now'::text
  ]));
