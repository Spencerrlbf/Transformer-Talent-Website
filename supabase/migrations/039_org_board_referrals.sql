-- Org-board referrals: the Refer-an-engineer card on tenant boards submits
-- without a recruiter page. Those rows carry recruiter_profile_id = null and
-- amount = 0 (no bounty was offered). Additive: existing writers always set
-- the column, so relaxing the constraint changes nothing for them.
alter table public.referrals
  alter column recruiter_profile_id drop not null;
