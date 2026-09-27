-- PREPARED ONLY. DB-minted application audit authority; no source/projection cutover.
set local lock_timeout='2s';
set local statement_timeout='30s';
create table person_private.certified_audit_anchors(
 candidate_id uuid primary key references public.person_audit_anchors(candidate_id),
 anchor_hash text not null
);
create table person_private.application_audit_operations(
 operation_id uuid primary key references public.person_audit_operations(id),
 work_id uuid not null references person_private.application_work(work_id),
 candidate_id uuid not null,
 transaction_id xid8 not null default pg_current_xact_id(),
 captured_version bigint not null,
 creator_event_id bigint
);
create index application_audit_operations_candidate_idx on person_private.application_audit_operations(candidate_id,captured_version desc,operation_id);
create table person_private.audit_proof_frames(
 backend_pid integer not null,transaction_id xid8 not null,
 kind text not null,candidate_id uuid,
 primary key(backend_pid,transaction_id,kind)
);
do $$declare t text;begin
 foreach t in array array['certified_audit_anchors','application_audit_operations','audit_proof_frames'] loop
  execute format('alter table person_private.%I enable row level security',t);
  execute format('revoke all on person_private.%I from public,anon,authenticated,service_role',t);
 end loop;
end$$;

-- Genuine capture/epoch writes already execute in private definer triggers.
-- Do not acquire controller/work locks from those AFTER-trigger positions.
revoke insert,update,delete,truncate on public.person_change_events from public,anon,authenticated,service_role;
grant update(reconciled_at) on public.person_change_events to service_role;
revoke insert,update,truncate on public.person_change_queue from public,anon,authenticated,service_role;
revoke insert,update,delete,truncate on public.person_audit_epochs,public.person_postcutover_lookup_epochs from public,anon,authenticated,service_role;
revoke insert,update,delete,truncate on public.person_change_attributions from public,anon,authenticated,service_role;
revoke insert on public.person_source_holds from public,anon,authenticated,service_role;
revoke truncate on public.person_audit_anchors,public.person_audit_operations,public.person_source_holds from public,anon,authenticated,service_role;

create function person_private.audit_proof_frame(p_kind text,p_candidate uuid default null) returns void
language sql security definer set search_path='' as $$
 insert into person_private.audit_proof_frames values(pg_backend_pid(),pg_current_xact_id(),p_kind,p_candidate)
$$;
create function person_private.audit_proof_clear(p_kind text) returns void
language sql security definer set search_path='' as $$
 delete from person_private.audit_proof_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and kind=p_kind
$$;
create function person_private.audit_proof_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare f person_private.audit_proof_frames;
begin
 if tg_level='STATEMENT' then
  if not person_private.normalization_gate() then return null;end if;
 else
  if not person_private.normalization_required() then return new;end if;
 end if;
 select * into f from person_private.audit_proof_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and kind=tg_table_name;
 if not found or tg_op<>'INSERT' then raise exception 'audit_proof_frame';end if;
 if tg_level='ROW' and f.candidate_id is not null and new.candidate_id is distinct from f.candidate_id then raise exception 'audit_proof_candidate';end if;
 return new;
end$$;
do $$declare t text;begin
 foreach t in array array['person_audit_anchors','person_audit_operations','person_change_attributions'] loop
  execute format('create trigger person_application_proof_statement before insert or update or delete on public.%I for each statement execute function person_private.audit_proof_guard()',t);
  execute format('create trigger person_application_proof_row before insert or update or delete on public.%I for each row execute function person_private.audit_proof_guard()',t);
 end loop;
end$$;
create function person_private.audit_proof_maintenance() returns trigger
language plpgsql security definer set search_path='' as $$
begin if person_private.normalization_gate() then raise exception 'audit_proof_maintenance';end if;return null;end$$;
create trigger person_application_capture_reconciliation before update or delete on public.person_change_events for each statement execute function person_private.audit_proof_maintenance();
create trigger person_application_queue_reconciliation before delete on public.person_change_queue for each statement execute function person_private.audit_proof_maintenance();
create trigger person_application_source_hold before update or delete on public.person_source_holds for each statement execute function person_private.audit_proof_maintenance();
-- There is no application TRUNCATE use, even with enforcement off. Reject it
-- without taking controller locks after TRUNCATE's access-exclusive table lock.
create function person_private.audit_proof_no_truncate() returns trigger
language plpgsql set search_path='' as $$begin raise exception 'audit_proof_truncate';end$$;
do $$declare t text;begin
 foreach t in array array['person_change_events','person_change_queue','person_audit_anchors','person_audit_operations','person_change_attributions','person_audit_epochs','person_postcutover_lookup_epochs','person_source_holds','candidate_sources','candidate_profile_state','candidate_identities','candidate_experiences','candidate_educations','candidate_skills','candidate_contacts','companies','schools','skills'] loop
  execute format('create trigger person_proof_no_truncate before truncate on public.%I for each statement execute function person_private.audit_proof_no_truncate()',t);
 end loop;
