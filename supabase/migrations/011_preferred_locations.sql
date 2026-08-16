-- Candidate-stated location preferences (multi-select on the apply form).
-- Empty array = fall back to their LinkedIn/profile location for gating.
alter table public.website_applications
  add column if not exists preferred_locations text[] not null default '{}';
