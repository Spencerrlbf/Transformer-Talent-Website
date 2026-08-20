-- Candidates v2 (additive): client-editable contact details, and a resume
-- slot for sourced candidates (applicants already have resume_path).
alter table public.sourced_candidates
  add column if not exists contact jsonb,
  add column if not exists resume_path text;
alter table public.website_applications
  add column if not exists contact jsonb;
