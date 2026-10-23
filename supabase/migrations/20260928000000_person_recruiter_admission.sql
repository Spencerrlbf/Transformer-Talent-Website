-- PREPARED ONLY. Atomic recruiter contact edits; no production activation.
-- CLI timestamp renamed after 230000 to preserve the reviewed dependency order.
set local lock_timeout='2s';set local statement_timeout='30s';
create table person_private.recruiter_saves(
 id uuid primary key,work_id uuid not null unique references person_private.transition_work(id),
 organization_id uuid not null,candidate_id uuid not null references public.candidates(id),actor_id uuid not null,
 input_hash text not null,requested_contact jsonb not null,mode text not null check(mode in ('shadow','live')),
 edited_at timestamptz not null,backend_pid integer not null,transaction_id xid8 not null,work_snapshot jsonb not null,
 candidate_before jsonb not null,prior_contacts jsonb not null,prior_flags jsonb,choices jsonb,document jsonb,
 audit_id uuid references public.person_audit_operations(id),audit_operation jsonb,attributions jsonb not null default '[]',
 receipt jsonb,primary_rows jsonb,normalized boolean not null default false,normalization_result jsonb,
 prepared_revision bigint,normalized_state jsonb,normalized_source jsonb,normalized_contacts jsonb,
 projection jsonb,candidate_after jsonb,result jsonb,completed_at timestamptz,seal_hash text not null
);
create table person_private.recruiter_admission_frames(backend_pid integer not null,transaction_id xid8 not null,request_id uuid not null,primary key(backend_pid,transaction_id));
create table person_private.recruiter_normalization_frames(backend_pid integer not null,transaction_id xid8 not null,execution_id uuid not null references person_private.recruiter_saves(id),work_id uuid not null,candidate_id uuid not null,document jsonb not null,primary key(backend_pid,transaction_id));
create table person_private.recruiter_audit_operations(operation_id uuid primary key references public.person_audit_operations(id),execution_id uuid not null references person_private.recruiter_saves(id),work_id uuid not null,candidate_id uuid not null,transaction_id xid8 not null,captured_version bigint not null,creator_event_id bigint,operation_hash text not null);
create table person_private.recruiter_projection_frames(backend_pid integer not null,transaction_id xid8 not null,work_id uuid not null,candidate_id uuid not null,operation_id uuid not null,before_profile jsonb not null,after_profile jsonb not null,execution_id uuid not null references person_private.recruiter_saves(id),primary key(backend_pid,transaction_id));
create table person_private.recruiter_frames(backend_pid integer not null,transaction_id xid8 not null,execution_id uuid not null references person_private.recruiter_saves(id),relation_name text not null,before_row jsonb,after_row jsonb not null,before_seen boolean not null default false,after_seen boolean not null default false,primary key(backend_pid,transaction_id));
do $$declare t text;begin foreach t in array array['recruiter_saves','recruiter_admission_frames','recruiter_normalization_frames','recruiter_audit_operations','recruiter_projection_frames','recruiter_frames'] loop execute format('alter table person_private.%I enable row level security',t);execute format('revoke all on person_private.%I from public,anon,authenticated,service_role',t);end loop;end$$;
create index recruiter_save_candidate on person_private.recruiter_saves(candidate_id);
create index recruiter_audit_candidate on person_private.recruiter_audit_operations(candidate_id,captured_version);
create function person_private.recruiter_valid(s person_private.recruiter_saves) returns boolean language sql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
 select s.id is not null and s.seal_hash=person_private.intake_hash(to_jsonb(s)-'seal_hash') and exists(select 1 from person_private.transition_work w where w.id=s.work_id and w.organization_id=s.organization_id and w.family='recruiter' and w.scope='tt_person' and w.resource_key='recruiter:'||s.id::text and w.input_hash=person_private.intake_hash(jsonb_build_array(s.organization_id,s.id,s.candidate_id,s.actor_id,s.input_hash,s.requested_contact,s.mode)) and to_jsonb(w)-array['status','finished_at']=s.work_snapshot-array['status','finished_at'])
$$;
create function person_private.recruiter_set(p_old jsonb,p_new jsonb) returns person_private.recruiter_saves language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.recruiter_saves;actual person_private.recruiter_saves;saved person_private.recruiter_saves;
begin
 s:=jsonb_populate_record(null::person_private.recruiter_saves,p_new);s.seal_hash:=person_private.intake_hash(to_jsonb(s)-'seal_hash');
 if p_old is null then insert into person_private.recruiter_saves select s.* returning * into saved;
 else
  select * into actual from person_private.recruiter_saves where id=s.id;
  if to_jsonb(actual) is distinct from p_old then raise exception 'recruiter_changed';end if;
  update person_private.recruiter_saves set prior_flags=s.prior_flags,choices=s.choices,document=s.document,audit_id=s.audit_id,audit_operation=s.audit_operation,attributions=s.attributions,receipt=s.receipt,primary_rows=s.primary_rows,normalized=s.normalized,normalization_result=s.normalization_result,prepared_revision=s.prepared_revision,normalized_state=s.normalized_state,normalized_source=s.normalized_source,normalized_contacts=s.normalized_contacts,projection=s.projection,candidate_after=s.candidate_after,result=s.result,completed_at=s.completed_at,seal_hash=s.seal_hash where id=s.id returning * into saved;
 end if;
 select * into actual from person_private.recruiter_saves where id=s.id;
 if to_jsonb(saved) is distinct from to_jsonb(s) or to_jsonb(actual) is distinct from to_jsonb(s) or person_private.recruiter_valid(actual) is distinct from true then raise exception 'recruiter_actual';end if;return actual;
end$$;
create function person_private.recruiter_context(p_id uuid) returns person_private.recruiter_saves language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.recruiter_saves;w person_private.transition_work;c person_private.transition_control;
begin
 select * into s from person_private.recruiter_saves where id=p_id;select * into w from person_private.transition_work where id=s.work_id;select * into c from person_private.transition_control where singleton;
 if person_private.recruiter_valid(s) is distinct from true or s.backend_pid<>pg_backend_pid() or s.transaction_id<>pg_current_xact_id() or s.result is not null or current_setting('person.work_id',true) is distinct from w.id::text or md5(current_setting('person.work_token',true)) is distinct from w.token_hash or w.generation<>c.generation or (c.enabled and c.phase<>'open') or w.status<>'active' or w.lease_until<=clock_timestamp() then raise exception 'recruiter_context';end if;return s;
