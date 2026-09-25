-- Phase 4: the Network tab reads the scorecard verdicts (verdict.v2) and
-- pages on the server. Applied 2026-09-24.
create or replace function public.network_people(
  p_org uuid,
  p_job text default null,
  p_label text default null,
  p_company text default null,
  p_q text default null,
  p_new_days int default null,
  p_limit int default 50,
  p_offset int default 0
) returns table (
  candidate_id uuid,
  latest_match_at timestamptz,
  matches jsonb,
  total_people bigint,
  total_matches bigint,
  new_since_yesterday bigint
) language sql stable as $$
with latest as (
  select distinct on (v.candidate_id, v.org_role_id)
    v.candidate_id, v.org_role_id, v.created_at,
    v.verdict->'v2'->>'label' as label,
    v.verdict->'v2'->>'paragraph' as paragraph
  from public.match_verdicts v
  where v.organization_id = p_org and v.verdict ? 'v2'
  order by v.candidate_id, v.org_role_id, v.created_at desc
), m as (
  select l.candidate_id, l.created_at, l.label, l.paragraph,
    r.external_id as job_id, r.title, r.company_name, r.salary, r.locations, r.workplace, r.linked_org_role
  from latest l join public.org_roles r on r.id = l.org_role_id
  where r.status = 'open' and l.label in ('contact', 'message')
    and (p_job is null or p_job = '' or r.external_id = p_job)
    and (p_label is null or p_label = '' or l.label = p_label)
    and (p_company is null or p_company = '' or r.company_name = p_company)
), people as (
  select m.candidate_id, max(m.created_at) as latest_match_at, count(*) as n_matches,
    bool_or(m.label = 'contact') as any_contact,
    jsonb_agg(jsonb_build_object(
      'jobId', m.job_id, 'title', m.title, 'company', m.company_name, 'salary', m.salary,
      'locations', m.locations, 'workplace', m.workplace, 'linked', m.linked_org_role,
      'label', m.label, 'reason', m.paragraph, 'addedAt', m.created_at
    ) order by (m.label = 'contact') desc, m.created_at desc) as matches
  from m group by m.candidate_id
), filtered as (
  select p.* from people p join public.candidates c on c.id = p.candidate_id
  where (p_q is null or p_q = ''
         or c.full_name ilike '%' || p_q || '%'
         or c.current_title ilike '%' || p_q || '%'
         or c.current_company ilike '%' || p_q || '%')
    and (p_new_days is null or p.latest_match_at >= now() - make_interval(days => p_new_days))
)
select f.candidate_id, f.latest_match_at, f.matches,
  count(*) over () as total_people,
  sum(f.n_matches) over () as total_matches,
  count(*) filter (where f.latest_match_at >= now() - interval '1 day') over () as new_since_yesterday
from filtered f
order by f.any_contact desc, f.latest_match_at desc, f.candidate_id
limit p_limit offset p_offset
$$;

create or replace function public.network_roles(p_org uuid)
returns table (job_id text, title text, company_name text, contact_count bigint, message_count bigint)
language sql stable as $$
with latest as (
  select distinct on (v.candidate_id, v.org_role_id)
    v.candidate_id, v.org_role_id, v.verdict->'v2'->>'label' as label
  from public.match_verdicts v
  where v.organization_id = p_org and v.verdict ? 'v2'
  order by v.candidate_id, v.org_role_id, v.created_at desc
)
select r.external_id, r.title, r.company_name,
  count(*) filter (where l.label = 'contact'), count(*) filter (where l.label = 'message')
from latest l join public.org_roles r on r.id = l.org_role_id
where r.status = 'open' and l.label in ('contact', 'message')
group by r.external_id, r.title, r.company_name
order by r.title
$$;
