-- PREPARED ONLY. The separate post-cutover auditor's durable accounting: run and
-- result tables, a lookup-change witness, timed record and finalize RPCs.
-- Nothing here writes a candidate, a source, a receipt, a capture row or an
-- epoch marker of the existing kinds. Historical runners are unchanged.
set local lock_timeout='2s';
set local statement_timeout='30s';

-- 1. Accounting tables (service role only).
create table public.person_postcutover_audit_runs (
 run_id text primary key check (run_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
 status text not null check (status in ('running','paused','failed','audited','review_required','catchup_pending')),
 commit_sha text not null,
 parser_version text not null default 'person-v3',
 scope text not null check (scope in ('all','pending')),
 batch integer not null check (batch between 1 and 20),
 last_id uuid,
 pass integer not null default 1,
 scan_complete boolean not null default false,
 external_start jsonb,
 external_end jsonb,
 counts jsonb not null default '{}' check (jsonb_typeof(counts)='object'),
 notes jsonb not null default '{}' check (jsonb_typeof(notes)='object'),
 started_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 finished_at timestamptz
);
create table public.person_postcutover_audit_results (
 run_id text not null references public.person_postcutover_audit_runs(run_id),
 candidate_id uuid not null, -- Keep evidence without acquiring candidate locks after gates.
 status text not null check (status in ('verified','pending','review')),
 reason text,
 boundary jsonb not null check (jsonb_typeof(boundary)='object'),
 lookup_ids text[] not null default '{}',
 checks jsonb not null default '{}' check (jsonb_typeof(checks)='object'),
 snapshot_hash text,
 external_hash text,
 checked_at timestamptz not null default clock_timestamp(),
 primary key (run_id, candidate_id)
);
create index person_postcutover_audit_results_status_idx on public.person_postcutover_audit_results(run_id, status);
alter table public.person_postcutover_audit_runs enable row level security;
alter table public.person_postcutover_audit_results enable row level security;
revoke all on public.person_postcutover_audit_runs, public.person_postcutover_audit_results from public, anon, authenticated;
grant all on public.person_postcutover_audit_runs, public.person_postcutover_audit_results to service_role;

-- 2. Shared lookup rows (companies, schools, skills) affect checked facts and
--    projections without touching a candidate's own revision or capture. Keep
--    append-only markers so record and finalize can see a lookup change after
--    a person was checked. Markers are deduplicated per row and transaction.
create table public.person_postcutover_lookup_epochs (
 table_name text not null check (table_name in ('companies','schools','skills')),
 row_id text not null,
 transaction_id xid8 not null default pg_current_xact_id(),
 created_at timestamptz not null default clock_timestamp(),
 primary key (table_name, row_id, transaction_id)
);
create index person_postcutover_lookup_epochs_time_idx on public.person_postcutover_lookup_epochs(created_at);
alter table public.person_postcutover_lookup_epochs enable row level security;
revoke all on public.person_postcutover_lookup_epochs from public, anon, authenticated, service_role;
grant select on public.person_postcutover_lookup_epochs to service_role;
create trigger person_audit_immutable before update or delete on public.person_postcutover_lookup_epochs
  for each row execute function person_private.audit_immutable();
create function person_private.postcutover_lookup_epoch() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 -- Same capture gate as the receipt epoch markers: finalize takes it exclusively.
 perform pg_advisory_xact_lock_shared(72006,0);
 if tg_op <> 'DELETE' then
  insert into public.person_postcutover_lookup_epochs(table_name,row_id) values (tg_table_name,(to_jsonb(new)->>'id')) on conflict do nothing;
 end if;
 if tg_op <> 'INSERT' then
  insert into public.person_postcutover_lookup_epochs(table_name,row_id) values (tg_table_name,(to_jsonb(old)->>'id')) on conflict do nothing;
 end if;
 return null;
end $$;
revoke all on function person_private.postcutover_lookup_epoch() from public, anon, authenticated;
create trigger person_postcutover_lookup_epoch after insert or update or delete on public.companies for each row execute function person_private.postcutover_lookup_epoch();
create trigger person_postcutover_lookup_epoch after insert or update or delete on public.schools for each row execute function person_private.postcutover_lookup_epoch();
create trigger person_postcutover_lookup_epoch after insert or update or delete on public.skills for each row execute function person_private.postcutover_lookup_epoch();

-- 3. One set-based boundary calculation for a bounded record or the full final
-- population. Count COMMITTED markers: timestamp / max-xid comparisons miss
-- transactions which began earlier and committed after a reader's snapshot.
create function person_private.postcutover_boundaries(p_ids uuid[] default null)
returns table(candidate_id uuid,boundary jsonb)
language sql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
 with people as materialized (
  select c.id,c.directory_contact_id from public.candidates c where p_ids is null
  union all select c.id,c.directory_contact_id from unnest(p_ids) u(id) join public.candidates c on c.id=u.id where p_ids is not null
 ),
 cap as (select e.candidate_id,max(e.id) n from public.person_change_events e join people p on p.id=e.candidate_id group by e.candidate_id),
 ep as (select e.scope_key,count(*) n from public.person_audit_epochs e where e.scope_kind='candidate' and exists(select 1 from people p where p.id::text=e.scope_key) group by e.scope_key),
 links as materialized (
  select id, directory_contact_id contact_id from people where directory_contact_id is not null
  union select r.candidate_id,r.contact_id from public.person_directory_receipts r join people p on p.id=r.candidate_id
  union select r.candidate_id,r.directory_contact_id from public.person_directory_primary r join people p on p.id=r.candidate_id
 ),
 de as (select e.scope_key,count(*) n from public.person_audit_epochs e where e.scope_kind='directory' and exists(select 1 from links l where l.contact_id::text=e.scope_key) group by e.scope_key),
 dirs as (select l.id,jsonb_agg(jsonb_build_object('contact_id',l.contact_id,'epoch',coalesce(de.n,0)::text) order by l.contact_id) proof
  from links l left join de on de.scope_key=l.contact_id::text group by l.id),
 lookup_links as materialized (
  select distinct e.candidate_id,'companies' t,e.company_id::text rid from public.candidate_experiences e join people p on p.id=e.candidate_id where e.source='person' and e.company_id is not null
  union select e.candidate_id,'schools',e.school_id::text from public.candidate_educations e join people p on p.id=e.candidate_id where e.school_id is not null
  union select e.candidate_id,'skills',e.skill_id::text from public.candidate_skills e join people p on p.id=e.candidate_id
 ),
 lookup_rows as materialized (
  select 'companies' t,c.id::text rid,md5(jsonb_build_object('id',c.id,'name',c.name,'linkedin_id',c.linkedin_id,'linkedin_username',c.linkedin_username,'linkedin_url',c.linkedin_url,'logo_url',c.logo_url,'normalized_name',c.normalized_name,'linkedin_url_normalized',c.linkedin_url_normalized,'identity_basis',c.identity_basis,'is_placeholder',c.is_placeholder,'tier',c.tier,'tier_list_version',c.tier_list_version,'merged_into',c.merged_into,'created_from',c.created_from)::text) h from public.companies c where c.id = any(array(select l.rid::uuid from lookup_links l where l.t='companies'))
  union all select 'schools',x.id::text,md5(to_jsonb(x)::text) from public.schools x where x.id = any(array(select l.rid::uuid from lookup_links l where l.t='schools'))
  union all select 'skills',x.id::text,md5(to_jsonb(x)::text) from public.skills x where x.id = any(array(select l.rid::bigint from lookup_links l where l.t='skills'))
 ),
 le as (select e.table_name,e.row_id,count(*) n from public.person_postcutover_lookup_epochs e where exists(select 1 from lookup_links l where l.t=e.table_name and l.rid=e.row_id) group by e.table_name,e.row_id),
 lookups as (select l.candidate_id,
  md5(string_agg(l.t||':'||l.rid||':'||coalesce(r.h,'missing'),'|' order by l.t,l.rid)) witness,
  jsonb_agg(jsonb_build_object('key',l.t||':'||l.rid,'epoch',coalesce(le.n,0)::text) order by l.t,l.rid) epochs
  from lookup_links l left join lookup_rows r on r.t=l.t and r.rid=l.rid left join le on le.table_name=l.t and le.row_id=l.rid group by l.candidate_id)
 select p.id,jsonb_build_object('anchor_hash',a.anchor_hash,'revision',st.rev::text,'capture',coalesce(cap.n,0)::text,
  'candidate_epoch',coalesce(ep.n,0)::text,'directory_epochs',coalesce(dirs.proof,'[]'),
  'lookup_witness',coalesce(lookups.witness,md5('')),'lookup_epochs',coalesce(lookups.epochs,'[]'))
 from people p left join public.person_audit_anchors a on a.candidate_id=p.id left join public.candidate_profile_state st on st.candidate_id=p.id
 left join cap on cap.candidate_id=p.id left join ep on ep.scope_key=p.id::text left join dirs on dirs.id=p.id left join lookups on lookups.candidate_id=p.id;
$$;
revoke all on function person_private.postcutover_boundaries(uuid[]) from public,anon,authenticated;
grant execute on function person_private.postcutover_boundaries(uuid[]) to service_role;

create function person_private.postcutover_boundary(p_candidate uuid) returns jsonb
language sql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
 select boundary from person_private.postcutover_boundaries(array[p_candidate]);
$$;
revoke all on function person_private.postcutover_boundary(uuid) from public,anon,authenticated;
grant execute on function person_private.postcutover_boundary(uuid) to service_role;

-- A run's external observation must cover all current candidate, receipt,
-- primary and staged directory-state links (including unassigned contacts).
-- Website-only, read-only metadata. COMMS is observed by the CLI separately.
create function public.person_postcutover_audit_external_inputs() returns jsonb
language sql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
 with links as materialized (
  select jsonb_build_array('candidate',c.id,c.directory_contact_id)::text k,c.directory_contact_id contact_id from public.candidates c
  union select jsonb_build_array('receipt',r.workspace_id,r.contact_id,r.candidate_id)::text,r.contact_id from public.person_directory_receipts r
  union select jsonb_build_array('primary',p.candidate_id,p.directory_contact_id)::text,p.directory_contact_id from public.person_directory_primary p
  union select jsonb_build_array('state',d.workspace_id,d.contact_id)::text,d.contact_id from public.person_directory_state d
 ), contacts as (select distinct contact_id from links where contact_id is not null),
 v2 as (select md5(to_jsonb(e)::text) h from public.candidate_emails_v2 e where exists(select 1 from public.candidates c where c.id=e.candidate_id))
 select jsonb_build_object('scope_hash',(select md5(coalesce(string_agg(k,'|' order by k),'')) from links),
  'contact_ids',(select coalesce(jsonb_agg(contact_id order by contact_id),'[]') from contacts),
  'contact_count',(select count(*) from contacts),
  'v2_hash',(select md5(coalesce(string_agg(h,'|' order by h),'')) from v2),'v2_rows',(select count(*) from v2));
$$;

-- 5. Snapshot plus witness in ONE stable statement, so the planner's inputs and
--    the witness come from the same database snapshot.
create function public.person_postcutover_audit_inputs_with_witness(p_ids jsonb) returns jsonb
language plpgsql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare result jsonb; snapshots jsonb; ready_ids uuid[]; boundary_rows jsonb:='{}';
begin
 if current_setting('statement_timeout')::interval<=interval '0 seconds' or current_setting('statement_timeout')::interval>interval '15 seconds' then raise exception 'audit_statement_timeout';end if;
 if jsonb_typeof(p_ids) is distinct from 'array' or jsonb_array_length(p_ids) not between 1 and 20
  or (select count(distinct value::uuid) from jsonb_array_elements_text(p_ids))<>jsonb_array_length(p_ids) then raise exception 'audit_batch';end if;
 select jsonb_agg(person_private.postcutover_snapshot(value::uuid) order by value) into snapshots from jsonb_array_elements_text(p_ids);
 select array_agg((x->>'candidate_id')::uuid) into ready_ids from jsonb_array_elements(snapshots)x where x->>'status'='ready';
 if cardinality(ready_ids)>0 then
  select jsonb_object_agg(candidate_id,boundary) into boundary_rows from person_private.postcutover_boundaries(ready_ids);
 end if;
 select jsonb_agg(case when octet_length(j::text)>8000000 then jsonb_build_object('candidate_id',id,'status','review','reason','snapshot_size_limit') else j end order by id)
 into result from (
  select x->>'candidate_id' id,case when x->>'status'<>'ready' then x else
   x||jsonb_build_object('boundary',boundary_rows->(x->>'candidate_id'),'lookup_witness',boundary_rows->(x->>'candidate_id')->>'lookup_witness',
    'expected_contact_ranks',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'new_rank',r.new_rank::text) order by r.id),'[]') from public.person_contact_ranks((x->>'candidate_id')::uuid) r)) end j
  from jsonb_array_elements(snapshots)x
 ) q;
 return result;
