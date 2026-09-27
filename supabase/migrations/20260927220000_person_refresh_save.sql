-- PREPARED ONLY. Atomic profile save for an existing certified refresh lifecycle.
-- No candidate creation, provider call or production activation.
set local lock_timeout='2s';set local statement_timeout='30s';
create table person_private.refresh_saves(
 id uuid primary key references person_private.refresh_lifecycles(request_id),
 work_id uuid not null unique references person_private.transition_work(id),
 organization_id uuid not null,candidate_id uuid not null references public.candidates(id),queue_id uuid not null,
 mode text not null check(mode in ('shadow','live')),backend_pid integer not null,transaction_id xid8 not null,
 lifecycle_hash text not null,candidate_before jsonb not null,document jsonb,
 audit_id uuid references public.person_audit_operations(id),audit_operation jsonb,normalized_state jsonb,normalized_source jsonb,attributions jsonb not null default '[]',normalized boolean not null default false,
 normalization_result jsonb,prepared_revision bigint,projection jsonb,candidate_after jsonb,
 metadata_done boolean not null default false,enqueue_done boolean not null default false,derivative_job jsonb,
 result jsonb,completed_at timestamptz,seal_hash text not null
);
create table person_private.refresh_normalization_frames(
 backend_pid integer not null,transaction_id xid8 not null,execution_id uuid not null references person_private.refresh_saves(id),
 work_id uuid not null,candidate_id uuid not null,document jsonb not null,primary key(backend_pid,transaction_id)
);
create table person_private.refresh_audit_operations(
 operation_id uuid primary key references public.person_audit_operations(id),execution_id uuid not null references person_private.refresh_saves(id),
 work_id uuid not null,candidate_id uuid not null,transaction_id xid8 not null,captured_version bigint not null,
 creator_event_id bigint,operation_hash text not null
);
do $$declare t text;begin foreach t in array array['refresh_saves','refresh_normalization_frames','refresh_audit_operations'] loop
 execute format('alter table person_private.%I enable row level security',t);
 execute format('revoke all on person_private.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
create function person_private.refresh_save_binding(e person_private.refresh_lifecycles) returns text language sql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
 select person_private.intake_hash(jsonb_build_array(e.request_id,e.work_id,e.queue_id,e.candidate_id,e.organization_id,e.username,e.input_hash,e.options,e.source_snapshot,e.source_hash))
$$;
create function person_private.refresh_save_valid(s person_private.refresh_saves) returns boolean language sql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
 select s.id is not null and s.seal_hash=person_private.intake_hash(to_jsonb(s)-'seal_hash') and exists(
 select 1 from person_private.refresh_lifecycles e where e.request_id=s.id and e.work_id=s.work_id and e.organization_id=s.organization_id and e.candidate_id=s.candidate_id and e.queue_id=s.queue_id and e.source_snapshot is not null and person_private.refresh_valid(e) and s.lifecycle_hash=person_private.refresh_save_binding(e))
$$;
create function person_private.refresh_save_set(p_old jsonb,p_new jsonb) returns person_private.refresh_saves language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.refresh_saves;returned person_private.refresh_saves;actual person_private.refresh_saves;
begin
 s:=jsonb_populate_record(null::person_private.refresh_saves,p_new);s.seal_hash:=person_private.intake_hash(to_jsonb(s)-'seal_hash');
 if p_old is null then insert into person_private.refresh_saves select s.* returning * into returned;
 else
  select * into actual from person_private.refresh_saves where id=s.id;
  if to_jsonb(actual) is distinct from p_old then raise exception 'refresh_save_changed';end if;
  update person_private.refresh_saves set document=s.document,audit_id=s.audit_id,audit_operation=s.audit_operation,normalized_state=s.normalized_state,normalized_source=s.normalized_source,attributions=s.attributions,normalized=s.normalized,normalization_result=s.normalization_result,prepared_revision=s.prepared_revision,projection=s.projection,candidate_after=s.candidate_after,metadata_done=s.metadata_done,enqueue_done=s.enqueue_done,derivative_job=s.derivative_job,result=s.result,completed_at=s.completed_at,seal_hash=s.seal_hash where id=s.id returning * into returned;
 end if;
 select * into actual from person_private.refresh_saves where id=s.id;
 if to_jsonb(returned) is distinct from to_jsonb(s) or to_jsonb(actual) is distinct from to_jsonb(s) or person_private.refresh_save_valid(actual) is distinct from true then raise exception 'refresh_save_actual';end if;
 return actual;
end$$;
create function person_private.refresh_save_context(p_id uuid) returns person_private.refresh_saves language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.refresh_saves;e person_private.refresh_lifecycles;
begin
 select * into s from person_private.refresh_saves where id=p_id;e:=person_private.refresh_context(p_id);
 if person_private.refresh_save_valid(s) is distinct from true or s.backend_pid<>pg_backend_pid() or s.transaction_id<>pg_current_xact_id() or s.result is not null or e.phase<>'claimed' then raise exception 'refresh_save_context';end if;
 perform person_private.refresh_images(p_id);return s;
end$$;
create function person_private.refresh_save_begin(p_org uuid,p_id uuid,p_queue uuid,p_token uuid,p_mode text) returns jsonb language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.refresh_lifecycles;s person_private.refresh_saves;c jsonb;
begin
 if p_mode is null or p_mode not in ('shadow','live') then raise exception 'refresh_save_mode';end if;
 e:=person_private.refresh_enter(p_org,p_id,p_queue,p_token,true,true);
 select * into s from person_private.refresh_saves where id=p_id;
 if found then
  if s.mode<>p_mode then raise exception 'refresh_save_binding';end if;
  if person_private.refresh_save_completion_valid(p_id) is distinct from true then raise exception 'refresh_save_incomplete';end if;
  return jsonb_build_object('status','completed','result',s.result);
 end if;
 e:=person_private.refresh_enter(p_org,p_id,p_queue,p_token,false,false);
 if e.phase<>'claimed' or e.source_snapshot is null then raise exception 'refresh_save_source';end if;
 perform pg_advisory_xact_lock(hashtext(e.candidate_id::text));
 select to_jsonb(x) into c from public.candidates x where id=e.candidate_id for update;
 perform person_private.refresh_context(p_id);perform person_private.refresh_images(p_id);
 if c is null or lower(btrim(c->>'linkedin_username')) is distinct from e.username or exists(select 1 from public.person_source_holds where candidate_id=e.candidate_id and resolved_at is null) or not exists(select 1 from public.candidate_profile_state where candidate_id=e.candidate_id) then raise exception 'refresh_candidate_changed';end if;
 s:=person_private.refresh_save_set(null,jsonb_build_object('id',p_id,'work_id',e.work_id,'organization_id',e.organization_id,'candidate_id',e.candidate_id,'queue_id',e.queue_id,'mode',p_mode,'backend_pid',pg_backend_pid(),'transaction_id',pg_current_xact_id()::text,'lifecycle_hash',person_private.refresh_save_binding(e),'candidate_before',c,'attributions','[]'::jsonb,'normalized',false,'metadata_done',false,'enqueue_done',false));
 return jsonb_build_object('status','admitted','source',e.source_snapshot,'candidateId',e.candidate_id,'before',c);
end$$;
create function person_private.refresh_save_seal(p_id uuid,p_doc jsonb) returns void language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.refresh_saves;e person_private.refresh_lifecycles;src jsonb;
begin
 s:=person_private.refresh_save_context(p_id);select * into e from person_private.refresh_lifecycles where request_id=p_id;src:=p_doc->'source';
 if s.document is not null or p_doc->>'candidate_id' is distinct from s.candidate_id::text or src->>'source' is distinct from 'harvest' or src->>'provider' is distinct from 'harvest' or src->>'raw_in' is distinct from 'candidate_enrichments' or src->>'source_ref' is distinct from e.source_snapshot->>'id' or src->>'enrichment_id' is distinct from e.source_snapshot->>'id' or (src->>'fetched_at')::timestamptz is distinct from date_trunc('milliseconds',(e.source_snapshot->>'created_at')::timestamptz) or src->>'parser_version' is distinct from 'person-v3' then raise exception 'refresh_document_binding';end if;
 perform person_private.refresh_save_set(to_jsonb(s),to_jsonb(s)||jsonb_build_object('document',p_doc));
end$$;

create or replace function person_private.normalization_frame(p_candidate uuid default null,p_source uuid default null) returns person_private.normalization_frames
language plpgsql security definer set search_path='' as $$
declare f person_private.normalization_frames;d person_private.directory_normalization_frames;e person_private.directory_executions;r person_private.refresh_normalization_frames;s person_private.refresh_saves;
begin
 select * into f from person_private.normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 select * into d from person_private.directory_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 select * into r from person_private.refresh_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if (f.backend_pid is not null)::int+(d.backend_pid is not null)::int+(r.backend_pid is not null)::int>1 then raise exception 'normalization_nested';end if;
 if d.backend_pid is not null then
  e:=person_private.directory_context(d.execution_id);
  if e.candidate_id is distinct from d.candidate_id or e.work_id is distinct from d.work_id or not exists(select 1 from jsonb_array_elements(e.decision->'docs') doc where doc=d.document) then raise exception 'directory_normalization_frame';end if;
  f:=row(d.backend_pid,d.transaction_id,d.work_id,null,d.candidate_id,d.document)::person_private.normalization_frames;
 elsif r.backend_pid is not null then
  s:=person_private.refresh_save_context(r.execution_id);
  if s.candidate_id is distinct from r.candidate_id or s.work_id is distinct from r.work_id or s.document is distinct from r.document or s.normalized then raise exception 'refresh_normalization_frame';end if;
  f:=row(r.backend_pid,r.transaction_id,r.work_id,null,r.candidate_id,r.document)::person_private.normalization_frames;
 end if;
 if f.backend_pid is null or (p_candidate is not null and p_candidate<>f.candidate_id) then raise exception 'normalization_frame';end if;
 if p_source is not null and not exists(select 1 from public.candidate_sources cs where cs.id=p_source and cs.candidate_id=f.candidate_id and cs.source=f.document->'source'->>'source' and cs.payload_hash=f.document->'source'->>'payload_hash') then raise exception 'normalization_source';end if;
 return f;
end$$;
do $$declare b text;sig text;n text:='exists(select 1 from person_private.directory_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())';begin
 foreach sig in array array['public.save_person(jsonb)','person_private.conflict_insert(text,uuid[],jsonb,text,uuid)','person_private.directory_frame(uuid,jsonb)'] loop
  b:=pg_get_functiondef(sig::regprocedure);if position(n in b)=0 then raise exception 'refresh_normalization_definition';end if;
  execute replace(b,n,n||' or exists(select 1 from person_private.refresh_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())');
 end loop;
end$$;
create function person_private.refresh_save_normalize(p_id uuid) returns jsonb language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.refresh_saves;r jsonb;f person_private.normalization_frames;rev bigint;
begin
 s:=person_private.refresh_save_context(p_id);
 if s.document is null or s.audit_id is null or s.normalized then raise exception 'refresh_normalization_order';end if;
 if exists(select 1 from person_private.normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or exists(select 1 from person_private.directory_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or exists(select 1 from person_private.refresh_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'normalization_nested';end if;
 insert into person_private.refresh_normalization_frames values(pg_backend_pid(),pg_current_xact_id(),s.id,s.work_id,s.candidate_id,s.document);
 f:=person_private.normalization_frame(s.candidate_id);
 r:=person_private.save_person_core(s.document);
 perform person_private.refresh_save_context(p_id);perform person_private.normalization_frame(s.candidate_id);
 delete from person_private.refresh_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if exists(select 1 from person_private.refresh_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'refresh_normalization_cleanup';end if;
 select x.rev into rev from public.candidate_profile_state x where x.candidate_id=s.candidate_id;
 perform person_private.refresh_save_set(to_jsonb(s),to_jsonb(s)||jsonb_build_object('normalized',true,'normalization_result',r,'prepared_revision',rev,'normalized_state',(select to_jsonb(x) from public.candidate_profile_state x where candidate_id=s.candidate_id),'normalized_source',(select to_jsonb(cs) from public.candidate_sources cs where cs.candidate_id=s.candidate_id and cs.source=s.document->'source'->>'source' and cs.source_ref=s.document->'source'->>'source_ref' and cs.payload_hash=s.document->'source'->>'payload_hash' and cs.fetched_at=(s.document->'source'->>'fetched_at')::timestamptz and cs.parser_version=s.document->'source'->>'parser_version' and cs.provider=s.document->'source'->>'provider' and cs.raw_in=s.document->'source'->>'raw_in' and cs.enrichment_id=(s.document->'source'->>'enrichment_id')::uuid)));
 return r;
end$$;

-- Existing-person audit verifier; refresh never creates an anchor.
CREATE OR REPLACE FUNCTION person_private.refresh_save_audit_begin(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
 SET "DateStyle" TO 'ISO,YMD'
AS $function$
declare dx person_private.refresh_saves;anchor public.person_audit_anchors;c jsonb;aux jsonb;guard jsonb;src jsonb;
 e record;v bigint;start_v bigint;candidate_hash text;current_hash text;oid uuid:=gen_random_uuid();events_seen integer:=0;checkpoint record;stored_operation public.person_audit_operations;expected_operation public.person_audit_operations;creator bigint;
begin
 dx:=person_private.refresh_save_context(p_id);
 if dx.candidate_id is null or dx.document is null or dx.audit_id is not null then raise exception 'directory_audit_binding';end if;
 select to_jsonb(t) into c from public.candidates t where id=dx.candidate_id;
 if c is distinct from dx.candidate_before then raise exception 'directory_candidate_changed';end if;
 aux:=person_private.audit_auxiliary_proof(dx.candidate_id);
 if (aux->>'n')::int>1000 then raise exception 'audit_auxiliary_limit';end if;aux:=aux->'proof';
 select coalesce(max(id),0) into v from public.person_change_events where candidate_id=dx.candidate_id;
 select * into anchor from public.person_audit_anchors where candidate_id=dx.candidate_id;
 if anchor.candidate_id is null or anchor.parser_version<>'person-v3' or anchor.before_image->>'id' is distinct from dx.candidate_id::text or
  anchor.anchor_hash is distinct from person_private.audit_anchor_hash(to_jsonb(anchor)) or not exists(select 1 from person_private.certified_audit_anchors where candidate_id=dx.candidate_id and anchor_hash=anchor.anchor_hash) then raise exception 'audit_anchor_uncertified';end if;
 if exists(select 1 from jsonb_each(aux) x where anchor.external_proof->x.key is distinct from x.value) then raise exception 'audit_auxiliary_changed';end if;
 if anchor.kind='legacy' then
  src:=anchor.legacy_doc->'source';
  if not exists(select 1 from public.candidate_sources where candidate_id=dx.candidate_id and source='legacy_import' and source_ref=src->>'source_ref' and payload_hash=src->>'payload_hash' and parser_version=src->>'parser_version' and fetched_at=(src->>'fetched_at')::timestamptz and provider is not distinct from src->>'provider' and raw_in is not distinct from src->>'raw_in' and enrichment_id is not distinct from nullif(src->>'enrichment_id','')::uuid) then raise exception 'audit_anchor_source';end if;
 else
  perform person_private.receipt_creator_valid(dx.candidate_id,dx.organization_id,anchor);
 end if;
 start_v:=anchor.captured_version;candidate_hash:=person_private.audit_candidate_hash(anchor.before_image);
 -- Only this private map certifies a DB-derived checkpoint. Public legacy
 -- operation JSON cannot advance the chain. Bound the interval after the latest
 -- verified checkpoint, so old valid history does not grow without limit.
 select p.captured_version,o.evidence->'guard' proof into checkpoint
 from person_private.certified_audit_operations p join public.person_audit_operations o on o.id=p.operation_id
 where p.candidate_id=dx.candidate_id and o.candidate_id=dx.candidate_id and p.transaction_id=o.transaction_id
 and o.evidence->'guard'->>'anchor_hash'=anchor.anchor_hash and p.captured_version between start_v and v
 order by p.captured_version desc,o.created_at desc,o.id desc limit 1;
 if found then
  if checkpoint.proof->>'version'<>'candidate-audit-1' or checkpoint.proof->>'captured_version' is distinct from checkpoint.captured_version::text or checkpoint.proof->'auxiliary' is distinct from aux then raise exception 'audit_checkpoint_invalid';end if;
  start_v:=checkpoint.captured_version;candidate_hash:=checkpoint.proof->>'candidate_hash';
 end if;
 for e in select ev.*,x.event_id attributed,x.candidate_id attribution_candidate,x.operation_id,x.event_hash,x.scope,
   o.candidate_id operation_candidate,o.transaction_id operation_transaction,o.evidence,
   p.operation_id private_operation,p.captured_version operation_boundary,p.creator_event_id
  from (select * from public.person_change_events where candidate_id=dx.candidate_id and source_table='candidates' and id>start_v and id<=v order by id limit 201) ev
  left join public.person_change_attributions x on x.event_id=ev.id left join public.person_audit_operations o on o.id=x.operation_id
  left join person_private.certified_audit_operations p on p.operation_id=o.id order by ev.id loop
  if e.operation<>'UPDATE' or e.previous_payload is null or e.source_row_id<>dx.candidate_id::text or e.payload->>'id' is distinct from dx.candidate_id::text or e.previous_payload->>'id' is distinct from dx.candidate_id::text then raise exception 'audit_proof_chain';end if;
  events_seen:=events_seen+1;
  if events_seen>200 then raise exception 'audit_event_limit';end if;
  if person_private.audit_candidate_hash(e.previous_payload) is distinct from candidate_hash then raise exception 'audit_proof_chain';end if;
  current_hash:=person_private.audit_candidate_hash(e.payload);
  if e.attributed is not null then
   if e.private_operation is null or e.attribution_candidate<>dx.candidate_id or e.operation_candidate<>dx.candidate_id or e.operation_transaction is distinct from e.transaction_id or e.id<=e.operation_boundary or e.evidence->'guard'->>'anchor_hash' is distinct from anchor.anchor_hash or e.event_hash is distinct from md5(jsonb_build_array(e.id,e.candidate_id,e.source_table,e.source_row_id,e.operation,e.transaction_id::text,e.previous_payload,e.payload)::text) then raise exception 'audit_proof_chain';end if;
  elsif candidate_hash is distinct from current_hash then raise exception 'audit_unattributed_change';end if;
  candidate_hash:=current_hash;
 end loop;
 if candidate_hash is distinct from person_private.audit_candidate_hash(c) then raise exception 'audit_proof_chain';end if;
 guard:=jsonb_build_object('version','candidate-audit-1','anchor_hash',anchor.anchor_hash,'candidate_hash',candidate_hash,'captured_version',v::text,'auxiliary',aux);

 perform person_private.audit_proof_frame('person_audit_operations',dx.candidate_id);
 expected_operation:=jsonb_populate_record(null::public.person_audit_operations,jsonb_build_object('id',oid,'candidate_id',dx.candidate_id,'writer','refresh','receipt_ref','refresh:'||dx.queue_id::text,'evidence',jsonb_build_object('guard',guard),'transaction_id',pg_current_xact_id()::text,'created_at',clock_timestamp()));
 insert into public.person_audit_operations select expected_operation.* returning * into stored_operation;
 -- Validate the independently constructed expected guard and complete row before
 -- registering it as authority; hashing a trigger-altered operation is insufficient.
 if to_jsonb(stored_operation) is distinct from to_jsonb(expected_operation) or (select to_jsonb(o) from public.person_audit_operations o where id=oid) is distinct from to_jsonb(expected_operation) then raise exception 'refresh_audit_actual';end if;
 insert into person_private.refresh_audit_operations values(oid,dx.id,dx.work_id,dx.candidate_id,pg_current_xact_id(),v,creator,person_private.directory_operation_hash(stored_operation));
 perform person_private.refresh_save_set(to_jsonb(dx),to_jsonb(dx)||jsonb_build_object('audit_id',oid,'audit_operation',to_jsonb(expected_operation)));
 perform person_private.audit_proof_clear('person_audit_operations');
 if not exists(select 1 from person_private.refresh_audit_operations p where p.operation_id=oid and p.execution_id=dx.id and p.work_id=dx.work_id and p.candidate_id=dx.candidate_id and p.transaction_id=pg_current_xact_id() and p.captured_version=v and p.creator_event_id is null and p.operation_hash=person_private.directory_operation_hash(stored_operation)) then raise exception 'refresh_audit_private_actual';end if;
 perform person_private.refresh_save_context(p_id);
 return jsonb_build_object('id',oid,'candidateId',dx.candidate_id,'writer','refresh','receiptRef','refresh:'||dx.queue_id::text,'anchorHash',anchor.anchor_hash);
exception when others then perform person_private.audit_proof_clear('person_audit_operations');perform person_private.audit_proof_clear('person_audit_anchors');raise;
end$function$;
-- Repeated at the final boundary as additional private helpers are introduced.
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='person_private'::regnamespace and proname like 'refresh_save_%' loop execute format('revoke all on function %s from public,anon,authenticated,service_role',p);end loop;end$$;

create function person_private.refresh_save_completion_valid(p_id uuid,p_completed boolean default true) returns boolean language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.refresh_saves;e person_private.refresh_lifecycles;w person_private.transition_work;o public.person_audit_operations;a person_private.refresh_audit_operations;actual_source jsonb;
begin
 select * into s from person_private.refresh_saves where id=p_id;
 select * into e from person_private.refresh_lifecycles where request_id=p_id;
 select * into w from person_private.transition_work where id=s.work_id;
 select * into o from public.person_audit_operations where id=s.audit_id;
 select * into a from person_private.refresh_audit_operations where operation_id=s.audit_id;
 select to_jsonb(x) into actual_source from public.candidate_enrichments x where id=(e.source_snapshot->>'id')::uuid;
 return person_private.refresh_save_valid(s) and s.result is not null and s.completed_at is not null and s.document is not null and s.normalized and s.prepared_revision is not null and
 s.normalized_state is not null and s.normalized_source is not null and to_jsonb(o)=s.audit_operation and a.captured_version::text=s.audit_operation->'evidence'->'guard'->>'captured_version' and person_private.refresh_save_attributions_valid(s) and
 (s.transaction_id<>pg_current_xact_id() or person_private.refresh_save_current_valid(s)) and e.phase='done' and (not p_completed or w.status='completed') and actual_source=e.source_snapshot and
 a.execution_id=s.id and a.work_id=s.work_id and a.candidate_id=s.candidate_id and a.transaction_id=s.transaction_id and a.creator_event_id is null and
 o.id=s.audit_id and o.candidate_id=s.candidate_id and o.transaction_id=s.transaction_id and o.writer='refresh' and o.receipt_ref='refresh:'||s.queue_id::text and a.operation_hash=person_private.directory_operation_hash(o) and
 e.expected_attempt->>'phase'='done' and e.expected_attempt->'documents'=jsonb_build_array(s.document) and e.expected_attempt->'result'=s.result and e.expected_queue->>'status'='done' and
 (s.mode='shadow' and s.projection is null and not s.metadata_done and not s.enqueue_done and s.derivative_job is null and s.candidate_after=s.candidate_before or
  s.mode='live' and s.projection is not null and s.metadata_done and s.enqueue_done and s.derivative_job is not null and s.candidate_after is not null);
end$$;
alter table person_private.refresh_lifecycles drop constraint refresh_lifecycles_phase_check;
alter table person_private.refresh_lifecycles add constraint refresh_lifecycles_phase_check check(phase in ('claimed','retry','review','uncertain','done'));
do $$declare d text;old text:='e.phase not in (''retry'',''review'')';begin
 d:=pg_get_functiondef('person_private.refresh_work_guard()'::regprocedure);
 if position(old in d)=0 then raise exception 'refresh_work_definition';end if;
 execute replace(d,old,'(e.phase not in (''retry'',''review'') and (e.phase<>''done'' or person_private.refresh_save_completion_valid(e.request_id,false) is distinct from true))');
 d:=pg_get_functiondef('person_private.refresh_deferred()'::regprocedure);
 old:=' perform person_private.refresh_images(e.request_id);';
 if position(old in d)=0 then raise exception 'refresh_deferred_definition';end if;
 execute replace(d,old,old||E'\n if e.phase=''done'' and person_private.refresh_save_completion_valid(e.request_id) is distinct from true then raise exception ''refresh_save_incomplete'';end if;');
 d:=pg_get_functiondef('person_private.refresh_fail(uuid,uuid,uuid,uuid)'::regprocedure);
 old:=' if e.phase in (''retry'',''review'',''uncertain'')';
 if position(old in d)=0 then raise exception 'refresh_fail_definition';end if;
 execute replace(d,old,E' if e.phase=''done'' then if person_private.refresh_save_completion_valid(p_request) is distinct from true then raise exception ''refresh_save_incomplete'';end if;return e.recovery_result;end if;\n'||old);
end$$;

-- Retain terminal history using the lifecycle's exact checked writer. No lock on
-- displaced work is taken after candidate/queue locks.
create function person_private.refresh_save_terminal(p_id uuid,p_attempt jsonb) returns person_private.refresh_lifecycles language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.refresh_lifecycles;q jsonb;oldq jsonb;newq jsonb;prior jsonb;archives jsonb;
begin
 e:=person_private.refresh_context(p_id);archives:=e.archives;
 select to_jsonb(x) into q from public.refresh_queue x where id=e.queue_id;
 prior:=p_attempt->'previous_queue_rows';
 for oldq in select to_jsonb(x) from public.refresh_queue x where candidate_id=e.candidate_id and organization_id=e.organization_id and status='done' and id<>e.queue_id order by id for update loop
  newq:=oldq||jsonb_build_object('status','archived_'||(oldq->>'id')||'_done');
  perform person_private.refresh_write(p_id,'refresh_queue',oldq,newq);
  prior:=prior||jsonb_build_array(oldq);archives:=archives||jsonb_build_array(jsonb_build_object('before',oldq,'after',newq));
 end loop;
 p_attempt:=p_attempt||jsonb_build_object('previous_queue_rows',prior);
 newq:=q||jsonb_build_object('status','done','processed_at',clock_timestamp());
 perform person_private.refresh_write(p_id,'refresh_queue',q,newq);
 perform person_private.refresh_write(p_id,'person_refresh_attempts',e.expected_attempt,p_attempt);
 return person_private.refresh_set(to_jsonb(e),to_jsonb(e)||jsonb_build_object('expected_queue',newq,'expected_attempt',p_attempt,'archives',archives));
end$$;
create function person_private.refresh_save_complete(p_id uuid) returns jsonb language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.refresh_saves;e person_private.refresh_lifecycles;c jsonb;r jsonb;a jsonb;
begin
 s:=person_private.refresh_save_context(p_id);e:=person_private.refresh_context(p_id);
 select to_jsonb(x) into c from public.candidates x where id=s.candidate_id;
 if not person_private.refresh_save_current_valid(s) or not person_private.refresh_save_attributions_valid(s) or not s.normalized or s.document is null or s.audit_id is null or (select rev from public.candidate_profile_state where candidate_id=s.candidate_id) is distinct from s.prepared_revision or
 (s.mode='shadow' and c is distinct from s.candidate_before) or (s.mode='live' and (s.projection is null or not s.metadata_done or not s.enqueue_done or s.candidate_after is distinct from c or (select to_jsonb(j) from public.person_derivative_jobs j where candidate_id=s.candidate_id) is distinct from s.derivative_job)) then raise exception 'refresh_save_incomplete';end if;
 r:=jsonb_build_object('status','done','candidateId',s.candidate_id,'projected',coalesce((s.projection->>'projected')::boolean,false),'semanticChanged',coalesce((s.projection->>'semanticChanged')::boolean,false),'changed',s.normalization_result->>'status'<>'unchanged' or coalesce((s.projection->>'projected')::boolean,false),'revision',s.prepared_revision::text);
 a:=e.expected_attempt||jsonb_build_object('phase','done','lease_until',null,'documents',jsonb_build_array(s.document),'result',r,'error_code',null,'updated_at',clock_timestamp());
 e:=person_private.refresh_save_terminal(p_id,a);
 perform person_private.refresh_context(p_id);
 s:=person_private.refresh_save_set(to_jsonb(s),to_jsonb(s)||jsonb_build_object('candidate_after',c,'result',r,'completed_at',clock_timestamp()));
 e:=person_private.refresh_set(to_jsonb(e),to_jsonb(e)||jsonb_build_object('phase','done','recovery_result',r));
 if person_private.refresh_save_completion_valid(p_id,false) is distinct from true then raise exception 'refresh_save_incomplete';end if;
 perform person_private.refresh_work_status(p_id,'completed');
 if person_private.refresh_save_completion_valid(p_id) is distinct from true then raise exception 'refresh_save_incomplete';end if;
 return r;
end$$;
create function person_private.refresh_save_deferred() returns trigger language plpgsql security definer set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$begin
 if person_private.refresh_save_completion_valid(new.id) is distinct from true then raise exception 'refresh_save_incomplete';end if;return null;
end$$;
create constraint trigger refresh_save_complete after insert or update on person_private.refresh_saves deferrable initially deferred for each row execute function person_private.refresh_save_deferred();
create index refresh_save_candidate on person_private.refresh_saves(candidate_id);
create index refresh_audit_candidate on person_private.refresh_audit_operations(candidate_id,captured_version);
do $$declare d text;begin
 d:=pg_get_viewdef('person_private.certified_audit_operations'::regclass,true);
 d:=regexp_replace(d,';[[:space:]]*$','');
 execute 'create or replace view person_private.certified_audit_operations with(security_invoker=true) as '||d||
 ' union all select a.operation_id,a.work_id,a.candidate_id,a.transaction_id,a.captured_version,a.creator_event_id from person_private.refresh_audit_operations a join person_private.refresh_saves s on s.id=a.execution_id where a.operation_id=s.audit_id and a.work_id=s.work_id and a.candidate_id=s.candidate_id and a.transaction_id=s.transaction_id and a.captured_version::text=s.audit_operation->''evidence''->''guard''->>''captured_version'' and a.creator_event_id is null and person_private.refresh_save_completion_valid(s.id)';
end$$;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='person_private'::regnamespace and proname like 'refresh_save_%' loop execute format('revoke all on function %s from public,anon,authenticated,service_role',p);end loop;end$$;

create table person_private.refresh_projection_frames(
 backend_pid integer not null,transaction_id xid8 not null,work_id uuid not null,candidate_id uuid not null,
 operation_id uuid not null,before_profile jsonb not null,after_profile jsonb not null,
 execution_id uuid not null references person_private.refresh_saves(id),primary key(backend_pid,transaction_id)
);
alter table person_private.refresh_projection_frames enable row level security;
revoke all on person_private.refresh_projection_frames from public,anon,authenticated,service_role;
create function person_private.refresh_projection_family() returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from person_private.transition_work where id=nullif(current_setting('person.work_id',true),'')::uuid and family='refresh')
$$;
create or replace function person_private.projection_owner(p_execution uuid) returns void language plpgsql set search_path='' as $$begin
 if p_execution is null then perform person_private.application_context();
 elsif person_private.refresh_projection_family() then perform person_private.refresh_save_context(p_execution);
 else perform person_private.directory_context(p_execution);end if;
end$$;
create or replace function person_private.projection_frame() returns person_private.application_projection_frames language plpgsql security definer set search_path='' as $$
declare f person_private.application_projection_frames;d person_private.directory_projection_frames;e person_private.directory_executions;r person_private.refresh_projection_frames;s person_private.refresh_saves;
begin
 select * into f from person_private.application_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 select * into d from person_private.directory_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 select * into r from person_private.refresh_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if (f.backend_pid is not null)::int+(d.backend_pid is not null)::int+(r.backend_pid is not null)::int>1 then raise exception 'projection_nested';end if;
 if d.backend_pid is not null then
  e:=person_private.directory_context(d.execution_id);
  if (e.mode<>'live' and e.creation_execution_id is null) or e.work_id<>d.work_id or e.candidate_id is distinct from d.candidate_id or e.audit_id is distinct from d.operation_id then raise exception 'directory_projection_frame';end if;
  f:=row(d.backend_pid,d.transaction_id,d.work_id,d.candidate_id,d.operation_id,d.before_profile,d.after_profile)::person_private.application_projection_frames;
 elsif r.backend_pid is not null then
  s:=person_private.refresh_save_context(r.execution_id);
  if s.mode<>'live' or not s.normalized or s.work_id<>r.work_id or s.candidate_id is distinct from r.candidate_id or s.audit_id is distinct from r.operation_id then raise exception 'refresh_projection_frame';end if;
  f:=row(r.backend_pid,r.transaction_id,r.work_id,r.candidate_id,r.operation_id,r.before_profile,r.after_profile)::person_private.application_projection_frames;
 end if;
 if f.backend_pid is null then raise exception 'projection_frame';end if;return f;
end$$;
do $$declare d text;n text;sig text;begin
 d:=pg_get_functiondef('person_private.projection_frame_clear(uuid)'::regprocedure);
 n:=' else delete from person_private.directory_projection_frames';
 if position(n in d)=0 then raise exception 'refresh_projection_definition';end if;
 execute replace(d,n,' elsif person_private.refresh_projection_family() then delete from person_private.refresh_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id(); if exists(select 1 from person_private.refresh_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception ''refresh_projection_cleanup'';end if;'||n);
 d:=pg_get_functiondef('person_private.projection_frame_set(uuid,uuid,uuid,uuid,jsonb,jsonb,boolean)'::regprocedure);
 n:=' else insert into person_private.directory_projection_frames';
 if position(n in d)=0 then raise exception 'refresh_projection_definition';end if;
 d:=replace(d,n,' elsif person_private.refresh_projection_family() then insert into person_private.refresh_projection_frames values(pg_backend_pid(),pg_current_xact_id(),p_work,p_candidate,p_operation,p_before,p_after,p_execution);'||n);
 execute d;
 n:='exists(select 1 from person_private.directory_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())';
 foreach sig in array array['person_private.projection_frame_set(uuid,uuid,uuid,uuid,jsonb,jsonb,boolean)','person_private.projection_apply(uuid,uuid,uuid,uuid,bigint,jsonb)','person_private.intake_mutation_guard()','person_private.conflict_insert(text,uuid[],jsonb,text,uuid)'] loop
  d:=pg_get_functiondef(sig::regprocedure);if position(n in d)=0 then raise exception 'refresh_projection_definition';end if;
  execute replace(d,n,n||' or exists(select 1 from person_private.refresh_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())');
 end loop;
end$$;
create function person_private.refresh_save_project(p_id uuid,p_envelope jsonb) returns jsonb language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.refresh_saves;r jsonb;c jsonb;
begin
 s:=person_private.refresh_save_context(p_id);
 if s.mode<>'live' or not s.normalized or s.projection is not null or s.prepared_revision is null then raise exception 'refresh_projection_order';end if;
 r:=person_private.projection_apply(s.id,s.work_id,s.candidate_id,s.audit_id,s.prepared_revision,p_envelope);
 s:=person_private.refresh_save_context(p_id);
 r:=r||jsonb_build_object('state',(select to_jsonb(x) from public.person_projection_state x where candidate_id=s.candidate_id),'history',(select to_jsonb(x) from public.person_projection_history x where id=(r->>'historyId')::bigint));
 select to_jsonb(x) into c from public.candidates x where id=s.candidate_id;
 perform person_private.refresh_save_set(to_jsonb(s),to_jsonb(s)||jsonb_build_object('projection',r,'candidate_after',c));
 return r;
end$$;
create function person_private.refresh_attribution_context(p_event bigint,p_operation uuid,p_scope text) returns uuid language plpgsql set search_path='' as $$
declare a person_private.refresh_audit_operations;s person_private.refresh_saves;o public.person_audit_operations;ev public.person_change_events;
begin
 select * into a from person_private.refresh_audit_operations where operation_id=p_operation;
 s:=person_private.refresh_save_context(a.execution_id);
 select * into o from public.person_audit_operations where id=p_operation;
 select * into ev from public.person_change_events where id=p_event;
 if s.mode<>'live' or s.audit_id is distinct from p_operation or a.work_id<>s.work_id or a.candidate_id<>s.candidate_id or a.transaction_id<>pg_current_xact_id() or o.transaction_id is distinct from a.transaction_id or a.operation_hash is distinct from person_private.directory_operation_hash(o) or ev.id is null or ev.id<=a.captured_version or ev.candidate_id<>s.candidate_id or ev.transaction_id is distinct from a.transaction_id or ev.source_table<>'candidates' or ev.source_row_id<>s.candidate_id::text or ev.operation<>'UPDATE' or p_scope not in ('profile','refresh_metadata') then raise exception 'refresh_attribution_scope';end if;
 return s.id;
end$$;
do $$declare d text;n text;begin
 d:=pg_get_functiondef('person_private.attribute_change(bigint,uuid,text)'::regprocedure);
 n:=' if exists(select 1 from person_private.directory_audit_operations where operation_id=p_operation) then';
 if position(n in d)=0 or position('directory_id uuid;' in d)=0 then raise exception 'refresh_attribution_definition';end if;
 d:=replace(d,'directory_id uuid;','directory_id uuid;refresh_id uuid;');
 d:=replace(d,n,' if exists(select 1 from person_private.refresh_audit_operations where operation_id=p_operation) then refresh_id:=person_private.refresh_attribution_context(p_event,p_operation,p_scope); elsif exists(select 1 from person_private.directory_audit_operations where operation_id=p_operation) then');
 d:=replace(d,' if directory_id is not null then',' if refresh_id is not null then perform person_private.refresh_save_context(refresh_id);elsif directory_id is not null then');execute d;
end$$;

create table person_private.refresh_metadata_frames(
 backend_pid integer not null,transaction_id xid8 not null,execution_id uuid not null references person_private.refresh_saves(id),
 before_row jsonb not null,after_row jsonb not null,before_seen boolean not null default false,after_seen boolean not null default false,primary key(backend_pid,transaction_id)
);
alter table person_private.refresh_metadata_frames enable row level security;
revoke all on person_private.refresh_metadata_frames from public,anon,authenticated,service_role;
create function person_private.refresh_metadata_check(p_old jsonb,p_new jsonb,p_when text,p_op text) returns void language plpgsql set search_path='' as $$
declare f person_private.refresh_metadata_frames;s person_private.refresh_saves;
begin
 select * into f from person_private.refresh_metadata_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 s:=person_private.refresh_save_context(f.execution_id);
 if s.mode<>'live' or s.projection is null or s.metadata_done or p_op<>'UPDATE' or f.before_row is distinct from p_old or f.after_row is distinct from p_new or p_new->>'id' is distinct from s.candidate_id::text or
 p_new-array['linkedin_enrichment_date','calculated_experience_years','updated_at'] is distinct from p_old-array['linkedin_enrichment_date','calculated_experience_years','updated_at'] or
 exists(select 1 from person_private.intake_mutation_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or exists(select 1 from person_private.application_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or exists(select 1 from person_private.directory_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or exists(select 1 from person_private.refresh_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or exists(select 1 from person_private.directory_candidate_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'refresh_metadata_frame';end if;
 if p_when='BEFORE' then
  if f.before_seen or f.after_seen then raise exception 'refresh_metadata_reentry';end if;
  update person_private.refresh_metadata_frames set before_seen=true where backend_pid=f.backend_pid and transaction_id=f.transaction_id;
 else
  if not f.before_seen or f.after_seen then raise exception 'refresh_metadata_reentry';end if;
  update person_private.refresh_metadata_frames set after_seen=true where backend_pid=f.backend_pid and transaction_id=f.transaction_id;
 end if;
end$$;
do $$declare d text;n text:=E'begin\n';begin
 d:=pg_get_functiondef('person_private.intake_mutation_guard()'::regprocedure);
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'refresh_metadata_definition';end if;
 execute replace(d,n,n||E' if tg_table_name=''candidates'' and exists(select 1 from person_private.refresh_metadata_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then perform person_private.refresh_metadata_check(o,n,tg_when,tg_op);return new;end if;\n');
end$$;
create function person_private.refresh_save_metadata(p_id uuid,p_years numeric) returns void language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.refresh_saves;e person_private.refresh_lifecycles;c jsonb;target jsonb;actual jsonb;returned jsonb;boundary bigint;event_id bigint;f person_private.refresh_metadata_frames;
begin
 s:=person_private.refresh_save_context(p_id);select * into e from person_private.refresh_lifecycles where request_id=p_id;
 select to_jsonb(x) into c from public.candidates x where id=s.candidate_id;
 if s.mode<>'live' or s.projection is null or s.metadata_done or c is distinct from s.candidate_after or (p_years is not null and (p_years<0 or p_years>1000 or p_years<>round(p_years))) then raise exception 'refresh_metadata_order';end if;
 if not exists(select 1 from public.candidate_sources cs where cs.candidate_id=s.candidate_id and cs.source='harvest' and cs.source_ref=s.document->'source'->>'source_ref' and cs.payload_hash=s.document->'source'->>'payload_hash' and cs.parser_version=s.document->'source'->>'parser_version' and cs.fetched_at=(s.document->'source'->>'fetched_at')::timestamptz and cs.enrichment_id=(e.source_snapshot->>'id')::uuid) then raise exception 'refresh_metadata_source';end if;
 target:=c||jsonb_build_object('linkedin_enrichment_date',greatest((c->>'linkedin_enrichment_date')::timestamptz,(e.source_snapshot->>'created_at')::timestamptz),'calculated_experience_years',coalesce(p_years,(c->>'calculated_experience_years')::numeric));
 if person_private.refresh_save_frames_present() then raise exception 'refresh_metadata_nested';end if;
 if target is distinct from c then
  target:=target||jsonb_build_object('updated_at',clock_timestamp());
  select coalesce(max(id),0) into boundary from public.person_change_events where candidate_id=s.candidate_id;
  insert into person_private.refresh_metadata_frames(backend_pid,transaction_id,execution_id,before_row,after_row) values(pg_backend_pid(),pg_current_xact_id(),p_id,c,target);
  update public.candidates set linkedin_enrichment_date=(target->>'linkedin_enrichment_date')::timestamptz,calculated_experience_years=(target->>'calculated_experience_years')::numeric,updated_at=(target->>'updated_at')::timestamptz where id=s.candidate_id returning to_jsonb(candidates) into returned;
  select to_jsonb(x) into actual from public.candidates x where id=s.candidate_id;
  select * into f from person_private.refresh_metadata_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
  if returned is distinct from target or actual is distinct from target or f.execution_id is distinct from p_id or f.before_row is distinct from c or f.after_row is distinct from target or not coalesce(f.before_seen and f.after_seen,false) then raise exception 'refresh_metadata_actual';end if;
  select id into strict event_id from public.person_change_events where candidate_id=s.candidate_id and source_table='candidates' and transaction_id=pg_current_xact_id() and id>boundary;
  perform person_private.attribute_change(event_id,s.audit_id,'refresh_metadata');
  delete from person_private.refresh_metadata_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
  if exists(select 1 from person_private.refresh_metadata_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'refresh_metadata_cleanup';end if;
 end if;
 s:=person_private.refresh_save_context(p_id);
 perform person_private.refresh_save_set(to_jsonb(s),to_jsonb(s)||jsonb_build_object('metadata_done',true,'candidate_after',target));
end$$;
-- Preserve the shared derivative writer. Only its family ownership branch changes.
do $$declare d text;n text;begin
 d:=pg_get_functiondef('person_private.derivative_enqueue(uuid,uuid,text,jsonb,jsonb)'::regprocedure);
 n:=' if p_execution is not null then';
 if position(n in d)=0 or position('declare e person_private.directory_executions;' in d)=0 then raise exception 'refresh_derivative_definition';end if;
 d:=replace(d,'declare e person_private.directory_executions;','declare e person_private.directory_executions;refresh_save person_private.refresh_saves;');
 d:=replace(d,n,E' if p_execution is not null and person_private.refresh_projection_family() then\n  refresh_save:=person_private.refresh_save_context(p_execution);wid:=refresh_save.work_id;\n  if refresh_save.mode<>''live'' or not refresh_save.metadata_done or refresh_save.enqueue_done or refresh_save.candidate_id is distinct from p_candidate or p_receipt is distinct from ''refresh:''||refresh_save.queue_id::text or p_before is distinct from refresh_save.candidate_after then raise exception ''refresh_derivative_scope'';end if;\n elsif p_execution is not null then');
 execute d;
end$$;
create function person_private.refresh_save_enqueue(p_id uuid,p_before jsonb,p_data jsonb) returns void language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.refresh_saves;job jsonb;
begin
 s:=person_private.refresh_save_context(p_id);
 job:=person_private.derivative_enqueue(p_id,s.candidate_id,'refresh:'||s.queue_id::text,p_before,p_data);
 perform person_private.refresh_save_context(p_id);
 perform person_private.refresh_save_set(to_jsonb(s),to_jsonb(s)||jsonb_build_object('enqueue_done',true,'derivative_job',job));
end$$;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='person_private'::regnamespace and (proname like 'refresh_save_%' or proname in ('refresh_projection_family','refresh_attribution_context','refresh_metadata_check')) loop execute format('revoke all on function %s from public,anon,authenticated,service_role',p);end loop;end$$;

-- Exact current-transaction witnesses are separate from immutable replay proof.
create function person_private.refresh_save_frames_present() returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from person_private.refresh_metadata_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
 or exists(select 1 from person_private.refresh_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
 or exists(select 1 from person_private.refresh_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
 or exists(select 1 from person_private.normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
 or exists(select 1 from person_private.directory_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
 or exists(select 1 from person_private.application_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
 or exists(select 1 from person_private.directory_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
 or exists(select 1 from person_private.intake_mutation_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
 or exists(select 1 from person_private.directory_candidate_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
$$;
create function person_private.refresh_save_current_valid(s person_private.refresh_saves) returns boolean language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
begin
 return s.transaction_id=pg_current_xact_id() and s.backend_pid=pg_backend_pid() and not person_private.refresh_save_frames_present() and
 exists(select 1 from person_private.transition_work where id=s.work_id and lease_until>clock_timestamp()) and
 (select to_jsonb(x) from public.candidates x where id=s.candidate_id)=coalesce(s.candidate_after,s.candidate_before) and
 s.normalized_state is not null and s.normalized_source is not null and
 (select to_jsonb(x) from public.candidate_profile_state x where candidate_id=s.candidate_id)=s.normalized_state and
 (select to_jsonb(x) from public.candidate_sources x where id=(s.normalized_source->>'id')::uuid)=s.normalized_source and
 (s.mode='shadow' or (
  (select to_jsonb(x) from public.person_projection_state x where candidate_id=s.candidate_id)=s.projection->'state' and
  (s.projection->>'historyId' is null or (select to_jsonb(x) from public.person_projection_history x where id=(s.projection->>'historyId')::bigint)=s.projection->'history') and
  (select to_jsonb(x) from public.person_derivative_jobs x where candidate_id=s.candidate_id)=s.derivative_job));
end$$;
create function person_private.refresh_save_attributions_valid(s person_private.refresh_saves) returns boolean language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare item jsonb;event_row jsonb;attribution_row jsonb;
begin
 for item in select value from jsonb_array_elements(s.attributions) loop
  select to_jsonb(e) into event_row from public.person_change_events e where id=(item->'event'->>'id')::bigint;
  select to_jsonb(a) into attribution_row from public.person_change_attributions a where event_id=(item->'event'->>'id')::bigint;
  if event_row-'reconciled_at' is distinct from item->'event' or attribution_row is distinct from item->'attribution' then return false;end if;
 end loop;
 return true;
end$$;
create function person_private.refresh_save_attribution_record(p_id uuid,p_event bigint,p_operation uuid,p_scope text) returns void language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.refresh_saves;e public.person_change_events;a jsonb;expected jsonb;changed text[];
begin
 s:=person_private.refresh_save_context(p_id);
 changed:=person_private.validate_change_attribution(p_event,p_operation,p_scope);
 select * into strict e from public.person_change_events where id=p_event;
 expected:=jsonb_build_object('event_id',e.id,'candidate_id',s.candidate_id,'operation_id',s.audit_id,'scope',p_scope,'changed_fields',changed,'event_hash',md5(jsonb_build_array(e.id,e.candidate_id,e.source_table,e.source_row_id,e.operation,e.transaction_id::text,e.previous_payload,e.payload)::text));
 select to_jsonb(x) into a from public.person_change_attributions x where event_id=p_event;
 if a is null or a-'created_at' is distinct from expected or exists(select 1 from jsonb_array_elements(s.attributions) x where x->'event'->>'id'=p_event::text) then raise exception 'refresh_attribution_actual';end if;
 perform person_private.refresh_save_set(to_jsonb(s),to_jsonb(s)||jsonb_build_object('attributions',s.attributions||jsonb_build_array(jsonb_build_object('event',to_jsonb(e)-'reconciled_at','attribution',a))));
end$$;
do $$declare d text;n text:=' if refresh_id is not null then perform person_private.refresh_save_context(refresh_id);';begin
 d:=pg_get_functiondef('person_private.attribute_change(bigint,uuid,text)'::regprocedure);
 if position(n in d)=0 then raise exception 'refresh_attribution_definition';end if;
 execute replace(d,n,' if refresh_id is not null then perform person_private.refresh_save_attribution_record(refresh_id,p_event,p_operation,p_scope);');
end$$;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='person_private'::regnamespace and proname like 'refresh_save_%' loop execute format('revoke all on function %s from public,anon,authenticated,service_role',p);end loop;end$$;
