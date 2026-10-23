-- Shadow migration support: never rewrites the live candidate representation.
set local lock_timeout='2s';
set local statement_timeout='30s';
create schema if not exists person_private;
revoke all on schema person_private from public,anon,authenticated;
grant usage on schema person_private to service_role;
create table public.person_change_events(
 id bigint generated always as identity primary key,
 candidate_id uuid not null references public.candidates(id) on delete cascade,
 source_table text not null,
 source_row_id text,
 operation text not null,
 recorded_at timestamptz not null default clock_timestamp(),
 payload jsonb not null,
 previous_payload jsonb,
 reconciled_at timestamptz
);
create index person_change_events_candidate_idx on public.person_change_events(candidate_id,id);
create table public.person_change_queue(
 candidate_id uuid primary key references public.candidates(id) on delete cascade,
 version bigint not null,
 changed_at timestamptz not null default clock_timestamp()
);
create table public.person_backfill_people(
 run_id text not null references public.backfill_runs(run_id),
 candidate_id uuid not null references public.candidates(id) on delete cascade,
 status text not null check(status in ('saved','audited','conflicted')),
 revision bigint not null,
 captured_version bigint not null default 0,
 source_hash text not null,
 counted boolean not null default false,
 checks jsonb,
 saved_at timestamptz not null default clock_timestamp(),
 audited_at timestamptz,
 primary key(run_id,candidate_id)
);
create index person_backfill_people_status_idx on public.person_backfill_people(run_id,status);
alter table public.person_change_events enable row level security;
alter table public.person_change_queue enable row level security;
alter table public.person_backfill_people enable row level security;
revoke all on public.person_change_events,public.person_change_queue,public.person_backfill_people from public,anon,authenticated;
revoke all on sequence public.person_change_events_id_seq from public,anon,authenticated;
grant all on public.person_change_events,public.person_change_queue,public.person_backfill_people to service_role;
grant usage,select on sequence public.person_change_events_id_seq to service_role;

-- Definer trigger is private so legacy callers need no new table grants.
-- Store only migration source evidence, omitting unrelated embeddings/notes.
create function person_private.capture_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare fresh jsonb; prior jsonb; row_data jsonb; cid uuid; event_id bigint; ids uuid[];
begin
 if tg_op<>'DELETE' then fresh:=to_jsonb(new); end if;
 if tg_op<>'INSERT' then prior:=to_jsonb(old); end if;
 if tg_table_name in ('website_applications','candidate_enrichments') then
  if fresh->>'organization_id' is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a' then fresh:=null; end if;
  if prior->>'organization_id' is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a' then prior:=null; end if;
 end if;
 row_data:=coalesce(fresh,prior);
 if row_data is null then return null; end if;
 if tg_table_name='candidates' then
  if tg_op='DELETE' then return null; end if;
  ids:=array[(row_data->>'id')::uuid];
 else
  select array_agg(distinct x order by x) into ids from unnest(array[
    (fresh->>'candidate_id')::uuid,(prior->>'candidate_id')::uuid]) x where x is not null;
 end if;
 foreach cid in array coalesce(ids,'{}'::uuid[]) loop
  -- Match the parent-row -> capture lock order used by candidate writers.
  -- Otherwise an application event's FK can deadlock with a locked candidate.
  perform 1 from public.candidates where id=cid for key share;
  if not found then continue; end if;
  perform pg_advisory_xact_lock(72004,hashtext(cid::text));
  insert into public.person_change_events(candidate_id,source_table,source_row_id,operation,payload,previous_payload)
  values(cid,tg_table_name,row_data->>'id',case when fresh is null then 'DELETE' when prior is null then 'INSERT' else 'UPDATE' end,
    row_data - array['resume_embedding','matching_embedding','resume_text','notes'],
    prior - array['resume_embedding','matching_embedding','resume_text','notes']) returning id into event_id;
  insert into public.person_change_queue(candidate_id,version) values(cid,event_id)
  on conflict(candidate_id) do update set version=excluded.version,changed_at=clock_timestamp();
 end loop;
 return null;
end $$;
revoke all on function person_private.capture_change() from public,anon,authenticated;
do $$ declare tbl text; begin
 foreach tbl in array array['candidates','candidate_emails','candidate_enrichments','website_applications','candidate_communications'] loop
  execute format('create trigger person_capture_change after insert or update or delete on public.%I for each row execute function person_private.capture_change()',tbl);
 end loop;
end $$;

