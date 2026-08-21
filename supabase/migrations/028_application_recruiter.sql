-- Recruiter pages, part 2 (applied 2026-08-20). Additive only: which
-- recruiter page an application came through, so outreach conversion is
-- visible per recruiter. Null = the application came from the site, a
-- tenant board, or anywhere that isn't a recruiter page.

alter table public.website_applications
  add column if not exists recruiter_profile_id uuid references public.recruiter_profiles (id);

create index if not exists website_applications_recruiter_idx
  on public.website_applications (recruiter_profile_id)
  where recruiter_profile_id is not null;
