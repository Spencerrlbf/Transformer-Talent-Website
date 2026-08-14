-- Website application system (applied 2026-08-14).

create table if not exists public.website_applications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  email text not null,
  linkedin_url text,
  linkedin_username text,
  location text,
  visa_status text,
  comp_expectation text,
  availability text,
  role_ids text[] not null default '{}',
  role_titles text[] not null default '{}',
  resume_path text,
  resume_text text,
  harvest_profile jsonb,
  parsed_profile jsonb,
  candidate_id uuid,
  matched_role_ids text[],
  status text not null default 'received',
  source text,
  ip inet,
  user_agent text
);
create index if not exists website_applications_email_idx on public.website_applications (email);
create index if not exists website_applications_created_idx on public.website_applications (created_at);
alter table public.website_applications enable row level security;

-- Embeddings of the site's live roles, for reverse-matching applicants.
create table if not exists public.site_role_embeddings (
  job_id text primary key,
  title text not null,
  embedding vector(1536) not null,
  updated_at timestamptz not null default now()
);
alter table public.site_role_embeddings enable row level security;

create or replace function public.match_site_roles(
  query_embedding vector(1536),
  match_count int default 5
)
returns table (job_id text, title text, similarity double precision)
language sql
as $$
  select e.job_id, e.title, 1 - (e.embedding <=> query_embedding) as similarity
  from public.site_role_embeddings e
  order by e.embedding <=> query_embedding
  limit least(match_count, 20)
$$;

revoke execute on function public.match_site_roles from public, anon, authenticated;
