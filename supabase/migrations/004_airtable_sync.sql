-- Airtable engaged-candidate sync support (applied 2026-08-14).
alter table public.candidates add column if not exists airtable_sync_hash text;
create unique index if not exists candidates_airtable_id_key
  on public.candidates (airtable_id) where airtable_id is not null;
