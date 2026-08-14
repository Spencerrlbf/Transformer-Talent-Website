-- ANN-first rewrite: pull top-N by embedding via the ivfflat index, then
-- filter that shortlist. Filters over the full 290k-row scan blew the
-- PostgREST statement timeout; filtering 600 shortlisted rows is instant.

create or replace function public.match_candidates_website(
  query_embedding vector(1536),
  match_count int default 25,
  min_years int default null,
  max_years int default null,
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
  with nearest as (
    select c.*, (c.matching_embedding <=> query_embedding) as dist
    from public.candidates c
    where c.matching_embedding is not null
    order by c.matching_embedding <=> query_embedding
    limit 600
  )
  select
    n.id,
    n.current_title,
    n.current_company,
    n.location,
    coalesce(nullif(n.total_experience_years, 0), n.calculated_experience_years) as years_experience,
    n.previous_companies,
    n.education_schools,
    n.education_degrees,
    n.education_fields,
    n.top_skills,
    n.headline,
    n.source,
    1 - n.dist as similarity
  from nearest n
  where (min_years is null or coalesce(nullif(n.total_experience_years, 0), n.calculated_experience_years) >= min_years)
    and (max_years is null or coalesce(nullif(n.total_experience_years, 0), n.calculated_experience_years) <= max_years)
    and (
      location_patterns is null
      or exists (select 1 from unnest(location_patterns) p where n.location ilike '%' || p || '%')
    )
  order by n.dist
  limit least(match_count, 100);
end;
$$;

revoke execute on function public.match_candidates_website from public, anon, authenticated;
