-- Role scorecard. Additive only: one nullable column and three new tables.
--
-- org_roles.scorecard: the three-tier checklist a role is judged against
--   ({v, criteria:[{id,label,tier,good}], draftedBy, draftedAt, editedBy, editedAt}).
--   Dashboard-owned like target_companies: the role sync chain never writes
--   it, so it survives a republish and is editable on synced roles too.
alter table public.org_roles add column if not exists scorecard jsonb;

-- What is known about a person beyond their profile, across every role.
-- Starts with the facts a recruiter confirmed by overruling a checklist row;
-- later steps add signals, best fit and the profile-line embedding.
create table if not exists public.candidate_profiles (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  candidate_key text not null,             -- "app_<id>" | "src_<id>"
  confirmed_facts jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, candidate_key)
);
alter table public.candidate_profiles enable row level security;

-- A recruiter's word on one verdict: a checklist row overruled ('override',
-- one live row per person x role x criterion) or the single button
-- "Right person, wrong role" ('wrong_role', criterion_id '').
create table if not exists public.verdict_feedback (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  org_role_id uuid not null references public.org_roles(id) on delete cascade,
  candidate_key text not null,
  kind text not null check (kind in ('override', 'wrong_role')),
  criterion_id text not null default '',
  criterion_label text,
  tier text,
  ai_status text,                          -- what the judge had said
  status text,                             -- yes | equivalent | unknown | no
  note text,
  member_email text not null,
  member_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, org_role_id, candidate_key, kind, criterion_id)
);
create index if not exists verdict_feedback_person_idx
  on public.verdict_feedback (organization_id, candidate_key);
alter table public.verdict_feedback enable row level security;

-- Saved verdicts: the same person against the same role with the same
-- inputs gets the stored answer, on every path. A changed profile, scorecard
-- or judge version is a new row; the old ones stay as history.
create table if not exists public.verdict_cache (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  org_role_id uuid not null references public.org_roles(id) on delete cascade,
  candidate_key text not null,
  input_hash text not null,                -- profile + role + scorecard + judge version + model
  judge_version text not null,
  model text not null,
  verdict jsonb not null,                  -- the view as judged, before any overrule
  created_at timestamptz not null default now(),
  unique (org_role_id, candidate_key, input_hash)
);
alter table public.verdict_cache enable row level security;
