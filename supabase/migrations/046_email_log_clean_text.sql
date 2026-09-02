-- 046: each logged email keeps its own words (quoted history stripped) so
-- the Email tab can render conversations chat-style. quoted_text keeps the
-- stripped "On … wrote:" chain behind a toggle. Additive.
alter table candidate_email_log add column if not exists body_text   text not null default '';
alter table candidate_email_log add column if not exists quoted_text text not null default '';
