-- Audit finalizer inside a held maintenance window (release remediation, 2026-10-22).
-- public.person_postcutover_audit_finalize compares every current candidate with the run's recorded
-- results in one statement while holding the writer and capture gates; it requires the caller's
-- statement_timeout to be at most 8 s so that live candidate writers are never delayed longer. On
-- production that statement needs about 2.5 minutes for 437,037 people (boundaries of 349,269
-- verified people 97 s, the comparison 137 s in total), measured read-only on 2026-10-22, so the
-- finalizer cannot run on the live controller.
--
-- The controller already has the mechanism for long maintenance that must not meet live writers:
-- a held phase with an explicit, leased, reason-coded maintenance window (catchup, anchors). This
-- forward adds the step `audit_finalize`:
--   * maintenance_prefix/maintenance_work know the step; maintenance_open admits it only while the
--     controller is held, with no unresolved work (deferred work is resolved, as 20260928090000
--     patched into the live definition; that patched check is carried verbatim here), for an audit
--     run that exists, is running or paused and has completed its scan;
--   * person_postcutover_audit_finalize keeps every check and every gate; only its bound changes:
--     8 s as before outside a window, the window's maximum (240 minutes) when the transaction holds
--     an `audit_finalize` frame;
--   * person_postcutover_audit_finalize_window(run, pass) enters the frame (maintenance_enter), runs
--     the unchanged finalizer and leaves the frame, exactly as the catch-up wrappers do.
-- No grant is widened: the wrapper is revoked from public, anon and authenticated like the other
-- maintenance entry points; the operator CLI reaches it over the 5432 session endpoint.

-- The step name joins the two check constraints exactly as 20260928050000 added `publish`.
alter table person_private.maintenance_frames drop constraint maintenance_frames_step_check;
alter table person_private.maintenance_frames add constraint maintenance_frames_step_check check(step in ('catchup','anchors','publish','audit_finalize'));
alter table person_private.maintenance_events drop constraint maintenance_events_step_check;
alter table person_private.maintenance_events add constraint maintenance_events_step_check check(step in ('catchup','anchors','publish','audit_finalize'));

create or replace function person_private.maintenance_prefix(p_step text,p_run text) returns text language plpgsql immutable set search_path='' as $$
begin
 if p_step is null or p_step not in ('catchup','anchors','publish','audit_finalize') or p_run is null or p_run !~ '^[A-Za-z0-9_-]{1,100}$' then raise exception 'maintenance_input';end if;
 return 'maintenance:'||p_step||':'||p_run||':';
end$$;

