-- PREPARED ONLY. Private direct-writer directory execution; existing people,
-- shadow mode, no external effects. Never grants this capability to service_role.
set local lock_timeout='2s';set local statement_timeout='30s';
create table person_private.directory_executions(
 id uuid primary key,work_id uuid not null unique references person_private.transition_work(id),
 organization_id uuid not null,workspace_id uuid not null,receipt_id bigint not null references person_private.directory_inputs(receipt_id),
 contact_id uuid not null,input_hash text not null,mode text not null check(mode='shadow'),
 backend_pid integer not null,transaction_id xid8 not null,candidate_id uuid references public.candidates(id),
 candidate_before jsonb,identities jsonb,evidence jsonb,decision jsonb,decision_hash text,
 primary_value text,next_document integer not null default 0,changed boolean not null default false,
 audit_id uuid references public.person_audit_operations(id),result jsonb,completed_at timestamptz
);
create index directory_execution_candidate_receipt on person_private.directory_executions(candidate_id,receipt_id desc) where completed_at is not null;
create index directory_execution_receipt on person_private.directory_executions(receipt_id) where completed_at is not null;
create table person_private.directory_normalization_frames(
 backend_pid integer not null,transaction_id xid8 not null,execution_id uuid not null references person_private.directory_executions(id),
 work_id uuid not null references person_private.transition_work(id),candidate_id uuid not null,document jsonb not null,
 primary key(backend_pid,transaction_id)
);
create table person_private.directory_audit_operations(
 operation_id uuid primary key references public.person_audit_operations(id),execution_id uuid not null references person_private.directory_executions(id),
 work_id uuid not null,candidate_id uuid not null,transaction_id xid8 not null,captured_version bigint not null,
 creator_event_id bigint,operation_hash text not null
);
do $$declare t text;begin foreach t in array array['directory_executions','directory_normalization_frames','directory_audit_operations'] loop
 execute format('alter table person_private.%I enable row level security',t);
 execute format('revoke all on person_private.%I from public,anon,authenticated,service_role',t);
end loop;end$$;

-- Row/helper checks deliberately take no locks. Entry points take the controller
-- and work before identity/contact/candidate locks; expiry is checked after waits.
create function person_private.directory_context(p_id uuid) returns person_private.directory_executions
language plpgsql set search_path='' as $$
declare e person_private.directory_executions;w person_private.transition_work;c person_private.transition_control;
begin
 select * into e from person_private.directory_executions where id=p_id;
 select * into w from person_private.transition_work where id=e.work_id;
 select * into c from person_private.transition_control where singleton;
 if e.id is null or e.backend_pid<>pg_backend_pid() or e.transaction_id<>pg_current_xact_id() or e.result is not null or
 w.id is null or w.family<>'directory' or w.scope<>'tt_person' or w.organization_id<>e.organization_id or
 w.resource_key<>'directory:'||e.receipt_id::text||':'||e.id::text or w.input_hash<>e.input_hash or w.status<>'active' or
 w.generation<>c.generation or (c.enabled and c.phase='held') or
 current_setting('person.work_id',true) is distinct from w.id::text or
 w.token_hash is distinct from md5(current_setting('person.work_token',true)) then raise exception 'directory_execution_context';end if;
 if w.lease_until<=clock_timestamp() then raise exception 'transition_expired';end if;
 if not person_private.directory_verify(e.receipt_id) then raise exception 'directory_input_review';end if;
 if e.decision is not null and e.decision_hash is distinct from person_private.intake_hash(jsonb_build_array(e.evidence,e.decision,e.identities,e.primary_value)) then raise exception 'directory_decision_certificate';end if;
 return e;
end$$;

