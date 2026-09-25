-- Each company's daily allowance for the automatic applicant review (resume
-- reading, LinkedIn lookup, AI scoring). Over it, applications are kept as
-- status "queued" and reviewed by the nightly queue; nobody is turned away.
-- Replaces the one shared cap every board used to hit together.
alter table public.organizations
  add column if not exists daily_review_limit integer not null default 300;