end$$;
revoke all on function person_private.audit_proof_no_truncate() from public,anon,authenticated,service_role;
-- Gate-only, not source authorization. Acquire before originating row/FK locks,
-- including candidate DELETE cascading into the guarded queue reconciliation.
create function person_private.audit_source_statement_gate() returns trigger
language plpgsql security definer set search_path='' as $$
begin perform person_private.transition_lock();return null;end$$;
do $$declare t text;begin
 foreach t in array array['candidates','candidate_emails','candidate_enrichments','website_applications','candidate_communications'] loop
  execute format('create trigger person_source_statement_gate before insert or update or delete on public.%I for each statement execute function person_private.audit_source_statement_gate()',t);
end loop;
end$$;

-- Direct PostgreSQL writers may use an owner connection too. ACLs are a second
-- layer: genuine trigger bodies get private synchronous markers; raw proof DML
-- still fails when armed. These internal inserts never acquire controller locks.
create function person_private.audit_internal_proof_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from person_private.audit_proof_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and kind=tg_table_name) then return coalesce(new,old);end if;
 if tg_level='STATEMENT' then
  if person_private.normalization_gate() then raise exception 'audit_internal_proof';end if;
 elsif person_private.normalization_required() then raise exception 'audit_internal_proof';end if;
 return coalesce(new,old);
end$$;
do $$declare t text;events text;begin
 foreach t in array array['person_change_events','person_change_queue','person_audit_epochs','person_postcutover_lookup_epochs','person_source_holds'] loop
  events:=case when t='person_change_queue' then 'insert or update' else 'insert' end;
  execute format('create trigger person_internal_proof_statement before %s on public.%I for each statement execute function person_private.audit_internal_proof_guard()',events,t);
  execute format('create trigger person_internal_proof_row before %s on public.%I for each row execute function person_private.audit_internal_proof_guard()',events,t);
 end loop;
end$$;
do $$declare r record;definition text;opening text;closing text;k text;
begin
 for r in select * from (values
  ('capture_change',array['person_change_events','person_change_queue'],array['public.candidates','public.candidate_emails','public.candidate_enrichments','public.website_applications','public.candidate_communications']),
  ('audit_epoch',array['person_audit_epochs'],array['public.person_application_receipts','public.person_refresh_attempts','public.person_directory_receipts','public.person_recruiter_receipts','public.person_directory_state','public.person_directory_primary','public.person_recruiter_primary','public.person_audit_anchors','public.person_audit_operations','public.person_change_attributions','public.candidate_contacts','public.candidate_identities','public.candidate_educations','public.candidate_skills','public.candidate_profile_state','public.candidate_sources','public.candidate_experiences','person_private.application_preference_decisions']),
  ('postcutover_attribution_reference_epoch',array['person_audit_epochs'],array['public.person_change_attributions']),
  ('postcutover_lookup_epoch',array['person_postcutover_lookup_epochs'],array['public.companies','public.schools','public.skills']),
  ('hold_cache_date',array['person_source_holds'],array['public.candidate_enrichments']),
  ('hold_existing_cache_dates',array['person_source_holds'],array['public.candidates'])
 ) x(fn,kinds,origins) loop
  definition:=pg_get_functiondef(('person_private.'||r.fn||'()')::regprocedure);
  if array_length(string_to_array(definition,E'\nbegin\n'),1)<>2 or position('audit_proof_frame' in definition)>0 or position('return null;' in definition)=0 then raise exception 'audit_trigger_definition_changed';end if;
  opening:=format(' if not (tg_table_schema||''.''||tg_table_name)=any(%L::text[]) then raise exception ''audit_trigger_origin'';end if;',r.origins)||chr(10);
  closing:='';
  foreach k in array r.kinds loop
   opening:=opening||format(' perform person_private.audit_proof_frame(%L);',k)||chr(10);
   closing:=closing||format('perform person_private.audit_proof_clear(%L);',k);
  end loop;
  definition:=replace(definition,E'\nbegin\n',E'\nbegin\n'||opening);
  definition:=replace(definition,'return null;',closing||'return null;');
  execute definition;
  execute format('revoke all on function person_private.%I() from public,anon,authenticated,service_role',r.fn);
 end loop;