end $$;
revoke all on function public.person_postcutover_audit_inputs_with_witness(jsonb) from public, anon, authenticated;
grant execute on function public.person_postcutover_audit_inputs_with_witness(jsonb) to service_role;

-- 6. Run lifecycle.
create function public.person_postcutover_audit_start(p_run text,p_commit text,p_scope text,p_batch integer,p_resume boolean) returns jsonb
language plpgsql set search_path='' as $$
declare r public.person_postcutover_audit_runs%rowtype;
begin
 if p_run !~ '^[a-zA-Z0-9_-]{1,100}$' or p_commit is null or p_scope not in ('all','pending') or p_batch not between 1 and 20 then raise exception 'audit_run_config';end if;
 select * into r from public.person_postcutover_audit_runs where run_id=p_run for update;
 if found then
  if not p_resume then raise exception 'audit_run_exists';end if;
  if r.commit_sha<>p_commit or r.batch<>p_batch or (r.scope='pending' and p_scope='all') then raise exception 'audit_run_config_differs';end if;
  if r.status='audited' then raise exception 'audit_run_finished';end if;
  if p_scope='pending' and (r.scope='all' or r.scan_complete or r.status in ('review_required','catchup_pending')) then
   update public.person_postcutover_audit_runs set scope='pending',pass=pass+1,last_id=null,scan_complete=false,external_start=null,external_end=null,finished_at=null where run_id=p_run;
  elsif r.status in ('review_required','catchup_pending') then raise exception 'audit_pending_pass_required';end if;
  update public.person_postcutover_audit_runs set status='running',updated_at=clock_timestamp() where run_id=p_run;
 else
  if p_resume then raise exception 'audit_run_missing';end if;
  insert into public.person_postcutover_audit_runs(run_id,status,commit_sha,scope,batch) values (p_run,'running',p_commit,p_scope,p_batch);
 end if;
 select * into r from public.person_postcutover_audit_runs where run_id=p_run;
 return to_jsonb(r);
