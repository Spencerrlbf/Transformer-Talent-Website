-- Screening cache + audit trail: one row per candidate x role pairing,
-- keyed by content hashes of both sides. Hash match = free reuse; either
-- side changing re-screens. verdict holds the full question sheet
-- (per-question answer + evidence) plus deterministic facts, so every
-- recommendation the system makes is queryable and explainable.

create table if not exists public.match_verdicts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  candidate_id uuid not null,
  org_role_id uuid not null references public.org_roles (id) on delete cascade,
  candidate_hash text not null,          -- sha256 of the candidate evidence text
  role_hash text not null,               -- sha256 of the role's questions + must-haves
  verdict jsonb not null,                -- {qualified, fit_score, answers:[{question, answer, evidence}], facts}
  model text,
  source text not null default 'apply',  -- 'apply' | 'precompute'
  surfaced_count int not null default 0, -- times this verdict backed a live recommendation
  last_surfaced_at timestamptz,
  outcome text,                          -- null | 'accepted' | 'rejected' (set when a human acts on it)
  outcome_at timestamptz,
  created_at timestamptz not null default now(),
  unique (candidate_id, org_role_id, candidate_hash, role_hash)
);
create index if not exists match_verdicts_role_idx on public.match_verdicts (org_role_id, created_at desc);
create index if not exists match_verdicts_cand_idx on public.match_verdicts (candidate_id, created_at desc);
alter table public.match_verdicts enable row level security;
