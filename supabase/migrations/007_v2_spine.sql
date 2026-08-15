-- V2 data spine on the Auto-Recruit pattern (applied 2026-08-15).
-- Tenant-ready, versioned, provenance-tracked. Legacy candidates table
-- remains authoritative for identity; the spine holds enrichment,
-- experiences, and embeddings keyed to it.

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  created_at timestamptz not null default now()
);
insert into public.organizations (slug, name)
  values ('transformer-talent', 'Transformer Talent')
  on conflict (slug) do nothing;

-- Roles as DB rows: prose JD (json), matching checklist (json), embeddings separate.
create table if not exists public.org_roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  external_id text not null,              -- Notion JobID
  title text not null,
  description text,
  jd jsonb,                               -- {about, doing[], needs[], bonus[]}
  matching_profile jsonb,                 -- {must_haves[], screening_questions[], min_years, visa_transfer_ok, onsite_city}
  salary text,
  locations text[] not null default '{}',
  workplace text,
  visa text,
  yoe text,
  role_type text,
  tech_stack text,
  industry text,
  company_profile jsonb,                  -- anonymized company card
  status text not null default 'open',
  source text not null default 'notion',
  updated_at timestamptz not null default now(),
  unique (organization_id, external_id)
);
alter table public.org_roles enable row level security;

create table if not exists public.job_embeddings (
  id uuid primary key default gen_random_uuid(),
  org_role_id uuid not null references public.org_roles (id) on delete cascade,
  facet text not null,                    -- 'context' | 'requirements'
  content text not null,
  content_hash text not null,
  model text not null,
  dimensions int not null,
  embedding vector(1536) not null,
  created_at timestamptz not null default now(),
  unique (org_role_id, facet, content_hash)
);
create index if not exists job_embeddings_role_idx on public.job_embeddings (org_role_id);
alter table public.job_embeddings enable row level security;

-- One row per position, structured (Harvest-sourced).
create table if not exists public.candidate_experiences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  candidate_id uuid not null,
  source text not null default 'harvest',
  provider_experience_key text,
  title text,
  company_name text,
  company_linkedin_url text,
  employment_type text,
  location text,
  start_month int,
  start_year int,
  end_month int,
  end_year int,
  is_current boolean,
  duration_text text,
  description text,
  skills text[] not null default '{}',
  raw jsonb,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (candidate_id, source, provider_experience_key)
);
create index if not exists candidate_experiences_cand_idx on public.candidate_experiences (candidate_id);
alter table public.candidate_experiences enable row level security;

-- Every enrichment call, with cost: the spend ledger.
create table if not exists public.candidate_enrichments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  candidate_id uuid,
  linkedin_username text,
  provider text not null default 'harvest',
  operation text not null default 'full_profile',
  cache_status text not null default 'miss',   -- 'miss' (paid) | 'hit' (reused)
  status text not null default 'ok',
  normalized_profile jsonb,
  raw_payload jsonb,
  cost_credits numeric not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists candidate_enrichments_cand_idx on public.candidate_enrichments (candidate_id);
create index if not exists candidate_enrichments_user_idx on public.candidate_enrichments (linkedin_username, created_at);
alter table public.candidate_enrichments enable row level security;

-- Multi-vector, chunked, hash-deduped, model-versioned.
create table if not exists public.candidate_embeddings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  candidate_id uuid not null,
  source_type text not null,              -- 'linkedin_profile' | 'resume' | 'summary'
  chunk_index int not null default 0,
  content text not null,
  content_hash text not null,
  model text not null,
  dimensions int not null,
  embedding vector(1536) not null,
  created_at timestamptz not null default now(),
  unique (candidate_id, source_type, chunk_index, content_hash)
);
create index if not exists candidate_embeddings_cand_idx on public.candidate_embeddings (candidate_id);
alter table public.candidate_embeddings enable row level security;

-- Prioritized Harvest refresh queue; nightly worker drains <= daily cap.
create table if not exists public.refresh_queue (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  candidate_id uuid not null,
  linkedin_url text,
  linkedin_username text,
  priority int not null default 100,      -- lower = sooner; 10=matched, 50=engaged
  reason text,
  status text not null default 'queued',  -- queued | done | failed | skipped
  queued_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (candidate_id, status)
);
create index if not exists refresh_queue_pick_idx on public.refresh_queue (status, priority, queued_at);
alter table public.refresh_queue enable row level security;

-- Best-of-vectors candidate matching: legacy vector UNION new spine vectors.
create or replace function public.match_candidates_v2(
  query_embedding vector(1536),
  match_count int default 30,
  min_years int default null,
  location_patterns text[] default null
)
returns table (
  id uuid,
  current_title text,
  current_company text,
  location text,
  years_experience int,
  previous_companies text[],
  education_schools text[],
  education_degrees text[],
  education_fields text[],
  top_skills text[],
  headline text,
  source text,
  similarity double precision
)
language plpgsql
as $$
begin
  set local ivfflat.probes = 12;
  return query
  with legacy as (
    select c.id as cid, (c.matching_embedding <=> query_embedding) as dist
    from public.candidates c
    where c.matching_embedding is not null
    order by c.matching_embedding <=> query_embedding
    limit 600
  ),
  spine as (
    select ce.candidate_id as cid, min(ce.embedding <=> query_embedding) as dist
    from public.candidate_embeddings ce
    group by ce.candidate_id
    order by min(ce.embedding <=> query_embedding)
    limit 200
  ),
  best as (
    select cid, min(dist) as dist
    from (select * from legacy union all select * from spine) u
    group by cid
  )
  select
    c.id,
    c.current_title,
    c.current_company,
    c.location,
    coalesce(nullif(c.total_experience_years, 0), c.calculated_experience_years) as years_experience,
    c.previous_companies,
    c.education_schools,
    c.education_degrees,
    c.education_fields,
    c.top_skills,
    c.headline,
    c.source,
    1 - b.dist as similarity
  from best b
  join public.candidates c on c.id = b.cid
  where (min_years is null or coalesce(nullif(c.total_experience_years, 0), c.calculated_experience_years) >= min_years)
    and (
      location_patterns is null
      or exists (select 1 from unnest(location_patterns) p where c.location ilike '%' || p || '%')
    )
  order by b.dist
  limit least(match_count, 100);
end;
$$;
revoke execute on function public.match_candidates_v2 from public, anon, authenticated;
