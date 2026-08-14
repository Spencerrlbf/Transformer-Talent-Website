-- Screening results per application (applied 2026-08-14).
alter table public.website_applications add column if not exists screening jsonb;
