-- Named candidate lists (the table's ★ is the built-in "Shortlist" list —
-- one mechanism) and manual role attachments ("Add to a job" from the bulk
-- bar). Both keyed by the unified candidate key like notes/tasks/links.
-- The built-in list is seeded lazily per org in code, not here.
-- Service-role only (RLS on, no policies).
create table public.candidate_lists (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  builtin boolean not null default false,
  created_by uuid,
  created_by_email text not null default '',
  created_at timestamptz not null default now()
);
create unique index candidate_lists_org_name on public.candidate_lists (organization_id, lower(name));
alter table public.candidate_lists enable row level security;

create table public.candidate_list_members (
  list_id uuid not null references public.candidate_lists(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  candidate_key text not null check (candidate_key ~ '^(app|src)_[0-9a-f-]{36}$'),
  added_by uuid,
  added_by_email text not null default '',
  added_at timestamptz not null default now(),
  primary key (list_id, candidate_key)
);
create index clm_org_key on public.candidate_list_members (organization_id, candidate_key);
alter table public.candidate_list_members enable row level security;

create table public.role_attachments (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  candidate_key text not null check (candidate_key ~ '^(app|src)_[0-9a-f-]{36}$'),
  job_id text not null,
  added_by uuid,
  added_by_email text not null default '',
  added_at timestamptz not null default now(),
  primary key (organization_id, candidate_key, job_id)
);
alter table public.role_attachments enable row level security;
