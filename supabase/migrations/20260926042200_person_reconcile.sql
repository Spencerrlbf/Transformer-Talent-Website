-- Evidence/checkpoint accounting for a final source scan and captured changes.
-- Never publishes candidate fields and never deletes captured event evidence.
set local lock_timeout='2s';
set local statement_timeout='30s';
-- Final accounting briefly excludes normalized commits and capture commits.
-- Capture holds no normalized gate; finalization never locks candidate rows.
do $capture_gate$
declare definition text; needle text:=' if tg_op<>''DELETE'' then fresh:=to_jsonb(new); end if;';
begin
 definition:=pg_get_functiondef('person_private.capture_change()'::regprocedure);
 if position(needle in definition)=0 or position('72006' in definition)>0 then raise exception 'Unexpected capture definition';end if;
 execute replace(definition,needle,' perform pg_advisory_xact_lock_shared(72006,0);'||chr(10)||needle);
end $capture_gate$;
create table public.person_reconcile_people(
 run_id text not null references public.backfill_runs(run_id),
 candidate_id uuid not null references public.candidates(id) on delete cascade,
 status text not null check(status in ('verified','pending','review')),
 revision bigint,
 captured_version bigint not null,
 source_hash text not null,
 checks jsonb not null,
 counted boolean not null default false,
 checked_at timestamptz not null default clock_timestamp(),
 primary key(run_id,candidate_id)
);
create index person_reconcile_people_candidate_idx on public.person_reconcile_people(candidate_id,checked_at desc);
alter table public.person_reconcile_people enable row level security;
revoke all on public.person_reconcile_people from public,anon,authenticated;
grant all on public.person_reconcile_people to service_role;

create view public.person_reconcile_pending with(security_invoker=true) as
 with latest as(select distinct on(candidate_id) candidate_id,status,revision from public.person_reconcile_people order by candidate_id,checked_at desc,run_id desc)
 select candidate_id from public.person_change_queue
 union
 select l.candidate_id from latest l left join public.candidate_profile_state ps on ps.candidate_id=l.candidate_id
 where l.status<>'verified' or l.revision is distinct from ps.rev;
revoke all on public.person_reconcile_pending from public,anon,authenticated;
grant select on public.person_reconcile_pending to service_role;

create function public.person_reconcile_start(p_run text,p_commit text,p_limit integer,p_batch integer,p_resume boolean,p_scope text,p_external_hash text default null)
returns jsonb language plpgsql set search_path='' as $$
declare result jsonb;
begin
 if p_scope not in ('all','queue','directory') then raise exception 'Invalid reconciliation scope';end if;
 if p_external_hash is null or p_external_hash !~ '^[a-f0-9]{32}$' then raise exception 'External fingerprint required';end if;
 if p_resume and not exists(select 1 from public.backfill_runs where run_id=p_run and notes->>'kind'='reconcile' and notes->>'scope'=p_scope) then raise exception 'Reconciliation configuration differs';end if;
 result:=public.person_backfill_start(p_run,p_commit,'person-v3',p_limit,p_batch,p_resume,'all');
 update public.backfill_runs set notes=notes||jsonb_build_object('kind','reconcile','scope',p_scope,'external_hash',coalesce(notes->>'external_hash',p_external_hash)) where run_id=p_run;
 select to_jsonb(r) into result from public.backfill_runs r where run_id=p_run;
 return result;
end $$;

create function public.person_reconcile_preview_page(p_after uuid,p_size integer,p_scope text)
returns jsonb language plpgsql stable set search_path='' as $$
declare result jsonb;
begin
 if p_size not between 1 and 500 or p_scope not in ('all','queue','directory') then raise exception 'Invalid preview';end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') into result from (
  select c.id,coalesce(q.version,(select max(e.id) from public.person_change_events e where e.candidate_id=c.id),0) captured_version from public.candidates c left join public.person_change_queue q on q.candidate_id=c.id
  where (p_after is null or c.id>p_after) and (p_scope<>'queue' or exists(select 1 from public.person_reconcile_pending p where p.candidate_id=c.id)) and (p_scope<>'directory' or c.directory_contact_id is not null)
  order by c.id limit p_size
 )x;return result;
end $$;