create function person_private.directory_begin(p_org uuid,p_workspace uuid,p_receipt bigint,p_execution uuid,p_mode text,p_token uuid) returns jsonb
language plpgsql set search_path='' set timezone='UTC' as $$
declare c person_private.transition_control;e person_private.directory_executions;r public.person_directory_receipts;w person_private.transition_work;a jsonb;h text;
begin
 c:=person_private.directory_scope(p_org,p_workspace);
 if p_execution is null or p_receipt is null or p_token is null or p_mode is distinct from 'shadow' then raise exception 'directory_execution_input';end if;
 -- Serialize the UUID before work/business locks, including different receipts.
 perform pg_advisory_xact_lock(72014,hashtext(p_execution::text));
 select * into e from person_private.directory_executions where id=p_execution;
 if found then
  if e.organization_id<>p_org or e.workspace_id<>p_workspace or e.receipt_id<>p_receipt or e.mode<>p_mode then raise exception 'directory_execution_binding';end if;
  select * into w from person_private.transition_work where id=e.work_id;
  if e.result is null or e.completed_at is null or w.status is distinct from 'completed' then raise exception 'directory_execution_incomplete';end if;
  return jsonb_build_object('status','completed','result',e.result);
 end if;
 if c.enabled and c.phase<>'open' then raise exception 'directory_held';end if;
 select * into r from public.person_directory_receipts where id=p_receipt;
 if r.id is null or r.workspace_id<>p_workspace or not person_private.directory_verify(p_receipt) then raise exception 'directory_input_review';end if;
 select input_hash into h from person_private.directory_inputs where receipt_id=p_receipt;
 a:=person_private.transition_claim('tt_person',p_org,'directory','directory:'||p_receipt::text||':'||p_execution::text,h,p_token,300);
 if a->>'status' is distinct from 'admitted' then raise exception 'directory_execution_admission';end if;
 perform set_config('person.work_id',a->>'work_id',true);perform set_config('person.work_token',p_token::text,true);
 insert into person_private.directory_executions(id,work_id,organization_id,workspace_id,receipt_id,contact_id,input_hash,mode,backend_pid,transaction_id)
 values(p_execution,(a->>'work_id')::uuid,p_org,p_workspace,p_receipt,r.contact_id,h,p_mode,pg_backend_pid(),pg_current_xact_id());
 e:=person_private.directory_context(p_execution);
 return jsonb_build_object('status','admitted','snapshot',r.snapshot,'workId',e.work_id);
end$$;

create function person_private.directory_capture(p_id uuid) returns jsonb
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;r public.person_directory_receipts;p public.person_directory_receipts;prior jsonb;sources jsonb;header jsonb;proof person_private.directory_executions;
begin
 e:=person_private.directory_context(p_id);
 if e.candidate_id is null then raise exception 'directory_candidate_binding';end if;
 select * into r from public.person_directory_receipts where id=e.receipt_id;
 select * into p from public.person_directory_receipts where candidate_id=e.candidate_id and id<r.id and documents is not null order by id desc limit 1;
 if exists(select 1 from person_private.directory_executions prior_execution where prior_execution.candidate_id=e.candidate_id and prior_execution.receipt_id<r.id and prior_execution.completed_at is not null and (p.id is null or prior_execution.receipt_id>p.id)) then raise exception 'directory_prior_review';end if;
 if p.id is not null then
  select * into proof from person_private.directory_executions x where x.receipt_id=p.id and x.candidate_id=e.candidate_id and x.completed_at is not null and x.result is not null;
  if proof.id is null or not person_private.directory_verify(p.id) or proof.decision_hash is distinct from person_private.intake_hash(jsonb_build_array(proof.evidence,proof.decision,proof.identities,proof.primary_value)) or
   p.documents is distinct from proof.decision->'docs' or p.source_reviews is distinct from proof.decision->'reviews' or not exists(select 1 from person_private.transition_work where id=proof.work_id and status='completed') then raise exception 'directory_prior_review';end if;
  prior:=jsonb_build_object('receiptId',p.id::text,'candidateId',p.candidate_id,'hasDocuments',true,'snapshot',p.snapshot,'sourceReviews',p.source_reviews);
 end if;
 if (select count(*) from public.candidate_sources where candidate_id=e.candidate_id and source='directory' and source_ref=e.contact_id::text)>10000 then raise exception 'directory_source_limit';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'payload_hash',s.payload_hash,'parser_version',s.parser_version,'fetched_at',s.fetched_at) order by s.id),'[]') into sources from public.candidate_sources s where candidate_id=e.candidate_id and source='directory' and source_ref=e.contact_id::text;
 select s.header into header from public.candidate_profile_state s where candidate_id=e.candidate_id;
 return jsonb_build_object('version','directory-admission-1','parserVersion','person-v3','candidateId',e.candidate_id,'receiptId',e.receipt_id::text,'snapshot',r.snapshot,'sources',sources,'header',coalesce(header,'{}'),'prior',prior);
end$$;

