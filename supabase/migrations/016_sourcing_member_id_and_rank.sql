-- Sourcing pipeline support (Sourcing Task 4).
--
-- 1. linkedin_member_id: Harvest's lead search exposes only a stable hashed
--    member id ("ACwAA…") — the public username arrives with the paid full
--    profile. Dedupe must happen BEFORE paying, so the pool keys on member
--    id, and username (learned post-fetch) becomes nullable. These tables
--    shipped empty two tasks ago and have no consumers yet, so loosening
--    the username constraint is safe.
alter table public.sourced_candidates add column if not exists linkedin_member_id text;
alter table public.sourced_candidates alter column linkedin_username drop not null;
create unique index if not exists sourced_candidates_org_member_uq
  on public.sourced_candidates (organization_id, linkedin_member_id)
  where linkedin_member_id is not null;

-- 2. Embedding rank in SQL: computing cosine similarity for up to 2,500
--    candidates in Node would mean shipping ~30MB of vectors over REST.
--    One UPDATE against the role's facet embeddings does it in place
--    (same min-distance-across-facets scoring as match_org_roles).
create or replace function public.rank_sourcing_run_embed(p_run_id uuid)
returns int
language sql
as $$
  with scores as (
    select m.id, 1 - min(je.embedding <=> sc.embedding) as sim
    from public.sourcing_run_candidates m
    join public.sourced_candidates sc on sc.id = m.sourced_candidate_id
    join public.sourcing_runs r on r.id = m.run_id
    join public.job_embeddings je on je.org_role_id = r.org_role_id
    where m.run_id = p_run_id and sc.embedding is not null
    group by m.id
  ),
  updated as (
    update public.sourcing_run_candidates m
    set embed_score = s.sim
    from scores s
    where m.id = s.id
    returning 1
  )
  select count(*)::int from updated;
$$;
revoke execute on function public.rank_sourcing_run_embed from public, anon, authenticated;
