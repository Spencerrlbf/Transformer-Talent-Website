-- 044: in-dashboard email, sent as the seat's own connected account (Nylas).
-- Three tables: per-seat connections, org-shared templates, and the per-
-- candidate email log (candidate_email_log; candidate_emails was taken
-- by the sourcing pipeline's verification store) that feeds the drawer timeline. Additive only.

create table if not exists email_accounts (
  organization_id uuid not null references organizations(id) on delete cascade,
  member_email    text not null,
  grant_id        text not null,
  address         text not null,
  provider        text not null default '',
  created_at      timestamptz not null default now(),
  primary key (organization_id, member_email)
);
create index if not exists email_accounts_grant on email_accounts (grant_id);
alter table email_accounts enable row level security;

create table if not exists email_templates (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  name             text not null,
  subject          text not null default '',
  body_html        text not null default '',
  created_by_email text not null default '',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists email_templates_org_name
  on email_templates (organization_id, lower(name));
alter table email_templates enable row level security;

create table if not exists candidate_email_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  candidate_key   text not null,
  direction       text not null check (direction in ('out','in')),
  member_email    text not null default '',
  address         text not null default '',
  subject         text not null default '',
  snippet         text not null default '',
  body_html       text,
  message_id      text not null default '',
  thread_id       text not null default '',
  created_at      timestamptz not null default now()
);
create index if not exists candidate_email_log_org_key
  on candidate_email_log (organization_id, candidate_key, created_at desc);
-- Webhook dedup: the sync event for a message we already logged at send
-- time conflicts here and is ignored.
create unique index if not exists candidate_email_log_msg
  on candidate_email_log (organization_id, message_id) where message_id <> '';
alter table candidate_email_log enable row level security;
