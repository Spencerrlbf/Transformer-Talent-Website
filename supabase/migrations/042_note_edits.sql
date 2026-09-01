-- Notes became editable (author-only): track when, so the timeline can show
-- an "edited" marker. Null = never edited.
alter table public.candidate_notes add column updated_at timestamptz;
