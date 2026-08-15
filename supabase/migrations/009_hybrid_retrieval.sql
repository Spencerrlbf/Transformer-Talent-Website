-- Hybrid retrieval: a keyword/text-search channel alongside vector search,
-- both directions. Exact tech-stack hits can no longer miss the shortlist
-- because of embedding fuzziness.
-- NOTE: the GIN index build exceeds the API gateway timeout — it is built
-- via a self-unscheduling pg_cron job (see bottom), same as the ivfflat index.

-- Indexed search document for a candidate. Must stay immutable and be used
-- verbatim in queries so the planner picks the index.
create or replace function public.candidate_search_doc(skills text[], title text, headline text)
returns tsvector
language sql immutable
as $$
  select to_tsvector('simple',
    coalesce(array_to_string(skills, ' '), '') || ' ' ||
    coalesce(title, '') || ' ' ||
    coalesce(headline, ''))
$$;

-- Terms like ['Python', 'Machine Learning'] -> tsquery (python) | (machine & learning)
create or replace function public.terms_to_tsquery(terms text[])
returns tsquery
language sql immutable
as $$
  select to_tsquery('simple', string_agg('(' || regexp_replace(t2, '\s+', ' & ', 'g') || ')', ' | '))
  from (
    select trim(regexp_replace(lower(t), '[^a-z0-9 ]', ' ', 'g')) as t2
    from unnest(terms) t
  ) s
  where t2 <> ''
$$;

-- JD -> candidates keyword channel (same row shape as match_candidates_v2).
create or replace function public.match_candidates_keyword(
  skill_terms text[],
  match_count int default 20,
  min_years int default null,
  location_patterns text[] default null,
  query_embedding vector(1536) default null  -- real cosine for blended scoring
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
declare
  q tsquery;
begin
  q := public.terms_to_tsquery(skill_terms);
  if q is null then
    return;
  end if;
  -- Common single terms make the planner prefer a seq scan, which recomputes
  -- the tsvector for every row (~7s on 400k). The GIN path is always right here.
  perform set_config('enable_seqscan', 'off', true);
  return query
  -- Two-phase: GIN-filtered candidate set capped at 5000, then rank only
  -- those. Common single terms can match 50k+ rows; ranking that many
  -- recomputes the tsvector per row and blows the statement timeout. When
  -- more than 5000 match, the keyword channel isn't selective anyway and
  -- the vector channel carries the search.
  with hits as (
    select c.id as cid
    from public.candidates c
    where public.candidate_search_doc(c.top_skills, c.current_title, c.headline) @@ q
      and (min_years is null or coalesce(nullif(c.total_experience_years, 0), c.calculated_experience_years) >= min_years)
      and (
        location_patterns is null
        or exists (select 1 from unnest(location_patterns) p where c.location ilike '%' || p || '%')
      )
    limit 5000
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
    case
      when query_embedding is not null and c.matching_embedding is not null
        then 1 - (c.matching_embedding <=> query_embedding)
      else 0.0
    end as similarity
  from public.candidates c
  join hits h on h.cid = c.id
  order by ts_rank(public.candidate_search_doc(c.top_skills, c.current_title, c.headline), q) desc
  limit least(match_count, 50);
end;
$$;
revoke execute on function public.match_candidates_keyword from public, anon, authenticated;

-- Candidate -> roles keyword channel: score open roles by how many of the
-- candidate's skills appear in the stack/title/must-haves. Small table, scan.
create or replace function public.match_roles_keyword(
  skills text[],
  match_count int default 5
)
returns table (job_id text, title text, keyword_hits int)
language sql
as $$
  select r.external_id as job_id, r.title, count(distinct s)::int as keyword_hits
  from public.org_roles r
  cross join (select distinct lower(trim(x)) as s from unnest(skills) x where length(trim(x)) >= 2) sk
  where r.status = 'open'
    and (
      r.tech_stack ilike '%' || sk.s || '%'
      or r.title ilike '%' || sk.s || '%'
      or (r.matching_profile->'must_haves')::text ilike '%' || sk.s || '%'
    )
  group by r.external_id, r.title
  order by keyword_hits desc
  limit least(match_count, 10)
$$;
revoke execute on function public.match_roles_keyword from public, anon, authenticated;

-- GIN index build (run via self-unscheduling pg_cron job):
-- select cron.schedule('build-kw-idx', '* * * * *', $job$
--   set maintenance_work_mem = '256MB';
--   create index if not exists candidates_keyword_fts_idx
--     on public.candidates using gin (public.candidate_search_doc(top_skills, current_title, headline));
--   select cron.unschedule('build-kw-idx');
-- $job$);
