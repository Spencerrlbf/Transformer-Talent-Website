-- Future interest v2: workplace preference (remote/hybrid/onsite) is its own
-- multi-select, separate from geography.
alter table public.website_applications
  add column if not exists preferred_workplace text[] not null default '{}';
