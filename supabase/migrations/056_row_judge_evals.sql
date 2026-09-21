-- Owner-only evaluation of row judges. Additive: one new table that nothing in
-- the product reads. One row per person per "ask": the scorecard rows as the
-- baseline judge read them (stored on the verdict) beside a second judge's
-- read, asked twice. Later the recruiter's check-offs (verdict_feedback) are
-- the answer key both judges are measured against.
create table if not exists public.row_judge_evals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  org_role_id uuid not null references public.org_roles(id) on delete cascade,
  run_id uuid,                        -- sourcing run the person was judged on
  membership_id uuid,                 -- sourcing_run_candidates.id
  candidate_key text not null,        -- "src_<id>"
  judge text not null,                -- e.g. "jev-1.13.0"
  baseline text,                      -- model behind the stored rows, e.g. "gpt-4o"
  rows jsonb not null,                -- [{id,label,tier,baseline,status,confidence,probabilities,again}]
  ms integer,
  input_tokens integer,
  created_at timestamptz not null default now()
);
create index if not exists row_judge_evals_role_idx
  on public.row_judge_evals (organization_id, org_role_id, created_at desc);
alter table public.row_judge_evals enable row level security;
