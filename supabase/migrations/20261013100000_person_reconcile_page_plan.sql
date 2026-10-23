-- Forward: planner-stable paging for the reconcile queue scan. Same results as the
-- 20260926042200 definition (same columns, order, limit and scope rules); only the
-- queue-scope query shape changes. The original tests `exists(select 1 from
-- person_reconcile_pending ...)` for every candidate past the cursor, and the pending
-- view (a DISTINCT ON over the whole person_reconcile_people table) is then re-evaluated
-- per candidate under a generic plan. While pending people are dense that is cheap;
-- once the cursor reaches a sparse region a single page exceeds PostgREST's 8-second
-- statement timeout (57014), which stopped the queue catch-up on the copy after 274
-- people on 2026-09-28 and after 2,000 on 2026-10-13. The candidate set is now gathered
-- once per page (pending people and this run's uncounted records past the cursor), then
-- joined to candidates in id order. Scopes `all` and `directory` keep the original query.
-- Grants are unchanged (create or replace keeps them). The pinned translator is
-- unchanged: it calls this RPC by name with the same arguments and reads the same rows.
set local lock_timeout='2s';set local statement_timeout='30s';
create or replace function public.person_reconcile_page(p_run text,p_size integer)
returns jsonb language plpgsql stable set search_path='' as $$
declare r public.backfill_runs%rowtype; result jsonb; n integer;
begin
 select * into strict r from public.backfill_runs where run_id=p_run;
 if r.status<>'running' or r.notes->>'kind'<>'reconcile' or p_size not between 1 and 500 or p_size>(r.notes->>'batch')::integer then raise exception 'Invalid reconciliation page';end if;
 n:=least(p_size,(r.notes->>'limit')::integer-r.processed);
 if r.notes->>'scope'='queue' then
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') into result from (
   with ids as materialized (
    select p.candidate_id as id from public.person_reconcile_pending p where r.last_id is null or p.candidate_id>r.last_id
    union
    select p.candidate_id from public.person_reconcile_people p where p.run_id=p_run and not p.counted and (r.last_id is null or p.candidate_id>r.last_id)
   )
   select c.id,coalesce(q.version,(select max(e.id) from public.person_change_events e where e.candidate_id=c.id),0) captured_version
   from ids join public.candidates c on c.id=ids.id left join public.person_change_queue q on q.candidate_id=c.id
   order by c.id limit n
  ) x;
 else
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') into result from (
   select c.id,coalesce(q.version,(select max(e.id) from public.person_change_events e where e.candidate_id=c.id),0) captured_version
   from public.candidates c left join public.person_change_queue q on q.candidate_id=c.id
   where (r.last_id is null or c.id>r.last_id)
    and (r.notes->>'scope'<>'directory' or c.directory_contact_id is not null)
   order by c.id limit n
  ) x;
 end if;
 return result;
end $$;