end $$;

-- A pending pass examines a bounded UUID window even if it produces zero
-- audit items. Return its scan cursor separately; LIMIT after a correlated
-- whole-pool stale filter would otherwise hide unbounded work.
create function public.person_postcutover_audit_page(p_run text,p_after uuid,p_limit integer,p_pass integer default 1) returns jsonb
language plpgsql stable set search_path='' as $$
declare r public.person_postcutover_audit_runs%rowtype; ids uuid[]; checked_ids uuid[]; wanted jsonb; current_rows jsonb:='{}';
begin
 select * into r from public.person_postcutover_audit_runs where run_id=p_run;
 if not found or r.status<>'running' or p_limit not between 1 and r.batch then raise exception 'audit_run_page';end if;
 if r.pass is distinct from p_pass then raise exception 'audit_run_pass';end if;
 select coalesce(array_agg(id order by id),'{}') into ids from (select id from public.candidates where p_after is null or id>p_after order by id limit p_limit)x;
 if r.scope='all' then wanted:=to_jsonb(ids);
 else
  select array_agg(x.candidate_id) into checked_ids from public.person_postcutover_audit_results x
   where x.run_id=p_run and x.candidate_id=any(ids) and x.status='verified' and x.external_hash is not distinct from r.external_start->>'hash';
  if cardinality(checked_ids)>0 then select jsonb_object_agg(candidate_id,boundary) into current_rows from person_private.postcutover_boundaries(checked_ids);end if;
  select coalesce(jsonb_agg(cid order by cid),'[]') into wanted from unnest(ids)cid
   left join public.person_postcutover_audit_results x on x.run_id=p_run and x.candidate_id=cid
   where x.candidate_id is null or x.status<>'verified' or x.boundary is distinct from current_rows->cid::text or x.external_hash is distinct from r.external_start->>'hash';
 end if;
 return jsonb_build_object('ids',wanted,'after',coalesce(ids[cardinality(ids)],p_after),'examined',cardinality(ids),'exhausted',cardinality(ids)<p_limit);
