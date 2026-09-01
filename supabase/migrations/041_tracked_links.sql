-- Per-candidate tracked outreach links: /l/<token> logs the open and
-- redirects to the minting user's public page. One link per (org, candidate)
-- so re-minting is idempotent and the CSV column is stable. Open counts are
-- best-effort signal (bot user-agents and prefetches are filtered at the
-- route), not proof. Service-role only (RLS on, no policies).
create table public.tracked_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  candidate_key text not null check (candidate_key ~ '^(app|src)_[0-9a-f-]{36}$'),
  token text not null unique,
  target_path text not null,
  created_by uuid,
  open_count integer not null default 0,
  first_opened_at timestamptz,
  last_opened_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, candidate_key)
);
alter table public.tracked_links enable row level security;
