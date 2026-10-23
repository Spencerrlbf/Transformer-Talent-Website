-- Prepared for application cutover only. No historical or automatic enqueue.
set local lock_timeout='3s';
create table public.person_derivative_jobs (
 candidate_id uuid primary key references public.candidates(id) on delete restrict,
 desired_revision bigint not null,
 desired_hash text not null,
 sources jsonb not null check(jsonb_typeof(sources)='object'),
 model text not null,
 dimensions integer not null check(dimensions=1536),
 status text not null default 'pending' check(status in ('pending','processing','done','review')),
 attempts integer not null default 0 check(attempts between 0 and 3),
 claim_token uuid,
 lease_until timestamptz,
 claim_missing jsonb,
 completed_hash text,
 receipt_ref text not null,
 error_code text,
 updated_at timestamptz not null default clock_timestamp(),
 check ((status='processing')=(claim_token is not null and lease_until is not null))
);
create index person_derivative_pending_idx on public.person_derivative_jobs(updated_at,candidate_id) where status in ('pending','processing');
alter table public.person_derivative_jobs enable row level security;
revoke all on public.person_derivative_jobs from public,anon,authenticated;
grant all on public.person_derivative_jobs to service_role;
