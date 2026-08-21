-- /talent matcher form: requester's LinkedIn profile, so requests can be
-- vetted before profiles are shared.
alter table jd_submissions add column if not exists linkedin_url text;
