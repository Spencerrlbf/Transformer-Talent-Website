-- Run with psql -v ON_ERROR_STOP=1 -f, outside any explicit transaction,
-- against the website database before enabling normalized intake. This
-- additive index also supports application identity admission. No unique
-- constraint is introduced and no people are merged.
set lock_timeout = '3s';
set statement_timeout = '5min';
create index concurrently if not exists candidates_person_linkedin_folded_idx
 on public.candidates (lower(linkedin_username));
-- A failed concurrent build can leave an invalid index. Do not treat the
-- IF NOT EXISTS notice from a retry as a successful release prerequisite.
do $$ begin
 if not exists (
  select 1 from pg_index i join pg_class c on c.oid=i.indexrelid
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname='candidates_person_linkedin_folded_idx'
   and i.indrelid='public.candidates'::regclass and i.indisvalid and i.indisready
   and pg_get_expr(i.indexprs,i.indrelid) in ('lower(linkedin_username)','lower((linkedin_username)::text)')
 ) then raise exception 'candidate folded identity index is not ready'; end if;
end $$;
reset statement_timeout;
reset lock_timeout;
