-- 048: quick actions. A template can carry a stable action key so the
-- Inbox buttons keep working when the org renames it; defaults are seeded
-- once per org (never re-seeded after a delete). Additive.
alter table public.email_templates add column if not exists action_key text;
create index if not exists email_templates_action_idx
  on public.email_templates (organization_id, action_key)
  where action_key is not null;
alter table public.organizations add column if not exists quick_templates_seeded_at timestamptz;
