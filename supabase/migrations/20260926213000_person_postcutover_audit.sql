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
 counts jsonb not null default '{}' check (jsonb_typeof(counts)='object'),
 notes jsonb not null default '{}' check (jsonb_typeof(notes)='object'),
 started_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 finished_at timestamptz
);
create table public.person_postcutover_audit_results (
 run_id text not null references public.person_postcutover_audit_runs(run_id),
 candidate_id uuid not null references public.candidates(id) on delete restrict,
 status text not null check (status in ('verified','pending','review')),
 reason text,
 boundary jsonb not null check (jsonb_typeof(boundary)='object'),
 lookup_ids text[] not null default '{}',
 checks jsonb not null default '{}' check (jsonb_typeof(checks)='object'),
 snapshot_hash text,
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

-- 3. The lookup witness: a hash over the exact lookup columns the integrity
--    checker reads, for the lookup rows a person's normalized rows reference.
create function person_private.postcutover_lookup_witness(p_candidate uuid) returns text
language sql stable set search_path='' as $$
 select md5(coalesce(string_agg(h, '|' order by h), ''))
 from (
  select 'companies:'||c.id||':'||md5(jsonb_build_object('id',c.id,'name',c.name,'linkedin_id',c.linkedin_id,'linkedin_username',c.linkedin_username,'linkedin_url',c.linkedin_url,'logo_url',c.logo_url,'normalized_name',c.normalized_name,'linkedin_url_normalized',c.linkedin_url_normalized,'identity_basis',c.identity_basis,'is_placeholder',c.is_placeholder,'tier',c.tier,'tier_list_version',c.tier_list_version,'merged_into',c.merged_into,'created_from',c.created_from)::text) h
  from public.candidate_experiences e join public.companies c on c.id=e.company_id
  where e.candidate_id=p_candidate and e.source='person' and e.removed_at is null
  union
  select 'schools:'||s.id||':'||md5(to_jsonb(s)::text)
  from public.candidate_educations ed join public.schools s on s.id=ed.school_id
  where ed.candidate_id=p_candidate and ed.removed_at is null
  union
  select 'skills:'||k.id||':'||md5(to_jsonb(k)::text)
  from public.candidate_skills cs join public.skills k on k.id=cs.skill_id
  where cs.candidate_id=p_candidate and cs.removed_at is null
 ) x;
$$;
revoke all on function person_private.postcutover_lookup_witness(uuid) from public, anon, authenticated;
grant execute on function person_private.postcutover_lookup_witness(uuid) to service_role;

-- 4. The compact boundary, computed exactly as the snapshot reader builds its
--    `boundary`, plus the lookup witness. Record and finalize compare against it.
create function person_private.postcutover_boundary(p_candidate uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare links uuid[]; epochs jsonb; candidate_epoch bigint; version bigint; revision bigint; anchor text;
begin
 select array_agg(contact_id order by contact_id) into links from (
  select distinct contact_id from (
   select c.directory_contact_id contact_id from public.candidates c where c.id=p_candidate
   union all select contact_id from public.person_directory_receipts where candidate_id=p_candidate
   union all select directory_contact_id from public.person_directory_primary where candidate_id=p_candidate
  ) u where contact_id is not null order by contact_id limit 201
 ) x;
 select count(*) into candidate_epoch from (select 1 from public.person_audit_epochs where scope_kind='candidate' and scope_key=p_candidate::text limit 10001) x;
 select coalesce(jsonb_agg(jsonb_build_object('contact_id',d,'epoch',n::text) order by d),'[]') into epochs from unnest(links) d
  cross join lateral (select count(*) n from (select 1 from public.person_audit_epochs where scope_kind='directory' and scope_key=d::text limit 10001) x) e;
 select coalesce(max(id),0) into version from public.person_change_events where candidate_id=p_candidate;
 select rev into revision from public.candidate_profile_state where candidate_id=p_candidate;
 select anchor_hash into anchor from public.person_audit_anchors where candidate_id=p_candidate;
 return jsonb_build_object('anchor_hash',anchor,'revision',revision::text,'capture',version::text,
  'candidate_epoch',candidate_epoch::text,'directory_epochs',epochs,
  'lookup_witness',person_private.postcutover_lookup_witness(p_candidate));
end $$;
revoke all on function person_private.postcutover_boundary(uuid) from public, anon, authenticated;
grant execute on function person_private.postcutover_boundary(uuid) to service_role;

-- 5. Snapshot plus witness in ONE stable statement, so the planner's inputs and
--    the witness come from the same database snapshot.
create function public.person_postcutover_audit_inputs_with_witness(p_ids jsonb) returns jsonb
language plpgsql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare result jsonb;
begin
 if current_setting('statement_timeout')::interval<=interval '0 seconds' or current_setting('statement_timeout')::interval>interval '15 seconds' then raise exception 'audit_statement_timeout';end if;
 if jsonb_typeof(p_ids) is distinct from 'array' or jsonb_array_length(p_ids) not between 1 and 20
  or (select count(distinct value::uuid) from jsonb_array_elements_text(p_ids))<>jsonb_array_length(p_ids) then raise exception 'audit_batch';end if;
 select jsonb_agg(person_private.postcutover_snapshot(value::uuid)||jsonb_build_object('lookup_witness',person_private.postcutover_lookup_witness(value::uuid)) order by value::uuid)
  into result from jsonb_array_elements_text(p_ids);
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
  if r.commit_sha<>p_commit or r.scope<>p_scope or r.batch<>p_batch then raise exception 'audit_run_config_differs';end if;
  if r.status not in ('running','paused','failed') then raise exception 'audit_run_finished';end if;
  update public.person_postcutover_audit_runs set status='running',updated_at=clock_timestamp() where run_id=p_run;
 else
  if p_resume then raise exception 'audit_run_missing';end if;
  insert into public.person_postcutover_audit_runs(run_id,status,commit_sha,scope,batch) values (p_run,'running',p_commit,p_scope,p_batch);
 end if;
 select * into r from public.person_postcutover_audit_runs where run_id=p_run;
 return to_jsonb(r);
end $$;

create function public.person_postcutover_audit_page(p_run text,p_after uuid,p_limit integer) returns jsonb
language plpgsql stable set search_path='' as $$
declare r public.person_postcutover_audit_runs%rowtype; result jsonb;
begin
 select * into r from public.person_postcutover_audit_runs where run_id=p_run;
 if not found or r.status<>'running' or p_limit not between 1 and r.batch then raise exception 'audit_run_page';end if;
 if r.scope='all' then
  select coalesce(jsonb_agg(id order by id),'[]') into result from (select id from public.candidates where p_after is null or id>p_after order by id limit p_limit) x;
 else
  select coalesce(jsonb_agg(id order by id),'[]') into result from (
   select c.id from public.candidates c left join public.person_postcutover_audit_results x on x.run_id=p_run and x.candidate_id=c.id
   where (p_after is null or c.id>p_after) and (x.candidate_id is null or x.status<>'verified') order by c.id limit p_limit) y;
 end if;
 return result;
end $$;

-- record_many: rechecks each person's compact boundary under the writer and
-- capture gates (shared), then stores the planner's outcome; a moved boundary
-- is stored as pending/boundary_moved so the person is revisited.
create function public.person_postcutover_audit_record_many(p_run text,p_items jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare r public.person_postcutover_audit_runs%rowtype; item jsonb; cid uuid; current jsonb; st text; rs text; out jsonb:='[]'; ids text[];
begin
 if current_setting('statement_timeout')::interval<=interval '0 seconds' or current_setting('statement_timeout')::interval>interval '15 seconds' then raise exception 'audit_statement_timeout';end if;
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'audit_isolation';end if;
 select * into r from public.person_postcutover_audit_runs where run_id=p_run for share;
 if not found or r.status<>'running' then raise exception 'audit_run_page';end if;
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 20 then raise exception 'audit_batch';end if;
 select array_agg(x->>'candidate_id') into ids from jsonb_array_elements(p_items) x;
 if (select count(distinct v) from unnest(ids) v)<>jsonb_array_length(p_items) then raise exception 'audit_batch';end if;
 perform pg_advisory_xact_lock_shared(72005,0);
 perform pg_advisory_xact_lock_shared(72006,0);
 for item in select x from jsonb_array_elements(p_items) x loop
  cid:=(item->>'candidate_id')::uuid;
  if item->>'status' not in ('verified','pending','review') or jsonb_typeof(item->'boundary') not in ('object','null')
   or jsonb_typeof(coalesce(item->'checks','{}'))<>'object' or jsonb_typeof(coalesce(item->'lookup_ids','[]'))<>'array' then raise exception 'audit_item';end if;
  if not exists(select 1 from public.candidates where id=cid) then raise exception 'audit_candidate_missing';end if;
  current:=person_private.postcutover_boundary(cid);
  -- A review reached before any boundary existed (no anchor, snapshot not
  -- ready) is stored as review at the current boundary. Verified and pending
  -- outcomes must have been planned at exactly the current boundary.
  if jsonb_typeof(item->'boundary')='null' then
   if item->>'status'<>'review' then raise exception 'audit_item';end if;
   st:='review'; rs:=item->>'reason';
  elsif current=item->'boundary' then st:=item->>'status'; rs:=item->>'reason';
  else st:='pending'; rs:='boundary_moved'; end if;
  insert into public.person_postcutover_audit_results(run_id,candidate_id,status,reason,boundary,lookup_ids,checks,snapshot_hash)
  values (p_run,cid,st,rs,current,coalesce((select array_agg(v) from jsonb_array_elements_text(coalesce(item->'lookup_ids','[]')) v),'{}'),coalesce(item->'checks','{}'),item->>'snapshot_hash')
  on conflict (run_id,candidate_id) do update set status=excluded.status,reason=excluded.reason,boundary=excluded.boundary,lookup_ids=excluded.lookup_ids,checks=excluded.checks,snapshot_hash=excluded.snapshot_hash,checked_at=clock_timestamp();
  out:=out||jsonb_build_object('candidate_id',cid,'status',st,'reason',rs);
 end loop;
 return out;
end $$;

create function public.person_postcutover_audit_checkpoint(p_run text,p_last_id uuid,p_status text,p_notes jsonb default '{}') returns jsonb
language plpgsql set search_path='' as $$
declare r public.person_postcutover_audit_runs%rowtype;
begin
 if p_status not in ('running','paused','failed') or jsonb_typeof(p_notes)<>'object' then raise exception 'audit_run_status';end if;
 update public.person_postcutover_audit_runs set last_id=p_last_id,status=p_status,notes=notes||p_notes,updated_at=clock_timestamp(),
  counts=(select coalesce(jsonb_object_agg(status,n),'{}') from (select status,count(*) n from public.person_postcutover_audit_results where run_id=p_run group by status) x)
  where run_id=p_run and status in ('running','paused','failed') returning * into r;
 if not found then raise exception 'audit_run_page';end if;
 return to_jsonb(r);
end $$;

-- finalize: exclusive writer gate then capture gate, then only reads. Every
-- current candidate must hold a verified result at its current boundary; a
-- directory or lookup marker committed after the check makes it stale.
create function public.person_postcutover_audit_finalize(p_run text,p_external_stable boolean) returns jsonb
language plpgsql set search_path='' set lock_timeout='2s' as $$
declare r public.person_postcutover_audit_runs%rowtype; eligible bigint; unverified bigint; reviews bigint; stale bigint; dir_stale bigint; lookup_stale bigint; holds bigint; dir_pending bigint; conflicts bigint; state text;
begin
 if current_setting('statement_timeout')::interval<=interval '0 seconds' or current_setting('statement_timeout')::interval>interval '8 seconds' then raise exception 'audit_statement_timeout';end if;
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'audit_isolation';end if;
 perform pg_advisory_xact_lock(72005,0);
 perform pg_advisory_xact_lock(72006,0);
 select * into r from public.person_postcutover_audit_runs where run_id=p_run for update;
 if not found or r.status not in ('running','paused') then raise exception 'audit_run_finished';end if;
 select count(*) into eligible from public.candidates;
 with res as (select * from public.person_postcutover_audit_results where run_id=p_run),
  cap as (select candidate_id,max(id) capture from public.person_change_events group by candidate_id),
  ep as (select scope_key,count(*) n from public.person_audit_epochs where scope_kind='candidate' group by scope_key),
  cur as (select c.id,a.anchor_hash,s.rev,coalesce(cap.capture,0) capture,coalesce(ep.n,0) epoch
          from public.candidates c left join public.person_audit_anchors a on a.candidate_id=c.id left join public.candidate_profile_state s on s.candidate_id=c.id
          left join cap on cap.candidate_id=c.id left join ep on ep.scope_key=c.id::text)
 select count(*) filter (where res.candidate_id is null or res.status<>'verified'),
        count(*) filter (where res.status='review'),
        count(*) filter (where res.status='verified' and (res.boundary->>'anchor_hash' is distinct from cur.anchor_hash or res.boundary->>'revision' is distinct from cur.rev::text
                         or res.boundary->>'capture' is distinct from cur.capture::text or res.boundary->>'candidate_epoch' is distinct from cur.epoch::text))
  into unverified,reviews,stale from cur left join res on res.candidate_id=cur.id;
 select count(distinct res.candidate_id) into dir_stale from public.person_postcutover_audit_results res
  cross join lateral jsonb_array_elements(coalesce(res.boundary->'directory_epochs','[]')) d
  join public.person_audit_epochs e on e.scope_kind='directory' and e.scope_key=d->>'contact_id' and e.created_at>res.checked_at
  where res.run_id=p_run and res.status='verified';
 select count(distinct res.candidate_id) into lookup_stale from public.person_postcutover_audit_results res
  cross join lateral unnest(res.lookup_ids) l
  join public.person_postcutover_lookup_epochs le on (le.table_name||':'||le.row_id)=l and le.created_at>res.checked_at
  where res.run_id=p_run and res.status='verified';
 select count(*) into holds from public.person_source_holds where resolved_at is null;
 select count(*) into dir_pending from public.person_directory_state s left join public.person_directory_receipts rc on rc.id=s.latest_receipt_id
  where s.applied_receipt_id is distinct from s.latest_receipt_id or rc.phase in ('ready','review');
 select count(*) into conflicts from public.identity_conflicts where status='open';
 state:=case when reviews>0 then 'review_required'
             when unverified>0 or stale>0 or dir_stale>0 or lookup_stale>0 or holds>0 or dir_pending>0 or p_external_stable is distinct from true then 'catchup_pending'
             else 'audited' end;
 update public.person_postcutover_audit_runs set status=state,finished_at=clock_timestamp(),updated_at=clock_timestamp(),
  counts=(select coalesce(jsonb_object_agg(status,n),'{}') from (select status,count(*) n from public.person_postcutover_audit_results where run_id=p_run group by status) x),
  notes=notes||jsonb_build_object('eligible',eligible,'unverified',unverified,'unresolved_review',reviews,'stale',stale,'directory_stale',dir_stale,'lookup_stale',lookup_stale,
   'source_date_holds',holds,'directory_pending',dir_pending,'open_identity_conflicts',conflicts,'external_stable',p_external_stable,'finalized_at',clock_timestamp())
  where run_id=p_run returning * into r;
 return to_jsonb(r);
end $$;

do $$ declare fn record;begin
 for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'person_postcutover_audit_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
  execute format('grant execute on function %s to service_role',fn.signature);
 end loop;
end $$;
