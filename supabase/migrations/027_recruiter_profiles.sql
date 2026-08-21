-- Recruiter pages, part 1 (applied 2026-08-20). Additive only:
--   1. org_roles.created_by: which dashboard user created the role. Stamped
--      by the jobs API going forward; existing rows backfilled to the org's
--      owner (oldest owner membership, else oldest membership).
--   2. organizations.website: the company site, shown on recruiter pages
--      (and reused by the public company page later).
--   3. recruiter_profiles: one public page per dashboard user per org.
--      Unpublished profiles have no public page. Referral config (task H)
--      will be added to this table later.
--   4. recruiter-photos storage bucket: public read, service-role writes
--      (headshots only; resumes stay in the private "resumes" bucket).

alter table public.org_roles
  add column if not exists created_by uuid;

update public.org_roles r
set created_by = (
  select m.user_id
  from public.org_members m
  where m.organization_id = r.organization_id
  order by (m.member_role = 'owner') desc, m.created_at asc
  limit 1
)
where r.created_by is null;

alter table public.organizations
  add column if not exists website text;

create table if not exists public.recruiter_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  user_id uuid not null,                  -- auth.users id (no FK across schemas)
  slug text not null unique,
  display_name text not null default '',
  photo_path text,                        -- object path in recruiter-photos bucket
  linkedin_url text,
  bio text not null default '',
  show_all_roles boolean not null default true,  -- false = only roles they created
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);
alter table public.recruiter_profiles enable row level security;

insert into storage.buckets (id, name, public)
values ('recruiter-photos', 'recruiter-photos', true)
on conflict (id) do nothing;
