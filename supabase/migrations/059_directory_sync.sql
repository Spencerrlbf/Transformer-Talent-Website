-- The engaged directory (communications project) replaces the Airtable sync.
-- Applied 2026-09-24.
alter table public.candidates add column if not exists directory_contact_id uuid;
alter table public.candidates add column if not exists directory_sync_hash text;
create unique index if not exists candidates_directory_contact_id_key
  on public.candidates (directory_contact_id) where directory_contact_id is not null;
