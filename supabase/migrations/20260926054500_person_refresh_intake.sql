-- Prepared only. Apply with the approved worker cutover, before enabling its flag.
set local lock_timeout='2s';
set local statement_timeout='30s';
create table public.person_refresh_attempts (
 queue_id uuid primary key,
 candidate_id uuid not null references public.candidates(id),
 organization_id uuid not null check(organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a'),
 phase text not null check(phase in ('ready','claimed','review','done')),
 claim_token uuid,
 lease_until timestamptz,
 attempts integer not null default 0 check(attempts between 0 and 3),
 linkedin_username text not null,
 linkedin_url text not null,
 paid_token uuid,
 paid_requested_at timestamptz,
 ledger_id uuid,
 ledger_snapshot jsonb,
 documents jsonb,
 result jsonb,
 previous_queue_rows jsonb not null default '[]'::jsonb,
 error_code text,
 derivatives_claimed_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp()
);
create index person_refresh_attempts_candidate_idx on public.person_refresh_attempts(candidate_id);
create index person_refresh_attempts_paid_idx on public.person_refresh_attempts(paid_requested_at) where paid_requested_at is not null;
alter table public.person_refresh_attempts enable row level security;
revoke all on public.person_refresh_attempts from public,anon,authenticated;
grant all on public.person_refresh_attempts to service_role;