create function public.person_backfill_pilot_ids(p_limit integer) returns setof uuid
language sql stable set search_path='' as $$
 with choices as (
  (select id,9 priority from public.candidates order by id limit least(p_limit,5000))
  union all (select id,1 from public.candidates where source in ('directory','airtable_sync') order by id limit 200)
  union all (select candidate_id,1 from public.website_applications where organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a' and candidate_id is not null order by created_at desc limit 100)
  union all (select candidate_id,2 from public.candidate_enrichments where organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a' and provider='harvest' and status='ok' and candidate_id is not null order by created_at desc limit 200)
  union all (select candidate_id,2 from public.candidate_emails where quality in ('bad','invalid') or result in ('invalid','bounced') order by id limit 100)
  union all (select candidate_id,2 from public.network_matches where organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a' order by candidate_id limit 100)
 ) select x.id from choices x join public.candidates c on c.id=x.id group by x.id order by min(priority),x.id limit least(p_limit,5000);
$$;
create table public.person_backfill_targets(
 run_id text not null references public.backfill_runs(run_id),
 candidate_id uuid not null references public.candidates(id) on delete cascade,
 primary key(run_id,candidate_id)
);
alter table public.person_backfill_targets enable row level security;
revoke all on public.person_backfill_targets from public,anon,authenticated;
grant all on public.person_backfill_targets to service_role;

create function public.person_backfill_start(p_run text,p_commit text,p_parser text,p_limit integer,p_batch integer,p_resume boolean,p_cohort text default 'all')
returns jsonb language plpgsql set search_path='' as $$
declare r public.backfill_runs%rowtype;
begin
 if p_run !~ '^[a-zA-Z0-9_-]{1,100}$' or p_commit is null or p_parser<>'person-v3'
   or p_cohort not in ('all','pilot') or (p_cohort='pilot' and p_limit>5000)
   or p_limit not between 1 and 1000000 or p_batch not between 1 and 500 then
  raise exception 'Invalid pinned backfill configuration';
 end if;
 select * into r from public.backfill_runs where run_id=p_run for update;
 if found then
  if not p_resume then raise exception 'Run exists; explicit resume required'; end if;
  if r.notes->>'commit'<>p_commit or r.notes->>'parser'<>p_parser or (r.notes->>'limit')::int<>p_limit or (r.notes->>'batch')::int<>p_batch or r.notes->>'cohort'<>p_cohort then
   raise exception 'Pinned run configuration differs';
  end if;
  update public.backfill_runs set status='running',finished_at=null where run_id=p_run;
 else
  if p_resume then raise exception 'Cannot resume a missing run'; end if;
  insert into public.backfill_runs(run_id,pass,processed,conflicts,status,started_at,notes)
  values(p_run,'shadow',0,0,'running',clock_timestamp(),jsonb_build_object('commit',p_commit,'parser',p_parser,'limit',p_limit,'batch',p_batch,'database_bytes_start',pg_database_size(current_database()),'capture','database-trigger','cohort',p_cohort));
  if p_cohort='pilot' then insert into public.person_backfill_targets(run_id,candidate_id) select p_run,id from public.person_backfill_pilot_ids(p_limit) id; end if;
 end if;
 select * into r from public.backfill_runs where run_id=p_run;
 return to_jsonb(r);
end $$;

create function public.person_backfill_page(p_run text,p_size integer)
returns jsonb language plpgsql stable set search_path='' as $$
declare r public.backfill_runs%rowtype; result jsonb;
begin
 select * into strict r from public.backfill_runs where run_id=p_run;
 if r.status<>'running' or p_size not between 1 and 500 or p_size>(r.notes->>'batch')::int then raise exception 'Invalid run/page'; end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') into result from (
  select c.id,coalesce(q.version,0) as captured_version
  from public.candidates c left join public.person_change_queue q on q.candidate_id=c.id
  where (r.last_id is null or c.id>r.last_id)
   and (r.notes->>'cohort'='all' or exists(select 1 from public.person_backfill_targets t where t.run_id=p_run and t.candidate_id=c.id))
  order by c.id limit least(p_size,(r.notes->>'limit')::int-r.processed)
 ) x;
 return result;
end $$;

create function public.person_backfill_preview_page(p_after uuid,p_size integer,p_directory_only boolean default false,p_cohort text default 'all',p_limit integer default 5000)
returns jsonb language plpgsql stable set search_path='' as $$
declare result jsonb;
begin
 if p_size not between 1 and 500 then raise exception 'Invalid page size'; end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') into result from (
  select c.id,coalesce(q.version,0) as captured_version
  from public.candidates c left join public.person_change_queue q on q.candidate_id=c.id
  where (p_after is null or c.id>p_after) and (not p_directory_only or c.directory_contact_id is not null)
   and (p_cohort='all' or c.id in (select public.person_backfill_pilot_ids(p_limit)))
  order by c.id limit p_size
 ) x;
 return result;
end $$;

create function public.person_backfill_save(p_run text,p_candidate uuid,p_docs jsonb,p_version bigint)
returns jsonb language plpgsql set search_path='' set statement_timeout='20s' set lock_timeout='2s' as $$
declare r public.backfill_runs%rowtype; d jsonb; result jsonb; results jsonb:='[]'; rev bigint;
begin
 select * into strict r from public.backfill_runs where run_id=p_run;
 if r.status<>'running' or jsonb_typeof(p_docs)<>'array' or jsonb_array_length(p_docs)=0 then raise exception 'Invalid run/documents'; end if;
 for d in select value from jsonb_array_elements(p_docs) loop
  if (d->>'candidate_id')::uuid<>p_candidate or d->'source'->>'parser_version'<>r.notes->>'parser' then raise exception 'Document identity/parser differs from run'; end if;
  result:=public.save_person(d);
  results:=results||jsonb_build_array(result);
 end loop;
 select ps.rev into strict rev from public.candidate_profile_state ps where ps.candidate_id=p_candidate;
 insert into public.person_backfill_people(run_id,candidate_id,status,revision,captured_version,source_hash)
 values(p_run,p_candidate,'saved',rev,p_version,md5(p_docs::text))
 on conflict(run_id,candidate_id) do update set status='saved',revision=excluded.revision,captured_version=excluded.captured_version,source_hash=excluded.source_hash,saved_at=clock_timestamp(),audited_at=null;
 return jsonb_build_object('revision',rev,'results',results);
end $$;

create function public.person_backfill_audit(p_run text,p_candidate uuid,p_revision bigint,p_version bigint,p_checks jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare rev bigint; n integer;
begin
 select ps.rev into strict rev from public.candidate_profile_state ps where candidate_id=p_candidate for update;
 if rev<>p_revision then raise exception 'Person changed during audit; reread required'; end if;
 select count(*) into n from public.identity_conflicts where status='open' and p_candidate=any(candidate_ids);
 update public.person_backfill_people set status=case when n>0 then 'conflicted' else 'audited' end,
  checks=p_checks||jsonb_build_object('open_conflicts',n),audited_at=clock_timestamp()
 where run_id=p_run and candidate_id=p_candidate and revision=p_revision and captured_version=p_version;
 if not found then raise exception 'Audit has no matching saved revision'; end if;
 -- Queue evidence is deliberately retained until a separate source reconciliation
 -- confirms every intervening event, rather than treating a baseline copy as catch-up.
 return jsonb_build_object('revision',rev,'open_conflicts',n);
end $$;

create function public.person_backfill_checkpoint(p_run text,p_ids jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_ids uuid[]; n integer; newly_counted integer; conflicts integer; last uuid; r public.backfill_runs%rowtype;
begin
 if jsonb_typeof(p_ids)<>'array' then raise exception 'Invalid checkpoint IDs'; end if;
 select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(p_ids) x;
 select * into strict r from public.backfill_runs where run_id=p_run for update;
 if r.status<>'running' or cardinality(v_ids) not between 1 and 500 then raise exception 'Invalid checkpoint'; end if;
 select count(*),count(*) filter(where status='conflicted') into n,conflicts from public.person_backfill_people
 where run_id=p_run and candidate_id=any(v_ids) and status in ('audited','conflicted');
 if n<>(select count(distinct x) from unnest(v_ids) x) then raise exception 'Cannot checkpoint an unaudited candidate'; end if;
 update public.person_backfill_people set counted=true where run_id=p_run and candidate_id=any(v_ids) and not counted;
 get diagnostics newly_counted=row_count;
 select x into last from unnest(v_ids) x order by x desc limit 1;
 update public.backfill_runs set last_id=case when last_id is null or last>last_id then last else last_id end,
  processed=processed+newly_counted,
  conflicts=(select count(*) from public.person_backfill_people where run_id=p_run and status='conflicted' and counted)
 where run_id=p_run returning * into r;
 return to_jsonb(r);
end $$;

create function public.person_backfill_status(p_run text,p_status text,p_notes jsonb default '{}')
returns jsonb language plpgsql set search_path='' as $$
declare r public.backfill_runs%rowtype;
begin
 if p_status not in ('running','paused','baseline_complete','failed') then raise exception 'Invalid status'; end if;
 update public.backfill_runs set status=p_status,notes=notes||p_notes,
  finished_at=case when p_status='baseline_complete' then clock_timestamp() else null end
 where run_id=p_run returning * into r;
 if not found then raise exception 'Missing run'; end if;
 return to_jsonb(r);
end $$;

create function public.person_backfill_metrics() returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('database_bytes',pg_database_size(current_database()),
  'active_sessions',(select count(*) from pg_stat_activity where state='active'),
  'blocked_sessions',(select count(*) from pg_stat_activity where wait_event_type='Lock'),
  'queue_pending',(select count(*) from public.person_change_queue),
  'captured_events',(select count(*) from public.person_change_events));
$$;

do $$ declare fn record; begin
 for fn in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname like 'person_backfill_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
  execute format('grant execute on function %s to service_role',fn.signature);
 end loop;
end $$;
