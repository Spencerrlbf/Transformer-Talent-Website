-- The Network tab reads a small ranking table instead of sorting every
-- verdict on every request. Through the API network_people_by_fit took 1 s
-- warm but 6 to 9 s cold (the first requests after a quiet spell), so page 1
-- could time out and a page turn could leave the old page on screen.
--
-- network_matches holds one row per person x role: the newest scorecard
-- verdict's label and strength, and what the order and the search need
-- (shortlist rank, a top-employer/university score, name, title, company).
-- It is kept in two ways:
--   * a trigger on match_verdicts updates the row whenever a verdict is
--     written (the nightly judge, applicants, Review again), and never lets
--     a failure here block the verdict itself;
--   * refresh_network_matches(org) rebuilds an organisation's rows; the
--     nightly judge calls it last, after the signals and the shortlists have
--     changed ranks and scores.
-- Additive: a new table, a trigger that writes only to it, and new
-- functions. Production reads none of it until this branch merges.

create table if not exists public.network_matches (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  org_role_id uuid not null references public.org_roles(id) on delete cascade,
  verdict_id uuid not null,
  label text not null,
  strength numeric not null default 0,
  created_at timestamptz not null,
  shortlist_rank int,
  -- Top employer and top university from person_signals: tier 1 = 2 points,
  -- tier 2 = 1, the two added (0-4).
  quality smallint not null default 0,
  full_name text,
  current_title text,
  current_company text,
  refreshed_at timestamptz not null default now(),
  primary key (organization_id, candidate_id, org_role_id)
);
create index if not exists network_matches_role_idx on public.network_matches (organization_id, org_role_id);
alter table public.network_matches enable row level security;

create or replace function public.refresh_network_matches(p_org uuid)
returns integer language plpgsql as $$
declare n integer;
begin
  delete from public.network_matches where organization_id = p_org;
  insert into public.network_matches (organization_id, candidate_id, org_role_id, verdict_id, label, strength, created_at,
    shortlist_rank, quality, full_name, current_title, current_company, refreshed_at)
  select l.organization_id, l.candidate_id, l.org_role_id, l.id, l.v2_label, coalesce(l.v2_strength, 0), l.created_at,
    s.rank,
    (case ps.top_employer_tier when 1 then 2 when 2 then 1 else 0 end)
      + (case ps.top_university_tier when 1 then 2 when 2 then 1 else 0 end),
    c.full_name, c.current_title, c.current_company, now()
  from (
    select distinct on (v.candidate_id, v.org_role_id) v.id, v.organization_id, v.candidate_id, v.org_role_id, v.created_at, v.v2_label, v.v2_strength
    from public.match_verdicts v
    where v.organization_id = p_org and v.v2_label is not null
    order by v.candidate_id, v.org_role_id, v.created_at desc
  ) l
  join public.candidates c on c.id = l.candidate_id
  left join public.role_shortlists s on s.org_role_id = l.org_role_id and s.candidate_id = l.candidate_id
  left join public.person_signals ps on ps.candidate_id = l.candidate_id;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.network_matches_on_verdict()
returns trigger language plpgsql as $$
begin
  if new.v2_label is null then return new; end if;
  begin
    insert into public.network_matches (organization_id, candidate_id, org_role_id, verdict_id, label, strength, created_at,
      shortlist_rank, quality, full_name, current_title, current_company, refreshed_at)
    select new.organization_id, new.candidate_id, new.org_role_id, new.id, new.v2_label, coalesce(new.v2_strength, 0), new.created_at,
      (select s.rank from public.role_shortlists s where s.org_role_id = new.org_role_id and s.candidate_id = new.candidate_id),
      coalesce((select (case ps.top_employer_tier when 1 then 2 when 2 then 1 else 0 end)
                     + (case ps.top_university_tier when 1 then 2 when 2 then 1 else 0 end)
                from public.person_signals ps where ps.candidate_id = new.candidate_id), 0),
      c.full_name, c.current_title, c.current_company, now()
    from public.candidates c where c.id = new.candidate_id
    on conflict (organization_id, candidate_id, org_role_id) do update set
      verdict_id = excluded.verdict_id, label = excluded.label, strength = excluded.strength,
      created_at = excluded.created_at, shortlist_rank = excluded.shortlist_rank, quality = excluded.quality,
      full_name = excluded.full_name, current_title = excluded.current_title, current_company = excluded.current_company,
      refreshed_at = now()
    where public.network_matches.created_at <= excluded.created_at;
  exception when others then
    -- The verdict is what matters; the next nightly refresh repairs the row.
    raise warning 'network_matches_on_verdict: %', sqlerrm;
  end;
  return new;
