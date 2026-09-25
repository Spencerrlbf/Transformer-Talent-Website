-- What kind of job a person does now (builds, leads the technical work,
-- manages engineers, leads an organisation), as Jev read their recent
-- positions (lib/server/rolecard/role-type.ts). Remembered per person, under a
-- hash of exactly what was read, so a person is read once and again only
-- when their positions change; the judge's holds use it on every role.
-- Server-only, like verdict_cache. Additive.
create table if not exists public.person_role_types (
  candidate_key text not null,
  input_hash text not null,
  result jsonb not null,
  model text,
  created_at timestamptz not null default now(),
  primary key (candidate_key, input_hash)
);
alter table public.person_role_types enable row level security;
