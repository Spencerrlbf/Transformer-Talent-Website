-- Tenant scoping for the keyword retrieval channel: match_roles_keyword
-- scanned ALL orgs' open roles, so a TT candidate (site apply or nightly
-- worker) could retrieve another tenant's role — and external ids collide
-- across orgs. org_filter defaults to null so existing callers keep their
-- behavior until they opt in (additive, same pattern as migration 013).
drop function if exists public.match_roles_keyword(text[], int);
create or replace function public.match_roles_keyword(
  skills text[],
  match_count int default 5,
  org_filter uuid default null
)
returns table (job_id text, title text, keyword_hits int)
language sql
as $$
  select r.external_id as job_id, r.title, count(distinct s)::int as keyword_hits
  from public.org_roles r
  cross join (select distinct lower(trim(x)) as s from unnest(skills) x where length(trim(x)) >= 2) sk
  where r.status = 'open'
    and (org_filter is null or r.organization_id = org_filter)
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