create or replace function person_private.maintenance_open(p_step text,p_run text,p_minutes integer,p_revision bigint,p_generation bigint,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c person_private.transition_control;w person_private.transition_work;prefix text;n integer;max_minutes integer;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'maintenance_isolation';end if;
 prefix:=person_private.maintenance_prefix(p_step,p_run);
 max_minutes:=case when p_step='publish' then 720 else 240 end;
 if p_minutes is null or p_minutes<1 or p_minutes>max_minutes or p_reason is null or p_reason !~ '^[a-z0-9_]{1,80}$' then raise exception 'maintenance_input';end if;
 perform pg_advisory_xact_lock(72005,0);
 select * into strict c from person_private.transition_control where singleton for update;
 if p_revision is distinct from c.revision or p_generation is distinct from c.generation then raise exception 'transition_stale';end if;
 if p_step='publish' then
  -- Other admitted writers keep running; only one maintenance window at a time.
  if not c.enabled or c.phase<>'open' then raise exception 'maintenance_requires_open';end if;
  if exists(select 1 from person_private.transition_work where scope='tt_person' and family='maintenance' and status<>'completed') then raise exception 'transition_unresolved';end if;
  -- The publish CLI creates its run on start, so the window is opened first for the run ID it will use.
  if exists(select 1 from public.person_publish_runs where run_id=p_run and (mode<>'publish' or status not in ('running','paused','failed'))) then raise exception 'maintenance_run';end if;
 else
  if not c.enabled or c.phase<>'held' then raise exception 'maintenance_requires_held';end if;
  if exists(select 1 from person_private.transition_work where scope='tt_person' and status not in ('completed','deferred')) then raise exception 'transition_unresolved';end if;
  if p_step='catchup' and not exists(select 1 from public.backfill_runs where run_id=p_run and status='running' and notes->>'kind'='reconcile'
   and notes->>'commit'='c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc') then raise exception 'maintenance_run';end if;
  if p_step='audit_finalize' and not exists(select 1 from public.person_postcutover_audit_runs where run_id=p_run and status in ('running','paused') and scan_complete) then raise exception 'maintenance_run';end if;
 end if;
 select count(*) into n from person_private.transition_work where scope='tt_person' and family='maintenance' and left(resource_key,length(prefix))=prefix;
 insert into person_private.maintenance_control_frames values(pg_backend_pid(),pg_current_xact_id());
 insert into person_private.transition_work(organization_id,scope,family,resource_key,input_hash,token_hash,generation,lease_until)
 values('801865a7-6533-41d2-9c45-e4a90e6ad51a','tt_person','maintenance',prefix||(n+1),
  encode(sha256(convert_to(p_step||':'||p_run,'UTF8')),'hex'),md5(gen_random_uuid()::text),c.generation,
  clock_timestamp()+make_interval(mins=>p_minutes)) returning * into w;
 insert into person_private.maintenance_events(work_id,action,step,run_id,controller_revision,generation,reason_code)
 values(w.id,'open',p_step,p_run,c.revision,c.generation,p_reason);
 delete from person_private.maintenance_control_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 return jsonb_build_object('status','open','work_id',w.id,'step',p_step,'run',p_run,'generation',w.generation,'lease_until',w.lease_until);
end$$;


create or replace function person_private.maintenance_work(p_step text,p_run text) returns person_private.transition_work
language plpgsql security definer set search_path='' as $$
declare c person_private.transition_control;w person_private.transition_work;
begin
 c:=person_private.transition_lock();
 if p_step='publish' then
  if not c.enabled or c.phase<>'open' then raise exception 'maintenance_requires_open';end if;
 elsif not c.enabled or c.phase<>'held' then raise exception 'maintenance_requires_held';end if;
 if p_step in ('catchup','publish','audit_finalize') then
  select * into w from person_private.transition_work where scope='tt_person' and family='maintenance' and status='active'
   and generation=c.generation and lease_until>clock_timestamp() and left(resource_key,length(person_private.maintenance_prefix(p_step,p_run)))=person_private.maintenance_prefix(p_step,p_run)
   for share;
 elsif p_step='anchors' and p_run is null then
  select * into w from person_private.transition_work where scope='tt_person' and family='maintenance' and status='active'
   and generation=c.generation and lease_until>clock_timestamp() and left(resource_key,length('maintenance:anchors:'))='maintenance:anchors:'
   for share;
 else raise exception 'maintenance_input';end if;
 if w.id is null then raise exception 'maintenance_admission';end if;
 return w;
end$$;


create or replace function public.person_postcutover_audit_finalize(p_run text,p_pass integer default 1) returns jsonb
language plpgsql volatile set search_path='' set timezone='UTC' set datestyle='ISO,YMD' set lock_timeout='2s' as $$
declare r public.person_postcutover_audit_runs%rowtype; eligible bigint; unverified bigint; reviews bigint; stale bigint; dir_stale bigint; lookup_stale bigint; holds bigint; dir_pending bigint; conflicts bigint; state text; external_stable boolean; ext jsonb;
begin
 -- A bounded caller is required. Outside a maintenance window the bound is 8 s: the gates taken below
 -- delay live candidate writers. Inside an open `audit_finalize` window the controller is held, so no
 -- live writer can be delayed, and the bound is the window's maximum (240 minutes); production's
 -- full-population comparison measured about 2.5 minutes (437,037 people, 2026-10-22).
 if person_private.maintenance_frame_present('audit_finalize') then
  if current_setting('statement_timeout')::interval<=interval '0 seconds' or current_setting('statement_timeout')::interval>interval '240 minutes' then raise exception 'audit_statement_timeout';end if;
 elsif current_setting('statement_timeout')::interval<=interval '0 seconds' or current_setting('statement_timeout')::interval>interval '8 seconds' then raise exception 'audit_statement_timeout';end if;
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'audit_isolation';end if;
 perform pg_advisory_xact_lock(72005,0);
 perform pg_advisory_xact_lock(72006,0);
 select * into r from public.person_postcutover_audit_runs where run_id=p_run for update;
 if not found or r.status not in ('running','paused') then raise exception 'audit_run_finished';end if;
 if r.pass is distinct from p_pass then raise exception 'audit_run_pass';end if;
 with res as materialized(select * from public.person_postcutover_audit_results where run_id=p_run),
 cur as materialized (select * from person_private.postcutover_boundaries(array(select candidate_id from res where status='verified')))
 select count(*),count(*) filter(where res.candidate_id is null or res.status<>'verified'),count(*) filter(where res.status='review'),
  count(*) filter(where res.status='verified' and (res.checks->'reference_version' is distinct from '1'::jsonb or res.external_hash is distinct from r.external_start->>'hash' or res.boundary-array['directory_epochs','lookup_epochs','lookup_witness'] is distinct from cur.boundary-array['directory_epochs','lookup_epochs','lookup_witness'])),
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


create function public.person_postcutover_audit_finalize_window(p_run text,p_pass integer default 1) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' set datestyle='ISO,YMD' set lock_timeout='2s' as $$
declare opened boolean;result jsonb;
begin
 opened:=person_private.maintenance_enter('audit_finalize',p_run);
 result:=public.person_postcutover_audit_finalize(p_run,p_pass);
 perform person_private.maintenance_leave(opened);
 return result;
end$$;
revoke all on function public.person_postcutover_audit_finalize_window(text,integer) from public,anon,authenticated;