end $$;

-- record_many: rechecks each person's compact boundary under the writer and
-- capture gates (exclusive), then stores the planner's outcome; a moved boundary
-- is stored as pending/boundary_moved so the person is revisited.
create function public.person_postcutover_audit_record_many(p_run text,p_items jsonb,p_pass integer default 1) returns jsonb
language plpgsql volatile set search_path='' set timezone='UTC' set datestyle='ISO,YMD' set lock_timeout='2s' as $$
declare r public.person_postcutover_audit_runs%rowtype; item jsonb; cid uuid; current jsonb; st text; rs text; out jsonb:='[]'; ids text[]; boundaries jsonb;
begin
 if current_setting('statement_timeout')::interval<=interval '0 seconds' or current_setting('statement_timeout')::interval>interval '15 seconds' then raise exception 'audit_statement_timeout';end if;
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'audit_isolation';end if;
 perform pg_advisory_xact_lock(72005,0);
 perform pg_advisory_xact_lock(72006,0);
 select * into r from public.person_postcutover_audit_runs where run_id=p_run for update;
 if not found or r.status<>'running' then raise exception 'audit_run_page';end if;
 if r.pass is distinct from p_pass then raise exception 'audit_run_pass';end if;
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 20 then raise exception 'audit_batch';end if;
 select array_agg(x->>'candidate_id') into ids from jsonb_array_elements(p_items) x;
 if (select count(distinct v) from unnest(ids) v)<>jsonb_array_length(p_items) then raise exception 'audit_batch';end if;
 select array_agg(x->>'candidate_id') into ids from jsonb_array_elements(p_items)x where jsonb_typeof(x->'boundary')='object';
 if cardinality(ids)>0 then select jsonb_object_agg(candidate_id,boundary) into boundaries from person_private.postcutover_boundaries(ids::uuid[]);end if;
 for item in select x from jsonb_array_elements(p_items) x loop
  cid:=(item->>'candidate_id')::uuid;
  if item->>'status' is null or item->>'status' not in ('verified','pending','review') or (jsonb_typeof(item->'boundary') is null or jsonb_typeof(item->'boundary') not in ('object','null'))
   or jsonb_typeof(coalesce(item->'checks','{}'))<>'object' or jsonb_typeof(coalesce(item->'lookup_ids','[]'))<>'array' then raise exception 'audit_item';end if;
  if not exists(select 1 from public.candidates where id=cid) then raise exception 'audit_candidate_missing';end if;
  current:=coalesce(boundaries->cid::text,'{}'::jsonb);
  -- A review reached before any boundary existed (no anchor, snapshot not
  -- ready) stays a compact review without evaluating oversized collections. Verified and pending
  -- outcomes must have been planned at exactly the current boundary.
  if jsonb_typeof(item->'boundary')='null' then
   if item->>'status'<>'review' then raise exception 'audit_item';end if;
   st:='review'; rs:=item->>'reason';
  elsif current=item->'boundary' then st:=item->>'status'; rs:=item->>'reason';
  else st:='pending'; rs:='boundary_moved'; end if;
  insert into public.person_postcutover_audit_results(run_id,candidate_id,status,reason,boundary,lookup_ids,checks,snapshot_hash,external_hash)
  values (p_run,cid,st,rs,current,coalesce((select array_agg(v) from jsonb_array_elements_text(coalesce(item->'lookup_ids','[]')) v),'{}'),coalesce(item->'checks','{}'),item->>'snapshot_hash',r.external_start->>'hash')
  on conflict (run_id,candidate_id) do update set status=excluded.status,reason=excluded.reason,boundary=excluded.boundary,lookup_ids=excluded.lookup_ids,checks=excluded.checks,snapshot_hash=excluded.snapshot_hash,external_hash=excluded.external_hash,checked_at=clock_timestamp();
  out:=out||jsonb_build_object('candidate_id',cid,'status',st,'reason',rs);
 end loop;
 return out;
