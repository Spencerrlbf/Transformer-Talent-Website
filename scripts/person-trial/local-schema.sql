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
