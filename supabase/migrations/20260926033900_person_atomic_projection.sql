-- Prepared for the approved application cutover; no candidate rows are rewritten.
set local lock_timeout='2s';
set local statement_timeout='30s';
create table public.person_projection_state (
 candidate_id uuid primary key references public.candidates(id),
 revision bigint not null,
 profile_hash text not null,
 semantic_hash text not null,
 updated_at timestamptz not null default clock_timestamp()
);
create table public.person_projection_history (
 id bigint generated always as identity primary key,
 candidate_id uuid not null references public.candidates(id),
 revision bigint not null,
 before_profile jsonb not null,
 after_hash text not null,
 semantic_before text not null,
 semantic_after text not null,
 created_at timestamptz not null default clock_timestamp(),
 restored_at timestamptz
);
create index person_projection_history_candidate_idx on public.person_projection_history(candidate_id,id desc);
alter table public.person_projection_state enable row level security;
alter table public.person_projection_history enable row level security;
revoke all on public.person_projection_state,public.person_projection_history from public,anon,authenticated;
revoke all on sequence public.person_projection_history_id_seq from public,anon,authenticated;
grant all on public.person_projection_state,public.person_projection_history to service_role;
grant usage,select on sequence public.person_projection_history_id_seq to service_role;
