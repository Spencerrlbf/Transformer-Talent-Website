-- network_matches rebuilt one role at a time.
--
-- refresh_network_matches(org) rebuilds every row in one statement. Called
-- through the API it ran past the 8-second statement timeout on 2026-09-25
-- (22,668 rows) and failed the nightly judge. The judge now calls this after
-- each role instead: about 300 rows, well inside the limit. The whole-org
-- function stays for use from SQL.
--
-- Additive: one new function, callable only with the service key.

create or replace function public.refresh_network_matches_role(p_org uuid, p_role uuid)
returns integer language plpgsql as $$
declare n integer;
begin
  delete from public.network_matches where organization_id = p_org and org_role_id = p_role;
  insert into public.network_matches (organization_id, candidate_id, org_role_id, verdict_id, label, strength, created_at,
    shortlist_rank, quality, full_name, current_title, current_company, refreshed_at)
  select l.organization_id, l.candidate_id, l.org_role_id, l.id, l.v2_label, coalesce(l.v2_strength, 0), l.created_at,
    s.rank,
    (case ps.top_employer_tier when 1 then 2 when 2 then 1 else 0 end)
      + (case ps.top_university_tier when 1 then 2 when 2 then 1 else 0 end),
    c.full_name, c.current_title, c.current_company, now()
  from (
    select distinct on (v.candidate_id) v.id, v.organization_id, v.candidate_id, v.org_role_id, v.created_at, v.v2_label, v.v2_strength
    from public.match_verdicts v
    where v.org_role_id = p_role and v.organization_id = p_org and v.v2_label is not null
    order by v.candidate_id, v.created_at desc
  ) l
  join public.candidates c on c.id = l.candidate_id
  left join public.role_shortlists s on s.org_role_id = l.org_role_id and s.candidate_id = l.candidate_id
  left join public.person_signals ps on ps.candidate_id = l.candidate_id;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.refresh_network_matches_role(uuid, uuid) from public, anon, authenticated;
