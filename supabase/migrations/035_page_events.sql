-- Recruiter page analytics: anonymous events fired by the public page.
-- One row per (page, event, role, visitor, day) — a daily one-way visitor
-- hash dedupes repeats, doubles as spam damping, and can never be reversed
-- into an identity. No cookies anywhere.
create table if not exists public.page_events (
  id uuid primary key default gen_random_uuid(),
  recruiter_profile_id uuid not null references public.recruiter_profiles(id) on delete cascade,
  event text not null check (event in ('view','role_open','booking_click','email_copy','linkedin_click','referral_open')),
  role_id text not null default '',
  referrer text,
  visitor_hash text not null,
  day date not null default current_date,
  created_at timestamptz not null default now()
);

create unique index if not exists page_events_dedupe
  on public.page_events (recruiter_profile_id, event, role_id, visitor_hash, day);
create index if not exists page_events_profile_idx
  on public.page_events (recruiter_profile_id, event, created_at);

alter table public.page_events enable row level security;

-- All the numbers My page shows, in one call: event counts (week + all
-- time), per-role engagement joined to titles, and the real application /
-- referral rows the events sit alongside.
create or replace function public.recruiter_page_stats(profile uuid)
returns json
language sql
stable
security definer
set search_path = public
as $$
  with p as (
    select organization_id from recruiter_profiles where id = profile
  ),
  ev as (
    select event, count(*) as all_time,
           count(*) filter (where created_at > now() - interval '7 days') as week
    from page_events where recruiter_profile_id = profile
    group by event
  ),
  role_opens as (
    select role_id, count(*) as opens
    from page_events
    where recruiter_profile_id = profile and event = 'role_open' and role_id <> ''
    group by role_id
  ),
  role_applies as (
    select rid as role_id, count(*) as applies
    from website_applications, unnest(role_ids) as rid
    where recruiter_profile_id = profile
    group by rid
  ),
  apps as (
    select count(*) filter (where cardinality(role_ids) > 0 and source not like 'referral:%') as applied_all,
           count(*) filter (where cardinality(role_ids) > 0 and source not like 'referral:%'
                            and created_at > now() - interval '7 days') as applied_week,
           count(*) filter (where cardinality(role_ids) = 0 and source not like 'referral:%') as spec_all,
           count(*) filter (where cardinality(role_ids) = 0 and source not like 'referral:%'
                            and created_at > now() - interval '7 days') as spec_week
    from website_applications where recruiter_profile_id = profile
  ),
  refs as (
    select count(*) as all_time,
           count(*) filter (where created_at > now() - interval '7 days') as week
    from referrals where recruiter_profile_id = profile
  )
  select json_build_object(
    'events', coalesce((select json_object_agg(event, json_build_object('week', week, 'all', all_time)) from ev), '{}'::json),
    'applications', (select json_build_object('week', applied_week, 'all', applied_all) from apps),
    'resumeDrops', (select json_build_object('week', spec_week, 'all', spec_all) from apps),
    'referrals', (select json_build_object('week', week, 'all', all_time) from refs),
    'roles', coalesce((
      select json_agg(json_build_object(
        'roleId', x.role_id,
        'title', coalesce(orl.title, 'Role #' || x.role_id),
        'opens', coalesce(ro.opens, 0),
        'applies', coalesce(ra.applies, 0)
      ) order by coalesce(ro.opens, 0) + coalesce(ra.applies, 0) desc)
      from (
        select role_id from role_opens
        union
        select role_id from role_applies
      ) x
      left join role_opens ro on ro.role_id = x.role_id
      left join role_applies ra on ra.role_id = x.role_id
      left join org_roles orl
        on orl.external_id = x.role_id and orl.organization_id = (select organization_id from p)
    ), '[]'::json)
  );
$$;

revoke all on function public.recruiter_page_stats(uuid) from public, anon, authenticated;