end$$;
revoke all on function person_private.audit_internal_proof_guard() from public,anon,authenticated,service_role;

-- Only a newly checked legacy anchor can acquire certification. A raw preexisting
-- public anchor cannot use the old RPC's unchanged shortcut to become authority.
alter function public.person_audit_anchor_commit(jsonb) rename to audit_anchor_commit_core;
alter function public.audit_anchor_commit_core(jsonb) set schema person_private;
revoke all on function person_private.audit_anchor_commit_core(jsonb) from public,anon,authenticated,service_role;
create function public.person_audit_anchor_commit(p_items jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;x jsonb;
begin
 if person_private.normalization_gate() then raise exception 'audit_proof_maintenance';end if;
 perform person_private.audit_proof_frame('person_audit_anchors');
 result:=person_private.audit_anchor_commit_core(p_items);
 for x in select value from jsonb_array_elements(result) loop
  if x->>'status'='created' then
   insert into person_private.certified_audit_anchors values((x->>'candidate_id')::uuid,x->>'anchor_hash');
  elsif x->>'status'='unchanged' and not exists(select 1 from person_private.certified_audit_anchors where candidate_id=(x->>'candidate_id')::uuid and anchor_hash=x->>'anchor_hash') then raise exception 'audit_anchor_uncertified';
  end if;
 end loop;
 perform person_private.audit_proof_clear('person_audit_anchors');return result;
exception when others then perform person_private.audit_proof_clear('person_audit_anchors');raise;
end$$;

create function public.person_application_audit_begin(p_creation boolean default false) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare a person_private.application_work;b person_private.application_candidates;r public.person_application_receipts;
 anchor public.person_audit_anchors;c jsonb;aux jsonb;payload jsonb;guard jsonb;seed public.person_change_events;
 e record;v bigint;start_v bigint;candidate_hash text;current_hash text;oid uuid:=gen_random_uuid();creator bigint;src jsonb;events_seen integer:=0;checkpoint record;
begin
 a:=person_private.application_source_context();
 select * into b from person_private.application_candidates where work_id=a.work_id;
 if not found then raise exception 'audit_application_binding';end if;
 perform pg_advisory_xact_lock(hashtext(b.candidate_id::text));
 select to_jsonb(x) into c from public.candidates x where id=b.candidate_id for update;
 perform person_private.application_context();
 if c is null then raise exception 'audit_candidate_missing';end if;
 if exists(select 1 from public.person_source_holds where candidate_id=b.candidate_id and resolved_at is null) then raise exception 'audit_source_hold';end if;
 aux:=person_private.audit_auxiliary_proof(b.candidate_id);
 if (aux->>'n')::int>1000 then raise exception 'audit_auxiliary_limit';end if;
 aux:=aux->'proof';
 select coalesce(max(id),0) into v from public.person_change_events where candidate_id=b.candidate_id;
 select * into anchor from public.person_audit_anchors where candidate_id=b.candidate_id;
 if p_creation then
  if anchor.candidate_id is not null or not b.created_person or b.transaction_id<>pg_current_xact_id() or
   exists(select 1 from public.candidate_profile_state where candidate_id=b.candidate_id) or exists(select 1 from public.candidate_sources where candidate_id=b.candidate_id) then raise exception 'audit_creation_not_new';end if;
  select * into r from public.person_application_receipts where application_id=a.application_id and candidate_id=b.candidate_id and created_person;
  if not found then raise exception 'audit_creation_receipt';end if;
  select * into seed from public.person_change_events where candidate_id=b.candidate_id and source_table='candidates' and source_row_id=b.candidate_id::text and operation='INSERT' and previous_payload is null and transaction_id=pg_current_xact_id();
  if not found or (select count(*) from public.person_change_events where candidate_id=b.candidate_id and source_table='candidates' and operation='INSERT' and transaction_id=pg_current_xact_id())<>1 then raise exception 'audit_creation_event';end if;
  if seed.payload->>'id' is distinct from b.candidate_id::text or seed.payload->>'linkedin_username' is distinct from b.linkedin_username or seed.payload->>'linkedin_url' is distinct from person_private.application_identity_url(b.linkedin_username) or seed.payload->>'full_name' is distinct from r.application_snapshot->>'name' or seed.payload->>'source' is distinct from 'website_applicant' then raise exception 'audit_creation_receipt';end if;
  if exists(select 1 from jsonb_each_text(aux) x where x.value<>'d751713988987e9331980363e24189ce') then raise exception 'audit_creation_auxiliary';end if;
  creator:=seed.id;
  payload:=jsonb_build_object('candidate_id',b.candidate_id,'kind','receipt_created','baseline_run',null,'parser_version','person-v3','legacy_doc',null,'before_image',seed.payload,'source_catalog','[]'::jsonb,'revision',0,'captured_version',creator,'creator_ref','application:'||a.application_id::text,'external_proof',aux||jsonb_build_object('creator_event_id',creator::text));
  perform person_private.audit_proof_frame('person_audit_anchors',b.candidate_id);
  insert into public.person_audit_anchors(candidate_id,kind,parser_version,before_image,source_catalog,revision,captured_version,creator_ref,external_proof,anchor_hash)
   values(b.candidate_id,'receipt_created','person-v3',seed.payload,'[]',0,creator,payload->>'creator_ref',payload->'external_proof',person_private.audit_anchor_hash(payload)) returning * into anchor;
  insert into person_private.certified_audit_anchors values(b.candidate_id,anchor.anchor_hash);
  perform person_private.audit_proof_clear('person_audit_anchors');
 end if;
 if anchor.candidate_id is null or anchor.parser_version<>'person-v3' or anchor.before_image->>'id' is distinct from b.candidate_id::text or
  anchor.anchor_hash is distinct from person_private.audit_anchor_hash(to_jsonb(anchor)) or not exists(select 1 from person_private.certified_audit_anchors where candidate_id=b.candidate_id and anchor_hash=anchor.anchor_hash) then raise exception 'audit_anchor_uncertified';end if;
 if exists(select 1 from jsonb_each(aux) x where anchor.external_proof->x.key is distinct from x.value) then raise exception 'audit_auxiliary_changed';end if;
 if anchor.kind='legacy' then
  src:=anchor.legacy_doc->'source';
  if not exists(select 1 from public.candidate_sources where candidate_id=b.candidate_id and source='legacy_import' and source_ref=src->>'source_ref' and payload_hash=src->>'payload_hash' and parser_version=src->>'parser_version' and fetched_at=(src->>'fetched_at')::timestamptz and provider is not distinct from src->>'provider' and raw_in is not distinct from src->>'raw_in' and enrichment_id is not distinct from nullif(src->>'enrichment_id','')::uuid) then raise exception 'audit_anchor_source';end if;
 elsif not p_creation then
  -- Retain the existing audit service's current creator-scope check. A prior
  -- certificate does not excuse a removed event or a transferred application.
  if not exists(select 1 from public.person_application_receipts rr join public.website_applications app on app.id=rr.application_id
   join person_private.application_candidates owner on owner.application_id=rr.application_id and owner.candidate_id=rr.candidate_id
   where 'application:'||rr.application_id::text=anchor.creator_ref and rr.candidate_id=b.candidate_id and rr.created_person and owner.created_person and app.organization_id=a.organization_id) then raise exception 'audit_creation_receipt';end if;
  if not exists(select 1 from public.person_change_events ev join public.person_change_attributions x on x.event_id=ev.id
   join public.person_audit_operations o on o.id=x.operation_id join person_private.application_audit_operations p on p.operation_id=o.id
   where ev.id::text=anchor.external_proof->>'creator_event_id' and ev.candidate_id=b.candidate_id and ev.source_table='candidates' and ev.source_row_id=b.candidate_id::text
   and ev.operation='INSERT' and ev.previous_payload is null and ev.payload->>'id'=b.candidate_id::text and x.scope='creation' and x.candidate_id=b.candidate_id
   and o.candidate_id=b.candidate_id and o.writer='application' and o.receipt_ref=anchor.creator_ref and o.transaction_id=ev.transaction_id
   and p.candidate_id=b.candidate_id and p.transaction_id=ev.transaction_id and p.creator_event_id=ev.id
   and o.evidence->'guard'->>'anchor_hash'=anchor.anchor_hash and o.evidence->>'creator_event_id'=ev.id::text
   and person_private.audit_candidate_hash(ev.payload)=person_private.audit_candidate_hash(anchor.before_image)
   and x.event_hash=md5(jsonb_build_array(ev.id,ev.candidate_id,ev.source_table,ev.source_row_id,ev.operation,ev.transaction_id::text,ev.previous_payload,ev.payload)::text)) then raise exception 'audit_creation_event';end if;
 end if;
 start_v:=anchor.captured_version;candidate_hash:=person_private.audit_candidate_hash(anchor.before_image);
 -- Only this private map certifies a DB-derived checkpoint. Public legacy
 -- operation JSON cannot advance the chain. Bound the interval after the latest
 -- verified checkpoint, so old valid history does not grow without limit.
 select p.captured_version,o.evidence->'guard' proof into checkpoint
 from person_private.application_audit_operations p join public.person_audit_operations o on o.id=p.operation_id
 where p.candidate_id=b.candidate_id and o.candidate_id=b.candidate_id and p.transaction_id=o.transaction_id
 and o.evidence->'guard'->>'anchor_hash'=anchor.anchor_hash and p.captured_version between start_v and v
 order by p.captured_version desc,o.created_at desc,o.id desc limit 1;
 if found then
  if checkpoint.proof->>'version'<>'candidate-audit-1' or checkpoint.proof->>'captured_version' is distinct from checkpoint.captured_version::text or checkpoint.proof->'auxiliary' is distinct from aux then raise exception 'audit_checkpoint_invalid';end if;
  start_v:=checkpoint.captured_version;candidate_hash:=checkpoint.proof->>'candidate_hash';
 end if;
 for e in select ev.*,x.event_id attributed,x.candidate_id attribution_candidate,x.operation_id,x.event_hash,x.scope,
   o.candidate_id operation_candidate,o.transaction_id operation_transaction,o.evidence,
   p.operation_id private_operation,p.captured_version operation_boundary,p.creator_event_id
  from (select * from public.person_change_events where candidate_id=b.candidate_id and source_table='candidates' and id>start_v and id<=v order by id limit 201) ev
  left join public.person_change_attributions x on x.event_id=ev.id left join public.person_audit_operations o on o.id=x.operation_id
  left join person_private.application_audit_operations p on p.operation_id=o.id order by ev.id loop
  if e.operation<>'UPDATE' or e.previous_payload is null or e.source_row_id<>b.candidate_id::text or e.payload->>'id' is distinct from b.candidate_id::text or e.previous_payload->>'id' is distinct from b.candidate_id::text then raise exception 'audit_proof_chain';end if;
  events_seen:=events_seen+1;
  if events_seen>200 then raise exception 'audit_event_limit';end if;
  if person_private.audit_candidate_hash(e.previous_payload) is distinct from candidate_hash then raise exception 'audit_proof_chain';end if;
  current_hash:=person_private.audit_candidate_hash(e.payload);
  if e.attributed is not null then
   if e.private_operation is null or e.attribution_candidate<>b.candidate_id or e.operation_candidate<>b.candidate_id or e.operation_transaction is distinct from e.transaction_id or e.id<=e.operation_boundary or e.evidence->'guard'->>'anchor_hash' is distinct from anchor.anchor_hash or e.event_hash is distinct from md5(jsonb_build_array(e.id,e.candidate_id,e.source_table,e.source_row_id,e.operation,e.transaction_id::text,e.previous_payload,e.payload)::text) then raise exception 'audit_proof_chain';end if;
  elsif candidate_hash is distinct from current_hash then raise exception 'audit_unattributed_change';end if;
  candidate_hash:=current_hash;
 end loop;
 if candidate_hash is distinct from person_private.audit_candidate_hash(c) then raise exception 'audit_proof_chain';end if;
 guard:=jsonb_build_object('version','candidate-audit-1','anchor_hash',anchor.anchor_hash,'candidate_hash',candidate_hash,'captured_version',v::text,'auxiliary',aux);
 perform person_private.audit_proof_frame('person_audit_operations',b.candidate_id);
 insert into public.person_audit_operations(id,candidate_id,writer,receipt_ref,evidence)
  values(oid,b.candidate_id,'application','application:'||a.application_id::text,jsonb_build_object('guard',guard)||case when creator is null then '{}'::jsonb else jsonb_build_object('creator_event_id',creator::text) end);
 insert into person_private.application_audit_operations(operation_id,work_id,candidate_id,captured_version,creator_event_id) values(oid,a.work_id,b.candidate_id,v,creator);
 perform person_private.audit_proof_clear('person_audit_operations');
 if creator is not null then perform person_private.attribute_change(creator,oid,'creation');end if;
 perform person_private.application_context();
 return jsonb_build_object('id',oid,'candidateId',b.candidate_id,'writer','application','receiptRef','application:'||a.application_id::text,'anchorHash',anchor.anchor_hash);
exception when others then perform person_private.audit_proof_clear('person_audit_operations');perform person_private.audit_proof_clear('person_audit_anchors');raise;
end$$;

create function person_private.application_attribution_context(p_event bigint,p_operation uuid,p_scope text) returns void
language plpgsql security definer set search_path='' as $$
declare a person_private.application_work;p person_private.application_audit_operations;o public.person_audit_operations;e public.person_change_events;
begin
 a:=person_private.application_context();
 select * into p from person_private.application_audit_operations where operation_id=p_operation;
 select * into o from public.person_audit_operations where id=p_operation;
 select * into e from public.person_change_events where id=p_event;
 if p.operation_id is null or e.id is null or p.work_id<>a.work_id or p.transaction_id<>pg_current_xact_id() or o.transaction_id<>p.transaction_id or e.transaction_id is distinct from p.transaction_id or p.candidate_id<>e.candidate_id or o.candidate_id<>p.candidate_id or o.writer<>'application' or o.receipt_ref<>'application:'||a.application_id::text then raise exception 'audit_application_scope';end if;
 if p_scope='creation' then
  if p.creator_event_id is distinct from p_event or e.operation<>'INSERT' then raise exception 'audit_application_event';end if;
 elsif e.id<=p.captured_version then raise exception 'audit_application_event';end if;
 if p_scope not in ('creation','profile','application_preferences','application_finalize') or
  (p_scope='application_finalize' and (e.source_table<>'website_applications' or e.source_row_id<>a.application_id::text)) or
  (p_scope<>'application_finalize' and (e.source_table<>'candidates' or e.source_row_id<>p.candidate_id::text)) then raise exception 'audit_application_scope';end if;
end$$;
alter function person_private.attribute_change(bigint,uuid,text) rename to attribute_change_core;
revoke all on function person_private.attribute_change_core(bigint,uuid,text) from public,anon,authenticated,service_role;
create function person_private.attribute_change(p_event bigint,p_operation uuid,p_scope text) returns void
language plpgsql security definer set search_path='' as $$
declare guarded boolean;cid uuid;
begin
 guarded:=person_private.normalization_gate() or exists(select 1 from person_private.application_audit_operations where operation_id=p_operation);
 if guarded then perform person_private.application_attribution_context(p_event,p_operation,p_scope);end if;
 select candidate_id into cid from public.person_audit_operations where id=p_operation;
 perform person_private.audit_proof_frame('person_change_attributions',cid);
 perform person_private.attribute_change_core(p_event,p_operation,p_scope);
 perform person_private.audit_proof_clear('person_change_attributions');
 if guarded then perform person_private.application_context();end if;
exception when others then perform person_private.audit_proof_clear('person_change_attributions');raise;
end$$;
alter function person_private.application_preference_decision(bigint,uuid) rename to application_preference_decision_core;
revoke all on function person_private.application_preference_decision_core(bigint,uuid) from public,anon,authenticated,service_role;
create function person_private.application_preference_decision(p_event bigint,p_operation uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if person_private.normalization_gate() or exists(select 1 from person_private.application_audit_operations where operation_id=p_operation) then
  perform person_private.application_attribution_context(p_event,p_operation,'application_preferences');
  if not exists(select 1 from public.person_change_attributions where event_id=p_event and operation_id=p_operation and scope='application_preferences') then raise exception 'audit_application_event';end if;
 end if;
 perform person_private.application_preference_decision_core(p_event,p_operation);
end$$;
revoke all on function person_private.audit_proof_frame(text,uuid),person_private.audit_proof_clear(text),person_private.audit_proof_guard(),person_private.audit_proof_maintenance(),person_private.audit_source_statement_gate(),person_private.application_attribution_context(bigint,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.person_application_audit_begin(boolean),public.person_audit_anchor_commit(jsonb),person_private.attribute_change(bigint,uuid,text),person_private.application_preference_decision(bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.person_application_audit_begin(boolean),public.person_audit_anchor_commit(jsonb),person_private.attribute_change(bigint,uuid,text),person_private.application_preference_decision(bigint,uuid) to service_role;
