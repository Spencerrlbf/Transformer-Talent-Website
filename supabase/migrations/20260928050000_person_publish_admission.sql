-- PREPARED ONLY. Profile publication while the transition controller is armed and
-- OPEN (Spencer, 2026-09-28): an operator `publish` window bound to one publish run
-- lets that run's projections through the shared checked projection path, beside the
-- admitted writers that keep running. Undo is not admitted here.
set local lock_timeout='2s';set local statement_timeout='30s';

-- The publish step joins catch-up and anchors.
alter table person_private.maintenance_frames drop constraint maintenance_frames_step_check;
alter table person_private.maintenance_frames add constraint maintenance_frames_step_check check(step in ('catchup','anchors','publish'));
alter table person_private.maintenance_events drop constraint maintenance_events_step_check;
alter table person_private.maintenance_events add constraint maintenance_events_step_check check(step in ('catchup','anchors','publish'));

create or replace function person_private.maintenance_prefix(p_step text,p_run text) returns text language plpgsql immutable set search_path='' as $$
begin
 if p_step is null or p_step not in ('catchup','anchors','publish') or p_run is null or p_run !~ '^[A-Za-z0-9_-]{1,100}$' then raise exception 'maintenance_input';end if;
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
  if exists(select 1 from person_private.transition_work where scope='tt_person' and status<>'completed') then raise exception 'transition_unresolved';end if;
  if p_step='catchup' and not exists(select 1 from public.backfill_runs where run_id=p_run and status='running' and notes->>'kind'='reconcile'
   and notes->>'commit'='c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc') then raise exception 'maintenance_run';end if;
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
 if p_step in ('catchup','publish') then
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

create table person_private.publish_projection_frames(
 backend_pid integer not null,transaction_id xid8 not null,work_id uuid not null,candidate_id uuid not null,operation_id uuid not null,
 before_profile jsonb not null,after_profile jsonb not null,execution_id uuid not null,primary key(backend_pid,transaction_id));
create table person_private.publish_audit_operations(
 operation_id uuid primary key references public.person_audit_operations(id),work_id uuid not null references person_private.transition_work(id),
 candidate_id uuid not null,transaction_id xid8 not null,captured_version bigint not null,creator_event_id bigint,run_id text not null);
