-- LOCAL DISPOSABLE STACK ONLY (never committed, never pushed): the base tables that
-- predate this repo's migrations, from the person test fixtures, plus stubs 001 touches.
-- Local mirror of the production objects migration 072 builds on.
--
-- For testing on a local Postgres 15 only. It copies, from the live
-- definitions read on 2026-09-25 (Supabase "recruitment-matching", PG 17.6):
--   * the Supabase roles and the default privileges on schema public, so the
--     test proves 072's revokes (by default every new table and function is
--     granted to anon and authenticated);
--   * public.organizations (id), public.candidates (id and a few columns the
--     test snapshots to prove the writer never touches them);
--   * public.companies and public.candidate_experiences column for column,
--     with their live constraints, indexes and trigger, because 072 adds
--     columns to both and save_person inserts rows into both.
-- No data: the only row is the Transformer Talent organization, whose id the
-- writer stamps on candidate_experiences.organization_id (NOT NULL, no default).

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase's default privileges on schema public (pg_default_acl, live).
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create or replace function public.update_updated_at_column()
returns trigger language plpgsql as $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text unique
);
alter table public.organizations enable row level security;
insert into public.organizations (id, slug) values ('801865a7-6533-41d2-9c45-e4a90e6ad51a', 'transformer-talent');

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  linkedin_id text,
  linkedin_username text,
  linkedin_url text,
  website text,
  description text,
  tagline text,
  phone text,
  email text,
  headquarters_city text,
  headquarters_country text,
  headquarters_address_line1 text,
  headquarters_address_line2 text,
  postal_code text,
  founded_year integer,
  company_type text,
  staff_count integer,
  staff_count_range text,
  industries text[],
  specialties text[],
  follower_count integer,
  is_verified boolean default false,
  logo_url text,
  cover_image_url text,
  linkedin_data jsonb,
  data_source text default 'manual'::text,
  last_linkedin_sync timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  enrichment_status varchar(50) default 'pending'::character varying,
  last_enrichment_sync timestamptz,
  constraint companies_linkedin_id_key unique (linkedin_id),
  constraint companies_linkedin_username_key unique (linkedin_username),
  constraint companies_enrichment_status_check check (((enrichment_status)::text = any ((array['pending'::character varying, 'enriched'::character varying, 'failed'::character varying, 'not_found'::character varying, 'error'::character varying])::text[])))
);
create unique index companies_linkedin_id_unique on public.companies using btree (linkedin_id);
create index idx_companies_enrichment_status on public.companies using btree (enrichment_status);
create index idx_companies_linkedin_username on public.companies using btree (linkedin_username);
create index idx_companies_name on public.companies using btree (name);
create index idx_companies_website on public.companies using btree (website);
create unique index unique_companies_linkedin_url_idx on public.companies using btree (linkedin_url) where ((linkedin_url is not null) and (linkedin_url <> ''::text));
create trigger update_companies_updated_at before update on public.companies for each row execute function public.update_updated_at_column();
alter table public.companies enable row level security;

create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  linkedin_username varchar not null,
  email text,
  phone text,
  current_title text,
  current_company text,
  current_company_id uuid references public.companies(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint candidates_email_key unique (email),
  constraint unique_candidates_linkedin_username unique (linkedin_username)
);
create index idx_candidates_current_company_id on public.candidates (current_company_id);
alter table public.candidates enable row level security;

create table public.candidate_experiences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  candidate_id uuid not null,
  source text not null default 'harvest'::text,
  provider_experience_key text,
  title text,
  company_name text,
  company_linkedin_url text,
  employment_type text,
  location text,
  start_month integer,
  start_year integer,
  end_month integer,
  end_year integer,
  is_current boolean,
  duration_text text,
  description text,
  skills text[] not null default '{}'::text[],
  raw jsonb,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint candidate_experiences_candidate_id_source_provider_experien_key unique (candidate_id, source, provider_experience_key)
);
create index candidate_experiences_cand_idx on public.candidate_experiences using btree (candidate_id);
alter table public.candidate_experiences enable row level security;
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
create table if not exists public.applications(id uuid primary key default gen_random_uuid());
create table if not exists public.jobs(id uuid primary key default gen_random_uuid());
-- The fixture's organizations table is minimal; give it 007's columns so the TT
-- organization keeps the fixture id the person chain expects.
alter table public.organizations add column if not exists name text;
update public.organizations set name='Transformer Talent' where slug='transformer-talent' and name is null;
alter table public.organizations alter column name set not null;
alter table public.organizations alter column slug set not null;
alter table public.organizations add column if not exists created_at timestamptz not null default now();
