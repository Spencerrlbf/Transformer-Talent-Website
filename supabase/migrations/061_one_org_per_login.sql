-- One organization per dashboard login. requireMember resolves a login to
-- exactly one organization and refuses a login with two memberships, so the
-- database holds the same rule: a second membership for the same user is
-- rejected (team invites and the onboarding script check first and say why).
-- Verified before applying: no user holds more than one membership.
create unique index if not exists org_members_one_org_per_user
  on public.org_members (user_id);