create function person_private.directory_bind(p_id uuid,p_candidate uuid,p_identities jsonb) returns jsonb
language plpgsql set search_path='' set timezone='UTC' as $$
declare e person_private.directory_executions;r public.person_directory_receipts;s public.person_directory_state;c jsonb;
begin
 e:=person_private.directory_context(p_id);
 select * into r from public.person_directory_receipts where id=e.receipt_id for update;
 select * into s from public.person_directory_state where contact_id=e.contact_id for update;
 if r.phase<>'ready' or r.documents is not null or r.result is not null or r.candidate_id is not null or r.projected or s.latest_receipt_id<>e.receipt_id or s.workspace_id<>e.workspace_id then raise exception 'directory_receipt_ineligible';end if;
 if r.snapshot->'board'->>'do_not_contact'='true' or r.snapshot->'board'->>'status'='Do Not Contact' then raise exception 'directory_suppression_unavailable';end if;
 if p_candidate is null or jsonb_typeof(p_identities) is distinct from 'array' or jsonb_array_length(p_identities)=0 then raise exception 'directory_candidate_binding';end if;
 perform pg_advisory_xact_lock(hashtext(p_candidate::text));
 select to_jsonb(x) into c from public.candidates x where id=p_candidate for update;
 if c is null or not exists(select 1 from public.candidate_profile_state where candidate_id=p_candidate) then raise exception 'directory_person_not_migrated';end if;
 if c->>'directory_contact_id' is not null and c->>'directory_contact_id'<>e.contact_id::text then raise exception 'directory_linkage_conflict';end if;
 if exists(select 1 from public.person_source_holds where candidate_id=p_candidate and resolved_at is null) then raise exception 'directory_source_hold';end if;
 perform person_private.directory_context(p_id);
 update person_private.directory_executions set candidate_id=p_candidate,candidate_before=c,identities=p_identities where id=p_id;
 return person_private.directory_capture(p_id);
end$$;

create function person_private.directory_seal(p_id uuid,p_evidence jsonb,p_decision jsonb,p_primary text) returns void
language plpgsql set search_path='' as $$
declare e person_private.directory_executions;actual jsonb;
begin
 e:=person_private.directory_context(p_id);actual:=person_private.directory_capture(p_id);
 if e.decision is not null or p_evidence is distinct from actual or jsonb_typeof(p_decision->'docs') is distinct from 'array' or
 jsonb_array_length(p_decision->'docs') not between 1 and 10000 or jsonb_typeof(p_decision->'reviews') is distinct from 'array' or
 exists(select 1 from jsonb_array_elements(p_decision->'docs') d where d->>'candidate_id' is distinct from e.candidate_id::text or d->'source'->>'source' is distinct from 'directory') then raise exception 'directory_decision_input';end if;
 -- The capability belongs only to the server writer running the frozen evaluator.
 -- No client/service RPC accepts arbitrary documents as authority.
 update person_private.directory_executions set evidence=actual,decision=p_decision,primary_value=p_primary,
 decision_hash=person_private.intake_hash(jsonb_build_array(actual,p_decision,identities,p_primary)) where id=p_id;
 perform person_private.directory_context(p_id);
end$$;

create or replace function person_private.normalization_frame(p_candidate uuid default null,p_source uuid default null) returns person_private.normalization_frames
language plpgsql security definer set search_path='' as $$
declare f person_private.normalization_frames;d person_private.directory_normalization_frames;e person_private.directory_executions;
begin
 select * into f from person_private.normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 select * into d from person_private.directory_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if f.backend_pid is not null and d.backend_pid is not null then raise exception 'normalization_nested';end if;
 if d.backend_pid is not null then
  e:=person_private.directory_context(d.execution_id);
  if e.candidate_id is distinct from d.candidate_id or e.work_id is distinct from d.work_id or not exists(select 1 from jsonb_array_elements(e.decision->'docs') doc where doc=d.document) then raise exception 'directory_normalization_frame';end if;
  f:=row(d.backend_pid,d.transaction_id,d.work_id,null,d.candidate_id,d.document)::person_private.normalization_frames;
 end if;
 if f.backend_pid is null or (p_candidate is not null and p_candidate<>f.candidate_id) then raise exception 'normalization_frame';end if;
 if p_source is not null and not exists(select 1 from public.candidate_sources s where s.id=p_source and s.candidate_id=f.candidate_id and s.source=f.document->'source'->>'source' and s.payload_hash=f.document->'source'->>'payload_hash') then raise exception 'normalization_source';end if;
 return f;
