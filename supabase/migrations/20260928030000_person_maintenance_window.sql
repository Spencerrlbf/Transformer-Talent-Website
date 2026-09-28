-- PREPARED ONLY. Operator maintenance windows while the controller is armed and held.
-- A window admits exactly one runbook step: the pinned historical catch-up for one
-- named run ID, or audit anchor commits. It opens no raw table writes; only the
-- existing run-bearing RPCs open a frame, and only while their window is active.
-- Publication, undo and source-hold resolution are not admitted here.
set local lock_timeout='2s';set local statement_timeout='30s';

-- Frames live for one transaction and are removed before commit.
create table person_private.maintenance_control_frames(
 backend_pid integer not null,transaction_id xid8 not null,primary key(backend_pid,transaction_id));
create table person_private.maintenance_frames(
 backend_pid integer not null,transaction_id xid8 not null,
 work_id uuid not null references person_private.transition_work(id),
 step text not null check(step in ('catchup','anchors')),run_id text,
 primary key(backend_pid,transaction_id));
create table person_private.maintenance_normalization_frames(
 backend_pid integer not null,transaction_id xid8 not null,
 work_id uuid not null references person_private.transition_work(id),
 candidate_id uuid not null,document jsonb not null,
 primary key(backend_pid,transaction_id));
-- Append-only operator history.
create table person_private.maintenance_events(
 id bigint generated always as identity primary key,
 work_id uuid not null references person_private.transition_work(id),
 action text not null check(action in ('open','close')),
 step text not null check(step in ('catchup','anchors')),run_id text not null,
 controller_revision bigint not null,generation bigint not null,
 reason_code text not null check(reason_code ~ '^[a-z0-9_]{1,80}$'),
 occurred_at timestamptz not null default clock_timestamp());