end $$;

drop trigger if exists match_verdicts_network on public.match_verdicts;
create trigger match_verdicts_network
  after insert or update of verdict on public.match_verdicts
  for each row execute function public.network_matches_on_verdict();

-- The tab's page, from network_matches: same arguments, columns and order as
-- before (066): Contact now first, then fit (strength as a share of the most
-- the role's card can give), then quality, then shortlist rank, then newest.
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
with roles as materialized (
  select r.id, r.external_id, r.title, r.company_name, r.salary, r.locations, r.workplace, r.linked_org_role,
    (select sum(case c->>'tier' when 'required' then 3 when 'exceptional' then 2 else 1 end)
       from jsonb_array_elements(case jsonb_typeof(r.scorecard->'criteria') when 'array' then r.scorecard->'criteria' else '[]'::jsonb end) c) as card_max
  from public.org_roles r
  where r.organization_id = p_org and r.status = 'open'
    and (p_job is null or p_job = '' or r.external_id = p_job)
    and (p_company is null or p_company = '' or r.company_name = p_company)
), m as materialized (
  select nm.candidate_id, nm.org_role_id, nm.verdict_id, nm.label, nm.created_at, nm.shortlist_rank, nm.quality,
    nm.full_name, nm.current_title, nm.current_company,
    nm.strength / nullif(r.card_max, 0) as fit
  from public.network_matches nm
  join roles r on r.id = nm.org_role_id
  where nm.organization_id = p_org and nm.label in ('contact', 'message')
    and (p_label is null or p_label = '' or nm.label = p_label)
), people as (
  select m.candidate_id, max(m.created_at) as latest_match_at, count(*) as n_matches,
    bool_or(m.label = 'contact') as any_contact,
    coalesce(max(m.fit) filter (where m.label = 'contact'), max(m.fit)) as best_fit,
    coalesce(min(m.shortlist_rank) filter (where m.label = 'contact'), min(m.shortlist_rank)) as best_rank,
    max(m.quality) as quality,
    max(m.full_name) as full_name, max(m.current_title) as current_title, max(m.current_company) as current_company
  from m group by m.candidate_id
), filtered as (
  select p.* from people p
  where (p_q is null or p_q = ''
         or p.full_name ilike '%' || p_q || '%'
         or p.current_title ilike '%' || p_q || '%'
         or p.current_company ilike '%' || p_q || '%')
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
  join roles r on r.id = m.org_role_id
  join public.match_verdicts v on v.id = m.verdict_id
  group by m.candidate_id
)
select pg.candidate_id, pg.latest_match_at, pm.matches, pg.total_people, pg.total_matches, pg.new_since_yesterday
from page pg
join page_matches pm on pm.candidate_id = pg.candidate_id
order by pg.any_contact desc, pg.best_fit desc nulls last, pg.quality desc, pg.best_rank asc nulls last,
  pg.latest_match_at desc, pg.candidate_id
$$;

-- The role filter's options and counts, from the same table (network_roles
-- reads every verdict).
create or replace function public.network_roles_by_fit(p_org uuid)
returns table (job_id text, title text, company_name text, contact_count bigint, message_count bigint)
language sql stable as $$
  select r.external_id, r.title, r.company_name,
    count(*) filter (where nm.label = 'contact'), count(*) filter (where nm.label = 'message')
  from public.network_matches nm
  join public.org_roles r on r.id = nm.org_role_id
  where nm.organization_id = p_org and r.status = 'open' and nm.label in ('contact', 'message')
  group by r.external_id, r.title, r.company_name
  order by r.title
$$;

-- Server-only, like the other matching functions.
revoke execute on function public.refresh_network_matches(uuid) from public, anon, authenticated;
revoke execute on function public.network_people_by_fit(uuid, text, text, text, text, integer, integer, integer) from public, anon, authenticated;
revoke execute on function public.network_roles_by_fit(uuid) from public, anon, authenticated;
revoke execute on function public.network_matches_on_verdict() from public, anon, authenticated;
