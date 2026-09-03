-- Home: goals + needs attention (applied 2026-09-03). Additive only:
--  * stage_events.moved_by_email: who made the move, so "moved to
--    Interviewing" and "placements" can be counted per seat. Null = the
--    system (a reply clearing a no-reply mark) or a move made before this.
--  * goal_targets: weekly targets. member_email '' = the org default the
--    owner sets in Settings; a seat's own row overrides it.
--  * organizations.attention_rules: the owner's day-counts and on/off per
--    rule for the Needs attention card (null = the built-in defaults).
--  * attention_snoozes: per-seat "not for 7 days" on one attention row.
alter table public.stage_events add column if not exists moved_by_email text;

create table if not exists public.goal_targets (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  member_email text not null default '',
  emails integer not null default 20 check (emails between 0 and 999),
  calls integer not null default 5 check (calls between 0 and 999),
  interviewing integer not null default 3 check (interviewing between 0 and 999),
  placements integer not null default 1 check (placements between 0 and 999),
  updated_at timestamptz not null default now(),
  primary key (organization_id, member_email)
);
alter table public.goal_targets enable row level security;

alter table public.organizations add column if not exists attention_rules jsonb;

create table if not exists public.attention_snoozes (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  member_email text not null,
  item_key text not null,
  until date not null,
  primary key (organization_id, member_email, item_key)
);
alter table public.attention_snoozes enable row level security;
