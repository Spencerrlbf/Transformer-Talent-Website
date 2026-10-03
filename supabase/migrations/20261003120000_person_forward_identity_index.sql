-- Forward validation for databases that installed the earlier
-- 20260927170000_person_directory_outcomes.sql, whose `create index if not
-- exists` accepted any object with the right name (release review RR-13). The
-- release chain validates the index at install; this step applies the same
-- check to an already-installed database. It never creates, drops or rebuilds
-- an index: an invalid (interrupted concurrent build), unique, partial,
-- non-btree or differently defined same-name index stops the upgrade so an
-- operator can rebuild it with the runbook's CONCURRENTLY procedure.
set local lock_timeout='2s';set local statement_timeout='30s';
do $$ begin
 if not exists (
  select 1 from pg_index i join pg_class c on c.oid=i.indexrelid
  join pg_am a on a.oid=c.relam
  where i.indexrelid=to_regclass('public.candidates_person_username_idx')
   and i.indrelid='public.candidates'::regclass and i.indisvalid and i.indisready
   and not i.indisunique and i.indpred is null and i.indnatts=1 and a.amname='btree'
   and pg_get_expr(i.indexprs,i.indrelid) in ('lower(linkedin_username)','lower((linkedin_username)::text)')
 ) then raise exception 'candidate identity index is not ready'; end if;
end $$;