end$$;
create function person_private.directory_frame(p_id uuid,p_doc jsonb) returns void
language plpgsql set search_path='' as $$
declare e person_private.directory_executions;f person_private.directory_normalization_frames;
begin
 e:=person_private.directory_context(p_id);
 if exists(select 1 from person_private.normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or exists(select 1 from person_private.directory_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'normalization_nested';end if;
 insert into person_private.directory_normalization_frames values(pg_backend_pid(),pg_current_xact_id(),e.id,e.work_id,e.candidate_id,p_doc);
 select * into f from person_private.directory_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if f.backend_pid is null or f.execution_id is distinct from e.id or f.work_id is distinct from e.work_id or f.candidate_id is distinct from e.candidate_id or f.document is distinct from p_doc then raise exception 'directory_normalization_frame';end if;
 perform person_private.normalization_frame(e.candidate_id);
end$$;
create function person_private.directory_normalize(p_id uuid,p_index integer) returns jsonb
language plpgsql set search_path='' as $$
declare e person_private.directory_executions;doc jsonb;r jsonb;
begin
 e:=person_private.directory_context(p_id);
 if e.audit_id is null or e.decision is null or p_index is distinct from e.next_document or p_index>=jsonb_array_length(e.decision->'docs') then raise exception 'directory_document_order';end if;
 doc:=e.decision->'docs'->p_index;perform person_private.directory_frame(p_id,doc);
 r:=person_private.save_person_core(doc);
 perform person_private.directory_context(p_id);perform person_private.normalization_frame(e.candidate_id);
 delete from person_private.directory_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 update person_private.directory_executions set next_document=next_document+1,changed=changed or r->>'status'<>'unchanged' where id=p_id;
 return r;
exception when others then delete from person_private.directory_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();raise;
end$$;

DO $$declare body text;begin
 body:=pg_get_functiondef('public.save_person(jsonb)'::regprocedure);
 if position('if exists(select 1 from person_private.normalization_frames' in body)=0 then raise exception 'directory_definition';end if;
 body:=replace(body,'if exists(select 1 from person_private.normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then',
 'if exists(select 1 from person_private.normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or exists(select 1 from person_private.directory_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then');
 execute body;
 body:=pg_get_functiondef('person_private.conflict_insert(text,uuid[],jsonb,text,uuid)'::regprocedure);
 body:=replace(body,'select * into f from person_private.normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();',
 'if exists(select 1 from person_private.normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or exists(select 1 from person_private.directory_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then f:=person_private.normalization_frame();end if;');
 execute body;
end$$;

create function person_private.directory_operation_hash(p_operation public.person_audit_operations) returns text
language sql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
 select person_private.intake_hash(to_jsonb(p_operation))
$$;
revoke all on function person_private.directory_operation_hash(public.person_audit_operations) from public,anon,authenticated,service_role;

create view person_private.certified_audit_operations with(security_invoker=true) as
 select operation_id,work_id,candidate_id,transaction_id,captured_version,creator_event_id from person_private.application_audit_operations
 union all
 select d.operation_id,d.work_id,d.candidate_id,d.transaction_id,d.captured_version,d.creator_event_id
 from person_private.directory_audit_operations d join person_private.directory_executions e on e.id=d.execution_id
 join person_private.transition_work w on w.id=e.work_id join public.person_audit_operations o on o.id=d.operation_id
 where e.completed_at is not null and e.result is not null and w.status='completed' and w.family='directory'
 and w.organization_id=e.organization_id and w.resource_key='directory:'||e.receipt_id::text||':'||e.id::text
 and w.input_hash=e.input_hash and d.work_id=e.work_id and d.candidate_id=e.candidate_id and d.transaction_id=e.transaction_id
 and e.audit_id=o.id and o.candidate_id=e.candidate_id and o.transaction_id=e.transaction_id and o.writer='directory'
 and o.receipt_ref='directory:'||e.receipt_id::text and person_private.directory_operation_hash(o)=d.operation_hash;
revoke all on person_private.certified_audit_operations from public,anon,authenticated,service_role;

DO $$declare body text;begin
 body:=pg_get_functiondef('public.person_application_audit_begin(boolean)'::regprocedure);
 body:=replace(body,'from person_private.application_audit_operations p join public.person_audit_operations o','from person_private.certified_audit_operations p join public.person_audit_operations o');
 body:=replace(body,'left join person_private.application_audit_operations p on','left join person_private.certified_audit_operations p on');
 execute body;
end$$;

create function person_private.directory_audit_begin(p_id uuid) returns jsonb
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare dx person_private.directory_executions;anchor public.person_audit_anchors;c jsonb;aux jsonb;guard jsonb;src jsonb;
 e record;v bigint;start_v bigint;candidate_hash text;current_hash text;oid uuid:=gen_random_uuid();events_seen integer:=0;checkpoint record;stored_operation public.person_audit_operations;
begin
 dx:=person_private.directory_context(p_id);
 if dx.candidate_id is null or dx.decision is null or dx.audit_id is not null then raise exception 'directory_audit_binding';end if;
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
  -- Retain the existing audit service's current creator-scope check. A prior
  -- certificate does not excuse a removed event or a transferred application.
  if not exists(select 1 from public.person_application_receipts rr join public.website_applications app on app.id=rr.application_id
   join person_private.application_candidates owner on owner.application_id=rr.application_id and owner.candidate_id=rr.candidate_id
   where 'application:'||rr.application_id::text=anchor.creator_ref and rr.candidate_id=dx.candidate_id and rr.created_person and owner.created_person and app.organization_id=dx.organization_id) then raise exception 'audit_creation_receipt';end if;
  if not exists(select 1 from public.person_change_events ev join public.person_change_attributions x on x.event_id=ev.id
   join public.person_audit_operations o on o.id=x.operation_id join person_private.application_audit_operations p on p.operation_id=o.id
   where ev.id::text=anchor.external_proof->>'creator_event_id' and ev.candidate_id=dx.candidate_id and ev.source_table='candidates' and ev.source_row_id=dx.candidate_id::text
   and ev.operation='INSERT' and ev.previous_payload is null and ev.payload->>'id'=dx.candidate_id::text and x.scope='creation' and x.candidate_id=dx.candidate_id
   and o.candidate_id=dx.candidate_id and o.writer='application' and o.receipt_ref=anchor.creator_ref and o.transaction_id=ev.transaction_id
   and p.candidate_id=dx.candidate_id and p.transaction_id=ev.transaction_id and p.creator_event_id=ev.id
   and o.evidence->'guard'->>'anchor_hash'=anchor.anchor_hash and o.evidence->>'creator_event_id'=ev.id::text
   and person_private.audit_candidate_hash(ev.payload)=person_private.audit_candidate_hash(anchor.before_image)
   and x.event_hash=md5(jsonb_build_array(ev.id,ev.candidate_id,ev.source_table,ev.source_row_id,ev.operation,ev.transaction_id::text,ev.previous_payload,ev.payload)::text)) then raise exception 'audit_creation_event';end if;
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
 insert into public.person_audit_operations(id,candidate_id,writer,receipt_ref,evidence)
 values(oid,dx.candidate_id,'directory','directory:'||dx.receipt_id::text,jsonb_build_object('guard',guard)) returning * into stored_operation;
 insert into person_private.directory_audit_operations values(oid,dx.id,dx.work_id,dx.candidate_id,pg_current_xact_id(),v,null,person_private.directory_operation_hash(stored_operation));
 update person_private.directory_executions set audit_id=oid where id=dx.id;
 perform person_private.audit_proof_clear('person_audit_operations');
 perform person_private.directory_context(p_id);
 return jsonb_build_object('id',oid,'candidateId',dx.candidate_id,'writer','directory','receiptRef','directory:'||dx.receipt_id::text,'anchorHash',anchor.anchor_hash);
exception when others then perform person_private.audit_proof_clear('person_audit_operations');raise;
end$$;
create or replace function person_private.directory_input_guard() returns trigger
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare f person_private.directory_input_frames;protected boolean;
begin
 if tg_table_name='person_directory_receipts' and tg_op<>'INSERT' then
  select exists(select 1 from person_private.directory_inputs where receipt_id=old.id) into protected;
  if protected and (tg_op='DELETE' or person_private.directory_binding(new)::text is distinct from person_private.directory_binding(old)::text) then raise exception 'directory_input_immutable';end if;
  -- Disabled legacy completion remains compatible; required completion must
  -- carry the exact synchronous OLD/NEW mutation frame.
  if tg_op='UPDATE' and person_private.directory_binding(new)::text=person_private.directory_binding(old)::text and not person_private.normalization_required() and not exists(select 1 from person_private.directory_input_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then return new;end if;
 end if;
 select * into f from person_private.directory_input_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if f.backend_pid is null and not person_private.normalization_required() then return coalesce(new,old);end if;
 if f.backend_pid is null or f.relation_name<>tg_table_name or f.operation<>tg_op or
  f.before_row is distinct from (case when tg_op='INSERT' then null else to_jsonb(old) end) or
  f.after_row is distinct from to_jsonb(new) or tg_op='DELETE' then raise exception 'directory_input_frame';end if;
 if tg_when='BEFORE' then
  if f.before_seen or f.after_seen then raise exception 'directory_input_reentry';end if;
  update person_private.directory_input_frames set before_seen=true where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 else
  if not f.before_seen or f.after_seen then raise exception 'directory_input_after';end if;
  update person_private.directory_input_frames set after_seen=true where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 end if;
 return new;
end$$;create or replace function person_private.directory_mutate(p_table text,p_before jsonb,p_after jsonb) returns void
language plpgsql set search_path='' set timezone='UTC' as $$
declare returned jsonb;actual jsonb;f person_private.directory_input_frames;cols text;key text;key_type text;
begin
 if p_table not in ('person_directory_scans','person_directory_receipts','person_directory_state','person_directory_primary') or p_after is null then raise exception 'directory_input_mutation';end if;
 if exists(select 1 from person_private.directory_input_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'directory_input_nested';end if;
 key:=case p_table when 'person_directory_scans' then 'workspace_id' when 'person_directory_state' then 'contact_id' when 'person_directory_primary' then 'candidate_id' else 'id' end;
 key_type:=case when p_table='person_directory_receipts' then 'bigint' else 'uuid' end;
 if p_table='person_directory_primary' and (p_after->>'kind' is distinct from 'email' or (p_before is not null and p_before->>'kind' is distinct from 'email')) then raise exception 'directory_input_key';end if;
 if p_after->>key is null or (p_before is not null and p_before->>key is distinct from p_after->>key) then raise exception 'directory_input_key';end if;
 insert into person_private.directory_input_frames(backend_pid,transaction_id,relation_name,operation,before_row,after_row)
 values(pg_backend_pid(),pg_current_xact_id(),p_table,case when p_before is null then 'INSERT' else 'UPDATE' end,p_before,p_after);
 if p_before is null then
  execute format('insert into public.%I overriding system value select x.* from jsonb_populate_record(null::public.%I,$1) x returning to_jsonb(%I)',p_table,p_table,p_table) into returned using p_after;
 else
  select string_agg(quote_ident(attname),',' order by attnum) into cols from pg_attribute where attrelid=format('public.%I',p_table)::regclass and attnum>0 and not attisdropped and attname<>key;
  execute format('update public.%I set (%s)=(select %s from jsonb_populate_record(null::public.%I,$1)) where %I=($1->>%L)::%s  %s returning to_jsonb(%I)',p_table,cols,cols,p_table,key,key,key_type,case when p_table='person_directory_primary' then 'and kind=''email''' else '' end,p_table) into returned using p_after;
 end if;
 execute format('select to_jsonb(t) from public.%I t where %I=($1->>%L)::%s %s',p_table,key,key,key_type,case when p_table='person_directory_primary' then 'and kind=''email''' else '' end) into actual using p_after;
 select * into f from person_private.directory_input_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if returned is distinct from p_after or actual is distinct from p_after or f.backend_pid is null or
 f.relation_name is distinct from p_table or f.before_row is distinct from p_before or f.after_row is distinct from p_after or
 f.operation is distinct from (case when p_before is null then 'INSERT' else 'UPDATE' end) or not f.before_seen or not f.after_seen then raise exception 'directory_input_result';end if;
 delete from person_private.directory_input_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
end$$;

create trigger person_directory_primary_statement before insert or update or delete or truncate on public.person_directory_primary for each statement execute function person_private.directory_input_statement();
create trigger person_directory_primary_before before insert or update or delete on public.person_directory_primary for each row execute function person_private.directory_input_guard();
create trigger person_directory_primary_after after insert or update or delete on public.person_directory_primary for each row execute function person_private.directory_input_guard();

create function person_private.directory_completion_valid(p_id uuid) returns boolean
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;r public.person_directory_receipts;w person_private.transition_work;
begin
 select * into e from person_private.directory_executions where id=p_id;
 select * into r from public.person_directory_receipts where id=e.receipt_id;
 select * into w from person_private.transition_work where id=e.work_id;
 return e.id is not null and e.result is not null and e.completed_at is not null and e.candidate_id is not null and
 w.id is not null and w.family='directory' and w.scope='tt_person' and w.organization_id=e.organization_id and w.input_hash=e.input_hash and
 w.resource_key='directory:'||e.receipt_id::text||':'||e.id::text and r.phase='done' and r.candidate_id=e.candidate_id and not r.created_person and not r.projected and
 r.documents=e.decision->'docs' and r.source_reviews=e.decision->'reviews' and r.result=e.result and
 e.next_document=jsonb_array_length(e.decision->'docs') and
 e.decision_hash=person_private.intake_hash(jsonb_build_array(e.evidence,e.decision,e.identities,e.primary_value)) and
 exists(select 1 from person_private.directory_audit_operations d join public.person_audit_operations o on o.id=d.operation_id
 where d.execution_id=e.id and d.operation_id=e.audit_id and d.work_id=e.work_id and d.candidate_id=e.candidate_id and d.transaction_id=e.transaction_id
 and o.candidate_id=e.candidate_id and o.transaction_id=e.transaction_id and o.writer='directory' and o.receipt_ref='directory:'||e.receipt_id::text
 and d.operation_hash=person_private.directory_operation_hash(o));
end$$;
create function person_private.directory_complete(p_id uuid) returns jsonb
language plpgsql set search_path='' set timezone='UTC' as $$
declare e person_private.directory_executions;r public.person_directory_receipts;s public.person_directory_state;
 old_primary jsonb;new_primary jsonb;changed_choice boolean;revision bigint;outcome jsonb;candidate jsonb;w person_private.transition_work;expected_state jsonb;returned_state jsonb;expected_contacts jsonb;actual_contacts jsonb;
begin
 e:=person_private.directory_context(p_id);
 if e.decision is null or e.next_document<>jsonb_array_length(e.decision->'docs') then raise exception 'directory_incomplete';end if;
 select * into r from public.person_directory_receipts where id=e.receipt_id;
 select * into s from public.person_directory_state where contact_id=e.contact_id;
 if s.latest_receipt_id<>r.id or s.workspace_id<>e.workspace_id or r.phase<>'ready' then raise exception 'directory_receipt_ineligible';end if;
 if exists(select 1 from jsonb_to_recordset(e.identities) x(kind text,value text) left join public.candidate_identities i on i.kind=x.kind and i.value=x.value where i.candidate_id is distinct from e.candidate_id) then raise exception 'directory_identity_conflict';end if;
 select to_jsonb(x) into old_primary from public.person_directory_primary x where candidate_id=e.candidate_id and kind='email' for update;
 if (old_primary->>'receipt_id')::bigint>e.receipt_id then raise exception 'directory_primary_superseded';end if;
 changed_choice:=old_primary is null or old_primary->>'chosen_value' is distinct from e.primary_value;
 new_primary:=jsonb_build_object('candidate_id',e.candidate_id,'kind','email','directory_contact_id',e.contact_id,'chosen_value',e.primary_value,'receipt_id',e.receipt_id);
 perform person_private.directory_mutate('person_directory_primary',old_primary,new_primary);
 if changed_choice then
  perform person_private.directory_frame(p_id,e.decision->'docs'->0);
  select coalesce(jsonb_agg(to_jsonb(cc)||jsonb_build_object('rank',ranked.new_rank,'updated_at',case when cc.rank is distinct from ranked.new_rank then now() else cc.updated_at end) order by cc.id),'[]') into expected_contacts
  from public.candidate_contacts cc join public.person_contact_ranks(e.candidate_id) ranked on ranked.id=cc.id where cc.candidate_id=e.candidate_id;
  perform person_private.person_rerank_contacts_core(e.candidate_id);
  select coalesce(jsonb_agg(to_jsonb(cc) order by cc.id),'[]') into actual_contacts from public.candidate_contacts cc where cc.candidate_id=e.candidate_id;
  if actual_contacts is distinct from expected_contacts then raise exception 'directory_primary_actual';end if;
  select to_jsonb(ps)||jsonb_build_object('rev',ps.rev+1,'updated_at',clock_timestamp()) into expected_state from public.candidate_profile_state ps where candidate_id=e.candidate_id;
  update public.candidate_profile_state ps set rev=(expected_state->>'rev')::bigint,updated_at=(expected_state->>'updated_at')::timestamptz where candidate_id=e.candidate_id returning to_jsonb(ps) into returned_state;
  if expected_state is null or returned_state is distinct from expected_state or (select to_jsonb(ps) from public.candidate_profile_state ps where candidate_id=e.candidate_id) is distinct from expected_state then raise exception 'directory_primary_actual';end if;
  perform person_private.directory_context(p_id);perform person_private.normalization_frame(e.candidate_id);
  delete from person_private.directory_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 end if;
 select rev into revision from public.candidate_profile_state where candidate_id=e.candidate_id;
 select to_jsonb(x) into candidate from public.candidates x where id=e.candidate_id;
 if candidate is distinct from e.candidate_before then raise exception 'directory_candidate_changed';end if;
 outcome:=jsonb_build_object('status','done','candidateId',e.candidate_id,'created',false,'revision',revision::text,'semanticChanged',false,'projected',false,'reviewCount',jsonb_array_length(e.decision->'reviews'),'changed',e.changed or changed_choice);
 perform person_private.directory_mutate('person_directory_receipts',to_jsonb(r),to_jsonb(r)||jsonb_build_object('candidate_id',e.candidate_id,'documents',e.decision->'docs','source_reviews',e.decision->'reviews','phase','done','result',outcome,'attempts',r.attempts+1,'updated_at',clock_timestamp()));
 perform person_private.directory_mutate('person_directory_state',to_jsonb(s),to_jsonb(s)||jsonb_build_object('applied_receipt_id',e.receipt_id));
 perform person_private.directory_context(p_id);
 update person_private.directory_executions set result=outcome,completed_at=clock_timestamp() where id=p_id;
 if person_private.directory_completion_valid(p_id) is distinct from true then raise exception 'directory_completion_witness';end if;
 perform person_private.transition_finish(e.work_id,current_setting('person.work_token')::uuid,'completed');
 select * into w from person_private.transition_work where id=e.work_id;
 if w.status<>'completed' or w.finished_at is null or w.lease_until<=clock_timestamp() then raise exception 'directory_completion_work';end if;
 if (select to_jsonb(x) from public.candidates x where id=e.candidate_id) is distinct from e.candidate_before then raise exception 'directory_candidate_changed';end if;
 return outcome;
end$$;

create function person_private.directory_work_guard() returns trigger
language plpgsql set search_path='' as $$
declare e person_private.directory_executions;
begin
 select * into e from person_private.directory_executions where work_id=old.id;
 if e.id is not null and (new.status is distinct from old.status or new.finished_at is distinct from old.finished_at) then
  if old.status<>'active' or new.status<>'completed' or new.lease_until<=clock_timestamp() or person_private.directory_completion_valid(e.id) is distinct from true then raise exception 'directory_completion_witness';end if;
 end if;
 return new;
end$$;
create trigger person_directory_work_guard before update on person_private.transition_work for each row execute function person_private.directory_work_guard();
create function person_private.directory_deferred_completion() returns trigger
language plpgsql set search_path='' as $$
begin
 if person_private.directory_completion_valid(new.id) is distinct from true or not exists(select 1 from person_private.transition_work where id=new.work_id and status='completed') then raise exception 'directory_execution_incomplete';end if;
 return null;
end$$;
create constraint trigger directory_execution_commit after insert or update on person_private.directory_executions deferrable initially deferred for each row execute function person_private.directory_deferred_completion();
do $$declare p record;begin
 for p in select oid::regprocedure signature from pg_proc where pronamespace='person_private'::regnamespace and proname in
 ('directory_context','directory_begin','directory_capture','directory_bind','directory_seal','directory_frame','directory_normalize','directory_audit_begin','directory_completion_valid','directory_complete','directory_work_guard','directory_deferred_completion') loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',p.signature);
 end loop;
end$$;
