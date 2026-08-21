-- Referrals (applied 2026-08-21). Additive only:
--   1. organizations.referral_amount: the bounty in whole dollars, the
--      company's commitment, shown on all its recruiter pages.
--   2. recruiter_profiles.show_referral: per-recruiter on/off for the block.
--   3. referrals: who referred whom, through whose page, at what promised
--      amount. status: new (processing/queued), duplicate (person already in
--      the system — not eligible, kept for the record), reviewed, placed,
--      paid. application_id links the website_applications row the pipeline
--      created for the referred person (null for duplicates).

alter table public.organizations
  add column if not exists referral_amount integer not null default 5000;

alter table public.recruiter_profiles
  add column if not exists show_referral boolean not null default true;

create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  recruiter_profile_id uuid not null references public.recruiter_profiles (id),
  referrer_name text not null,
  referrer_email text not null,
  candidate_linkedin text not null,
  candidate_linkedin_username text,
  candidate_email text not null,
  amount integer not null,
  status text not null default 'new',
  application_id uuid references public.website_applications (id),
  created_at timestamptz not null default now()
);
create index if not exists referrals_org_idx on public.referrals (organization_id);
alter table public.referrals enable row level security;