create function public.person_reconcile_page(p_run text,p_size integer)
returns jsonb language plpgsql stable set search_path='' as $$
declare r public.backfill_runs%rowtype; result jsonb;
begin
 select * into strict r from public.backfill_runs where run_id=p_run;
 if r.status<>'running' or r.notes->>'kind'<>'reconcile' or p_size not between 1 and 500 or p_size>(r.notes->>'batch')::integer then raise exception 'Invalid reconciliation page';end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') into result from (
  select c.id,coalesce(q.version,(select max(e.id) from public.person_change_events e where e.candidate_id=c.id),0) captured_version
  from public.candidates c left join public.person_change_queue q on q.candidate_id=c.id
  where (r.last_id is null or c.id>r.last_id)
   and (r.notes->>'scope'<>'queue' or exists(select 1 from public.person_reconcile_pending p where p.candidate_id=c.id)
    or exists(select 1 from public.person_reconcile_people p where p.run_id=p_run and p.candidate_id=c.id and not p.counted))
   and (r.notes->>'scope'<>'directory' or c.directory_contact_id is not null)
  order by c.id limit least(p_size,(r.notes->>'limit')::integer-r.processed)
 ) x;
 return result;
end $$;

create function public.person_reconcile_record_many(p_run text,p_items jsonb)
returns jsonb language plpgsql set search_path='' set lock_timeout='2s' set statement_timeout='20s' as $$
declare item jsonb; cid uuid; ver bigint; actual_ver bigint; rev bigint; state text; results jsonb:='[]';
begin
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Invalid record batch';end if;
 if (select count(distinct (i->>'candidate_id')::uuid) from jsonb_array_elements(p_items)i)<>jsonb_array_length(p_items) then raise exception 'Duplicate or missing candidate';end if;
 if not exists(select 1 from public.backfill_runs where run_id=p_run and status='running' and notes->>'kind'='reconcile') then raise exception 'Invalid reconciliation run';end if;
 perform pg_advisory_xact_lock_shared(72005,0);
 for item in select value from jsonb_array_elements(p_items) order by value->>'candidate_id' loop
  cid:=(item->>'candidate_id')::uuid;ver:=(item->>'version')::bigint;state:=item->>'status';
  if state not in ('verified','pending','review') or ver is null or ver<0 or nullif(item->>'source_hash','') is null or jsonb_typeof(item->'checks') is distinct from 'object' then raise exception 'Invalid reconciliation evidence';end if;
  perform pg_advisory_xact_lock(hashtext(cid::text));
  perform 1 from public.candidates where id=cid for key share;
  if not found then raise exception 'Candidate disappeared during reconciliation';end if;
  perform pg_advisory_xact_lock(72004,hashtext(cid::text));
  select coalesce((select version from public.person_change_queue where candidate_id=cid),(select max(e.id) from public.person_change_events e where e.candidate_id=cid),0) into actual_ver;
  select ps.rev into rev from public.candidate_profile_state ps where candidate_id=cid for update;
  if state='verified' then
   if item->'checks'->>'integrity_ok' is distinct from 'true' or item->'checks'->>'external_stable' is distinct from 'true' then raise exception 'Missing successful verification';end if;
   if rev is null or rev is distinct from (item->>'revision')::bigint or actual_ver<>ver then
    state:='pending';
   else
    perform public.person_backfill_flag_missing_employers(cid);
    update public.person_change_events set reconciled_at=coalesce(reconciled_at,clock_timestamp()) where candidate_id=cid and id<=ver;
    delete from public.person_change_queue where candidate_id=cid and version=ver;
   end if;
  end if;
  insert into public.person_reconcile_people(run_id,candidate_id,status,revision,captured_version,source_hash,checks)
  values(p_run,cid,state,(item->>'revision')::bigint,ver,item->>'source_hash',item->'checks')
  on conflict(run_id,candidate_id) do update set status=excluded.status,revision=excluded.revision,captured_version=excluded.captured_version,
   source_hash=excluded.source_hash,checks=excluded.checks,checked_at=clock_timestamp();
  results:=results||jsonb_build_array(jsonb_build_object('candidate_id',cid,'status',state));
 end loop;
 return results;
end $$;

