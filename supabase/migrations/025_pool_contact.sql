-- Uniform contact editing: pool candidates get the same contact jsonb
-- overlay website_applications and sourced_candidates use, so the drawer's
-- contact block (and its Edit) works identically for network people.
alter table candidates add column if not exists contact jsonb;
