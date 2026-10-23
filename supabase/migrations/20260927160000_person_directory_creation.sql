-- PREPARED ONLY. Genuine same-transaction directory creation. No worker activation.
set local lock_timeout='2s';set local statement_timeout='30s';
alter table person_private.directory_executions add column creation_execution_id uuid references person_private.directory_executions(id),add column chunk_disposition text;
create table person_private.directory_creations(
 execution_id uuid primary key references person_private.directory_executions(id),candidate_id uuid not null unique references public.candidates(id),
 work_id uuid not null,transaction_id xid8 not null,input_hash text not null,username text not null,
 seed_row jsonb not null,creator_event_id bigint not null unique
);
create table person_private.directory_seed_frames(
 backend_pid integer not null,transaction_id xid8 not null,execution_id uuid not null,work_id uuid not null,
 candidate_id uuid not null,expected_row jsonb not null,before_seen boolean not null default false,after_seen boolean not null default false,
 primary key(backend_pid,transaction_id)
);
alter table person_private.directory_creations enable row level security;
alter table person_private.directory_seed_frames enable row level security;
revoke all on person_private.directory_creations,person_private.directory_seed_frames from public,anon,authenticated,service_role;
do $$declare b text;needle text:=' if tg_table_name=''candidates'' then';begin
 b:=pg_get_functiondef('person_private.intake_mutation_guard()'::regprocedure);
 if position(needle in b)=0 then raise exception 'directory_creation_definition';end if;
 b:=replace(b,'df person_private.directory_candidate_frames;', 'df person_private.directory_candidate_frames;ds person_private.directory_seed_frames;');
 b:=replace(b,needle,$fragment$
 if tg_table_name='candidates' then
  select * into ds from person_private.directory_seed_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
  if ds.backend_pid is not null then
   perform person_private.directory_context(ds.execution_id);
   if tg_op<>'INSERT' or ds.candidate_id is distinct from new.id or ds.expected_row is distinct from n or
    exists(select 1 from person_private.intake_mutation_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
    exists(select 1 from person_private.directory_candidate_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'directory_seed_frame';end if;
   if tg_when='BEFORE' then
    if ds.before_seen or ds.after_seen then raise exception 'directory_seed_reentry';end if;
    update person_private.directory_seed_frames set before_seen=true where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
   else
    if not ds.before_seen or ds.after_seen then raise exception 'directory_seed_reentry';end if;
    update person_private.directory_seed_frames set after_seen=true where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
   end if;
   return new;
  end if;
 end if;
 if tg_table_name='candidates' then
$fragment$);execute b;
end$$;
create function person_private.directory_creation_valid(p_execution uuid,p_completed boolean default true) returns boolean
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;proof person_private.directory_creations;ev public.person_change_events;w person_private.transition_work;
begin
 select * into e from person_private.directory_executions where id=p_execution;
 select * into proof from person_private.directory_creations where execution_id=p_execution;
 if e.id is null or proof.execution_id is null then return false;end if;
 select * into ev from public.person_change_events where id=proof.creator_event_id;
 select * into w from person_private.transition_work where id=e.work_id;
 return e.id is not null and e.creation_execution_id=e.id and proof.execution_id=e.id and proof.candidate_id=e.candidate_id and proof.work_id=e.work_id and proof.transaction_id=e.transaction_id and proof.input_hash=e.input_hash and
 w.id=e.work_id and w.family='directory' and w.scope='tt_person' and w.organization_id=e.organization_id and w.input_hash=e.input_hash and w.resource_key='directory:'||e.receipt_id::text||':'||e.id::text and
 (not p_completed or (w.status='completed' and e.completed_at is not null and e.result is not null)) and
 ev.id=proof.creator_event_id and ev.candidate_id=e.candidate_id and ev.source_table='candidates' and ev.source_row_id=e.candidate_id::text and ev.operation='INSERT' and ev.previous_payload is null and ev.transaction_id=e.transaction_id and ev.payload=(proof.seed_row-array['resume_embedding','matching_embedding','resume_text','notes']) and
 proof.seed_row->>'id'=e.candidate_id::text and proof.seed_row->>'linkedin_username'=proof.username and proof.seed_row->>'linkedin_url'=person_private.application_identity_url(proof.username) and proof.seed_row->>'source'='directory' and proof.seed_row->>'status'='engaged' and person_private.directory_verify(e.receipt_id);
end$$;
create function person_private.directory_seed(p_id uuid,p_username text,p_identities jsonb) returns uuid
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;r public.person_directory_receipts;s public.person_directory_state;cid uuid:=gen_random_uuid();target public.candidates;saved jsonb;f person_private.directory_seed_frames;event_id bigint;
begin
 e:=person_private.directory_context(p_id);
 if e.candidate_id is not null or e.creation_execution_id is not null then raise exception 'directory_seed_existing';end if;
 select * into r from public.person_directory_receipts where id=e.receipt_id for update;
 select * into s from public.person_directory_state where contact_id=e.contact_id for update;
 if r.phase<>'ready' or r.candidate_id is not null or r.result is not null or r.documents is not null or r.projected or s.latest_receipt_id is distinct from r.id or s.workspace_id is distinct from e.workspace_id then raise exception 'directory_receipt_ineligible';end if;
 if r.snapshot->'board'->>'do_not_contact'='true' or r.snapshot->'board'->>'status'='Do Not Contact' then raise exception 'directory_suppression_unavailable';end if;
 if p_username is null or p_username<>lower(btrim(p_username)) or not exists(select 1 from jsonb_to_recordset(p_identities) x(kind text,value text) where x.kind='linkedin_username' and x.value=p_username) then raise exception 'directory_linkedin_required';end if;
 -- The direct writer holds sorted username/identity/contact locks before this
 -- capability. Recheck every actual owner after those waits, never use email.
 if exists(select 1 from public.candidates c where c.directory_contact_id=e.contact_id or exists(select 1 from jsonb_to_recordset(p_identities) x(kind text,value text) where (x.kind='linkedin_username' and lower(c.linkedin_username)=x.value) or (x.kind='airtable_id' and c.airtable_id=x.value))) or exists(select 1 from public.candidate_identities i join jsonb_to_recordset(p_identities) x(kind text,value text) on i.kind=x.kind and i.value=x.value) then raise exception 'directory_identity_conflict';end if;
 perform pg_advisory_xact_lock(hashtext(cid::text));perform person_private.directory_context(p_id);
 target:=jsonb_populate_record(null::public.candidates,jsonb_build_object('id',cid,'full_name',coalesce(nullif(r.snapshot->'board'->>'name',''),p_username),'linkedin_username',p_username,'linkedin_url',person_private.application_identity_url(p_username),'source','directory','status','engaged','created_at',now(),'updated_at',now(),'embedding_type','unknown','linkedin_enrichment_status','not_applicable','open_profile',false));
 if exists(select 1 from person_private.directory_seed_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'directory_seed_nested';end if;
 insert into person_private.directory_seed_frames(backend_pid,transaction_id,execution_id,work_id,candidate_id,expected_row) values(pg_backend_pid(),pg_current_xact_id(),p_id,e.work_id,cid,to_jsonb(target));
 insert into public.candidates select target.* returning to_jsonb(candidates) into saved;
 select * into f from person_private.directory_seed_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if saved is distinct from to_jsonb(target) or person_private.publication_candidate(cid) is distinct from to_jsonb(target) or f.execution_id is distinct from p_id or f.work_id is distinct from e.work_id or f.candidate_id is distinct from cid or f.expected_row is distinct from to_jsonb(target) or not coalesce(f.before_seen and f.after_seen,false) then raise exception 'directory_seed_actual';end if;
 select id into strict event_id from public.person_change_events where candidate_id=cid and source_table='candidates' and source_row_id=cid::text and operation='INSERT' and previous_payload is null and transaction_id=pg_current_xact_id();
 update person_private.directory_executions set candidate_id=cid,creation_execution_id=p_id,candidate_before=to_jsonb(target),identities=p_identities where id=p_id;
 insert into person_private.directory_creations values(p_id,cid,e.work_id,pg_current_xact_id(),e.input_hash,p_username,to_jsonb(target),event_id);
 if person_private.directory_creation_valid(p_id,false) is distinct from true then raise exception 'directory_creation_witness';end if;
 perform person_private.directory_context(p_id);
 delete from person_private.directory_seed_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 return cid;
end$$;

CREATE OR REPLACE FUNCTION person_private.directory_bind(p_id uuid, p_candidate uuid, p_identities jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
 SET "DateStyle" TO 'ISO,YMD'
AS $function$
declare e person_private.directory_executions;r public.person_directory_receipts;s public.person_directory_state;c jsonb;prior person_private.directory_executions;
begin
 e:=person_private.directory_context(p_id);
 select * into r from public.person_directory_receipts where id=e.receipt_id for update;
 select * into s from public.person_directory_state where contact_id=e.contact_id for update;
 if s.latest_receipt_id is distinct from e.receipt_id or s.workspace_id is distinct from e.workspace_id then raise exception 'directory_receipt_ineligible';end if;
 if r.phase='done' and e.mode='live' then
  select * into prior from person_private.directory_executions where receipt_id=e.receipt_id and mode='shadow' and completed_at is not null order by completed_at desc limit 1;
  if prior.id is null then raise exception 'directory_receipt_ineligible';end if;
  if r.projected is distinct from (prior.creation_execution_id is not null) or (prior.creation_execution_id is not null and person_private.directory_creation_valid(prior.creation_execution_id,true) is distinct from true) or prior.candidate_id is distinct from p_candidate or prior.identities is distinct from p_identities or
   person_private.directory_completion_valid(prior.id) is distinct from true or r.result is distinct from prior.result or
   not exists(select 1 from person_private.transition_work where id=prior.work_id and status='completed') then raise exception 'directory_shadow_proof';end if;
 elsif r.phase<>'ready' or r.documents is not null or r.result is not null or r.candidate_id is not null or r.projected then raise exception 'directory_receipt_ineligible';end if;
 if prior.id is null and (r.derivative_text is not null or r.derivative_revision is not null or r.derivative_token is not null or r.derivative_lease_until is not null or r.derivatives_claimed_at is not null or r.derivative_attempts<>0 or r.derivative_done or r.derivative_error is not null) then raise exception 'directory_derivative_unproven';end if;
 if r.snapshot->'board'->>'do_not_contact'='true' or r.snapshot->'board'->>'status'='Do Not Contact' then raise exception 'directory_suppression_unavailable';end if;
 if p_candidate is null or jsonb_typeof(p_identities) is distinct from 'array' or jsonb_array_length(p_identities)=0 then raise exception 'directory_candidate_binding';end if;
 perform pg_advisory_xact_lock(hashtext(p_candidate::text));
 select to_jsonb(x) into c from public.candidates x where id=p_candidate for update;
 if c is null or (not exists(select 1 from public.candidate_profile_state where candidate_id=p_candidate) and (e.creation_execution_id=e.id and person_private.directory_creation_valid(e.id,false)) is distinct from true) then raise exception 'directory_person_not_migrated';end if;
 if c->>'directory_contact_id' is not null and c->>'directory_contact_id'<>e.contact_id::text then raise exception 'directory_linkage_conflict';end if;
 if exists(select 1 from public.person_source_holds where candidate_id=p_candidate and resolved_at is null) then raise exception 'directory_source_hold';end if;
 if e.creation_execution_id=e.id and c is distinct from (select seed_row from person_private.directory_creations where execution_id=e.id) then raise exception 'directory_seed_changed';end if;
 perform person_private.directory_context(p_id);
 update person_private.directory_executions set candidate_id=p_candidate,candidate_before=c,identities=p_identities where id=p_id;
 if prior.id is not null then
  update person_private.directory_executions set shadow_id=prior.id,creation_execution_id=prior.creation_execution_id,evidence=prior.evidence,decision=prior.decision,decision_hash=prior.decision_hash,primary_value=prior.primary_value where id=p_id;
  return jsonb_build_object('adopted',true,'createdPerson',prior.creation_execution_id is not null,'evidence',prior.evidence,'decision',prior.decision);
 end if;
 return person_private.directory_capture(p_id)||jsonb_build_object('createdPerson',e.creation_execution_id is not null);
end$function$;


create function person_private.receipt_creator_valid(p_candidate uuid,p_org uuid,anchor public.person_audit_anchors,p_current uuid default null) returns void
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare d person_private.directory_creations;e person_private.directory_executions;stored_event public.person_change_events;stored_operation public.person_audit_operations;attribution public.person_change_attributions;operation person_private.directory_audit_operations;expected_anchor jsonb;changed text[];
begin
 if anchor.creator_ref like 'application:%' then
  if p_current is not null then raise exception 'audit_creation_receipt';end if;
  -- Retain the existing audit service's current creator-scope check. A prior
  -- certificate does not excuse a removed event or a transferred application.
  if not exists(select 1 from public.person_application_receipts rr join public.website_applications app on app.id=rr.application_id
   join person_private.application_candidates owner on owner.application_id=rr.application_id and owner.candidate_id=rr.candidate_id
   where 'application:'||rr.application_id::text=anchor.creator_ref and rr.candidate_id=p_candidate and rr.created_person and owner.created_person and app.organization_id=p_org) then raise exception 'audit_creation_receipt';end if;
  if not exists(select 1 from public.person_change_events ev join public.person_change_attributions x on x.event_id=ev.id
   join public.person_audit_operations o on o.id=x.operation_id join person_private.application_audit_operations p on p.operation_id=o.id
   where ev.id::text=anchor.external_proof->>'creator_event_id' and ev.candidate_id=p_candidate and ev.source_table='candidates' and ev.source_row_id=p_candidate::text
   and ev.operation='INSERT' and ev.previous_payload is null and ev.payload->>'id'=p_candidate::text and x.scope='creation' and x.candidate_id=p_candidate
   and o.candidate_id=p_candidate and o.writer='application' and o.receipt_ref=anchor.creator_ref and o.transaction_id=ev.transaction_id
   and p.candidate_id=p_candidate and p.transaction_id=ev.transaction_id and p.creator_event_id=ev.id
   and o.evidence->'guard'->>'anchor_hash'=anchor.anchor_hash and o.evidence->>'creator_event_id'=ev.id::text
   and person_private.audit_candidate_hash(ev.payload)=person_private.audit_candidate_hash(anchor.before_image)
   and x.event_hash=md5(jsonb_build_array(ev.id,ev.candidate_id,ev.source_table,ev.source_row_id,ev.operation,ev.transaction_id::text,ev.previous_payload,ev.payload)::text)) then raise exception 'audit_creation_event';end if;
 elsif anchor.creator_ref like 'directory:%' then
  select * into d from person_private.directory_creations where candidate_id=p_candidate;
  select * into e from person_private.directory_executions where id=d.execution_id;
  select * into stored_event from public.person_change_events where id=d.creator_event_id;
  select * into attribution from public.person_change_attributions where event_id=d.creator_event_id;
  select * into stored_operation from public.person_audit_operations where id=e.audit_id;
  select * into operation from person_private.directory_audit_operations where operation_id=stored_operation.id;
  -- Only the current original execution can validate its still-uncompleted
  -- creator. Promotions and all later callers require the completed original.
  if p_current is not null then
   if p_current is distinct from e.id then raise exception 'audit_creation_receipt';end if;
   perform person_private.directory_context(p_current);
  end if;
  if person_private.directory_creation_valid(e.id,p_current is null) is distinct from true or e.organization_id<>p_org or anchor.creator_ref is distinct from 'directory:'||e.receipt_id::text or
   anchor.before_image is distinct from (d.seed_row-array['resume_embedding','matching_embedding','resume_text','notes']) or anchor.external_proof->>'creator_event_id' is distinct from d.creator_event_id::text or
   (p_current is null and not exists(select 1 from public.person_directory_receipts r where r.id=e.receipt_id and r.candidate_id=p_candidate and r.created_person and person_private.directory_verify(r.id))) then raise exception 'audit_creation_receipt';end if;
  expected_anchor:=jsonb_build_object('candidate_id',p_candidate,'kind','receipt_created','baseline_run',null,'parser_version','person-v3','legacy_doc',null,'before_image',d.seed_row-array['resume_embedding','matching_embedding','resume_text','notes'],'source_catalog','[]'::jsonb,'revision',0,'captured_version',d.creator_event_id,'creator_ref','directory:'||e.receipt_id::text,'external_proof',jsonb_build_object('legacy_hash',md5('[]'),'v2_hash',md5('[]'),'outreach_hash',md5('[]'),'creator_event_id',d.creator_event_id::text));
  if (to_jsonb(anchor)-array['created_at','anchor_hash']) is distinct from expected_anchor or anchor.anchor_hash is distinct from person_private.audit_anchor_hash(expected_anchor) or not exists(select 1 from person_private.certified_audit_anchors ca where ca.candidate_id=p_candidate and ca.anchor_hash=anchor.anchor_hash) then raise exception 'audit_creation_anchor';end if;
  select coalesce(array_agg(k order by k),'{}') into changed from jsonb_object_keys(stored_event.payload) k;
  if attribution.operation_id is distinct from e.audit_id or attribution.candidate_id is distinct from p_candidate or attribution.scope is distinct from 'creation' or
   attribution.changed_fields is distinct from changed or
   operation.creator_event_id is distinct from d.creator_event_id or operation.execution_id is distinct from e.id or operation.work_id is distinct from e.work_id or operation.captured_version is distinct from d.creator_event_id or operation.candidate_id is distinct from p_candidate or operation.transaction_id is distinct from d.transaction_id or
   stored_operation.candidate_id is distinct from p_candidate or stored_operation.transaction_id is distinct from d.transaction_id or stored_operation.writer is distinct from 'directory' or stored_operation.receipt_ref is distinct from anchor.creator_ref or
   stored_operation.evidence is distinct from jsonb_build_object('creator_event_id',d.creator_event_id::text,'guard',jsonb_build_object('version','candidate-audit-1','anchor_hash',anchor.anchor_hash,'candidate_hash',person_private.audit_candidate_hash(anchor.before_image),'captured_version',d.creator_event_id::text,'auxiliary',(expected_anchor->'external_proof')-'creator_event_id')) or
   operation.operation_hash is distinct from person_private.directory_operation_hash(stored_operation) or
   attribution.event_hash is distinct from md5(jsonb_build_array(stored_event.id,stored_event.candidate_id,stored_event.source_table,stored_event.source_row_id,stored_event.operation,stored_event.transaction_id::text,stored_event.previous_payload,stored_event.payload)::text) then raise exception 'audit_creation_event';end if;
 else raise exception 'audit_creation_receipt';end if;
end$$;

CREATE OR REPLACE FUNCTION public.person_application_audit_begin(p_creation boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
 SET "DateStyle" TO 'ISO,YMD'
AS $function$
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
  perform person_private.receipt_creator_valid(b.candidate_id,a.organization_id,anchor);
 end if;
 start_v:=anchor.captured_version;candidate_hash:=person_private.audit_candidate_hash(anchor.before_image);
 -- Only this private map certifies a DB-derived checkpoint. Public legacy
 -- operation JSON cannot advance the chain. Bound the interval after the latest
 -- verified checkpoint, so old valid history does not grow without limit.
 select p.captured_version,o.evidence->'guard' proof into checkpoint
 from person_private.certified_audit_operations p join public.person_audit_operations o on o.id=p.operation_id
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
  left join person_private.certified_audit_operations p on p.operation_id=o.id order by ev.id loop
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
end$function$;


CREATE OR REPLACE FUNCTION person_private.directory_audit_begin(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
 SET "DateStyle" TO 'ISO,YMD'
AS $function$
declare dx person_private.directory_executions;anchor public.person_audit_anchors;c jsonb;aux jsonb;guard jsonb;src jsonb;
 e record;v bigint;start_v bigint;candidate_hash text;current_hash text;oid uuid:=gen_random_uuid();events_seen integer:=0;checkpoint record;stored_operation public.person_audit_operations;creation person_private.directory_creations;payload jsonb;creator bigint;
begin
 dx:=person_private.directory_context(p_id);
 if dx.candidate_id is null or dx.decision is null or dx.audit_id is not null then raise exception 'directory_audit_binding';end if;
 select to_jsonb(t) into c from public.candidates t where id=dx.candidate_id;
 if c is distinct from dx.candidate_before then raise exception 'directory_candidate_changed';end if;
 aux:=person_private.audit_auxiliary_proof(dx.candidate_id);
 if (aux->>'n')::int>1000 then raise exception 'audit_auxiliary_limit';end if;aux:=aux->'proof';
 select coalesce(max(id),0) into v from public.person_change_events where candidate_id=dx.candidate_id;
 select * into anchor from public.person_audit_anchors where candidate_id=dx.candidate_id;
 if dx.creation_execution_id=dx.id then
  select * into creation from person_private.directory_creations where execution_id=dx.id;
  if person_private.directory_creation_valid(dx.id,false) is distinct from true or dx.transaction_id<>pg_current_xact_id() or
   anchor.candidate_id is not null or exists(select 1 from public.candidate_profile_state where candidate_id=dx.candidate_id) or exists(select 1 from public.candidate_sources where candidate_id=dx.candidate_id) or c is distinct from creation.seed_row then raise exception 'audit_creation_not_new';end if;
  if exists(select 1 from jsonb_each_text(aux) x where x.value<>'d751713988987e9331980363e24189ce') then raise exception 'audit_creation_auxiliary';end if;
  creator:=creation.creator_event_id;
  payload:=jsonb_build_object('candidate_id',dx.candidate_id,'kind','receipt_created','baseline_run',null,'parser_version','person-v3','legacy_doc',null,'before_image',creation.seed_row-array['resume_embedding','matching_embedding','resume_text','notes'],'source_catalog','[]'::jsonb,'revision',0,'captured_version',creator,'creator_ref','directory:'||dx.receipt_id::text,'external_proof',aux||jsonb_build_object('creator_event_id',creator::text));
  perform person_private.audit_proof_frame('person_audit_anchors',dx.candidate_id);
  insert into public.person_audit_anchors(candidate_id,kind,parser_version,before_image,source_catalog,revision,captured_version,creator_ref,external_proof,anchor_hash)
   values(dx.candidate_id,'receipt_created','person-v3',creation.seed_row-array['resume_embedding','matching_embedding','resume_text','notes'],'[]',0,creator,payload->>'creator_ref',payload->'external_proof',person_private.audit_anchor_hash(payload)) returning * into anchor;
  insert into person_private.certified_audit_anchors values(dx.candidate_id,anchor.anchor_hash);
  perform person_private.audit_proof_clear('person_audit_anchors');
 end if;
 if anchor.candidate_id is null or anchor.parser_version<>'person-v3' or anchor.before_image->>'id' is distinct from dx.candidate_id::text or
  anchor.anchor_hash is distinct from person_private.audit_anchor_hash(to_jsonb(anchor)) or not exists(select 1 from person_private.certified_audit_anchors where candidate_id=dx.candidate_id and anchor_hash=anchor.anchor_hash) then raise exception 'audit_anchor_uncertified';end if;
 if exists(select 1 from jsonb_each(aux) x where anchor.external_proof->x.key is distinct from x.value) then raise exception 'audit_auxiliary_changed';end if;
 if anchor.kind='legacy' then
  src:=anchor.legacy_doc->'source';
  if not exists(select 1 from public.candidate_sources where candidate_id=dx.candidate_id and source='legacy_import' and source_ref=src->>'source_ref' and payload_hash=src->>'payload_hash' and parser_version=src->>'parser_version' and fetched_at=(src->>'fetched_at')::timestamptz and provider is not distinct from src->>'provider' and raw_in is not distinct from src->>'raw_in' and enrichment_id is not distinct from nullif(src->>'enrichment_id','')::uuid) then raise exception 'audit_anchor_source';end if;
 elsif creator is null then
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
 insert into public.person_audit_operations(id,candidate_id,writer,receipt_ref,evidence)
 values(oid,dx.candidate_id,'directory','directory:'||dx.receipt_id::text,jsonb_build_object('guard',guard)||case when creator is null then '{}'::jsonb else jsonb_build_object('creator_event_id',creator::text) end) returning * into stored_operation;
 insert into person_private.directory_audit_operations values(oid,dx.id,dx.work_id,dx.candidate_id,pg_current_xact_id(),v,creator,person_private.directory_operation_hash(stored_operation));
 update person_private.directory_executions set audit_id=oid where id=dx.id;
 perform person_private.audit_proof_clear('person_audit_operations');
 if creator is not null then
  perform person_private.attribute_change(creator,oid,'creation');
  perform person_private.receipt_creator_valid(dx.candidate_id,dx.organization_id,anchor,dx.id);
 end if;
 perform person_private.directory_context(p_id);
 return jsonb_build_object('id',oid,'candidateId',dx.candidate_id,'writer','directory','receiptRef','directory:'||dx.receipt_id::text,'anchorHash',anchor.anchor_hash);
exception when others then perform person_private.audit_proof_clear('person_audit_operations');perform person_private.audit_proof_clear('person_audit_anchors');raise;
end$function$;


CREATE OR REPLACE FUNCTION person_private.projection_frame()
 RETURNS person_private.application_projection_frames
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare f person_private.application_projection_frames;d person_private.directory_projection_frames;e person_private.directory_executions;
begin
 select * into f from person_private.application_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 select * into d from person_private.directory_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if f.backend_pid is not null and d.backend_pid is not null then raise exception 'projection_nested';end if;
 if d.backend_pid is not null then
  e:=person_private.directory_context(d.execution_id);
  if (e.mode<>'live' and e.creation_execution_id is null) or e.work_id<>d.work_id or e.candidate_id is distinct from d.candidate_id or e.audit_id is distinct from d.operation_id then raise exception 'directory_projection_frame';end if;
  f:=row(d.backend_pid,d.transaction_id,d.work_id,d.candidate_id,d.operation_id,d.before_profile,d.after_profile)::person_private.application_projection_frames;
 end if;
 if f.backend_pid is null then raise exception 'projection_frame';end if;
 return f;
end$function$;


CREATE OR REPLACE FUNCTION person_private.directory_project(p_id uuid, p_revision bigint, p_envelope jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
 SET "DateStyle" TO 'ISO,YMD'
AS $function$
declare e person_private.directory_executions;doc jsonb;src jsonb;project_result jsonb;
begin
 e:=person_private.directory_context(p_id);
 if (e.mode<>'live' and e.creation_execution_id is null) or e.audit_id is null or e.projection is not null or e.prepared_revision is distinct from p_revision or e.next_document<>jsonb_array_length(e.decision->'docs') then raise exception 'directory_projection_order';end if;
 for doc in select value from jsonb_array_elements(e.decision->'docs') loop
  src:=doc->'source';
  if not exists(select 1 from public.candidate_sources cs where cs.candidate_id=e.candidate_id and cs.source=src->>'source' and cs.source_ref is not distinct from src->>'source_ref' and cs.provider is not distinct from src->>'provider' and cs.payload_hash=src->>'payload_hash' and cs.parser_version=src->>'parser_version' and cs.fetched_at=(src->>'fetched_at')::timestamptz and cs.raw_in=src->>'raw_in' and cs.enrichment_id is not distinct from nullif(src->>'enrichment_id','')::uuid) then raise exception 'directory_projection_source';end if;
 end loop;
 project_result:=person_private.projection_apply(p_id,e.work_id,e.candidate_id,e.audit_id,p_revision,p_envelope);
 perform person_private.directory_context(p_id);
 update person_private.directory_executions set projection=project_result||jsonb_build_object('state',(select to_jsonb(ps) from public.person_projection_state ps where ps.candidate_id=e.candidate_id),'history',(select to_jsonb(ph) from public.person_projection_history ph where ph.id=(project_result->>'historyId')::bigint)),candidate_after=(select to_jsonb(c) from public.candidates c where id=e.candidate_id) where id=p_id;
 return project_result;
end$function$;


CREATE OR REPLACE FUNCTION person_private.directory_candidate_mutate(p_id uuid, p_before jsonb, p_after jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
 SET "DateStyle" TO 'ISO,YMD'
AS $function$
declare e person_private.directory_executions;f person_private.directory_candidate_frames;actual jsonb;returned jsonb;boundary bigint;event_id bigint;cols text;
begin
 e:=person_private.directory_context(p_id);
 if (e.mode<>'live' and e.creation_execution_id is null) or e.projection is null or e.metadata_done or e.audit_id is null or p_before->>'id' is distinct from e.candidate_id::text or p_after->>'id' is distinct from e.candidate_id::text then raise exception 'directory_metadata_scope';end if;
 if exists(select 1 from person_private.directory_candidate_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'directory_metadata_nested';end if;
 if p_before=p_after then return;end if;
 select coalesce(max(id),0) into boundary from public.person_change_events where candidate_id=e.candidate_id;
 insert into person_private.directory_candidate_frames(backend_pid,transaction_id,execution_id,before_row,after_row) values(pg_backend_pid(),pg_current_xact_id(),p_id,p_before,p_after);
 update public.candidates set calculated_experience_years=(p_after->>'calculated_experience_years')::numeric,
 directory_contact_id=(p_after->>'directory_contact_id')::uuid,directory_sync_hash=p_after->>'directory_sync_hash',source=p_after->>'source',status=p_after->>'status',follow_up_at=(p_after->>'follow_up_at')::date,linkedin_enrichment_date=(p_after->>'linkedin_enrichment_date')::timestamptz,updated_at=(p_after->>'updated_at')::timestamptz where id=e.candidate_id returning to_jsonb(candidates) into returned;
 select to_jsonb(c) into actual from public.candidates c where id=e.candidate_id;
 select * into f from person_private.directory_candidate_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if returned is distinct from p_after or actual is distinct from p_after or f.execution_id is distinct from p_id or f.before_row is distinct from p_before or f.after_row is distinct from p_after or not coalesce(f.before_seen and f.after_seen,false) then raise exception 'directory_metadata_actual';end if;
 select id into strict event_id from public.person_change_events where candidate_id=e.candidate_id and source_table='candidates' and transaction_id=pg_current_xact_id() and id>boundary;
 perform person_private.attribute_change(event_id,e.audit_id,'directory_metadata');
 perform person_private.directory_context(p_id);
 delete from person_private.directory_candidate_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
end$function$;


CREATE OR REPLACE FUNCTION person_private.directory_metadata(p_id uuid, p_years numeric, p_witnesses jsonb, p_followup date, p_harvest timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
 SET "DateStyle" TO 'ISO,YMD'
AS $function$
declare e person_private.directory_executions;r public.person_directory_receipts;c jsonb;target jsonb;admitted timestamptz;
begin
 e:=person_private.directory_context(p_id);
 select * into r from public.person_directory_receipts where id=e.receipt_id;
 select to_jsonb(cc) into c from public.candidates cc where id=e.candidate_id;
 if (e.mode<>'live' and e.creation_execution_id is null) or e.projection is null or e.metadata_done or c is distinct from e.candidate_after or (p_years is not null and (p_years<0 or p_years>1000 or p_years<>round(p_years))) then raise exception 'directory_metadata_order';end if;
 -- Frozen server translators supply potential old-monolithic and split-Harvest
 -- witnesses. Actual normalized evidence must match original content and date.
 if p_harvest is not null and exists(select 1 from public.candidate_sources cs join jsonb_to_recordset(p_witnesses) w(source_ref text,payload_hash text,parser_version text,fetched_at timestamptz)
 on cs.source_ref=w.source_ref and cs.payload_hash=w.payload_hash and cs.parser_version=w.parser_version and cs.fetched_at=w.fetched_at
 where cs.candidate_id=e.candidate_id and cs.source='directory' and w.source_ref in (e.contact_id::text,e.contact_id::text||':harvest') and cs.fetched_at=p_harvest) then admitted:=p_harvest;end if;
 if p_years is not null and (c->>'calculated_experience_years')::numeric is distinct from p_years then
  target:=c||jsonb_build_object('calculated_experience_years',p_years);
  perform person_private.directory_candidate_mutate(p_id,c,target);c:=target;
 end if;
 target:=c||jsonb_build_object('directory_contact_id',e.contact_id,'directory_sync_hash',r.snapshot_hash,'source','directory','status',case when c->>'status'='Do Not Contact' then 'Do Not Contact' else coalesce(nullif(r.snapshot->'board'->>'status',''),'engaged') end,'follow_up_at',coalesce((c->>'follow_up_at')::date,p_followup),'linkedin_enrichment_date',greatest((c->>'linkedin_enrichment_date')::timestamptz,admitted));
 if target is distinct from c then
  target:=target||jsonb_build_object('updated_at',clock_timestamp());perform person_private.directory_candidate_mutate(p_id,c,target);
 end if;
 perform person_private.directory_context(p_id);
 update person_private.directory_executions set metadata_done=true,candidate_after=target where id=p_id;
end$function$;


CREATE OR REPLACE FUNCTION person_private.derivative_enqueue(p_execution uuid, p_candidate uuid, p_receipt text, p_before jsonb, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
 SET "DateStyle" TO 'ISO,YMD'
AS $function$
declare e person_private.directory_executions;a person_private.application_work;wid uuid;old_job public.person_derivative_jobs;target public.person_derivative_jobs;saved jsonb;f person_private.derivative_producer_frames;changed boolean;bytes jsonb;
begin
 p_before:=to_jsonb(jsonb_populate_record(null::public.candidates,p_before));
 if p_execution is not null then
  e:=person_private.directory_context(p_execution);wid:=e.work_id;
  if (e.mode<>'live' and e.creation_execution_id is null) or not e.metadata_done or e.enqueue_done or e.candidate_id is distinct from p_candidate or p_receipt is distinct from 'directory:'||e.receipt_id::text or p_before is distinct from e.candidate_after then raise exception 'directory_derivative_scope';end if;
 else
  a:=person_private.application_source_context();wid:=a.work_id;
  if p_receipt is distinct from 'application:'||a.application_id::text or not exists(select 1 from person_private.application_candidates where work_id=a.work_id and candidate_id=p_candidate) then raise exception 'application_derivative_scope';end if;
 end if;
 if (select to_jsonb(c) from public.candidates c where id=p_candidate) is distinct from p_before or not exists(select 1 from public.person_projection_state p join public.candidate_profile_state s using(candidate_id) where p.candidate_id=p_candidate and p.revision=s.rev and p.revision=(p_data->>'revision')::bigint and p.profile_hash=p_data->>'profileHash') or exists(select 1 from public.person_source_holds where candidate_id=p_candidate and resolved_at is null) then raise exception 'derivative_profile';end if;
 bytes:=(p_data->>'bytes')::jsonb;
 if bytes is distinct from jsonb_build_array('text-embedding-3-small',1536,p_data->'sources') or jsonb_typeof(p_data->'sources') is distinct from 'object' or
 (select count(*) from jsonb_object_keys(p_data->'sources'))<>3 or exists(select 1 from jsonb_each(p_data->'sources') v where v.key not in ('linkedin_profile','resume','summary') or jsonb_typeof(v.value)<>'string') or
 p_data->'sources'->>'resume' is distinct from coalesce(p_before->>'resume_text','') or p_data->'sources'->>'summary' is distinct from coalesce(p_before->>'profile_summary','') then raise exception 'derivative_input';end if;
 if exists(select 1 from person_private.derivative_producer_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'derivative_producer_nested';end if;
 select * into old_job from public.person_derivative_jobs where candidate_id=p_candidate for update;
 target:=old_job;
 if old_job.candidate_id is null then target:=jsonb_populate_record(null::public.person_derivative_jobs,jsonb_build_object('candidate_id',p_candidate,'status','pending','attempts',0,'updated_at',clock_timestamp()));end if;
 target.desired_revision:=(p_data->>'revision')::bigint;target.desired_hash:=encode(sha256(convert_to(p_data->>'bytes','UTF8')),'hex');
 target.sources:=p_data->'sources';target.model:='text-embedding-3-small';target.dimensions:=1536;target.receipt_ref:=p_receipt;
 changed:=old_job.candidate_id is not null and old_job.desired_hash<>target.desired_hash;
 if changed then target.status:='pending';target.attempts:=0;target.claim_token:=null;target.lease_until:=null;target.claim_missing:=null;target.error_code:=null;target.updated_at:=clock_timestamp();end if;
 insert into person_private.derivative_producer_frames(backend_pid,transaction_id,work_id,candidate_id,before_row,after_row) values(pg_backend_pid(),pg_current_xact_id(),wid,p_candidate,case when old_job.candidate_id is null then null else to_jsonb(old_job) end,to_jsonb(target));
 if old_job.candidate_id is null then insert into public.person_derivative_jobs select target.* returning to_jsonb(person_derivative_jobs) into saved;
 else update public.person_derivative_jobs j set desired_revision=target.desired_revision,desired_hash=target.desired_hash,sources=target.sources,model=target.model,dimensions=target.dimensions,receipt_ref=target.receipt_ref,status=target.status,attempts=target.attempts,claim_token=target.claim_token,lease_until=target.lease_until,claim_missing=target.claim_missing,error_code=target.error_code,updated_at=target.updated_at where candidate_id=p_candidate returning to_jsonb(j) into saved;end if;
 select * into f from person_private.derivative_producer_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if saved is distinct from to_jsonb(target) or (select to_jsonb(j) from public.person_derivative_jobs j where candidate_id=p_candidate) is distinct from to_jsonb(target) or f.work_id is distinct from wid or f.candidate_id is distinct from p_candidate or f.after_row is distinct from to_jsonb(target) or f.before_row is distinct from (case when old_job.candidate_id is null then null else to_jsonb(old_job) end) or not coalesce(f.before_seen and f.after_seen,false) then raise exception 'derivative_producer_actual';end if;
 perform person_private.projection_owner(p_execution);
 delete from person_private.derivative_producer_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 return to_jsonb(target);
end$function$;


CREATE OR REPLACE FUNCTION person_private.directory_attribution_context(p_event bigint, p_operation uuid, p_scope text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare d person_private.directory_audit_operations;e person_private.directory_executions;o public.person_audit_operations;ev public.person_change_events;
begin
 select * into d from person_private.directory_audit_operations where operation_id=p_operation;
 e:=person_private.directory_context(d.execution_id);
 select * into o from public.person_audit_operations where id=p_operation;
 select * into ev from public.person_change_events where id=p_event;
 if (e.mode<>'live' and e.creation_execution_id is null) or e.audit_id is distinct from p_operation or d.work_id<>e.work_id or d.candidate_id<>e.candidate_id or
 d.transaction_id<>pg_current_xact_id() or o.transaction_id is distinct from d.transaction_id or
 d.operation_hash is distinct from person_private.directory_operation_hash(o) or ev.id is null or (p_scope<>'creation' and ev.id<=d.captured_version) or ev.candidate_id<>e.candidate_id or ev.transaction_id is distinct from d.transaction_id or ev.source_table<>'candidates' or ev.source_row_id<>e.candidate_id::text or ev.operation<>(case when p_scope='creation' then 'INSERT' else 'UPDATE' end) or p_scope not in ('creation','profile','directory_metadata') then raise exception 'directory_attribution_scope';end if;
 if p_scope='creation' and (e.creation_execution_id is distinct from e.id or d.creator_event_id is distinct from p_event or person_private.directory_creation_valid(e.id,false) is distinct from true or e.transaction_id<>pg_current_xact_id()) then raise exception 'directory_creation_attribution';end if;
 return e.id;
end$function$;


CREATE OR REPLACE FUNCTION person_private.directory_complete(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
 SET "DateStyle" TO 'ISO,YMD'
AS $function$
declare e person_private.directory_executions;r public.person_directory_receipts;s public.person_directory_state;
 old_primary jsonb;new_primary jsonb;changed_choice boolean;revision bigint;outcome jsonb;candidate jsonb;w person_private.transition_work;expected_state jsonb;returned_state jsonb;expected_contacts jsonb;actual_contacts jsonb;
begin
 e:=person_private.directory_context(p_id);
 if e.decision is null or e.next_document<>jsonb_array_length(e.decision->'docs') then raise exception 'directory_incomplete';end if;
 if e.prepared_revision is null then
  if e.mode<>'shadow' then raise exception 'directory_not_prepared';end if;
  perform person_private.directory_prepare(p_id);e:=person_private.directory_context(p_id);
 end if;
 select * into r from public.person_directory_receipts where id=e.receipt_id;
 select * into s from public.person_directory_state where contact_id=e.contact_id;
 if s.latest_receipt_id is distinct from r.id or s.workspace_id is distinct from e.workspace_id then raise exception 'directory_receipt_ineligible';end if;
 if e.creation_execution_id is not null and person_private.directory_creation_valid(e.creation_execution_id,e.creation_execution_id<>e.id) is distinct from true then raise exception 'directory_creation_witness';end if;
 if e.creation_execution_id is not null then
  perform person_private.receipt_creator_valid(e.candidate_id,e.organization_id,(select a from public.person_audit_anchors a where a.candidate_id=e.candidate_id),case when e.creation_execution_id=e.id then e.id else null end);
 end if;
 revision:=e.prepared_revision;changed_choice:=e.primary_changed;
 if (select rev from public.candidate_profile_state where candidate_id=e.candidate_id) is distinct from revision then raise exception 'projection_revision';end if;
 if (e.mode='live' or e.creation_execution_id is not null) and (e.projection is null or not e.metadata_done or not e.enqueue_done or to_jsonb(r) is distinct from e.derivative_receipt or
  (e.mode='live' and (e.chunk_disposition is distinct from 'enqueued' or (select to_jsonb(j) from public.person_derivative_jobs j where candidate_id=e.candidate_id) is distinct from e.derivative_job)) or (e.mode='shadow' and (e.chunk_disposition is distinct from 'not_applicable' or e.derivative_job is not null)) or
  (select to_jsonb(ps) from public.person_projection_state ps where ps.candidate_id=e.candidate_id) is distinct from e.projection->'state' or
 (e.projection->>'historyId' is not null and (select to_jsonb(ph) from public.person_projection_history ph where ph.id=(e.projection->>'historyId')::bigint) is distinct from e.projection->'history')) then raise exception 'directory_publication_incomplete';end if;
 select to_jsonb(x) into candidate from public.candidates x where id=e.candidate_id;
 if candidate is distinct from (case when e.mode='live' or e.creation_execution_id is not null then e.candidate_after else e.candidate_before end) then raise exception 'directory_candidate_changed';end if;
 outcome:=jsonb_build_object('status','done','candidateId',e.candidate_id,'created',e.creation_execution_id is not null,'revision',revision::text,'semanticChanged',coalesce((e.projection->>'semanticChanged')::boolean,false),'projected',coalesce((e.projection->>'projected')::boolean,false),'reviewCount',jsonb_array_length(e.decision->'reviews'),'changed',e.changed or changed_choice or coalesce((e.projection->>'projected')::boolean,false));
 perform person_private.directory_mutate('person_directory_receipts',to_jsonb(r),to_jsonb(r)||jsonb_build_object('candidate_id',e.candidate_id,'projected',e.mode='live' or e.creation_execution_id is not null,'created_person',e.creation_execution_id is not null,'documents',e.decision->'docs','source_reviews',e.decision->'reviews','phase','done','result',outcome,'attempts',r.attempts+1,'updated_at',clock_timestamp()));
 perform person_private.directory_mutate('person_directory_state',to_jsonb(s),to_jsonb(s)||jsonb_build_object('applied_receipt_id',e.receipt_id));
 perform person_private.directory_context(p_id);
 update person_private.directory_executions set result=outcome,completed_at=clock_timestamp(),receipt_after=(select to_jsonb(rr) from public.person_directory_receipts rr where rr.id=e.receipt_id) where id=p_id;
 if person_private.directory_completion_valid(p_id) is distinct from true then raise exception 'directory_completion_witness';end if;
 perform person_private.transition_finish(e.work_id,current_setting('person.work_token')::uuid,'completed');
 select * into w from person_private.transition_work where id=e.work_id;
 if w.status<>'completed' or w.finished_at is null or w.lease_until<=clock_timestamp() then raise exception 'directory_completion_work';end if;
 if e.creation_execution_id is not null then perform person_private.receipt_creator_valid(e.candidate_id,e.organization_id,(select a from public.person_audit_anchors a where a.candidate_id=e.candidate_id));end if;
 if (select to_jsonb(x) from public.candidates x where id=e.candidate_id) is distinct from (case when e.mode='live' or e.creation_execution_id is not null then e.candidate_after else e.candidate_before end) then raise exception 'directory_candidate_changed';end if;
 return outcome;
end$function$;


CREATE OR REPLACE FUNCTION person_private.directory_completion_valid(p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
 SET "DateStyle" TO 'ISO,YMD'
AS $function$
declare e person_private.directory_executions;r public.person_directory_receipts;w person_private.transition_work;
begin
 select * into e from person_private.directory_executions where id=p_id;
 select * into r from public.person_directory_receipts where id=e.receipt_id;
 select * into w from person_private.transition_work where id=e.work_id;
 if w.status='completed' and e.creation_execution_id is not null then perform person_private.receipt_creator_valid(e.candidate_id,e.organization_id,(select a from public.person_audit_anchors a where a.candidate_id=e.candidate_id));end if;
 return e.id is not null and e.result is not null and e.completed_at is not null and e.candidate_id is not null and
 w.id is not null and w.family='directory' and w.scope='tt_person' and w.organization_id=e.organization_id and w.input_hash=e.input_hash and
 w.resource_key='directory:'||e.receipt_id::text||':'||e.id::text and r.phase='done' and r.candidate_id=e.candidate_id and r.created_person=(e.creation_execution_id is not null) and r.projected=(e.mode='live' or e.creation_execution_id is not null) and
 r.documents=e.decision->'docs' and r.source_reviews=e.decision->'reviews' and r.result=e.result and to_jsonb(r)=e.receipt_after and
 e.next_document=jsonb_array_length(e.decision->'docs') and e.prepared_revision is not null and
 ((e.mode='shadow' and e.creation_execution_id is null) or (e.projection is not null and e.candidate_after is not null and e.metadata_done and e.enqueue_done)) and
 (e.creation_execution_id is null or person_private.directory_creation_valid(e.creation_execution_id,e.creation_execution_id<>e.id)) and
 e.decision_hash=person_private.intake_hash(jsonb_build_array(e.evidence,e.decision,e.identities,e.primary_value)) and
 exists(select 1 from person_private.directory_audit_operations d join public.person_audit_operations o on o.id=d.operation_id
 where d.execution_id=e.id and d.operation_id=e.audit_id and d.work_id=e.work_id and d.candidate_id=e.candidate_id and d.transaction_id=e.transaction_id
 and o.candidate_id=e.candidate_id and o.transaction_id=e.transaction_id and o.writer='directory' and o.receipt_ref='directory:'||e.receipt_id::text
 and d.operation_hash=person_private.directory_operation_hash(o));
end$function$;

create or replace function person_private.directory_enqueue(p_id uuid,p_before jsonb,p_data jsonb,p_text text,p_before_text text) returns void
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;r public.person_directory_receipts;job jsonb;target jsonb;
begin
 e:=person_private.directory_context(p_id);
 if (e.mode<>'live' and e.creation_execution_id is null) or not e.metadata_done or e.enqueue_done or p_text is null or length(p_text)>8000 or p_before_text is null then raise exception 'directory_derivative_text';end if;
 if e.mode='live' then job:=person_private.derivative_enqueue(p_id,e.candidate_id,'directory:'||e.receipt_id::text,p_before,p_data);
 elsif person_private.publication_candidate(e.candidate_id) is distinct from e.candidate_after or (select ps.revision from public.person_projection_state ps where ps.candidate_id=e.candidate_id) is distinct from e.prepared_revision then raise exception 'directory_derivative_scope';end if;
 select * into r from public.person_directory_receipts where id=e.receipt_id;
 if r.derivative_text is not null or e.creation_execution_id is not null or e.candidate_before->>'matching_embedding' is null or p_text<>p_before_text or exists(select 1 from public.person_directory_receipts where candidate_id=e.candidate_id and derivative_text=p_text and not derivative_done and id<>r.id) then
  target:=to_jsonb(r)||jsonb_build_object('derivative_text',p_text,'derivative_revision',e.prepared_revision);
  if r.derivative_text is not null and r.derivative_text<>p_text then
   target:=target||jsonb_build_object('derivative_token',null,'derivative_lease_until',null,'derivatives_claimed_at',null,'derivative_attempts',0,'derivative_done',false,'derivative_error',null);
  end if;
  perform person_private.directory_mutate('person_directory_receipts',to_jsonb(r),target);
 end if;
 perform person_private.directory_context(p_id);
 update person_private.directory_executions set enqueue_done=true,derivative_job=job,chunk_disposition=case when e.mode='live' then 'enqueued' else 'not_applicable' end,derivative_receipt=(select to_jsonb(rr) from public.person_directory_receipts rr where rr.id=e.receipt_id) where id=p_id;
end$$;
do $$declare p record;begin
 for p in select oid::regprocedure signature from pg_proc where pronamespace='person_private'::regnamespace and proname in
 ('directory_seed','directory_creation_valid','receipt_creator_valid') loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',p.signature);
 end loop;
end$$;
