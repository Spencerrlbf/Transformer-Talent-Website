create table if not exists public.candidate_embeddings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  candidate_id uuid not null,
  source_type text not null,              -- 'linkedin_profile' | 'resume' | 'summary'
  chunk_index int not null default 0,
  content text not null,
  content_hash text not null,
  model text not null,
  dimensions int not null,
  embedding vector(1536) not null,
  created_at timestamptz not null default now(),
  unique (candidate_id, source_type, chunk_index, content_hash)
);
create index if not exists candidate_embeddings_cand_idx on public.candidate_embeddings (candidate_id);
alter table public.candidate_embeddings enable row level security;
