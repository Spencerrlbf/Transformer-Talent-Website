-- Interview stages (applied 2026-08-21). Additive only. The "interviewing"
-- pipeline status expands into configurable sub-stages:
--   1. organizations.interview_stages: the company default template, a jsonb
--      array of {id, label}. Stable ids survive renames; labels are free.
--   2. org_roles.interview_stages: per-job override (null = inherit the
--      company default).
--   3. candidate_role_statuses.interview_stage: which sub-stage (template id)
--      a candidate is in. Only meaningful while status = 'interviewing';
--      null there means "first stage" on the board.

alter table public.organizations
  add column if not exists interview_stages jsonb not null default
  '[{"id":"screen","label":"Recruiter screen"},{"id":"technical","label":"Technical"},{"id":"onsite","label":"Onsite"},{"id":"final","label":"Final"}]'::jsonb;

alter table public.org_roles
  add column if not exists interview_stages jsonb;

alter table public.candidate_role_statuses
  add column if not exists interview_stage text;
