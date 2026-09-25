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
-- Additive: two generated columns and a new function beside network_people,
-- which production keeps calling until this branch merges.

-- The label and the strength as plain columns, kept by Postgres from the
-- verdict itself. Reading them out of the verdict meant unpacking every
-- stored card on every call: 8 s through the API, over the statement limit.
alter table public.match_verdicts
  add column if not exists v2_label text generated always as (verdict->'v2'->>'label') stored,
  add column if not exists v2_strength numeric generated always as ((verdict->'v2'->'card'->>'strength')::numeric) stored;

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
  -- Light columns only: the verdict itself is read for the page's people.
  select distinct on (v.candidate_id, v.org_role_id)
    v.id as verdict_id, v.candidate_id, v.org_role_id, v.created_at,
    v.v2_label as label, coalesce(v.v2_strength, 0) as strength
  from public.match_verdicts v
  where v.organization_id = p_org and v.v2_label is not null
  order by v.candidate_id, v.org_role_id, v.created_at desc
), cards as materialized (
  -- The most each open role's card can give, worked out once per role (every
  -- verdict on a role is judged against that role's card) and kept as one
  -- lookup, {org_role_id: most}.
  select coalesce(jsonb_object_agg(x.org_role_id, x.card_max), '{}'::jsonb) as most
  from (
    select r.id::text as org_role_id,
      sum(case c->>'tier' when 'required' then 3 when 'exceptional' then 2 else 1 end) as card_max
    from public.org_roles r
    cross join lateral jsonb_array_elements(case jsonb_typeof(r.scorecard->'criteria') when 'array' then r.scorecard->'criteria' else '[]'::jsonb end) c
    where r.organization_id = p_org and r.status = 'open'
    group by r.id
  ) x
), m as materialized (
  select l.verdict_id, l.candidate_id, l.org_role_id, l.created_at, l.label,
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
    coalesce(min(m.shortlist_rank) filter (where m.label = 'contact'), min(m.shortlist_rank)) as best_rank
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
), page as (
  select f.*,
    count(*) over () as total_people,
    sum(f.n_matches) over () as total_matches,
    count(*) filter (where f.latest_match_at >= now() - interval '1 day') over () as new_since_yesterday
  from filtered f
  order by f.any_contact desc, f.best_fit desc nulls last, f.quality desc, f.best_rank asc nulls last,
    f.latest_match_at desc, f.candidate_id
  limit p_limit offset p_offset
), page_matches as (
  select m.candidate_id,
    jsonb_agg(jsonb_build_object(
      'jobId', r.external_id, 'title', r.title, 'company', r.company_name, 'salary', r.salary,
      'locations', r.locations, 'workplace', r.workplace, 'linked', r.linked_org_role,
      'label', m.label, 'reason', v.verdict->'v2'->>'paragraph', 'addedAt', m.created_at
    ) order by (m.label = 'contact') desc, m.fit desc nulls last, m.created_at desc) as matches
  from m
  join page pg on pg.candidate_id = m.candidate_id
  join public.org_roles r on r.id = m.org_role_id
  join public.match_verdicts v on v.id = m.verdict_id
  group by m.candidate_id
)
select pg.candidate_id, pg.latest_match_at, pm.matches, pg.total_people, pg.total_matches, pg.new_since_yesterday
from page pg
join page_matches pm on pm.candidate_id = pg.candidate_id
order by pg.any_contact desc, pg.best_fit desc nulls last, pg.quality desc, pg.best_rank asc nulls last,
  pg.latest_match_at desc, pg.candidate_id
$$;

-- Called only by the server with the service key, like network_people (065).
revoke execute on function public.network_people_by_fit(uuid, text, text, text, text, integer, integer, integer) from public, anon, authenticated;

-- What the sort needs, readable from the index alone (no visit to the
-- verdicts themselves): about 1 s for the whole tab through the API, where
-- network_people takes 2 s.
create index if not exists match_verdicts_network_idx
  on public.match_verdicts (organization_id, candidate_id, org_role_id, created_at desc)
  include (id, v2_label, v2_strength)
  where v2_label is not null;
