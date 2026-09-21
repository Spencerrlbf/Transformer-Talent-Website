-- Verdict comparison (owner-only eval page). Additive only: one row per
-- candidate x role in the golden set, holding the verdict the product shows
-- today ("old"), the proposed one-paragraph verdict per model ("runs"), and
-- the owner's vote per model. Nothing else reads this table.
create table if not exists public.verdict_evals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('sourced', 'applicant')),
  subject_id uuid not null,            -- sourced_candidates.id | candidates.id
  application_id uuid,                 -- website_applications.id (applicants)
  org_role_id uuid not null references public.org_roles(id) on delete cascade,
  person jsonb not null,               -- {name,title,company,location,years,linkedinUrl}
  old jsonb not null,                  -- {engine,tag,label,reason,scorecard}
  runs jsonb not null default '{}'::jsonb,   -- model -> Verdict
  votes jsonb not null default '{}'::jsonb,  -- model -> 'new' | 'old' | 'neither'
  created_at timestamptz not null default now(),
  unique (organization_id, kind, subject_id, org_role_id)
);
alter table public.verdict_evals enable row level security;
