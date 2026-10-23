-- Local end-to-end test of the person trial: the rest of the live tables the
-- runner (scripts/person-trial.mjs) reads, on top of local-schema.sql.
--
-- For a LOCAL Postgres 15 only. Apply after local-schema.sql and before
-- migration 072 (these tables exist before 072 in production):
--   psql -f scripts/person-trial/local-schema.sql
--   psql -f scripts/person-trial/local-site-extras.sql
--   psql -1 -f supabase/migrations/072_person_tables.sql
-- Column names, types and defaults are the live ones (information_schema,
-- read 2026-09-25). local-schema.sql's candidates table carries only the
-- columns 072's tests snapshot; the translators read the whole row, so the
-- other live columns are added here. No data.

create extension if not exists citext;
create extension if not exists vector;
create extension if not exists "uuid-ossp";

alter table public.candidates
  add column if not exists airtable_id text,
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists years_of_experience integer,
  add column if not exists location text,
  add column if not exists remote_work_preference text,
  add column if not exists security_clearance text[],
  add column if not exists education text,
  add column if not exists resume_text text,
  add column if not exists ai_summary text,
  add column if not exists candidate_type text,
  add column if not exists source text,
  add column if not exists status text default 'Active'::text,
  add column if not exists notes text,
  add column if not exists previous_companies text[],
  add column if not exists total_experience_summary text,
  add column if not exists visa_status text,
  add column if not exists all_skills_text text,
  add column if not exists linkedin_url text,
  add column if not exists headline text,
  add column if not exists profile_summary text,
  add column if not exists profile_picture_url text,
  add column if not exists education_schools text[],
  add column if not exists education_degrees text[],
  add column if not exists education_fields text[],
  add column if not exists skills_endorsements jsonb,
  add column if not exists top_skills text[],
  add column if not exists work_experience jsonb,
  add column if not exists total_experience_years integer,
  add column if not exists linkedin_data jsonb,
  add column if not exists resume_embedding vector(1536),
  add column if not exists embedding_type text default 'unknown'::text,
  add column if not exists linkedin_enrichment_date timestamptz,
  add column if not exists linkedin_enrichment_status text default 'not_applicable'::text,
  add column if not exists matching_embedding vector(1536),
  add column if not exists open_profile boolean default false,
  add column if not exists calculated_experience_years integer,
  add column if not exists airtable_sync_hash text,
  add column if not exists contact jsonb,
  add column if not exists follow_up_at date,
  add column if not exists role_preferences jsonb,
  add column if not exists directory_contact_id uuid,
  add column if not exists directory_sync_hash text;

create table if not exists public.candidate_emails (
  id uuid not null default gen_random_uuid() primary key,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  email_address varchar(255) not null,
  email_type varchar(50),
  email_source varchar(100),
  is_primary boolean default false,
  quality varchar(20),
  result varchar(50),
  resultcode integer,
  subresult text,
  verification_date timestamptz,
  verification_attempts integer default 0,
  last_verification_attempt timestamptz,
  raw_response jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists candidate_emails_candidate_idx on public.candidate_emails (candidate_id);

create table if not exists public.candidate_emails_v2 (
  id uuid not null default uuid_generate_v4() primary key,
  candidate_id uuid not null,
  email_raw text not null,
  email_normalized citext not null,
  email_type text,
  email_source text,
  is_primary boolean not null default false,
  quality text,
  result text,
  resultcode text,
  subresult text,
  verification_date timestamptz,
  verification_attempts integer not null default 0,
  last_verification_attempt timestamptz,
  raw_response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists candidate_emails_v2_candidate_idx on public.candidate_emails_v2 (candidate_id);

create table if not exists public.candidate_enrichments (
  id uuid not null default gen_random_uuid() primary key,
  organization_id uuid not null,
  candidate_id uuid,
  linkedin_username text,
  provider text not null default 'harvest'::text,
  operation text not null default 'full_profile'::text,
  cache_status text not null default 'miss'::text,
  status text not null default 'ok'::text,
  normalized_profile jsonb,
  raw_payload jsonb,
  cost_credits numeric not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists candidate_enrichments_candidate_idx on public.candidate_enrichments (candidate_id);

create table if not exists public.website_applications (
  id uuid not null default gen_random_uuid() primary key,
  created_at timestamptz not null default now(),
  name text not null,
  email text not null,
  linkedin_url text,
  linkedin_username text,
  location text,
  visa_status text,
  comp_expectation text,
  availability text,
  role_ids text[] not null default '{}'::text[],
  role_titles text[] not null default '{}'::text[],
  resume_path text,
  resume_text text,
  harvest_profile jsonb,
  parsed_profile jsonb,
  candidate_id uuid,
  matched_role_ids text[],
  status text not null default 'received'::text,
  source text,
  ip inet,
  user_agent text,
  screening jsonb,
  preferred_locations text[] not null default '{}'::text[],
  organization_id uuid,
  contact jsonb,
  recruiter_profile_id uuid,
  follow_up_at date,
  preferred_roles text[] not null default '{}'::text[],
  preferred_workplace text[] not null default '{}'::text[]
);
create index if not exists website_applications_candidate_idx on public.website_applications (candidate_id);

-- Read only for the before/after detail (what the Network tab and the judge see today).
create table if not exists public.network_matches (
  organization_id uuid not null,
  candidate_id uuid not null,
  org_role_id uuid not null,
  verdict_id uuid not null,
  label text not null,
  strength numeric not null default 0,
  created_at timestamptz not null,
  shortlist_rank integer,
  quality smallint not null default 0,
  full_name text,
  current_title text,
  current_company text,
  refreshed_at timestamptz not null default now()
);

create table if not exists public.person_signals (
  candidate_id uuid not null primary key,
  years numeric,
  engineering_years numeric,
  current_tenure_months integer,
  current_title text,
  title_family text[] not null default '{}'::text[],
  seniority text,
  top_university_tier smallint,
  top_university text,
  top_employer_tier smallint,
  top_employer text,
  has_descriptions boolean not null default false,
  positions integer not null default 0,
  source_hash text not null,
  computed_at timestamptz not null default now()
);

-- Outreach outcomes (the runner reads bounces and replies to candidate_emails
-- rows) and the other live table with a foreign key to companies (the undo
-- checks it). Live types, enums included.
do $$ begin
  create type public.communication_type as enum ('linkedin_connection_request', 'linkedin_message', 'linkedin_inmail', 'email', 'phone_call', 'meeting');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.communication_status as enum ('sent', 'delivered', 'bounced', 'opened', 'replied', 'failed');
exception when duplicate_object then null; end $$;

create table if not exists public.candidate_communications (
  id uuid primary key default gen_random_uuid(),
  recruiter_id integer not null,
  candidate_id uuid not null,
  communication_type public.communication_type not null,
  communication_date timestamptz default now(),
  email_used uuid,
  subject text,
  linkedin_message_type varchar,
  message_content text,
  status public.communication_status default 'sent'::public.communication_status,
  response_date timestamptz,
  response_content text,
  sent_by varchar,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  sender_email varchar,
  email_provider varchar,
  interest_level varchar,
  campaign_name varchar
);

create table if not exists public.candidate_company_history (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid,
  company_id uuid references public.companies(id),
  position_title text,
  start_date date,
  end_date date,
  is_current boolean default false,
  linkedin_company_username text,
  raw_company_name text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
