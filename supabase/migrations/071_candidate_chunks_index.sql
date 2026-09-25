-- The chunk half of match_candidates_v2 through an index.
--
-- The search's "spine" part compared the query with every row of
-- candidate_embeddings and grouped by person. That was cheap at ~1,000 rows;
-- the Harvest refresh of 5,110 Network people on 2026-09-25 took the table to
-- 11,741, and a full call took 23 s cold, past the API's 8 s statement
-- timeout, so every shortlist build and the website's search failed.
--
-- Now an HNSW index finds the 600 nearest chunks and those are grouped to the
-- 200 nearest people. On six real role facets the 600-chunk method picked the
-- same 200 people as the full comparison (200 of 200 each); the index's own
-- approximation is checked after it is built. The candidate half (ivfflat on
-- candidates.matching_embedding) is unchanged.
--
-- Additive: one index, and the same function signature and results shape.

create index if not exists candidate_embeddings_embedding_hnsw
  on public.candidate_embeddings using hnsw (embedding vector_cosine_ops);

create or replace function public.match_candidates_v2(query_embedding vector, match_count integer default 30, min_years integer default null::integer, location_patterns text[] default null::text[])
 returns table(id uuid, current_title text, current_company text, location text, years_experience integer, previous_companies text[], education_schools text[], education_degrees text[], education_fields text[], top_skills text[], headline text, source text, similarity double precision)
 language plpgsql
as $function$
begin
  set local ivfflat.probes = 12;
  -- Enough candidates from the chunk index for 600 rows to come back.
  set local hnsw.ef_search = 600;
  return query
  with legacy as (
    select c.id as cid, (c.matching_embedding <=> query_embedding) as dist
    from public.candidates c
    where c.matching_embedding is not null
    order by c.matching_embedding <=> query_embedding
    limit 600
  ),
  nearest_chunks as (
    select ce.candidate_id as cid, (ce.embedding <=> query_embedding) as dist
    from public.candidate_embeddings ce
    order by ce.embedding <=> query_embedding
    limit 600
  ),
  spine as (
    select cid, min(dist) as dist
    from nearest_chunks
    group by cid
    order by min(dist)
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
$function$;
