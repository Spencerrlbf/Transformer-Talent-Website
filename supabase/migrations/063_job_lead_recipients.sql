-- Who gets the email when someone applies to a job: the job's recruiter
-- (the teammate who created it) by default. notify_user_ids, when set, is the
-- company's own list for that job (teammates only; checked on save and again
-- at send time against the company's current members). NULL = the creator.
alter table public.org_roles
  add column if not exists notify_user_ids uuid[];
