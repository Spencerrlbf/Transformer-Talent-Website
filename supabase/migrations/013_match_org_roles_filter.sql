-- Tenant boards suggest only that tenant's roles: match_org_roles gains an
-- optional org_filter (default null = all orgs, so the nightly worker's
-- existing calls behave exactly as before).
drop function if exists public.match_org_roles(vector(1536), int);
create or replace function public.match_org_roles(
  query_embedding vector(1536),
  match_count int default 5,
  org_filter uuid default null
)
returns table (org_role_id uuid, external_id text, title text, similarity double precision)
language sql
as $$
  select r.id as org_role_id, r.external_id, r.title,
         1 - min(je.embedding <=> query_embedding) as similarity
  from public.job_embeddings je
  join public.org_roles r on r.id = je.org_role_id
  where r.status = 'open'
    and (org_filter is null or r.organization_id = org_filter)
  group by r.id, r.external_id, r.title
  order by min(je.embedding <=> query_embedding)
  limit least(match_count, 20)
$$;
revoke execute on function public.match_org_roles from public, anon, authenticated;
