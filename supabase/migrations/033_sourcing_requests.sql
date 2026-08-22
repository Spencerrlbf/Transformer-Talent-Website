-- Client-request loop (applied 2026-08-21). Additive only: a client can
-- raise a hand on any of their jobs — "ask Transformer Talent to help fill
-- this role". Doubles as explicit consent to receive profiles.
alter table public.org_roles
  add column if not exists sourcing_requested boolean not null default false,
  add column if not exists sourcing_requested_at timestamptz;
