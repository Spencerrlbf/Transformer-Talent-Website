-- 047: Inbox. Additive.
--  * inbox_items: per-seat seen/handled state for the things that arrive
--    (applications, resume drops, referrals, asks) and for email threads
--    awaiting a reply. Tasks and due follow-ups are org truth already and
--    need no row here. kind/label/candidate_key are display snapshots for
--    the Done view — labels, not sources of truth.
--  * organizations.email_visibility: 'private' = only the mailbox owner
--    sees a thread (Inbox, Email tab, timeline); 'team' = every member.
--  * tasks.kind gains 'message' (LinkedIn / other messages).
create table if not exists public.inbox_items (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  member_email text not null,
  item_key text not null,
  kind text,
  label text,
  candidate_key text,
  seen_at timestamptz,
  handled_at timestamptz,
  handled_by text,
  primary key (organization_id, member_email, item_key)
);
create index if not exists inbox_items_done_idx
  on public.inbox_items (organization_id, member_email, handled_at desc)
  where handled_at is not null;
alter table public.inbox_items enable row level security;

alter table public.organizations
  add column if not exists email_visibility text not null default 'private';
alter table public.organizations drop constraint if exists organizations_email_visibility_check;
alter table public.organizations
  add constraint organizations_email_visibility_check
  check (email_visibility in ('private', 'team'));

alter table public.tasks drop constraint if exists tasks_kind_check;
alter table public.tasks
  add constraint tasks_kind_check check (kind in ('task', 'call', 'email', 'message'));
