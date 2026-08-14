-- Tier 3: JD matcher tables + security lockdown
-- Run once against the Supabase project (psql or SQL editor).

-- 1. Lock down candidate data from the anon key.
--    The website only ever touches the DB through server-held service key.
alter table public.candidates enable row level security;
alter table public.applications enable row level security;
alter table public.jobs enable row level security;
alter table public.companies enable row level security;
-- No anon policies created deliberately: anon key can read nothing.
-- Service-role key bypasses RLS, so local scripts using it keep working.

-- 2. JD submissions from hiring managers.
create table if not exists public.jd_submissions (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  email_verified_at timestamptz,
  company_name text,
  jd_filename text,
  jd_text text,
  jd_extracted jsonb,
  matched_candidate_ids uuid[],
  match_scores jsonb,
  ip inet,
  user_agent text,
  status text not null default 'pending_verification',
  created_at timestamptz not null default now()
);
create index if not exists jd_submissions_email_idx on public.jd_submissions (email);
create index if not exists jd_submissions_created_idx on public.jd_submissions (created_at);
alter table public.jd_submissions enable row level security;

-- 3. Email verification codes (6-digit, short-lived).
create table if not exists public.verification_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code text not null,
  submission_id uuid references public.jd_submissions (id) on delete cascade,
  attempts int not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists verification_codes_email_idx on public.verification_codes (email);
alter table public.verification_codes enable row level security;

-- 4. Rate limiting / abuse log.
create table if not exists public.rate_limit_events (
  id bigint generated always as identity primary key,
  bucket text not null,          -- e.g. 'jd_upload:ip:1.2.3.4', 'jd_upload:email:x@y.com', 'jd_upload:global'
  created_at timestamptz not null default now()
);
create index if not exists rate_limit_events_bucket_idx on public.rate_limit_events (bucket, created_at);
alter table public.rate_limit_events enable row level security;