end$$;
create function person_private.recruiter_begin(p_org uuid,p_id uuid,p_candidate uuid,p_actor uuid,p_hash text,p_contact jsonb,p_mode text) returns jsonb language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare ctl person_private.transition_control;s person_private.recruiter_saves;w person_private.transition_work;c jsonb;token uuid:=gen_random_uuid();claim jsonb;
begin
 if p_org is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a'::uuid or p_id is null or p_candidate is null or p_actor is null or p_hash is null or p_hash !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_contact) is distinct from 'object' or p_mode is null or p_mode not in ('shadow','live') or current_setting('transaction_isolation')<>'read committed' then raise exception 'recruiter_input';end if;
 if nullif(current_setting('person.work_id',true),'') is not null or person_private.recruiter_frames_present() then raise exception 'recruiter_nested';end if;
 ctl:=person_private.transition_lock();perform pg_advisory_xact_lock(72016,hashtext(p_id::text));
 select * into s from person_private.recruiter_saves where id=p_id;
 if found then
  perform 1 from person_private.transition_work where id=s.work_id for update;
  if s.organization_id<>p_org or s.candidate_id<>p_candidate or s.actor_id<>p_actor or s.input_hash<>p_hash or s.requested_contact is distinct from p_contact then raise exception 'person_recruiter_receipt_conflict';end if;
  if person_private.recruiter_completion_valid(p_id) is distinct from true then raise exception 'recruiter_incomplete';end if;
  perform pg_advisory_xact_lock(hashtext(p_candidate::text));perform 1 from public.candidates where id=p_candidate for update;
  if not found then raise exception 'person_not_found';end if;
  return jsonb_build_object('status','completed');
 end if;
 if exists(select 1 from public.person_recruiter_receipts where id=p_id) then raise exception 'recruiter_unowned_receipt';end if;
 if ctl.enabled and ctl.phase<>'open' then return jsonb_build_object('status','unavailable');end if;
 insert into person_private.recruiter_admission_frames values(pg_backend_pid(),pg_current_xact_id(),p_id);
 claim:=person_private.transition_claim('tt_person',p_org,'recruiter','recruiter:'||p_id::text,person_private.intake_hash(jsonb_build_array(p_org,p_id,p_candidate,p_actor,p_hash,p_contact,p_mode)),token,30);
 delete from person_private.recruiter_admission_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if claim->>'status' is distinct from 'admitted' or exists(select 1 from person_private.recruiter_admission_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'recruiter_admission';end if;
 select * into strict w from person_private.transition_work where id=(claim->>'work_id')::uuid;
 perform set_config('person.work_id',w.id::text,true);perform set_config('person.work_token',token::text,true);
 perform pg_advisory_xact_lock(hashtext(p_candidate::text));select to_jsonb(x) into c from public.candidates x where id=p_candidate for update;
 if c is null then raise exception 'person_not_found';end if;
 if not exists(select 1 from public.candidate_profile_state where candidate_id=p_candidate) then raise exception 'person_recruiter_not_migrated';end if;
 if exists(select 1 from public.person_source_holds where candidate_id=p_candidate and resolved_at is null) then raise exception 'person_recruiter_source_hold';end if;
 s:=person_private.recruiter_set(null,jsonb_build_object('id',p_id,'work_id',w.id,'organization_id',p_org,'candidate_id',p_candidate,'actor_id',p_actor,'input_hash',p_hash,'requested_contact',p_contact,'mode',p_mode,'edited_at',date_trunc('milliseconds',clock_timestamp()),'backend_pid',pg_backend_pid(),'transaction_id',pg_current_xact_id()::text,'work_snapshot',to_jsonb(w),'candidate_before',c,'prior_contacts',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') from public.candidate_contacts x where candidate_id=p_candidate),'attributions','[]'::jsonb,'normalized',false));
 perform person_private.recruiter_context(p_id);
 return jsonb_build_object('status','admitted','before',c,'editedAt',s.edited_at,'contacts',s.prior_contacts);
end$$;
do $$declare d text;n text:=E'begin\n';begin
 d:=pg_get_functiondef('person_private.transition_claim(text,uuid,text,text,text,uuid,integer)'::regprocedure);
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'recruiter_claim_definition';end if;
 execute replace(d,n,n||E' if p_family=''recruiter'' and not exists(select 1 from person_private.recruiter_admission_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and p_resource=''recruiter:''||request_id::text) then raise exception ''recruiter_admission_required'';end if;\n');
end$$;
create function person_private.recruiter_seal(p_id uuid,p_doc jsonb,p_choices jsonb,p_flags jsonb) returns void language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.recruiter_saves;src jsonb;item jsonb;prior jsonb;
begin
 s:=person_private.recruiter_context(p_id);src:=p_doc->'source';
 if s.document is not null or p_doc->>'candidate_id' is distinct from s.candidate_id::text or p_doc->>'mode' is distinct from 'contacts_only' or src->>'source' is distinct from 'recruiter' or src->>'provider' is distinct from 'website-recruiter' or src->>'source_ref' is distinct from p_id::text or src->>'raw_in' is distinct from 'inline' or src->>'enrichment_id' is not null or (src->>'fetched_at')::timestamptz is distinct from s.edited_at or src->>'parser_version' is distinct from 'person-v3' or jsonb_typeof(p_flags) is distinct from 'array' or jsonb_typeof(p_choices) is distinct from 'object' or p_choices-array['email','phone']<>'{}'::jsonb then raise exception 'recruiter_document_binding';end if;
 for item in select value from jsonb_array_elements(p_flags) loop
  select value into prior from jsonb_array_elements(s.prior_contacts) x where x->>'kind'=item->>'kind' and x->>'value_normalized'=item->>'value_normalized';
  if item->'existed' is distinct from to_jsonb(prior is not null) or item->'never_primary' is distinct from coalesce(prior->'never_primary','null'::jsonb) then raise exception 'recruiter_prior_flags';end if;
 end loop;
 for item in select jsonb_build_object('kind',key,'value',value) from jsonb_each(p_choices) where value<>'null'::jsonb loop
  select value into prior from jsonb_array_elements(s.prior_contacts) x where x->>'kind'=item->>'kind' and x->>'value_normalized'=item->>'value';
  if coalesce((prior->>'never_primary')::boolean,false) or prior->>'status' in ('invalid','bounced','do_not_use','removed','shared') or (item->>'kind'='email' and public.tt_email_check_class(prior->>'quality',prior->>'result')='bad') then raise exception '%_unusable',item->>'kind';end if;
 end loop;
 perform person_private.recruiter_set(to_jsonb(s),to_jsonb(s)||jsonb_build_object('document',p_doc,'choices',p_choices,'prior_flags',p_flags));
end$$;
-- Exact synchronous frames cover receipt, preference and intentional legacy contact writes.
create function person_private.recruiter_frame_check(p_table text,p_old jsonb,p_new jsonb,p_when text,p_op text) returns void language plpgsql set search_path='' as $$
declare f person_private.recruiter_frames;s person_private.recruiter_saves;
begin
 select * into f from person_private.recruiter_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();s:=person_private.recruiter_context(f.execution_id);
 if f.relation_name is distinct from p_table or f.before_row is distinct from p_old or f.after_row is distinct from p_new or p_op is distinct from (case when p_old is null then 'INSERT' else 'UPDATE' end) then raise exception 'recruiter_write_frame';end if;
 if p_when='BEFORE' then
  if f.before_seen or f.after_seen then raise exception 'recruiter_write_reentry';end if;
  update person_private.recruiter_frames set before_seen=true where backend_pid=f.backend_pid and transaction_id=f.transaction_id;
 else
  if not f.before_seen or f.after_seen then raise exception 'recruiter_write_reentry';end if;
  update person_private.recruiter_frames set after_seen=true where backend_pid=f.backend_pid and transaction_id=f.transaction_id;
 end if;
end$$;
create function person_private.recruiter_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare owned boolean;
begin
 if tg_level='STATEMENT' then
  if tg_op='TRUNCATE' then raise exception 'recruiter_truncate';end if;perform person_private.transition_lock();return null;
 end if;
 owned:=exists(select 1 from person_private.recruiter_saves where id=any(array[(to_jsonb(old)->>(case when tg_table_name='person_recruiter_receipts' then 'id' else 'receipt_id' end))::uuid,(to_jsonb(new)->>(case when tg_table_name='person_recruiter_receipts' then 'id' else 'receipt_id' end))::uuid]));
 if not owned and not person_private.normalization_required() then return coalesce(new,old);end if;
 perform person_private.recruiter_frame_check(tg_table_name,case when tg_op='INSERT' then null else to_jsonb(old) end,to_jsonb(new),tg_when,tg_op);return new;
end$$;
do $$declare t text;d text;n text:=E'begin\n';begin
 foreach t in array array['person_recruiter_receipts','person_recruiter_primary'] loop
  execute format('create trigger person_recruiter_statement before insert or update or delete or truncate on public.%I for each statement execute function person_private.recruiter_guard()',t);
  execute format('create trigger person_recruiter_before before insert or update or delete on public.%I for each row execute function person_private.recruiter_guard()',t);
  execute format('create trigger person_recruiter_after after insert or update or delete on public.%I for each row execute function person_private.recruiter_guard()',t);
 end loop;
 d:=pg_get_functiondef('person_private.intake_mutation_guard()'::regprocedure);
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'recruiter_guard_definition';end if;
 execute replace(d,n,n||E' if tg_table_name=''candidates'' and exists(select 1 from person_private.recruiter_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and relation_name=''candidates'') then perform person_private.recruiter_frame_check(tg_table_name,o,n,tg_when,tg_op);return new;end if;\n');
end$$;
create function person_private.recruiter_write(p_id uuid,p_table text,p_before jsonb,p_after jsonb) returns void language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.recruiter_saves;returned jsonb;actual jsonb;f person_private.recruiter_frames;cols text;predicate text;
begin
 s:=person_private.recruiter_context(p_id);
 if p_table is null or p_table not in ('person_recruiter_receipts','person_recruiter_primary','candidates') or p_after is null or exists(select 1 from person_private.recruiter_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'recruiter_write_scope';end if;
 if p_table='person_recruiter_receipts' then
  if p_after->>'id' is distinct from s.id::text or p_after->>'candidate_id' is distinct from s.candidate_id::text then raise exception 'recruiter_write_scope';end if;predicate:='id=($1->>''id'')::uuid';
 elsif p_table='person_recruiter_primary' then
  if p_after->>'candidate_id' is distinct from s.candidate_id::text or p_after->>'receipt_id' is distinct from s.id::text or p_after->>'kind' not in ('email','phone') or p_after->'chosen_value' is distinct from s.choices->(p_after->>'kind') then raise exception 'recruiter_write_scope';end if;predicate:='candidate_id=($1->>''candidate_id'')::uuid and kind=$1->>''kind''';
 else
  if p_before is null or p_after->>'id' is distinct from s.candidate_id::text or p_after-array['contact','updated_at'] is distinct from p_before-array['contact','updated_at'] or p_after->'contact' is distinct from s.requested_contact then raise exception 'recruiter_write_scope';end if;predicate:='id=($1->>''id'')::uuid';
 end if;
 execute format('select to_jsonb(x) from public.%I x where %s',p_table,predicate) into actual using p_after;
 if actual is distinct from p_before then raise exception 'recruiter_write_changed';end if;
 insert into person_private.recruiter_frames(backend_pid,transaction_id,execution_id,relation_name,before_row,after_row) values(pg_backend_pid(),pg_current_xact_id(),p_id,p_table,p_before,p_after);
 if p_before is null then
  execute format('insert into public.%I select x.* from jsonb_populate_record(null::public.%I,$1) x returning to_jsonb(%I)',p_table,p_table,p_table) into returned using p_after;
 else
  select string_agg(quote_ident(attname),',' order by attnum) into cols from pg_attribute where attrelid=format('public.%I',p_table)::regclass and attnum>0 and not attisdropped;
  execute format('update public.%I set (%s)=(select %s from jsonb_populate_record(null::public.%I,$1)) where %s returning to_jsonb(%I)',p_table,cols,cols,p_table,predicate,p_table) into returned using p_after;
 end if;
 execute format('select to_jsonb(x) from public.%I x where %s',p_table,predicate) into actual using p_after;
 select * into f from person_private.recruiter_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if returned is distinct from p_after or actual is distinct from p_after or f.execution_id is distinct from s.id or f.relation_name is distinct from p_table or f.before_row is distinct from p_before or f.after_row is distinct from p_after or not coalesce(f.before_seen and f.after_seen,false) then raise exception 'recruiter_write_actual';end if;
 delete from person_private.recruiter_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if exists(select 1 from person_private.recruiter_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'recruiter_write_cleanup';end if;
 perform person_private.recruiter_context(p_id);
end$$;

CREATE OR REPLACE FUNCTION person_private.recruiter_audit_begin(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
 SET "DateStyle" TO 'ISO,YMD'
AS $function$
declare dx person_private.recruiter_saves;anchor public.person_audit_anchors;c jsonb;aux jsonb;guard jsonb;src jsonb;
 e record;v bigint;start_v bigint;candidate_hash text;current_hash text;oid uuid:=gen_random_uuid();events_seen integer:=0;checkpoint record;stored_operation public.person_audit_operations;expected_operation public.person_audit_operations;creator bigint;
begin
 dx:=person_private.recruiter_context(p_id);
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
 expected_operation:=jsonb_populate_record(null::public.person_audit_operations,jsonb_build_object('id',oid,'candidate_id',dx.candidate_id,'writer','recruiter','receipt_ref','recruiter:'||dx.id::text,'evidence',jsonb_build_object('guard',guard,'prior_contact_flags',dx.prior_flags),'transaction_id',pg_current_xact_id()::text,'created_at',clock_timestamp()));
 insert into public.person_audit_operations select expected_operation.* returning * into stored_operation;
 -- Validate the independently constructed expected guard and complete row before
 -- registering it as authority; hashing a trigger-altered operation is insufficient.
 if to_jsonb(stored_operation) is distinct from to_jsonb(expected_operation) or (select to_jsonb(o) from public.person_audit_operations o where id=oid) is distinct from to_jsonb(expected_operation) then raise exception 'refresh_audit_actual';end if;
 insert into person_private.recruiter_audit_operations values(oid,dx.id,dx.work_id,dx.candidate_id,pg_current_xact_id(),v,creator,person_private.directory_operation_hash(stored_operation));
 perform person_private.recruiter_set(to_jsonb(dx),to_jsonb(dx)||jsonb_build_object('audit_id',oid,'audit_operation',to_jsonb(expected_operation)));
 perform person_private.audit_proof_clear('person_audit_operations');
 if not exists(select 1 from person_private.recruiter_audit_operations p where p.operation_id=oid and p.execution_id=dx.id and p.work_id=dx.work_id and p.candidate_id=dx.candidate_id and p.transaction_id=pg_current_xact_id() and p.captured_version=v and p.creator_event_id is null and p.operation_hash=person_private.directory_operation_hash(stored_operation)) then raise exception 'refresh_audit_private_actual';end if;
 perform person_private.recruiter_context(p_id);
 return jsonb_build_object('id',oid,'candidateId',dx.candidate_id,'writer','recruiter','receiptRef','recruiter:'||dx.id::text,'anchorHash',anchor.anchor_hash);
exception when others then perform person_private.audit_proof_clear('person_audit_operations');perform person_private.audit_proof_clear('person_audit_anchors');raise;
end$function$;
create or replace function person_private.normalization_frame(p_candidate uuid default null,p_source uuid default null) returns person_private.normalization_frames
language plpgsql security definer set search_path='' as $$
declare f person_private.normalization_frames;d person_private.directory_normalization_frames;e person_private.directory_executions;r person_private.refresh_normalization_frames;s person_private.refresh_saves;q person_private.recruiter_normalization_frames;rs person_private.recruiter_saves;
begin
 select * into f from person_private.normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 select * into d from person_private.directory_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 select * into r from person_private.refresh_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 select * into q from person_private.recruiter_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if (f.backend_pid is not null)::int+(d.backend_pid is not null)::int+(r.backend_pid is not null)::int+(q.backend_pid is not null)::int>1 then raise exception 'normalization_nested';end if;
 if d.backend_pid is not null then
  e:=person_private.directory_context(d.execution_id);
  if e.candidate_id is distinct from d.candidate_id or e.work_id is distinct from d.work_id or not exists(select 1 from jsonb_array_elements(e.decision->'docs') doc where doc=d.document) then raise exception 'directory_normalization_frame';end if;
  f:=row(d.backend_pid,d.transaction_id,d.work_id,null,d.candidate_id,d.document)::person_private.normalization_frames;
 elsif r.backend_pid is not null then
  s:=person_private.refresh_save_context(r.execution_id);
  if s.candidate_id is distinct from r.candidate_id or s.work_id is distinct from r.work_id or s.document is distinct from r.document or s.normalized then raise exception 'refresh_normalization_frame';end if;
  f:=row(r.backend_pid,r.transaction_id,r.work_id,null,r.candidate_id,r.document)::person_private.normalization_frames;
 elsif q.backend_pid is not null then
  rs:=person_private.recruiter_context(q.execution_id);
  if rs.candidate_id is distinct from q.candidate_id or rs.work_id is distinct from q.work_id or rs.document is distinct from q.document or rs.normalized then raise exception 'recruiter_normalization_frame';end if;
  f:=row(q.backend_pid,q.transaction_id,q.work_id,null,q.candidate_id,q.document)::person_private.normalization_frames;
 end if;
 if f.backend_pid is null or (p_candidate is not null and p_candidate<>f.candidate_id) then raise exception 'normalization_frame';end if;
 if p_source is not null and not exists(select 1 from public.candidate_sources cs where cs.id=p_source and cs.candidate_id=f.candidate_id and cs.source=f.document->'source'->>'source' and cs.payload_hash=f.document->'source'->>'payload_hash') then raise exception 'normalization_source';end if;
 return f;
end$$;
create or replace function person_private.projection_frame() returns person_private.application_projection_frames language plpgsql security definer set search_path='' as $$
declare f person_private.application_projection_frames;d person_private.directory_projection_frames;e person_private.directory_executions;r person_private.refresh_projection_frames;s person_private.refresh_saves;q person_private.recruiter_projection_frames;rs person_private.recruiter_saves;
begin
 select * into f from person_private.application_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 select * into d from person_private.directory_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 select * into r from person_private.refresh_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 select * into q from person_private.recruiter_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if (f.backend_pid is not null)::int+(d.backend_pid is not null)::int+(r.backend_pid is not null)::int+(q.backend_pid is not null)::int>1 then raise exception 'projection_nested';end if;
 if d.backend_pid is not null then
  e:=person_private.directory_context(d.execution_id);
  if (e.mode<>'live' and e.creation_execution_id is null) or e.work_id<>d.work_id or e.candidate_id is distinct from d.candidate_id or e.audit_id is distinct from d.operation_id then raise exception 'directory_projection_frame';end if;
  f:=row(d.backend_pid,d.transaction_id,d.work_id,d.candidate_id,d.operation_id,d.before_profile,d.after_profile)::person_private.application_projection_frames;
 elsif r.backend_pid is not null then
  s:=person_private.refresh_save_context(r.execution_id);
  if s.mode<>'live' or not s.normalized or s.work_id<>r.work_id or s.candidate_id is distinct from r.candidate_id or s.audit_id is distinct from r.operation_id then raise exception 'refresh_projection_frame';end if;
  f:=row(r.backend_pid,r.transaction_id,r.work_id,r.candidate_id,r.operation_id,r.before_profile,r.after_profile)::person_private.application_projection_frames;
 elsif q.backend_pid is not null then
  rs:=person_private.recruiter_context(q.execution_id);
  if rs.mode<>'live' or not rs.normalized or rs.work_id<>q.work_id or rs.candidate_id is distinct from q.candidate_id or rs.audit_id is distinct from q.operation_id then raise exception 'recruiter_projection_frame';end if;
  f:=row(q.backend_pid,q.transaction_id,q.work_id,q.candidate_id,q.operation_id,q.before_profile,q.after_profile)::person_private.application_projection_frames;
 end if;
 if f.backend_pid is null then raise exception 'projection_frame';end if;return f;
end$$;
create function person_private.recruiter_project(p_id uuid,p_envelope jsonb) returns jsonb language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.recruiter_saves;r jsonb;c jsonb;
begin
 s:=person_private.recruiter_context(p_id);
 if s.mode<>'live' or not s.normalized or s.projection is not null or s.prepared_revision is null then raise exception 'refresh_projection_order';end if;
 r:=person_private.projection_apply(s.id,s.work_id,s.candidate_id,s.audit_id,s.prepared_revision,p_envelope);
 s:=person_private.recruiter_context(p_id);
 r:=r||jsonb_build_object('state',(select to_jsonb(x) from public.person_projection_state x where candidate_id=s.candidate_id),'history',(select to_jsonb(x) from public.person_projection_history x where id=(r->>'historyId')::bigint));
 select to_jsonb(x) into c from public.candidates x where id=s.candidate_id;
 perform person_private.recruiter_set(to_jsonb(s),to_jsonb(s)||jsonb_build_object('projection',r,'candidate_after',c));
 return r;
end$$;
create function person_private.recruiter_attributions_valid(s person_private.recruiter_saves) returns boolean language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare item jsonb;event_row jsonb;attribution_row jsonb;
begin
 for item in select value from jsonb_array_elements(s.attributions) loop
  select to_jsonb(e) into event_row from public.person_change_events e where id=(item->'event'->>'id')::bigint;
  select to_jsonb(a) into attribution_row from public.person_change_attributions a where event_id=(item->'event'->>'id')::bigint;
  if event_row-'reconciled_at' is distinct from item->'event' or attribution_row is distinct from item->'attribution' then return false;end if;
 end loop;
 return true;
end$$;
create function person_private.recruiter_attribution_record(p_id uuid,p_event bigint,p_operation uuid,p_scope text) returns void language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.recruiter_saves;e public.person_change_events;a jsonb;expected jsonb;changed text[];
begin
 s:=person_private.recruiter_context(p_id);
 changed:=person_private.validate_change_attribution(p_event,p_operation,p_scope);
 select * into strict e from public.person_change_events where id=p_event;
 expected:=jsonb_build_object('event_id',e.id,'candidate_id',s.candidate_id,'operation_id',s.audit_id,'scope',p_scope,'changed_fields',changed,'event_hash',md5(jsonb_build_array(e.id,e.candidate_id,e.source_table,e.source_row_id,e.operation,e.transaction_id::text,e.previous_payload,e.payload)::text));
 select to_jsonb(x) into a from public.person_change_attributions x where event_id=p_event;
 if a is null or a-'created_at' is distinct from expected or exists(select 1 from jsonb_array_elements(s.attributions) x where x->'event'->>'id'=p_event::text) then raise exception 'refresh_attribution_actual';end if;
 perform person_private.recruiter_set(to_jsonb(s),to_jsonb(s)||jsonb_build_object('attributions',s.attributions||jsonb_build_array(jsonb_build_object('event',to_jsonb(e)-'reconciled_at','attribution',a))));
end$$;
create function person_private.recruiter_projection_family() returns boolean language sql stable set search_path='' as $$select exists(select 1 from person_private.transition_work where id=nullif(current_setting('person.work_id',true),'')::uuid and family='recruiter')$$;
do $$declare d text;n text;sig text;begin
 d:=pg_get_functiondef('person_private.projection_owner(uuid)'::regprocedure);
 n:=' elsif person_private.refresh_projection_family()';
 if position(n in d)=0 then raise exception 'recruiter_projection_definition';end if;
 execute replace(d,n,' elsif person_private.recruiter_projection_family() then perform person_private.recruiter_context(p_execution);'||n);
 d:=pg_get_functiondef('person_private.projection_frame_clear(uuid)'::regprocedure);
 if position(n in d)=0 then raise exception 'recruiter_projection_definition';end if;
 execute replace(d,n,' elsif person_private.recruiter_projection_family() then delete from person_private.recruiter_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();if exists(select 1 from person_private.recruiter_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception ''recruiter_projection_cleanup'';end if;'||n);
 d:=pg_get_functiondef('person_private.projection_frame_set(uuid,uuid,uuid,uuid,jsonb,jsonb,boolean)'::regprocedure);
 if position(n in d)=0 then raise exception 'recruiter_projection_definition';end if;
 execute replace(d,n,' elsif person_private.recruiter_projection_family() then insert into person_private.recruiter_projection_frames values(pg_backend_pid(),pg_current_xact_id(),p_work,p_candidate,p_operation,p_before,p_after,p_execution);'||n);
 n:='exists(select 1 from person_private.refresh_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())';
 foreach sig in array array['person_private.projection_frame_set(uuid,uuid,uuid,uuid,jsonb,jsonb,boolean)','person_private.projection_apply(uuid,uuid,uuid,uuid,bigint,jsonb)','person_private.intake_mutation_guard()','person_private.conflict_insert(text,uuid[],jsonb,text,uuid)','person_private.refresh_metadata_check(jsonb,jsonb,text,text)'] loop
  d:=pg_get_functiondef(sig::regprocedure);if position(n in d)=0 then raise exception 'recruiter_projection_definition';end if;execute replace(d,n,n||' or exists(select 1 from person_private.recruiter_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())');
 end loop;
 n:='exists(select 1 from person_private.refresh_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())';
 foreach sig in array array['public.save_person(jsonb)','person_private.conflict_insert(text,uuid[],jsonb,text,uuid)','person_private.directory_frame(uuid,jsonb)','person_private.refresh_save_normalize(uuid)'] loop
  d:=pg_get_functiondef(sig::regprocedure);if position(n in d)=0 then raise exception 'recruiter_normalization_definition';end if;execute replace(d,n,n||' or exists(select 1 from person_private.recruiter_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())');
 end loop;
end$$;
create function person_private.recruiter_normalize(p_id uuid) returns void language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.recruiter_saves;r jsonb;receipt jsonb;item record;prior jsonb;target jsonb;state jsonb;expected_state jsonb;source jsonb;contacts jsonb;
begin
 s:=person_private.recruiter_context(p_id);
 if s.document is null or s.audit_id is null or s.normalized or person_private.recruiter_frames_present() then raise exception 'recruiter_normalization_order';end if;
 receipt:=to_jsonb(jsonb_populate_record(null::public.person_recruiter_receipts,jsonb_build_object('id',s.id,'candidate_id',s.candidate_id,'actor_id',s.actor_id,'input_hash',s.input_hash,'edited_at',s.edited_at,'requested_contact',s.requested_contact,'before_contact',s.candidate_before->'contact','document',s.document,'mode',s.mode)));
 perform person_private.recruiter_write(p_id,'person_recruiter_receipts',null,receipt);
 insert into person_private.recruiter_normalization_frames values(pg_backend_pid(),pg_current_xact_id(),s.id,s.work_id,s.candidate_id,s.document);
 perform person_private.normalization_frame(s.candidate_id);
 r:=person_private.save_person_core(s.document);
 for item in select * from jsonb_each(s.choices) order by key loop
  select to_jsonb(x) into prior from public.person_recruiter_primary x where candidate_id=s.candidate_id and kind=item.key;
  target:=jsonb_build_object('candidate_id',s.candidate_id,'kind',item.key,'chosen_value',item.value,'receipt_id',s.id);
  perform person_private.recruiter_write(p_id,'person_recruiter_primary',prior,target);
 end loop;
 perform public.person_rerank_contacts(s.candidate_id);
 select to_jsonb(x) into state from public.candidate_profile_state x where candidate_id=s.candidate_id;
 expected_state:=state||jsonb_build_object('rev',(state->>'rev')::bigint+1,'updated_at',clock_timestamp());
 update public.candidate_profile_state set rev=(expected_state->>'rev')::bigint,updated_at=(expected_state->>'updated_at')::timestamptz where candidate_id=s.candidate_id returning to_jsonb(candidate_profile_state) into state;
 if state is distinct from expected_state or (select to_jsonb(x) from public.candidate_profile_state x where candidate_id=s.candidate_id) is distinct from expected_state then raise exception 'recruiter_revision_actual';end if;
 if exists(select 1 from public.candidate_contacts cc join public.person_contact_ranks(s.candidate_id) ranks using(id) where cc.rank is distinct from ranks.new_rank) then raise exception 'recruiter_ranks_actual';end if;
 for item in select * from jsonb_each_text(s.choices) where value is not null loop
  if not exists(select 1 from public.candidate_contacts where candidate_id=s.candidate_id and kind=item.key and value_normalized=item.value and rank=1 and status='active' and not never_primary and (kind<>'email' or public.tt_email_check_class(quality,result)<>'bad')) then raise exception '%_unusable',item.key;end if;
 end loop;
 select to_jsonb(cs) into source from public.candidate_sources cs where cs.candidate_id=s.candidate_id and cs.source='recruiter' and cs.source_ref=s.id::text and cs.payload_hash=s.document->'source'->>'payload_hash' and cs.fetched_at=s.edited_at and cs.parser_version='person-v3' and cs.provider='website-recruiter' and cs.raw_in='inline' and cs.enrichment_id is null;
 if source is null then raise exception 'recruiter_source_actual';end if;
 perform person_private.normalization_frame(s.candidate_id);
 delete from person_private.recruiter_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if exists(select 1 from person_private.recruiter_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'recruiter_normalization_cleanup';end if;
 -- Core normalization can preserve older verification/provenance. Every requested
 -- key must still exist and retain this sighting and manual/never-primary facts;
 -- a trigger-suppressed secondary email or GitHub insert is not a completed edit.
 if exists(select 1 from jsonb_array_elements(s.document->'contacts') doc where not exists(
  select 1 from public.candidate_contacts cc where cc.candidate_id=s.candidate_id and cc.kind=doc->>'kind' and cc.value_normalized=doc->>'value_normalized'
  and cc.first_seen_at<=s.edited_at and cc.last_seen_at>=s.edited_at
  and (not coalesce((doc->>'is_manual')::boolean,false) or (cc.is_manual and cc.manual_at>=s.edited_at))
  and (not coalesce((doc->>'never_primary')::boolean,false) or cc.never_primary)
 )) then raise exception 'recruiter_contacts_actual';end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') into contacts from public.candidate_contacts x where candidate_id=s.candidate_id;
 perform person_private.recruiter_set(to_jsonb(s),to_jsonb(s)||jsonb_build_object('receipt',receipt,'primary_rows',(select jsonb_agg(to_jsonb(x) order by x.kind) from public.person_recruiter_primary x where candidate_id=s.candidate_id),'normalized',true,'normalization_result',r,'prepared_revision',(state->>'rev')::bigint,'normalized_state',state,'normalized_source',source,'normalized_contacts',contacts));
end$$;
create function person_private.recruiter_attribution_context(p_event bigint,p_operation uuid,p_scope text) returns uuid language plpgsql set search_path='' as $$
declare a person_private.recruiter_audit_operations;s person_private.recruiter_saves;o public.person_audit_operations;ev public.person_change_events;
begin
 select * into a from person_private.recruiter_audit_operations where operation_id=p_operation;s:=person_private.recruiter_context(a.execution_id);
 select * into o from public.person_audit_operations where id=p_operation;select * into ev from public.person_change_events where id=p_event;
 if s.audit_id is distinct from p_operation or a.work_id<>s.work_id or a.candidate_id<>s.candidate_id or a.transaction_id<>pg_current_xact_id() or o.transaction_id is distinct from a.transaction_id or a.operation_hash is distinct from person_private.directory_operation_hash(o) or ev.id is null or ev.id<=a.captured_version or ev.candidate_id<>s.candidate_id or ev.transaction_id is distinct from a.transaction_id or ev.source_table<>'candidates' or ev.source_row_id<>s.candidate_id::text or ev.operation<>'UPDATE' or p_scope not in ('profile','recruiter_contact') or (p_scope='profile' and s.mode<>'live') then raise exception 'recruiter_attribution_scope';end if;return s.id;
end$$;
do $$declare d text;n text;begin
 d:=pg_get_functiondef('person_private.attribute_change(bigint,uuid,text)'::regprocedure);
 n:=' if exists(select 1 from person_private.refresh_audit_operations where operation_id=p_operation) then';
 if position(n in d)=0 or position('refresh_id uuid;' in d)=0 then raise exception 'recruiter_attribution_definition';end if;
 d:=replace(d,'refresh_id uuid;','refresh_id uuid;recruiter_id uuid;');
 d:=replace(d,n,' if exists(select 1 from person_private.recruiter_audit_operations where operation_id=p_operation) then recruiter_id:=person_private.recruiter_attribution_context(p_event,p_operation,p_scope);elsif exists(select 1 from person_private.refresh_audit_operations where operation_id=p_operation) then');
 d:=replace(d,' if refresh_id is not null then',' if recruiter_id is not null then perform person_private.recruiter_attribution_record(recruiter_id,p_event,p_operation,p_scope);elsif refresh_id is not null then');execute d;
end$$;
create function person_private.recruiter_contact(p_id uuid) returns void language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.recruiter_saves;c jsonb;target jsonb;boundary bigint;event_id bigint;
begin
 s:=person_private.recruiter_context(p_id);select to_jsonb(x) into c from public.candidates x where id=s.candidate_id;
 if not s.normalized or s.candidate_after is not null or c is distinct from s.candidate_before or person_private.recruiter_frames_present() then raise exception 'recruiter_contact_order';end if;
 target:=c||jsonb_build_object('contact',s.requested_contact,'updated_at',clock_timestamp());
 select coalesce(max(id),0) into boundary from public.person_change_events where candidate_id=s.candidate_id;
 perform person_private.recruiter_write(p_id,'candidates',c,target);
 select id into strict event_id from public.person_change_events where candidate_id=s.candidate_id and source_table='candidates' and transaction_id=pg_current_xact_id() and id>boundary;
 perform person_private.attribute_change(event_id,s.audit_id,'recruiter_contact');s:=person_private.recruiter_context(p_id);
 perform person_private.recruiter_set(to_jsonb(s),to_jsonb(s)||jsonb_build_object('candidate_after',target));
end$$;
create function person_private.recruiter_frames_present() returns boolean language sql stable set search_path='' as $$
 select person_private.refresh_save_frames_present()
 or exists(select 1 from person_private.recruiter_normalization_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
 or exists(select 1 from person_private.recruiter_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
 or exists(select 1 from person_private.recruiter_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
 or exists(select 1 from person_private.recruiter_admission_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
$$;
create function person_private.recruiter_current_valid(s person_private.recruiter_saves) returns boolean language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
begin
 return s.transaction_id=pg_current_xact_id() and s.backend_pid=pg_backend_pid() and not person_private.recruiter_frames_present() and
 exists(select 1 from person_private.transition_work w join person_private.transition_control c on c.singleton where w.id=s.work_id and w.lease_until>clock_timestamp() and w.generation=c.generation and (not c.enabled or c.phase='open')) and
 (select to_jsonb(x) from public.candidates x where id=s.candidate_id)=s.candidate_after and
 (select to_jsonb(x) from public.candidate_profile_state x where candidate_id=s.candidate_id)=s.normalized_state and
 (select to_jsonb(x) from public.candidate_sources x where id=(s.normalized_source->>'id')::uuid)=s.normalized_source and
 (select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') from public.candidate_contacts x where candidate_id=s.candidate_id)=s.normalized_contacts and
 (select jsonb_agg(to_jsonb(x) order by x.kind) from public.person_recruiter_primary x where candidate_id=s.candidate_id)=s.primary_rows and
 (s.mode='shadow' or ((select to_jsonb(x) from public.person_projection_state x where candidate_id=s.candidate_id)=s.projection->'state' and
 (s.projection->>'historyId' is null or (select to_jsonb(x) from public.person_projection_history x where id=(s.projection->>'historyId')::bigint)=s.projection->'history')));
end$$;
create function person_private.recruiter_completion_valid(p_id uuid,p_completed boolean default true) returns boolean language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.recruiter_saves;w person_private.transition_work;a person_private.recruiter_audit_operations;o public.person_audit_operations;
begin
 select * into s from person_private.recruiter_saves where id=p_id;select * into w from person_private.transition_work where id=s.work_id;
 select * into a from person_private.recruiter_audit_operations where operation_id=s.audit_id;select * into o from public.person_audit_operations where id=s.audit_id;
 return person_private.recruiter_valid(s) and s.result is not null and s.completed_at is not null and s.normalized and s.prepared_revision is not null and s.normalized_source is not null and s.normalized_state is not null and s.normalized_contacts is not null and s.document is not null and s.primary_rows is not null and s.candidate_after is not null and
 (not p_completed or (w.status='completed' and w.finished_at is not null)) and (s.transaction_id<>pg_current_xact_id() or person_private.recruiter_current_valid(s)) and
 (select to_jsonb(x) from public.person_recruiter_receipts x where id=s.id)=s.receipt and s.receipt->'result'=s.result and s.receipt->'document'=s.document and
 to_jsonb(o)=s.audit_operation and a.execution_id=s.id and a.work_id=s.work_id and a.candidate_id=s.candidate_id and a.transaction_id=s.transaction_id and a.creator_event_id is null and a.captured_version::text=s.audit_operation->'evidence'->'guard'->>'captured_version' and a.operation_hash=person_private.directory_operation_hash(o) and
 o.id=s.audit_id and o.candidate_id=s.candidate_id and o.writer='recruiter' and o.receipt_ref='recruiter:'||s.id::text and o.transaction_id=s.transaction_id and person_private.recruiter_attributions_valid(s) and
 (s.mode='shadow' and s.projection is null and s.candidate_before-array['contact','updated_at']=s.candidate_after-array['contact','updated_at'] or s.mode='live' and s.projection is not null);
end$$;
create function person_private.recruiter_complete(p_id uuid,p_contact jsonb) returns jsonb language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare s person_private.recruiter_saves;r jsonb;receipt jsonb;w person_private.transition_work;expected person_private.transition_work;actual person_private.transition_work;
begin
 s:=person_private.recruiter_context(p_id);
 if person_private.recruiter_current_valid(s) is distinct from true or person_private.recruiter_attributions_valid(s) is distinct from true or not s.normalized or (s.mode='live' and s.projection is null) or jsonb_typeof(p_contact) is distinct from 'object' then raise exception 'recruiter_incomplete';end if;
 r:=jsonb_build_object('candidateId',s.candidate_id,'revision',s.prepared_revision::text,'projected',coalesce((s.projection->>'projected')::boolean,false),'semanticChanged',coalesce((s.projection->>'semanticChanged')::boolean,false),'changed',true);
 receipt:=s.receipt||jsonb_build_object('effective_contact',p_contact,'result',r);
 perform person_private.recruiter_write(p_id,'person_recruiter_receipts',s.receipt,receipt);
 s:=person_private.recruiter_set(to_jsonb(s),to_jsonb(s)||jsonb_build_object('receipt',receipt,'result',r,'completed_at',clock_timestamp()));
 if person_private.recruiter_completion_valid(p_id,false) is distinct from true then raise exception 'recruiter_incomplete';end if;
 select * into w from person_private.transition_work where id=s.work_id;
 expected:=jsonb_populate_record(w,jsonb_build_object('status','completed','finished_at',clock_timestamp()));
 update person_private.transition_work set status=expected.status,finished_at=expected.finished_at where id=s.work_id returning * into actual;
 if to_jsonb(actual) is distinct from to_jsonb(expected) or (select to_jsonb(x) from person_private.transition_work x where id=s.work_id) is distinct from to_jsonb(expected) or person_private.recruiter_completion_valid(p_id) is distinct from true then raise exception 'recruiter_work_actual';end if;return r;
end$$;
create function person_private.recruiter_work_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare s person_private.recruiter_saves;
begin
 if new.family is distinct from 'recruiter' and old.family is distinct from 'recruiter' and not exists(select 1 from person_private.recruiter_saves where work_id=old.id) then return coalesce(new,old);end if;
 if tg_op='INSERT' then
  if not exists(select 1 from person_private.recruiter_admission_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and new.resource_key='recruiter:'||request_id::text) then raise exception 'recruiter_admission_required';end if;return new;
 end if;
 select * into s from person_private.recruiter_saves where work_id=old.id;
 if tg_op<>'UPDATE' or s.transaction_id is distinct from pg_current_xact_id() or s.backend_pid is distinct from pg_backend_pid() or old.status<>'active' or new.status<>'completed' or new.finished_at is null or to_jsonb(old)-array['status','finished_at'] is distinct from to_jsonb(new)-array['status','finished_at'] or person_private.recruiter_completion_valid(s.id,false) is distinct from true then raise exception 'recruiter_work_proof';end if;return new;
end$$;
create trigger recruiter_work_before before insert or update or delete on person_private.transition_work for each row execute function person_private.recruiter_work_guard();
create trigger recruiter_work_after after insert or update or delete on person_private.transition_work for each row execute function person_private.recruiter_work_guard();
create function person_private.recruiter_deferred() returns trigger language plpgsql security definer set search_path='' as $$
declare rid uuid;
begin
 if tg_table_name='transition_work' then
  select id into rid from person_private.recruiter_saves where work_id=new.id;
  if new.family<>'recruiter' and old.family is distinct from 'recruiter' and rid is null then return null;end if;
 elsif tg_table_name='recruiter_audit_operations' then
  rid:=new.execution_id;
  if not exists(select 1 from person_private.recruiter_saves where id=rid and audit_id=new.operation_id) then raise exception 'recruiter_audit_extra';end if;
 else rid:=new.id;end if;
 if person_private.recruiter_completion_valid(rid) is distinct from true then raise exception 'recruiter_incomplete';end if;return null;
end$$;
create constraint trigger recruiter_work_complete after insert or update on person_private.transition_work deferrable initially deferred for each row execute function person_private.recruiter_deferred();
create constraint trigger recruiter_save_complete after insert or update on person_private.recruiter_saves deferrable initially deferred for each row execute function person_private.recruiter_deferred();
create constraint trigger recruiter_audit_complete after insert or update on person_private.recruiter_audit_operations deferrable initially deferred for each row execute function person_private.recruiter_deferred();
do $$declare d text;begin
 d:=regexp_replace(pg_get_viewdef('person_private.certified_audit_operations'::regclass,true),';[[:space:]]*$','');
 execute 'create or replace view person_private.certified_audit_operations with(security_invoker=true) as '||d||' union all select a.operation_id,a.work_id,a.candidate_id,a.transaction_id,a.captured_version,a.creator_event_id from person_private.recruiter_audit_operations a join person_private.recruiter_saves s on s.id=a.execution_id where a.operation_id=s.audit_id and a.work_id=s.work_id and a.candidate_id=s.candidate_id and a.transaction_id=s.transaction_id and a.creator_event_id is null and person_private.recruiter_completion_valid(s.id)';
end$$;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='person_private'::regnamespace and proname like 'recruiter_%' loop execute format('revoke all on function %s from public,anon,authenticated,service_role',p);end loop;end$$;