do $$declare t text;begin foreach t in array array['maintenance_control_frames','maintenance_frames','maintenance_normalization_frames','maintenance_events'] loop
 execute format('alter table person_private.%I enable row level security',t);
 execute format('revoke all on person_private.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
revoke all on sequence person_private.maintenance_events_id_seq from public,anon,authenticated,service_role;
create function person_private.maintenance_events_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'maintenance_events_immutable';end$$;
create trigger maintenance_events_immutable before update or delete on person_private.maintenance_events
 for each row execute function person_private.maintenance_events_immutable();
create trigger maintenance_events_no_truncate before truncate on person_private.maintenance_events
 for each statement execute function person_private.maintenance_events_immutable();

-- Maintenance work rows can be created or changed only by open/close below.
create function person_private.maintenance_work_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (tg_op<>'DELETE' and new.family='maintenance') or (tg_op<>'INSERT' and old.family='maintenance') then
  if not exists(select 1 from person_private.maintenance_control_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then
   raise exception 'maintenance_admission_required';
  end if;
 end if;
 return coalesce(new,old);
end$$;
create trigger maintenance_work_guard before insert or update or delete on person_private.transition_work
 for each row execute function person_private.maintenance_work_guard();

-- No frame may survive its transaction.
create function person_private.maintenance_frame_cleanup() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from person_private.maintenance_control_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
  exists(select 1 from person_private.maintenance_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
  exists(select 1 from person_private.maintenance_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
 then raise exception 'maintenance_frame_cleanup';end if;
 return null;
end$$;
create constraint trigger maintenance_control_cleanup after insert on person_private.maintenance_control_frames
 deferrable initially deferred for each row execute function person_private.maintenance_frame_cleanup();
create constraint trigger maintenance_frame_cleanup after insert on person_private.maintenance_frames
 deferrable initially deferred for each row execute function person_private.maintenance_frame_cleanup();
create constraint trigger maintenance_normalization_cleanup after insert on person_private.maintenance_normalization_frames
 deferrable initially deferred for each row execute function person_private.maintenance_frame_cleanup();

create function person_private.maintenance_prefix(p_step text,p_run text) returns text language plpgsql immutable set search_path='' as $$
begin
 if p_step is null or p_step not in ('catchup','anchors') or p_run is null or p_run !~ '^[A-Za-z0-9_-]{1,100}$' then raise exception 'maintenance_input';end if;
 return 'maintenance:'||p_step||':'||p_run||':';
end$$;

-- Operator-only: not granted to any API role.
create function person_private.maintenance_open(p_step text,p_run text,p_minutes integer,p_revision bigint,p_generation bigint,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c person_private.transition_control;w person_private.transition_work;prefix text;n integer;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'maintenance_isolation';end if;
 prefix:=person_private.maintenance_prefix(p_step,p_run);
 if p_minutes is null or p_minutes not between 1 and 240 or p_reason is null or p_reason !~ '^[a-z0-9_]{1,80}$' then raise exception 'maintenance_input';end if;
 perform pg_advisory_xact_lock(72005,0);
 select * into strict c from person_private.transition_control where singleton for update;
 if p_revision is distinct from c.revision or p_generation is distinct from c.generation then raise exception 'transition_stale';end if;
 if not c.enabled or c.phase<>'held' then raise exception 'maintenance_requires_held';end if;
 if exists(select 1 from person_private.transition_work where scope='tt_person' and status<>'completed') then raise exception 'transition_unresolved';end if;
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
-- Exclusive 72005 waits for every in-flight maintenance transaction to finish.
create function person_private.maintenance_close(p_work uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c person_private.transition_control;w person_private.transition_work;step text;run text;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'maintenance_isolation';end if;
 if p_work is null or p_reason is null or p_reason !~ '^[a-z0-9_]{1,80}$' then raise exception 'maintenance_input';end if;
 perform pg_advisory_xact_lock(72005,0);
 select * into strict c from person_private.transition_control where singleton for share;
 select * into w from person_private.transition_work where id=p_work and scope='tt_person' and family='maintenance' for update;
 if not found then raise exception 'maintenance_unknown';end if;
 if w.status='completed' then return jsonb_build_object('status','closed','work_id',w.id);end if;
 select e.step,e.run_id into step,run from person_private.maintenance_events e where e.work_id=w.id and e.action='open';
 insert into person_private.maintenance_control_frames values(pg_backend_pid(),pg_current_xact_id());
 update person_private.transition_work set status='completed',finished_at=clock_timestamp() where id=w.id;
 insert into person_private.maintenance_events(work_id,action,step,run_id,controller_revision,generation,reason_code)
 values(w.id,'close',step,run,c.revision,c.generation,p_reason);
 delete from person_private.maintenance_control_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 return jsonb_build_object('status','closed','work_id',w.id);
end$$;

-- The active window for a step (and, for catch-up, the exact run). Held only.
create function person_private.maintenance_work(p_step text,p_run text) returns person_private.transition_work
language plpgsql security definer set search_path='' as $$
declare c person_private.transition_control;w person_private.transition_work;
begin
 c:=person_private.transition_lock();
 if not c.enabled or c.phase<>'held' then raise exception 'maintenance_requires_held';end if;
 if p_step='catchup' then
  select * into w from person_private.transition_work where scope='tt_person' and family='maintenance' and status='active'
   and generation=c.generation and lease_until>clock_timestamp() and left(resource_key,length(person_private.maintenance_prefix('catchup',p_run)))=person_private.maintenance_prefix('catchup',p_run)
   for share;
 elsif p_step='anchors' and p_run is null then
  select * into w from person_private.transition_work where scope='tt_person' and family='maintenance' and status='active'
   and generation=c.generation and lease_until>clock_timestamp() and left(resource_key,length('maintenance:anchors:'))='maintenance:anchors:'
   for share;
 else raise exception 'maintenance_input';end if;
 if w.id is null then raise exception 'maintenance_admission';end if;
 return w;
end$$;
create function person_private.maintenance_frame(p_step text) returns person_private.maintenance_frames
language plpgsql security definer set search_path='' as $$
declare f person_private.maintenance_frames;w person_private.transition_work;
begin
 select * into f from person_private.maintenance_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if f.backend_pid is null or f.step is distinct from p_step then raise exception 'maintenance_frame';end if;
 w:=person_private.maintenance_work(f.step,f.run_id);
 if w.id<>f.work_id then raise exception 'maintenance_frame';end if;
 return f;
end$$;
create function person_private.maintenance_frame_present(p_step text) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from person_private.maintenance_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and step=p_step)
$$;
-- Entry points call this first. Disabled: no frame, unchanged behavior. Armed:
-- requires the step's active window while held; nested calls reuse the frame.
create function person_private.maintenance_enter(p_step text,p_run text) returns boolean
language plpgsql security definer set search_path='' as $$
declare f person_private.maintenance_frames;w person_private.transition_work;
begin
 if not person_private.normalization_gate() then return false;end if;
 select * into f from person_private.maintenance_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if f.backend_pid is not null then
  if f.step is distinct from p_step or f.run_id is distinct from p_run then raise exception 'maintenance_nested';end if;
  perform person_private.maintenance_frame(p_step);return false;
 end if;
 w:=person_private.maintenance_work(p_step,p_run);
 insert into person_private.maintenance_frames values(pg_backend_pid(),pg_current_xact_id(),w.id,p_step,p_run);
 return true;
end$$;
create function person_private.maintenance_leave(p_opened boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_opened then
  delete from person_private.maintenance_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
  if exists(select 1 from person_private.maintenance_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'maintenance_frame_cleanup';end if;
 end if;
end$$;

-- A catch-up save inside the run's frame: one document, one normalization frame.
create function person_private.maintenance_save_person(doc jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare f person_private.maintenance_frames;result jsonb;
begin
 f:=person_private.maintenance_frame('catchup');
 if doc->>'candidate_id' is null or doc->>'candidate_id' !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then raise exception 'maintenance_document';end if;
 if exists(select 1 from person_private.normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
  exists(select 1 from person_private.directory_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
  exists(select 1 from person_private.refresh_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
  exists(select 1 from person_private.recruiter_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
  exists(select 1 from person_private.maintenance_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
 then raise exception 'normalization_nested';end if;
 insert into person_private.maintenance_normalization_frames values(pg_backend_pid(),pg_current_xact_id(),f.work_id,(doc->>'candidate_id')::uuid,doc);
 result:=person_private.save_person_core(doc);
 perform person_private.maintenance_frame('catchup');
 delete from person_private.maintenance_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 return result;
end$$;
create function person_private.maintenance_normalization_check(m person_private.maintenance_normalization_frames) returns void
language plpgsql security definer set search_path='' as $$
declare f person_private.maintenance_frames;
begin
 f:=person_private.maintenance_frame('catchup');
 if f.work_id is distinct from m.work_id then raise exception 'maintenance_normalization_frame';end if;
end$$;
-- Missing-employer evidence under the catch-up frame, with the conflict fence's
-- exact expected-row protocol.
create function person_private.maintenance_conflict(p_candidate uuid,p_incoming jsonb,p_hash text,p_source uuid) returns integer
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare f person_private.maintenance_frames;e public.identity_conflicts;saved public.identity_conflicts;actual public.identity_conflicts;
begin
 f:=person_private.maintenance_frame('catchup');
 if p_candidate is null or p_hash is null or p_incoming is null then raise exception 'maintenance_conflict';end if;
 e:=jsonb_populate_record(null::public.identity_conflicts,jsonb_build_object('id',gen_random_uuid(),'kind','missing_employer','candidate_ids',array[p_candidate],
  'incoming',p_incoming,'evidence_hash',p_hash,'source_id',p_source,'status','open','created_at',clock_timestamp()));
 insert into person_private.conflict_frames values(pg_backend_pid(),pg_current_xact_id(),f.work_id,p_candidate,to_jsonb(e));
 insert into public.identity_conflicts select (e).* on conflict(kind,evidence_hash) where status='open' do nothing returning * into saved;
 if found then
  select * into actual from public.identity_conflicts where id=e.id;
  if to_jsonb(saved) is distinct from to_jsonb(e) or to_jsonb(actual) is distinct from to_jsonb(e) then raise exception 'conflict_evidence_actual';end if;
 else
  perform 1 from public.identity_conflicts where kind='missing_employer' and evidence_hash=p_hash and status='open' for share;
  if not found then raise exception 'conflict_evidence_actual';end if;
 end if;
 delete from person_private.conflict_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 return case when saved.id is null then 0 else 1 end;
end$$;

-- Recognize the maintenance normalization frame wherever the shared frame is read.
do $$declare d text;n text;o text;sig text;begin
 d:=pg_get_functiondef('person_private.normalization_frame(uuid,uuid)'::regprocedure);o:=d;
 n:='rs person_private.recruiter_saves;';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'maintenance_frame_definition';end if;
 d:=replace(d,n,n||'m person_private.maintenance_normalization_frames;');
 n:='select * into q from person_private.recruiter_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'maintenance_frame_definition';end if;
 d:=replace(d,n,n||E'\n select * into m from person_private.maintenance_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();');
 n:='+(q.backend_pid is not null)::int>1';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'maintenance_frame_definition';end if;
 d:=replace(d,n,'+(q.backend_pid is not null)::int+(m.backend_pid is not null)::int>1');
 n:=E' end if;\n if f.backend_pid is null or (p_candidate';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'maintenance_frame_definition';end if;
 d:=replace(d,n,E' elsif m.backend_pid is not null then\n  perform person_private.maintenance_normalization_check(m);\n  f:=row(m.backend_pid,m.transaction_id,m.work_id,null,m.candidate_id,m.document)::person_private.normalization_frames;\n end if;\n if f.backend_pid is null or (p_candidate');
 execute d;
 n:='exists(select 1 from person_private.recruiter_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())';
 foreach sig in array array['public.save_person(jsonb)','person_private.conflict_insert(text,uuid[],jsonb,text,uuid)','person_private.directory_frame(uuid,jsonb)',
  'person_private.refresh_save_normalize(uuid)','person_private.recruiter_normalize(uuid)','person_private.recruiter_frames_present()'] loop
  d:=pg_get_functiondef(sig::regprocedure);if position(n in d)=0 then raise exception 'maintenance_nested_definition %',sig;end if;
  execute replace(d,n,n||' or exists(select 1 from person_private.maintenance_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())');
 end loop;
 -- save_person: inside a catch-up frame the document goes through the maintenance save.
 d:=pg_get_functiondef('public.save_person(jsonb)'::regprocedure);
 n:='if not person_private.normalization_gate() then return person_private.save_person_core(doc);end if;';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'maintenance_save_definition';end if;
 execute replace(d,n,n||E'\n if person_private.maintenance_frame_present(''catchup'') then return person_private.maintenance_save_person(doc);end if;');
 -- Anchor commits need the anchors window while armed.
 d:=pg_get_functiondef('public.person_audit_anchor_commit(jsonb)'::regprocedure);
 n:='if person_private.normalization_gate() then raise exception ''audit_proof_maintenance'';end if;';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'maintenance_anchor_definition';end if;
 execute replace(d,n,'if person_private.normalization_gate() then perform person_private.maintenance_work(''anchors'',null);end if;');
end$$;

-- Reconciliation may mark captured events and drain the queue inside a catch-up
-- frame. Source holds stay refused.
create or replace function person_private.audit_proof_maintenance() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if person_private.normalization_gate() and not (tg_table_name in ('person_change_events','person_change_queue') and person_private.maintenance_frame_present('catchup')) then
  raise exception 'audit_proof_maintenance';
 end if;
 return null;
end$$;

-- Missing-employer flags: unchanged while disabled; checked evidence inside a frame.
create or replace function public.person_backfill_flag_missing_employers(p_candidate uuid)
returns integer language plpgsql set search_path='' as $$
declare n integer:=0;r record;
begin
 if not person_private.maintenance_frame_present('catchup') then
  insert into public.identity_conflicts(kind,candidate_ids,incoming,evidence_hash,source_id)
  select 'missing_employer',array[p_candidate],jsonb_build_object('job_id',e.id,'row_key',e.row_key,'reason','source_has_no_employer_identity'),
   md5('missing-employer|'||p_candidate::text||'|'||e.row_key),e.source_id
  from public.candidate_experiences e join public.companies c on c.id=e.company_id
  where e.candidate_id=p_candidate and e.source='person' and e.removed_at is null
    and c.is_placeholder and c.normalized_name='unknown employer'
  on conflict(kind,evidence_hash) where status='open' do nothing;
  get diagnostics n=row_count;
  return n;
 end if;
 for r in select e.id,e.row_key,e.source_id from public.candidate_experiences e join public.companies c on c.id=e.company_id
  where e.candidate_id=p_candidate and e.source='person' and e.removed_at is null and c.is_placeholder and c.normalized_name='unknown employer'
  order by e.id loop
  n:=n+person_private.maintenance_conflict(p_candidate,jsonb_build_object('job_id',r.id,'row_key',r.row_key,'reason','source_has_no_employer_identity'),
   md5('missing-employer|'||p_candidate::text||'|'||r.row_key),r.source_id);
 end loop;
 return n;
end$$;

-- Run-bearing catch-up RPCs keep their public signatures for the pinned runner.
alter function public.person_backfill_save(text,uuid,jsonb,bigint) rename to backfill_save_core;
alter function public.backfill_save_core(text,uuid,jsonb,bigint) set schema person_private;
alter function public.person_backfill_audit_many(text,jsonb) rename to backfill_audit_many_core;
alter function public.backfill_audit_many_core(text,jsonb) set schema person_private;
alter function public.person_reconcile_record_many(text,jsonb) rename to reconcile_record_many_core;
alter function public.reconcile_record_many_core(text,jsonb) set schema person_private;
revoke all on function person_private.backfill_save_core(text,uuid,jsonb,bigint),person_private.backfill_audit_many_core(text,jsonb),
 person_private.reconcile_record_many_core(text,jsonb) from public,anon,authenticated;
grant execute on function person_private.backfill_save_core(text,uuid,jsonb,bigint),person_private.backfill_audit_many_core(text,jsonb),
 person_private.reconcile_record_many_core(text,jsonb) to service_role;
create function public.person_backfill_save(p_run text,p_candidate uuid,p_docs jsonb,p_version bigint)
returns jsonb language plpgsql set search_path='' set statement_timeout='20s' set lock_timeout='2s' as $$
declare opened boolean;result jsonb;
begin
 opened:=person_private.maintenance_enter('catchup',p_run);
 result:=person_private.backfill_save_core(p_run,p_candidate,p_docs,p_version);
 perform person_private.maintenance_leave(opened);
 return result;
end$$;
create function public.person_backfill_audit_many(p_run text,p_items jsonb) returns jsonb
language plpgsql set search_path='' set lock_timeout='2s' set statement_timeout='20s' as $$
declare opened boolean;result jsonb;
begin
 opened:=person_private.maintenance_enter('catchup',p_run);
 result:=person_private.backfill_audit_many_core(p_run,p_items);
 perform person_private.maintenance_leave(opened);
 return result;
end$$;
create function public.person_reconcile_record_many(p_run text,p_items jsonb)
returns jsonb language plpgsql set search_path='' set lock_timeout='2s' set statement_timeout='20s' as $$
declare opened boolean;result jsonb;
begin
 opened:=person_private.maintenance_enter('catchup',p_run);
 result:=person_private.reconcile_record_many_core(p_run,p_items);
 perform person_private.maintenance_leave(opened);
 return result;
end$$;
revoke all on function public.person_backfill_save(text,uuid,jsonb,bigint),public.person_backfill_audit_many(text,jsonb),
 public.person_reconcile_record_many(text,jsonb) from public,anon,authenticated;
grant execute on function public.person_backfill_save(text,uuid,jsonb,bigint),public.person_backfill_audit_many(text,jsonb),
 public.person_reconcile_record_many(text,jsonb) to service_role;

do $$declare p regprocedure;begin
 for p in select oid::regprocedure from pg_proc where pronamespace='person_private'::regnamespace and proname like 'maintenance_%' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',p);
 end loop;
end$$;
-- Called from the invoker entry points above, which run as the service role.
grant execute on function person_private.maintenance_enter(text,text),person_private.maintenance_leave(boolean),
 person_private.maintenance_frame_present(text),person_private.maintenance_conflict(uuid,jsonb,text,uuid) to service_role;
