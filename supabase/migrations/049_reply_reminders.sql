-- Reply reminders (applied 2026-09-03). Additive only:
--  * tasks.kind gains 'reminder': "no reply from X" set at send time, owned
--    by the sender, tied to the conversation (thread_id) and the message that
--    set it (remind_message_id). Ends when the candidate replies in that
--    thread, when the person moves to Rejected or Hired, when a nudge sets
--    the next one, or by hand — ended_reason says which.
--  * tasks.job_id: the role the reminder's email was about, so a nudge's
--    stage move lands on the right role.
--  * org_members.reply_reminder_days: the seat's default when they send
--    (0 = off; 2, 3, 5 or 7 days).
alter table public.tasks drop constraint if exists tasks_kind_check;
alter table public.tasks
  add constraint tasks_kind_check check (kind in ('task', 'call', 'email', 'message', 'reminder'));

alter table public.tasks
  add column if not exists thread_id text,
  add column if not exists remind_message_id text,
  add column if not exists ended_reason text,
  add column if not exists job_id text;

create index if not exists tasks_org_thread_open
  on public.tasks (organization_id, thread_id)
  where kind = 'reminder' and status = 'open';

alter table public.org_members
  add column if not exists reply_reminder_days integer not null default 3;
