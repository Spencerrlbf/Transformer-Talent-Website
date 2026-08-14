-- Tier 3: website matching function (the old match_candidates references a
-- dropped column; this replaces it for website use without touching legacy).

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
language sql
stable
as $$
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
    1 - (c.matching_embedding <=> query_embedding) as similarity
  from public.candidates c
  where c.matching_embedding is not null
    and (min_years is null or coalesce(nullif(c.total_experience_years, 0), c.calculated_experience_years) >= min_years)
    and (max_years is null or coalesce(nullif(c.total_experience_years, 0), c.calculated_experience_years) <= max_years)
    and (
      location_patterns is null
      or exists (select 1 from unnest(location_patterns) p where c.location ilike '%' || p || '%')
    )
  order by c.matching_embedding <=> query_embedding
  limit least(match_count, 100)
$$;

-- Lock execution to service role only: the website server calls this,
-- never browsers.
revoke execute on function public.match_candidates_website from public, anon, authenticated;
