-- The Network tab in fit order. network_people (062) put Contact first and
-- then the newest verdict first; the nightly judge works down each shortlist
-- best-first, so "newest" meant the bottom of the shortlist on top. Spencer's
-- blind test (2026-09-25) preferred the card-strength order 13 to 5.
--
-- Order, for people and for the roles under each person:
--   1. Contact now before Worth a message.
--   2. Fit: the stored card strength (cardStrength) as a share of the most
--      that card can give (Required 3, Exceptional 2, Bonus 1 per row), so
--      roles with different cards compare. Within one role it is the same
--      order as the strength itself.
--   3. Quality, as a tie-break: top employer and top university from
--      person_signals, tier 1 = 2 points, tier 2 = 1, the two added (0-4).
--   4. Shortlist rank, then the newest match.
-- A person across several roles is placed by their best role: the best fit
-- among their Contact now roles when they have one, else among the rest.
--
-- Additive: a new function beside network_people, which production keeps
-- calling until this branch merges. Same arguments and columns.
create or replace function public.network_people_by_fit(
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
    v.verdict->'v2'->>'paragraph' as paragraph,
    -- Only the number leaves this step: carrying the whole card through the
    -- sort made the function seven times slower.
    coalesce((v.verdict->'v2'->'card'->>'strength')::numeric, 0) as strength
  from public.match_verdicts v
  where v.organization_id = p_org and v.verdict ? 'v2'
  order by v.candidate_id, v.org_role_id, v.created_at desc
), cards as materialized (
  -- The most each open role's card can give, worked out once per role (every
  -- verdict on a role is judged against that role's card) and kept as one
  -- lookup, {org_role_id: most}: a join here made the planner compare every
  -- verdict with every role.
  select coalesce(jsonb_object_agg(x.org_role_id, x.card_max), '{}'::jsonb) as most
  from (
    select r.id::text as org_role_id,
      sum(case c->>'tier' when 'required' then 3 when 'exceptional' then 2 else 1 end) as card_max
    from public.org_roles r
    cross join lateral jsonb_array_elements(case jsonb_typeof(r.scorecard->'criteria') when 'array' then r.scorecard->'criteria' else '[]'::jsonb end) c
    where r.organization_id = p_org and r.status = 'open'
    group by r.id
  ) x
), m as (
  select l.candidate_id, l.created_at, l.label, l.paragraph,
    r.external_id as job_id, r.title, r.company_name, r.salary, r.locations, r.workplace, r.linked_org_role,
    l.strength / nullif(((select most from cards)->>l.org_role_id::text)::numeric, 0) as fit,
    s.rank as shortlist_rank
  from latest l
  join public.org_roles r on r.id = l.org_role_id
  left join public.role_shortlists s on s.org_role_id = l.org_role_id and s.candidate_id = l.candidate_id
  where r.status = 'open' and l.label in ('contact', 'message')
    and (p_job is null or p_job = '' or r.external_id = p_job)
    and (p_label is null or p_label = '' or l.label = p_label)
    and (p_company is null or p_company = '' or r.company_name = p_company)
), people as (
  select m.candidate_id, max(m.created_at) as latest_match_at, count(*) as n_matches,
    bool_or(m.label = 'contact') as any_contact,
    coalesce(max(m.fit) filter (where m.label = 'contact'), max(m.fit)) as best_fit,
    coalesce(min(m.shortlist_rank) filter (where m.label = 'contact'), min(m.shortlist_rank)) as best_rank,
    jsonb_agg(jsonb_build_object(
      'jobId', m.job_id, 'title', m.title, 'company', m.company_name, 'salary', m.salary,
      'locations', m.locations, 'workplace', m.workplace, 'linked', m.linked_org_role,
      'label', m.label, 'reason', m.paragraph, 'addedAt', m.created_at
    ) order by (m.label = 'contact') desc, m.fit desc nulls last, m.created_at desc) as matches
  from m group by m.candidate_id
), filtered as (
  select p.*,
    (case ps.top_employer_tier when 1 then 2 when 2 then 1 else 0 end)
      + (case ps.top_university_tier when 1 then 2 when 2 then 1 else 0 end) as quality
  from people p
  join public.candidates c on c.id = p.candidate_id
  left join public.person_signals ps on ps.candidate_id = p.candidate_id
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
order by f.any_contact desc, f.best_fit desc nulls last, f.quality desc, f.best_rank asc nulls last,
  f.latest_match_at desc, f.candidate_id
limit p_limit offset p_offset
$$;

-- Called only by the server with the service key, like network_people (065).
revoke execute on function public.network_people_by_fit(uuid, text, text, text, text, integer, integer, integer) from public, anon, authenticated;
