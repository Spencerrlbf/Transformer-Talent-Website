-- Screening retries: flaky LLM responses fail individual rows, and a row
-- that fails must not be skipped forever — especially the top-ranked ones.
-- Track attempts so failed rows re-queue (up to 3 tries) before a run
-- declares screening finished.
alter table public.sourcing_run_candidates
  add column if not exists screen_attempts int not null default 0;
