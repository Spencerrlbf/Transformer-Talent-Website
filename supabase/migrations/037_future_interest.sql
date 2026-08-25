-- Future interest: candidates who ask to be contacted later from a recruiter
-- page. The application row carries the ask (follow_up_at + preferences);
-- the pipeline mirrors it onto the global candidate record. On future rows,
-- the otherwise-unused `location` and `comp_expectation` columns hold the
-- preferred location and salary floor.
alter table public.website_applications
  add column if not exists follow_up_at date,
  add column if not exists preferred_roles text[] not null default '{}';

alter table public.candidates
  add column if not exists follow_up_at date,
  add column if not exists role_preferences jsonb;

create index if not exists candidates_follow_up_idx
  on public.candidates (follow_up_at)
  where follow_up_at is not null;

create index if not exists website_applications_follow_up_idx
  on public.website_applications (organization_id, follow_up_at)
  where follow_up_at is not null;

-- Page analytics: the "hear from me later" trigger gets its own event.
alter table public.page_events drop constraint if exists page_events_event_check;
alter table public.page_events add constraint page_events_event_check
  check (event in ('view','role_open','booking_click','email_copy','linkedin_click','referral_open','future_open'));
