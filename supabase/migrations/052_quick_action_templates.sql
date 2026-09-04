-- Quick-action buttons → templates (applied 2026-09-03). Additive only.
-- Each button in the Inbox and on Home sends one template. By default it
-- finds the org's copy of the stock wording by email_templates.action_key;
-- a row here points it at any other template instead. Deleting that
-- template nulls the row, and the button falls back to the default again.
create table if not exists public.quick_action_templates (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  button_key text not null,
  template_id uuid references public.email_templates(id) on delete set null,
  updated_by_email text not null default '',
  updated_at timestamptz not null default now(),
  primary key (organization_id, button_key)
);
alter table public.quick_action_templates enable row level security;
