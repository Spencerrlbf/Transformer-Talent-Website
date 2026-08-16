-- SaaS tenancy foundations (applied 2026-08-15). Additive only — no existing
-- behavior changes. Three pieces:
--   1. org_members: maps magic-link auth users to organizations. Dashboard
--      access is enforced in API routes with the service role (the client
--      never talks to Supabase directly), so RLS stays locked-down default.
--   2. org_roles.skills: structured skills for dashboard-created roles —
--      [{"skill": "Python", "must_have": true, "alternates": ["Golang"]}].
--      Legacy Notion-synced roles keep using tech_stack text; empty array
--      means "no structured skills defined".
--   3. website_applications.organization_id: which tenant's board the
--      application came through. Existing rows backfilled to the
--      transformer-talent org; the apply route stamps it going forward.

create table if not exists public.org_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  user_id uuid not null,                  -- auth.users id (no FK across schemas)
  email text not null,
  member_role text not null default 'member',
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index if not exists org_members_user_idx on public.org_members (user_id);
alter table public.org_members enable row level security;

alter table public.org_roles
  add column if not exists skills jsonb not null default '[]'::jsonb;

alter table public.website_applications
  add column if not exists organization_id uuid references public.organizations (id);
create index if not exists website_applications_org_idx
  on public.website_applications (organization_id);

update public.website_applications
  set organization_id = (
    select id from public.organizations where slug = 'transformer-talent'
  )
  where organization_id is null;
