-- Credits (Sourcing Task 6). Model: 1 credit = 1 candidate imported (review
-- and ranking included). Balance is never a hand-edited number — it is
-- always sum(grants) - sum(usage_events.credits), so it reconciles against
-- the exactly-once metering the engine already writes.

create table if not exists public.credit_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  credits int not null, -- negative allowed for manual adjustments
  reason text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists credit_grants_org_idx
  on public.credit_grants (organization_id, created_at desc);
alter table public.credit_grants enable row level security;

-- Balance summary. held = credits active runs still expect to consume
-- (their remaining estimates), so two concurrent runs can't both spend the
-- same balance.
create or replace function public.org_credit_summary(p_org uuid)
returns table (granted bigint, spent bigint, held bigint, balance bigint, available bigint)
language sql as $$
  with g as (
    select coalesce(sum(credits), 0)::bigint as granted
    from public.credit_grants where organization_id = p_org
  ),
  s as (
    select coalesce(sum(credits), 0)::bigint as spent
    from public.usage_events where organization_id = p_org
  ),
  h as (
    select coalesce(sum(greatest(0, coalesce(match_estimate, 0) - imported_count)), 0)::bigint as held
    from public.sourcing_runs
    where organization_id = p_org
      and status in ('previewed', 'importing', 'ranking', 'screening')
  )
  select g.granted, s.spent, h.held,
         g.granted - s.spent as balance,
         g.granted - s.spent - h.held as available
  from g, s, h;
$$;

-- Atomic run creation with credit enforcement. An advisory lock on the org
-- serializes concurrent creations, so two simultaneous imports can never
-- both pass the same balance check.
create or replace function public.create_run_with_credits(
  p_org uuid, p_role uuid, p_created_by uuid,
  p_params jsonb, p_estimate int, p_mode text default 'live'
) returns jsonb
language plpgsql as $$
declare
  v_available bigint;
  v_run public.sourcing_runs;
begin
  perform pg_advisory_xact_lock(hashtext(p_org::text));
  select available into v_available from public.org_credit_summary(p_org);
  if v_available < p_estimate then
    return jsonb_build_object('ok', false, 'available', v_available, 'needed', p_estimate);
  end if;
  insert into public.sourcing_runs
    (organization_id, org_role_id, created_by, search_params, status, match_estimate, screen_target, provider_mode)
  values (p_org, p_role, p_created_by, p_params, 'previewed', p_estimate, 0, coalesce(p_mode, 'live'))
  returning * into v_run;
  return jsonb_build_object('ok', true, 'run', to_jsonb(v_run));
end;
$$;

revoke execute on function public.org_credit_summary, public.create_run_with_credits
from public, anon, authenticated;

-- A run created in mock mode (preview deployments, CLI tests) must never be
-- driven by a live-mode driver (the scheduled resumer) — that would turn a
-- demo into real Harvest/OpenAI spend. Runs remember their mode; drivers
-- refuse mode mismatches.
alter table public.sourcing_runs add column if not exists provider_mode text not null default 'live';
