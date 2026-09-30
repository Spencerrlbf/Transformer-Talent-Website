-- Prepared for the approved application cutover. No flags are enabled here.
set local lock_timeout='2s';
set local statement_timeout='30s';
create table public.person_application_receipts(
 application_id uuid primary key references public.website_applications(id),
 candidate_id uuid not null references public.candidates(id),
 created_person boolean not null,
 application_snapshot jsonb not null,
 harvest_ledger_id uuid references public.candidate_enrichments(id),
 documents jsonb not null check(jsonb_typeof(documents)='array'),
 created_at timestamptz not null default clock_timestamp()
);
create index person_application_receipts_candidate_idx on public.person_application_receipts(candidate_id);
alter table public.person_application_receipts enable row level security;
revoke all on public.person_application_receipts from public,anon,authenticated;
grant all on public.person_application_receipts to service_role;
alter table public.website_applications add column pool_created_person boolean;