end $$;

create function public.person_postcutover_audit_checkpoint(p_run text,p_last_id uuid,p_status text,p_notes jsonb default '{}',p_pass integer default 1) returns jsonb
language plpgsql set search_path='' as $$
declare r public.person_postcutover_audit_runs%rowtype;
begin
 if p_status not in ('running','paused','failed') or jsonb_typeof(p_notes)<>'object' then raise exception 'audit_run_status';end if;
 select * into r from public.person_postcutover_audit_runs where run_id=p_run for update;
 if not found or r.pass is distinct from p_pass then raise exception 'audit_run_pass';end if;
 update public.person_postcutover_audit_runs set last_id=greatest(last_id,p_last_id),status=p_status,notes=notes||p_notes,scan_complete=coalesce((p_notes->>'scan_complete')::boolean,scan_complete),updated_at=clock_timestamp(),
  counts=(select coalesce(jsonb_object_agg(status,n),'{}') from (select status,count(*) n from public.person_postcutover_audit_results where run_id=p_run group by status) x)
  where run_id=p_run and status in ('running','paused','failed') returning * into r;
 if not found then raise exception 'audit_run_page';end if;
 return to_jsonb(r);
end $$;

-- Observations are bound to this run's current pass. Repeated resumes retain the
-- original start; only a complete pass can attach an end. The observation is
-- evidence from a read-only CLI, never an operator-provided stability boolean.
create function public.person_postcutover_audit_observe(p_run text,p_phase text,p_observation jsonb,p_pass integer default 1) returns jsonb
language plpgsql volatile set search_path='' as $$
declare r public.person_postcutover_audit_runs%rowtype;
begin
 select * into r from public.person_postcutover_audit_runs where run_id=p_run for update;
 if not found or r.status not in ('running','paused') or p_phase not in ('start','end') or jsonb_typeof(p_observation)<>'object' then raise exception 'audit_observation';end if;
 if r.pass is distinct from p_pass then raise exception 'audit_run_pass';end if;
 if p_observation->>'complete' is null then raise exception 'audit_observation';end if;
 if p_observation->>'complete'='true' and (
  coalesce(p_observation->>'hash','') !~ '^[a-f0-9]{64}$' or coalesce(p_observation->>'scope_hash','') !~ '^[a-f0-9]{32}$'
  or coalesce(p_observation->>'v2_hash','') !~ '^[a-f0-9]{32}$' or coalesce(p_observation->>'contact_count','') !~ '^[0-9]+$'
  or coalesce(p_observation->>'v2_rows','') !~ '^[0-9]+$') then raise exception 'audit_observation';end if;
 if p_phase='start' then
  if r.external_start is null then
   update public.person_postcutover_audit_runs set external_start=p_observation||jsonb_build_object('pass',pass,'recorded_at',clock_timestamp()),external_end=null where run_id=p_run;
  end if;
 else
  if not r.scan_complete or r.external_start is null then raise exception 'audit_observation_order';end if;
  update public.person_postcutover_audit_runs set external_end=p_observation||jsonb_build_object('pass',pass,'recorded_at',clock_timestamp()) where run_id=p_run;
 end if;
 select * into r from public.person_postcutover_audit_runs where run_id=p_run;return to_jsonb(r);