do $$declare t text;begin foreach t in array array['publish_projection_frames','publish_audit_operations'] loop
 execute format('alter table person_private.%I enable row level security',t);
 execute format('revoke all on person_private.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
create function person_private.publish_audit_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'publish_audit_immutable';end$$;
create trigger publish_audit_immutable before update or delete on person_private.publish_audit_operations
 for each row execute function person_private.publish_audit_immutable();
create constraint trigger publish_projection_cleanup after insert on person_private.publish_projection_frames
 deferrable initially deferred for each row execute function person_private.maintenance_frame_cleanup();
create or replace function person_private.maintenance_frame_cleanup() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from person_private.maintenance_control_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
  exists(select 1 from person_private.maintenance_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
  exists(select 1 from person_private.maintenance_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
  exists(select 1 from person_private.publish_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
 then raise exception 'maintenance_frame_cleanup';end if;
 return null;
end$$;

-- Publish operations are certified like every other family's.
do $$declare v text;begin
 v:=rtrim(pg_get_viewdef('person_private.certified_audit_operations'::regclass),E'; \n');
 execute 'create or replace view person_private.certified_audit_operations as '||v||
  ' union all select p.operation_id,p.work_id,p.candidate_id,p.transaction_id,p.captured_version,p.creator_event_id from person_private.publish_audit_operations p';
end$$;
revoke all on person_private.certified_audit_operations from public,anon,authenticated,service_role;

create function person_private.publish_projection_family() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from person_private.maintenance_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and step='publish')
$$;
create function person_private.publish_run() returns text language sql stable security definer set search_path='' as $$
 select run_id from person_private.maintenance_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and step='publish'
$$;

-- The guarded audit operation for one publication, built in SQL exactly as the
-- other admitted families build theirs (anchor, auxiliary proof, attributed chain).
create function person_private.publish_audit_begin(p_candidate uuid) returns uuid
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare f person_private.maintenance_frames;anchor public.person_audit_anchors;c jsonb;aux jsonb;guard jsonb;src jsonb;
 e record;v bigint;start_v bigint;candidate_hash text;current_hash text;oid uuid:=gen_random_uuid();events_seen integer:=0;checkpoint record;stored_operation public.person_audit_operations;expected_operation public.person_audit_operations;
begin
 f:=person_private.maintenance_frame('publish');
 select to_jsonb(t) into c from public.candidates t where id=p_candidate;
 if c is null then raise exception 'audit_candidate_missing';end if;
 aux:=person_private.audit_auxiliary_proof(p_candidate);
 if (aux->>'n')::int>1000 then raise exception 'audit_auxiliary_limit';end if;aux:=aux->'proof';
 select coalesce(max(id),0) into v from public.person_change_events where candidate_id=p_candidate;
 select * into anchor from public.person_audit_anchors where candidate_id=p_candidate;
 if anchor.candidate_id is null then raise exception 'audit_anchor_required';end if;
 if anchor.parser_version<>'person-v3' or anchor.before_image->>'id' is distinct from p_candidate::text or
  anchor.anchor_hash is distinct from person_private.audit_anchor_hash(to_jsonb(anchor)) or not exists(select 1 from person_private.certified_audit_anchors where candidate_id=p_candidate and anchor_hash=anchor.anchor_hash) then raise exception 'audit_anchor_uncertified';end if;
 if exists(select 1 from jsonb_each(aux) x where anchor.external_proof->x.key is distinct from x.value) then raise exception 'audit_auxiliary_changed';end if;
 if exists(select 1 from public.person_source_holds where candidate_id=p_candidate and resolved_at is null) then raise exception 'audit_source_hold';end if;
 if anchor.kind='legacy' then
  src:=anchor.legacy_doc->'source';
  if not exists(select 1 from public.candidate_sources where candidate_id=p_candidate and source='legacy_import' and source_ref=src->>'source_ref' and payload_hash=src->>'payload_hash' and parser_version=src->>'parser_version' and fetched_at=(src->>'fetched_at')::timestamptz and provider is not distinct from src->>'provider' and raw_in is not distinct from src->>'raw_in' and enrichment_id is not distinct from nullif(src->>'enrichment_id','')::uuid) then raise exception 'audit_anchor_source';end if;
 else
  perform person_private.receipt_creator_valid(p_candidate,'801865a7-6533-41d2-9c45-e4a90e6ad51a',anchor);
 end if;
 start_v:=anchor.captured_version;candidate_hash:=person_private.audit_candidate_hash(anchor.before_image);
 select p.captured_version,o.evidence->'guard' proof into checkpoint
 from person_private.certified_audit_operations p join public.person_audit_operations o on o.id=p.operation_id
 where p.candidate_id=p_candidate and o.candidate_id=p_candidate and p.transaction_id=o.transaction_id
 and o.evidence->'guard'->>'anchor_hash'=anchor.anchor_hash and p.captured_version between start_v and v
 order by p.captured_version desc,o.created_at desc,o.id desc limit 1;
 if found then
  if checkpoint.proof->>'version'<>'candidate-audit-1' or checkpoint.proof->>'captured_version' is distinct from checkpoint.captured_version::text or checkpoint.proof->'auxiliary' is distinct from aux then raise exception 'audit_checkpoint_invalid';end if;
  start_v:=checkpoint.captured_version;candidate_hash:=checkpoint.proof->>'candidate_hash';
 end if;
 for e in select ev.*,x.event_id attributed,x.candidate_id attribution_candidate,x.operation_id,x.event_hash,x.scope,
   o.candidate_id operation_candidate,o.transaction_id operation_transaction,o.evidence,
   p.operation_id private_operation,p.captured_version operation_boundary,p.creator_event_id
  from (select * from public.person_change_events where candidate_id=p_candidate and source_table='candidates' and id>start_v and id<=v order by id limit 201) ev
  left join public.person_change_attributions x on x.event_id=ev.id left join public.person_audit_operations o on o.id=x.operation_id
  left join person_private.certified_audit_operations p on p.operation_id=o.id order by ev.id loop
  if e.operation<>'UPDATE' or e.previous_payload is null or e.source_row_id<>p_candidate::text or e.payload->>'id' is distinct from p_candidate::text or e.previous_payload->>'id' is distinct from p_candidate::text then raise exception 'audit_proof_chain';end if;
  events_seen:=events_seen+1;
  if events_seen>200 then raise exception 'audit_event_limit';end if;
  if person_private.audit_candidate_hash(e.previous_payload) is distinct from candidate_hash then raise exception 'audit_proof_chain';end if;
  current_hash:=person_private.audit_candidate_hash(e.payload);
  if e.attributed is not null then
   if e.private_operation is null or e.attribution_candidate<>p_candidate or e.operation_candidate<>p_candidate or e.operation_transaction is distinct from e.transaction_id or e.id<=e.operation_boundary or e.evidence->'guard'->>'anchor_hash' is distinct from anchor.anchor_hash or e.event_hash is distinct from md5(jsonb_build_array(e.id,e.candidate_id,e.source_table,e.source_row_id,e.operation,e.transaction_id::text,e.previous_payload,e.payload)::text) then raise exception 'audit_proof_chain';end if;
  elsif candidate_hash is distinct from current_hash then raise exception 'audit_unattributed_change';end if;
  candidate_hash:=current_hash;
 end loop;
 if candidate_hash is distinct from person_private.audit_candidate_hash(c) then raise exception 'audit_proof_chain';end if;
 guard:=jsonb_build_object('version','candidate-audit-1','anchor_hash',anchor.anchor_hash,'candidate_hash',candidate_hash,'captured_version',v::text,'auxiliary',aux);
 perform person_private.audit_proof_frame('person_audit_operations',p_candidate);
 expected_operation:=jsonb_populate_record(null::public.person_audit_operations,jsonb_build_object('id',oid,'candidate_id',p_candidate,'writer','projection',
  'receipt_ref','projection:publish:'||f.run_id||':'||gen_random_uuid()::text,'evidence',jsonb_build_object('guard',guard,'mode','publish','run_id',f.run_id),
  'transaction_id',pg_current_xact_id()::text,'created_at',clock_timestamp()));
 insert into public.person_audit_operations select expected_operation.* returning * into stored_operation;
 if to_jsonb(stored_operation) is distinct from to_jsonb(expected_operation) or (select to_jsonb(o) from public.person_audit_operations o where id=oid) is distinct from to_jsonb(expected_operation) then raise exception 'publish_audit_actual';end if;
 insert into person_private.publish_audit_operations values(oid,f.work_id,p_candidate,pg_current_xact_id(),v,null,f.run_id);
 perform person_private.audit_proof_clear('person_audit_operations');
 return oid;
exception when others then perform person_private.audit_proof_clear('person_audit_operations');raise;
end$$;

-- Recognize the publish projection frame in the shared projection path.
do $$declare d text;n text;sig text;begin
 n:=' elsif person_private.recruiter_projection_family()';
 d:=pg_get_functiondef('person_private.projection_owner(uuid)'::regprocedure);
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'publish_projection_definition';end if;
 execute replace(d,n,' elsif person_private.publish_projection_family() then if (person_private.maintenance_frame(''publish'')).work_id is distinct from p_execution then raise exception ''publish_projection_owner'';end if;'||n);
 d:=pg_get_functiondef('person_private.projection_frame_clear(uuid)'::regprocedure);
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'publish_projection_definition';end if;
 execute replace(d,n,' elsif person_private.publish_projection_family() then delete from person_private.publish_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();'||n);
 d:=pg_get_functiondef('person_private.projection_frame_set(uuid,uuid,uuid,uuid,jsonb,jsonb,boolean)'::regprocedure);
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'publish_projection_definition';end if;
 execute replace(d,n,' elsif person_private.publish_projection_family() then insert into person_private.publish_projection_frames values(pg_backend_pid(),pg_current_xact_id(),p_work,p_candidate,p_operation,p_before,p_after,p_execution);'||n);
 -- The frame reader.
 d:=pg_get_functiondef('person_private.projection_frame()'::regprocedure);
 n:='rs person_private.recruiter_saves;';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'publish_projection_definition';end if;
 d:=replace(d,n,n||'pp person_private.publish_projection_frames;');
 n:='select * into q from person_private.recruiter_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'publish_projection_definition';end if;
 d:=replace(d,n,n||E'\n select * into pp from person_private.publish_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();');
 n:='+(q.backend_pid is not null)::int>1';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'publish_projection_definition';end if;
 d:=replace(d,n,'+(q.backend_pid is not null)::int+(pp.backend_pid is not null)::int>1');
 n:=E' end if;\n if f.backend_pid is null then raise exception ''projection_frame'';end if;return f;';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'publish_projection_definition';end if;
 d:=replace(d,n,E' elsif pp.backend_pid is not null then\n  if (person_private.maintenance_frame(''publish'')).work_id is distinct from pp.work_id or not exists(select 1 from person_private.publish_audit_operations a where a.operation_id=pp.operation_id and a.candidate_id=pp.candidate_id and a.work_id=pp.work_id and a.transaction_id=pg_current_xact_id()) then raise exception ''publish_projection_frame'';end if;\n  f:=row(pp.backend_pid,pp.transaction_id,pp.work_id,pp.candidate_id,pp.operation_id,pp.before_profile,pp.after_profile)::person_private.application_projection_frames;\n'||n);
 execute d;
 -- Nested-frame checks see publish frames too.
 n:='exists(select 1 from person_private.recruiter_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())';
 foreach sig in array array['person_private.projection_frame_set(uuid,uuid,uuid,uuid,jsonb,jsonb,boolean)','person_private.projection_apply(uuid,uuid,uuid,uuid,bigint,jsonb)',
  'person_private.intake_mutation_guard()','person_private.conflict_insert(text,uuid[],jsonb,text,uuid)','person_private.refresh_metadata_check(jsonb,jsonb,text,text)','person_private.recruiter_frames_present()'] loop
  d:=pg_get_functiondef(sig::regprocedure);if position(n in d)=0 then raise exception 'publish_nested_definition %',sig;end if;
  execute replace(d,n,n||' or exists(select 1 from person_private.publish_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())');
 end loop;
 -- History rows written by a publish run carry its run ID, so undo can select them.
 d:=pg_get_functiondef('person_private.projection_apply(uuid,uuid,uuid,uuid,bigint,jsonb)'::regprocedure);
 n:='''restored_at'',null,''run_id'',null)';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'publish_history_definition';end if;
 d:=replace(d,n,'''restored_at'',null,''run_id'',person_private.publish_run())');
 n:='h.run_id is null and h.restored_at is null';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'publish_history_definition';end if;
 execute replace(d,n,'h.run_id is not distinct from person_private.publish_run() and h.restored_at is null');
end$$;

-- Profile attribution of a publish operation: same window, same transaction, a
-- later candidate event, profile scope only.
create function person_private.publish_attribution_context(p_event bigint,p_operation uuid,p_scope text) returns void
language plpgsql security definer set search_path='' as $$
declare f person_private.maintenance_frames;a person_private.publish_audit_operations;o public.person_audit_operations;ev public.person_change_events;
begin
 f:=person_private.maintenance_frame('publish');
 select * into a from person_private.publish_audit_operations where operation_id=p_operation;
 select * into o from public.person_audit_operations where id=p_operation;
 select * into ev from public.person_change_events where id=p_event;
 if a.operation_id is null or a.work_id<>f.work_id or a.run_id is distinct from f.run_id or a.transaction_id<>pg_current_xact_id() or
  o.transaction_id::text is distinct from a.transaction_id::text or o.writer<>'projection' or o.candidate_id<>a.candidate_id or
  ev.id is null or ev.id<=a.captured_version or ev.candidate_id<>a.candidate_id or ev.transaction_id::text is distinct from a.transaction_id::text or
  ev.source_table<>'candidates' or ev.source_row_id<>a.candidate_id::text or p_scope<>'profile' then raise exception 'audit_publish_scope';end if;
end$$;
do $$declare d text;n text;begin
 d:=pg_get_functiondef('person_private.attribute_change(bigint,uuid,text)'::regprocedure);
 n:='if exists(select 1 from person_private.recruiter_audit_operations where operation_id=p_operation) then recruiter_id:=';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'publish_attribution_definition';end if;
 execute replace(d,n,'if exists(select 1 from person_private.publish_audit_operations where operation_id=p_operation) then perform person_private.publish_attribution_context(p_event,p_operation,p_scope);els'||n);
end$$;

-- Operator entry point (direct session). One person, one short transaction.
create function public.person_publish_project(p_run text,p_candidate uuid,p_revision bigint,p_envelope jsonb) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare opened boolean;w person_private.maintenance_frames;oid uuid;r jsonb;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'publish_isolation';end if;
 if p_candidate is null or p_revision is null then raise exception 'publish_input';end if;
 opened:=person_private.maintenance_enter('publish',p_run);
 if not opened then raise exception 'publish_requires_window';end if;
 w:=person_private.maintenance_frame('publish');
 oid:=person_private.publish_audit_begin(p_candidate);
 r:=person_private.projection_apply(w.work_id,w.work_id,p_candidate,oid,p_revision,p_envelope);
 perform person_private.maintenance_frame('publish');
 perform person_private.maintenance_leave(opened);
 return r||jsonb_build_object('operationId',oid);
end$$;

do $$declare p regprocedure;begin
 for p in select oid::regprocedure from pg_proc where pronamespace='person_private'::regnamespace and (proname like 'publish_%' or proname like 'maintenance_%') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',p);
 end loop;
end$$;
revoke all on function public.person_publish_project(text,uuid,bigint,jsonb) from public,anon,authenticated,service_role;
