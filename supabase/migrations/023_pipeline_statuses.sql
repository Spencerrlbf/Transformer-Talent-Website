-- Job workspace Task C: human pipeline statuses, one per (candidate, role).
-- candidate_key is the unified key ("app_<id>" | "src_<id>"); job_id is the
-- role's external_id. Distinct from the AI fit tag ("Not now" stays a
-- judgment); 'rejected' is the human decision that moves someone to Past.
create table if not exists public.candidate_role_statuses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  candidate_key text not null,
  job_id text not null,
  status text not null default 'new' check (status in
    ('new','contacted','replied','interviewing','offer','hired','rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, candidate_key, job_id)
);
create index if not exists candidate_role_statuses_org_job_idx
  on public.candidate_role_statuses (organization_id, job_id);
alter table public.candidate_role_statuses enable row level security;