end $$;

-- Finalize takes gates 72005 -> 72006 -> run row, then only reads business rows.
-- All comparisons are grouped over the pool; no per-person function loop.
create function public.person_postcutover_audit_finalize(p_run text,p_pass integer default 1) returns jsonb
language plpgsql volatile set search_path='' set timezone='UTC' set datestyle='ISO,YMD' set lock_timeout='2s' as $$
declare r public.person_postcutover_audit_runs%rowtype; eligible bigint; unverified bigint; reviews bigint; stale bigint; dir_stale bigint; lookup_stale bigint; holds bigint; dir_pending bigint; conflicts bigint; state text; external_stable boolean; ext jsonb;
begin
 if current_setting('statement_timeout')::interval<=interval '0 seconds' or current_setting('statement_timeout')::interval>interval '8 seconds' then raise exception 'audit_statement_timeout';end if;
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'audit_isolation';end if;
 perform pg_advisory_xact_lock(72005,0);
 perform pg_advisory_xact_lock(72006,0);
 select * into r from public.person_postcutover_audit_runs where run_id=p_run for update;
 if not found or r.status not in ('running','paused') then raise exception 'audit_run_finished';end if;
 if r.pass is distinct from p_pass then raise exception 'audit_run_pass';end if;
 with res as materialized(select * from public.person_postcutover_audit_results where run_id=p_run),
 cur as materialized (select * from person_private.postcutover_boundaries(array(select candidate_id from res where status='verified')))
 select count(*),count(*) filter(where res.candidate_id is null or res.status<>'verified'),count(*) filter(where res.status='review'),
  count(*) filter(where res.status='verified' and (res.external_hash is distinct from r.external_start->>'hash' or res.boundary-array['directory_epochs','lookup_epochs','lookup_witness'] is distinct from cur.boundary-array['directory_epochs','lookup_epochs','lookup_witness'])),
  count(*) filter(where res.status='verified' and res.boundary->'directory_epochs' is distinct from cur.boundary->'directory_epochs'),
  count(*) filter(where res.status='verified' and (res.boundary->'lookup_epochs' is distinct from cur.boundary->'lookup_epochs' or res.boundary->>'lookup_witness' is distinct from cur.boundary->>'lookup_witness'))
 into eligible,unverified,reviews,stale,dir_stale,lookup_stale from public.candidates c left join res on res.candidate_id=c.id left join cur on cur.candidate_id=c.id;
 select count(*) into holds from public.person_source_holds where resolved_at is null;
 select count(*) into dir_pending from public.person_directory_state s left join public.person_directory_receipts rc on rc.id=s.latest_receipt_id
  where s.applied_receipt_id is distinct from s.latest_receipt_id or rc.phase in ('ready','review');
 select count(*) into conflicts from public.identity_conflicts where status='open';
 ext:=public.person_postcutover_audit_external_inputs();
 external_stable:=coalesce(r.scan_complete and r.external_start->>'complete'='true' and r.external_end->>'complete'='true'
  and r.external_start->>'pass'=r.pass::text and r.external_end->>'pass'=r.pass::text
  and r.external_start->>'hash'=r.external_end->>'hash'
  and r.external_start->>'scope_hash'=r.external_end->>'scope_hash' and r.external_end->>'scope_hash'=ext->>'scope_hash'
  and r.external_start->>'v2_hash'=r.external_end->>'v2_hash' and r.external_end->>'v2_hash'=ext->>'v2_hash'
  and r.external_end->>'contact_count'=ext->>'contact_count' and r.external_end->>'v2_rows'=ext->>'v2_rows',false);
 state:=case when reviews>0 then 'review_required'
  when unverified>0 or stale>0 or dir_stale>0 or lookup_stale>0 or holds>0 or dir_pending>0 or not external_stable then 'catchup_pending' else 'audited' end;
 update public.person_postcutover_audit_runs set status=state,finished_at=clock_timestamp(),updated_at=clock_timestamp(),
  counts=(select coalesce(jsonb_object_agg(status,n),'{}') from (select status,count(*) n from public.person_postcutover_audit_results where run_id=p_run group by status) x),
  notes=notes||jsonb_build_object('eligible',eligible,'unverified',unverified,'unresolved_review',reviews,'stale',stale,'directory_stale',dir_stale,'lookup_stale',lookup_stale,
   'source_date_holds',holds,'directory_pending',dir_pending,'open_identity_conflicts',conflicts,'external_stable',external_stable,'finalized_at',clock_timestamp())
  where run_id=p_run returning * into r;
 return to_jsonb(r);
end $$;

do $$ declare fn record;begin
 for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'person_postcutover_audit_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
  execute format('grant execute on function %s to service_role',fn.signature);
 end loop;
end $$;
