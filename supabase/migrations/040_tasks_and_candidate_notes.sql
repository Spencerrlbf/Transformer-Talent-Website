-- Tasks + candidate notes (dashboard). Candidates are addressed by the
-- unified key ("app_<id>" | "src_<id>") the drawer already uses, so both
-- applied and sourced people attach cleanly. candidate_name / author email
-- are display snapshots taken at write time — labels, not sources of truth.
-- Service-role access only (RLS on, no policies): every dashboard route goes
-- through requireMember.
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  candidate_key text check (candidate_key ~ '^(app|src)_[0-9a-f-]{36}$'),
  candidate_name text not null default '',
  kind text not null default 'task' check (kind in ('task','call','email')),
  title text not null,
  due_date date not null,
  due_time time,
  status text not null default 'open' check (status in ('open','done')),
  created_by uuid,
  created_by_email text not null default '',
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_org_status_due on public.tasks (organization_id, status, due_date);
create index tasks_org_candidate on public.tasks (organization_id, candidate_key);
alter table public.tasks enable row level security;

create table public.candidate_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  candidate_key text not null check (candidate_key ~ '^(app|src)_[0-9a-f-]{36}$'),
  kind text not null default 'note' check (kind in ('note','call','email','message')),
  body text not null,
  author_id uuid,
  author_email text not null default '',
  created_at timestamptz not null default now()
);
create index candidate_notes_org_key on public.candidate_notes (organization_id, candidate_key, created_at desc);
alter table public.candidate_notes enable row level security;
