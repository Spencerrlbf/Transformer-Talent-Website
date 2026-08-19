-- Sourcing engine hardening (additive). Outcome of the adversarial design
-- review: DB-clock leases with fenced writes, atomic page commits with
-- idempotent usage billing, claim-fenced row screening, persisted pacing +
-- circuit breaker, and a set-based rank write. Every RPC uses the DATABASE
-- clock (now()) — app-server clock skew can never seize a live lease.

-- ---------- columns ----------
alter table public.sourcing_runs
  add column if not exists lease_id uuid,
  add column if not exists lease_until timestamptz,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists allfail_streak int not null default 0,
  add column if not exists page_attempts int not null default 0;

alter table public.sourcing_run_candidates
  add column if not exists screen_claim_id uuid,
  add column if not exists screen_next_attempt_at timestamptz,
  add column if not exists orphan_heals int not null default 0;

-- Idempotent paged billing: a replayed page can never double-insert its
-- usage rows. NULLs are distinct, so unpaged events are unaffected.
alter table public.usage_events add column if not exists page int;
update public.usage_events set page = (meta->>'page')::int
  where page is null and meta ? 'page';
create unique index if not exists usage_events_run_event_page_uq
  on public.usage_events (run_id, event_type, page);

-- ---------- run lease (claim / renew / release) ----------
-- claim: succeeds when the lease is free, expired, or already ours.
-- Returns the authoritative run row (the caller's snapshot) or nothing.
create or replace function public.claim_run_lease(
  p_run_id uuid, p_lease_id uuid, p_ttl_secs int default 90
) returns setof public.sourcing_runs
language sql as $$
  update public.sourcing_runs
  set lease_id = p_lease_id,
      lease_until = now() + make_interval(secs => p_ttl_secs),
      updated_at = now()
  where id = p_run_id
    and (lease_until is null or lease_until < now() or lease_id = p_lease_id)
  returning *;
$$;

create or replace function public.renew_run_lease(
  p_run_id uuid, p_lease_id uuid, p_ttl_secs int default 90
) returns boolean
language sql as $$
  with u as (
    update public.sourcing_runs
    set lease_until = now() + make_interval(secs => p_ttl_secs), updated_at = now()
    where id = p_run_id and lease_id = p_lease_id
    returning 1
  ) select count(*) > 0 from u;
$$;

create or replace function public.release_run_lease(
  p_run_id uuid, p_lease_id uuid
) returns boolean
language sql as $$
  with u as (
    update public.sourcing_runs
    set lease_id = null, lease_until = null, updated_at = now()
    where id = p_run_id and lease_id = p_lease_id
    returning 1
  ) select count(*) > 0 from u;
$$;

-- ---------- atomic import-page commit ----------
-- One transaction: cursor CAS (fenced by lease), idempotent usage inserts,
-- and counts recomputed from ground truth. Returns false when the CAS or
-- fence loses — the caller aborts without touching anything else.
create or replace function public.commit_import_page(
  p_run_id uuid, p_lease_id uuid, p_page int,
  p_org uuid, p_import_qty int,
  p_search_cost numeric default 0.1, p_import_unit_cost numeric default 0.004
) returns boolean
language plpgsql as $$
declare
  v_imported int;
  v_total int;
begin
  update public.sourcing_runs
  set pages_fetched = p_page, updated_at = now(), page_attempts = 0
  where id = p_run_id and pages_fetched = p_page - 1 and lease_id = p_lease_id;
  if not found then return false; end if;

  insert into public.usage_events (organization_id, run_id, event_type, quantity, unit_cost_usd, credits, page)
  values (p_org, p_run_id, 'search_page', 1, p_search_cost, 0, p_page)
  on conflict (run_id, event_type, page) do nothing;

  if p_import_qty > 0 then
    insert into public.usage_events (organization_id, run_id, event_type, quantity, unit_cost_usd, credits, page)
    values (p_org, p_run_id, 'profile_import', p_import_qty, p_import_unit_cost, p_import_qty, p_page)
    on conflict (run_id, event_type, page) do nothing;
  end if;

  select count(*) into v_imported from public.sourced_candidates where first_run_id = p_run_id;
  select count(*) into v_total from public.sourcing_run_candidates where run_id = p_run_id;
  update public.sourcing_runs
  set imported_count = v_imported, duplicate_count = greatest(0, v_total - v_imported)
  where id = p_run_id;
  return true;
end;
$$;

-- ---------- claim-fenced screening rows ----------
-- Atomically claims the next screenable rows (rank order, pacing honored,
-- 3-attempt cap on BOTH arms) and stamps them with the driver's claim id.
-- Attempts are NOT incremented here — infra kills must not burn retries;
-- the driver charges the attempt only on a real failure.
create or replace function public.claim_screen_rows(
  p_run_id uuid, p_lease_id uuid, p_limit int
) returns setof public.sourcing_run_candidates
language sql as $$
  update public.sourcing_run_candidates m
  set screen_status = 'pending', screen_claim_id = p_lease_id
  where m.id in (
    select id from public.sourcing_run_candidates
    where run_id = p_run_id
      and hidden = false
      and rank is not null
      and screen_status in ('none', 'failed')
      and screen_attempts < 3
      and (screen_next_attempt_at is null or screen_next_attempt_at < now())
    order by rank asc
    limit greatest(p_limit, 0)
    for update skip locked
  )
  returning *;
$$;

-- Orphan heal: pending rows stamped by a DIFFERENT (dead) driver become
-- 'failed' — never 'none', so the attempts cap still binds. Attempts are
-- not charged (the kill wasn't the row's fault); orphan_heals counts the
-- incidents, and a row healed 5+ times is terminally failed as a poison
-- row (attempts forced to the cap).
create or replace function public.heal_orphan_rows(
  p_run_id uuid, p_lease_id uuid
) returns int
language plpgsql as $$
declare v_count int;
begin
  update public.sourcing_run_candidates
  set screen_status = 'failed', orphan_heals = orphan_heals + 1, screen_claim_id = null
  where run_id = p_run_id and screen_status = 'pending'
    and (screen_claim_id is distinct from p_lease_id);
  get diagnostics v_count = row_count;
  update public.sourcing_run_candidates
  set screen_attempts = greatest(screen_attempts, 3)
  where run_id = p_run_id and orphan_heals >= 5 and screen_attempts < 3;
  return v_count;
end;
$$;

-- ---------- set-based rank write ----------
-- Replaces ~2500 per-row PATCHes with one UPDATE.
create or replace function public.apply_ranks(
  p_run_id uuid, p_ranks jsonb
) returns int
language plpgsql as $$
declare v_count int;
begin
  update public.sourcing_run_candidates c
  set rank = r.rank, keyword_score = r.keyword_score, rank_score = r.rank_score
  from jsonb_to_recordset(p_ranks) as r(id uuid, rank int, keyword_score real, rank_score real)
  where c.id = r.id and c.run_id = p_run_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function
  public.claim_run_lease, public.renew_run_lease, public.release_run_lease,
  public.commit_import_page, public.claim_screen_rows, public.heal_orphan_rows,
  public.apply_ranks
from public, anon, authenticated;
