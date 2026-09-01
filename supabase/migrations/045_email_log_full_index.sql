-- 045: the candidate_email_log dedup index must be a FULL unique index.
-- Postgres can't use a partial unique index as an ON CONFLICT arbiter via
-- PostgREST (no way to supply the index predicate), so every log insert
-- failed 42P10 and the timeline stayed silently empty. logEmail now mints
-- a synthetic unique message_id when the provider gives none, so the full
-- index never collides on empties.
drop index if exists candidate_email_log_msg;
create unique index if not exists candidate_email_log_msg
  on candidate_email_log (organization_id, message_id);
