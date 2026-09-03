-- No reply (applied 2026-09-03). Additive only:
--  * candidate_role_statuses.reason / stage_events.reason: why a person is
--    where they are. 'no_reply' = we stopped chasing them; null = a
--    judgement (Rejected proper). Past keeps the two apart.
--  * no_reply_marks: one live mark per person per org: when, by whom, on
--    which conversation and role, the check-back date. Cleared (kept for
--    history) when they reply or are contacted again.
--  * tasks.kind gains 'recontact': the check-back, due on the chosen day.
alter table public.candidate_role_statuses add column if not exists reason text;
alter table public.stage_events add column if not exists reason text;

create table if not exists public.no_reply_marks (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  candidate_key text not null check (candidate_key ~ '^(app|src)_[0-9a-f-]{36}$'),
  marked_at timestamptz not null default now(),
  marked_by_email text not null default '',
  thread_id text,
  job_id text,
  check_back_at date,
  cleared_at timestamptz,
  cleared_reason text,
  primary key (organization_id, candidate_key)
);
alter table public.no_reply_marks enable row level security;

alter table public.tasks drop constraint if exists tasks_kind_check;
alter table public.tasks
  add constraint tasks_kind_check check (kind in ('task', 'call', 'email', 'message', 'reminder', 'recontact'));
