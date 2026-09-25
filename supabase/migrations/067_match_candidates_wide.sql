-- A wider search for the shortlist builder. match_candidates_v2 returns at
-- most 100 people a call (limit least(match_count, 100)), though the builder
-- asks for 800: two facets, nearby then anyone, leave about 300 people per
-- role, and the shortlist of 300 keeps nearly all of them, so its quality
-- weights never decide who is judged. On role #67 similarity falls only from
-- 0.614 at the 300th nearest person to 0.581 at the 1,500th, with 417 more
-- tier-1-employer people passing the role's rules in that band.
--
-- Same arguments and columns as match_candidates_v2 (a drop-in for the
-- builder); up to 1,000 a call, the nearest-neighbour steps sized to leave
-- room for the location filter. Additive: nothing calls it until the
-- builder is switched, which waits for Spencer's pick on the preview.
create or replace function public.match_candidates_wide(
  query_embedding vector,
  match_count integer default 800,
  min_years integer default null,
  location_patterns text[] default null
) returns table (
  id uuid, current_title text, current_company text, location text, years_experience integer,
  previous_companies text[], education_schools text[], education_degrees text[], education_fields text[],
  top_skills text[], headline text, source text, similarity double precision
) language plpgsql as $function$
declare
  want integer := least(greatest(match_count, 1), 1000);
begin
  set local ivfflat.probes = 12;
  return query
  with legacy as (
    select c.id as cid, (c.matching_embedding <=> query_embedding) as dist
    from public.candidates c
    where c.matching_embedding is not null
    order by c.matching_embedding <=> query_embedding
    limit want * 3
  ),
  spine as (
    select ce.candidate_id as cid, min(ce.embedding <=> query_embedding) as dist
    from public.candidate_embeddings ce
    group by ce.candidate_id
    order by min(ce.embedding <=> query_embedding)
    limit want
  ),
  best as (
    select cid, min(dist) as dist
    from (select * from legacy union all select * from spine) u
    group by cid
  )
  select
    c.id, c.current_title, c.current_company, c.location,
    coalesce(nullif(c.total_experience_years, 0), c.calculated_experience_years) as years_experience,
    c.previous_companies, c.education_schools, c.education_degrees, c.education_fields,
    c.top_skills, c.headline, c.source,
    1 - b.dist as similarity
  from best b
  join public.candidates c on c.id = b.cid
  where (min_years is null or coalesce(nullif(c.total_experience_years, 0), c.calculated_experience_years) >= min_years)
    and (location_patterns is null
         or exists (select 1 from unnest(location_patterns) p where c.location ilike '%' || p || '%'))
  order by b.dist
  limit want;
end;
$function$;

-- Server-only, like the other matching functions.
revoke execute on function public.match_candidates_wide(vector, integer, integer, text[]) from public, anon, authenticated;
