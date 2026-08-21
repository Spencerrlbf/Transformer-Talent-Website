-- Company pages (applied 2026-08-21, task J). Additive only:
--   1. organizations.company_profile: all page content as one jsonb doc
--      (tagline, mission, building + cards, founders w/ photo paths,
--      process note + per-step durations, facts). Sanitized in the API.
--   2. organizations.company_page_published: publish gate — unpublished
--      boards look exactly as before.
--   3. organizations.logo_path: object path in the company-assets bucket.
--   4. company-assets bucket: public read (logos + founder photos).

alter table public.organizations
  add column if not exists company_profile jsonb,
  add column if not exists company_page_published boolean not null default false,
  add column if not exists logo_path text;

insert into storage.buckets (id, name, public)
values ('company-assets', 'company-assets', true)
on conflict (id) do nothing;
