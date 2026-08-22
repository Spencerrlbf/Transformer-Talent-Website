-- Team management: seat limits (hand-set until billing exists; null =
-- unlimited) and invitation audit on memberships.
alter table public.organizations
  add column if not exists seat_limit integer;
alter table public.org_members
  add column if not exists invited_at timestamptz,
  add column if not exists invited_by uuid;