create function public.person_reconcile_checkpoint(p_run text,p_ids jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare ids uuid[]; n integer; delta integer; last uuid; r public.backfill_runs%rowtype;
begin
 if jsonb_typeof(p_ids) is distinct from 'array' or jsonb_array_length(p_ids) not between 1 and 500 then raise exception 'Invalid checkpoint';end if;
 select array_agg(x::uuid) into ids from jsonb_array_elements_text(p_ids)x;
 select * into strict r from public.backfill_runs where run_id=p_run for update;
 if r.status<>'running' or r.notes->>'kind'<>'reconcile' then raise exception 'Invalid reconciliation run';end if;
 select count(*) into n from public.person_reconcile_people where run_id=p_run and candidate_id=any(ids);
 if n<>(select count(distinct x) from unnest(ids)x) then raise exception 'Cannot checkpoint unrecorded candidate';end if;
 update public.person_reconcile_people set counted=true where run_id=p_run and candidate_id=any(ids) and not counted;
 get diagnostics delta=row_count;
 select x into last from unnest(ids)x order by x desc limit 1;
 update public.backfill_runs set last_id=case when last_id is null or last>last_id then last else last_id end,processed=processed+delta
 where run_id=p_run returning * into r;
 return to_jsonb(r);
end $$;

create function public.person_reconcile_finish(p_run text,p_external_stable boolean)
returns jsonb language plpgsql set search_path='' set lock_timeout='2s' as $$
declare r public.backfill_runs%rowtype; missing bigint; pending bigint; reviews bigint; eligible bigint; state text; full_done boolean; anchor boolean;
begin
 -- A function-level SET cannot arm the current statement's timer. Require an
 -- already-bounded caller before acquiring gates that can briefly delay writes.
 if current_setting('statement_timeout')::interval<=interval '0 seconds' or current_setting('statement_timeout')::interval>interval '8 seconds' then
  raise exception 'active_statement_timeout_required';
 end if;
 perform pg_advisory_xact_lock(72005,0);
 perform pg_advisory_xact_lock(72006,0);
 select * into strict r from public.backfill_runs where run_id=p_run for update;
 if r.status not in ('running','paused') or r.notes->>'kind'<>'reconcile' then raise exception 'Invalid reconciliation run';end if;
 select count(*) into eligible from public.candidates;
 select count(*) into pending from public.person_change_queue;
 full_done:=r.notes->>'scope'='all' and not exists(select 1 from public.candidates where r.last_id is null or id>r.last_id);
 update public.backfill_runs set notes=notes||jsonb_build_object('full_scan_complete',full_done,'external_stable',p_external_stable) where run_id=p_run;
 select exists(select 1 from public.backfill_runs b where b.notes->>'kind'='reconcile' and b.notes->>'full_scan_complete'='true' and b.notes->>'external_stable'='true'
  and b.notes->>'external_hash' is not distinct from r.notes->>'external_hash') into anchor;
 -- The latest check must still match the normalized revision, across all scan runs.
 with latest as(select distinct on(candidate_id) candidate_id,status,revision from public.person_reconcile_people where counted order by candidate_id,checked_at desc,run_id desc)
 select count(*) filter(where l.status is distinct from 'verified' or l.revision is distinct from ps.rev),count(*) filter(where l.status='review') into missing,reviews
 from public.candidates c left join public.candidate_profile_state ps on ps.candidate_id=c.id left join latest l on l.candidate_id=c.id;
 state:=case when reviews>0 then 'review_required' when missing>0 or pending>0 or p_external_stable is distinct from true or not anchor then 'catchup_pending' else 'reconciled' end;
 update public.backfill_runs set status=state,finished_at=clock_timestamp(),notes=notes||jsonb_build_object('eligible',eligible,'unverified',missing,'unresolved_review',reviews,'queue_pending',pending,'external_stable',p_external_stable,'open_identity_conflicts',(select count(*) from public.identity_conflicts where status='open'))
 where run_id=p_run returning * into r;
 return to_jsonb(r);
end $$;

create function public.person_reconcile_v2_fingerprint()
returns jsonb language sql stable set search_path='' set statement_timeout='20s' as $$
 select jsonb_build_object('rows',count(*),'hash',md5(coalesce(string_agg(h,'' order by h),'')))
 from (select md5(to_jsonb(e)::text) h from public.candidate_emails_v2 e where exists(select 1 from public.candidates c where c.id=e.candidate_id)) x;
$$;

do $$ declare fn record;begin
 for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'person_reconcile_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
  execute format('grant execute on function %s to service_role',fn.signature);
 end loop;
end $$;
