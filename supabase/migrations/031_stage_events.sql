-- Stage history (applied 2026-08-21). Additive only: every pipeline stage
-- change appends a row — the journey, not just the current position.
-- candidate_role_statuses keeps the current stage; this table keeps the
-- path (when contacted, how long each interview round took) for placement
-- records and future analytics. No UI yet; recorded from day one.

create table if not exists public.stage_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  candidate_key text not null,
  job_id text not null,
  from_status text,
  from_interview_stage text,
  to_status text not null,
  to_interview_stage text,
  created_at timestamptz not null default now()
);
create index if not exists stage_events_lookup_idx
  on public.stage_events (organization_id, candidate_key, job_id, created_at);
alter table public.stage_events enable row level security;
