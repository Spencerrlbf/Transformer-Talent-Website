-- PREPARED ONLY. Retained refresh claims and provider recovery; no profile writer.
set local lock_timeout='2s';set local statement_timeout='30s';
create table person_private.refresh_lifecycles(
 request_id uuid primary key, sequence bigint generated always as identity unique,
 work_id uuid not null unique references person_private.transition_work(id),
 queue_id uuid not null, candidate_id uuid not null references public.candidates(id),
 organization_id uuid not null, username text not null, input_hash text not null,
 options jsonb not null, phase text not null check(phase in ('claimed','retry','review','uncertain')),
 paid boolean not null, provider_started_at timestamptz,
 source_snapshot jsonb, source_hash text, expected_queue jsonb not null, expected_attempt jsonb not null,
 archives jsonb not null default '[]', claim_result jsonb not null,
 recovery_result jsonb, payload_result jsonb, work_snapshot jsonb not null, seal_hash text not null
);
create index refresh_lifecycle_queue on person_private.refresh_lifecycles(queue_id,sequence desc);
create index refresh_lifecycle_candidate on person_private.refresh_lifecycles(candidate_id);
create index refresh_lifecycle_ledger on person_private.refresh_lifecycles((source_snapshot->>'id'));
create index refresh_paid_ledger on person_private.refresh_lifecycles((expected_attempt->>'ledger_id')) where paid and provider_started_at is not null;
create table person_private.refresh_heads(queue_id uuid primary key, request_id uuid not null unique references person_private.refresh_lifecycles(request_id));
create table person_private.refresh_frames(
 backend_pid integer not null,transaction_id xid8 not null,request_id uuid not null,
 relation_name text not null,before_row jsonb,after_row jsonb not null,
 before_seen boolean not null default false,after_seen boolean not null default false,
 primary key(backend_pid,transaction_id)
);
create table person_private.refresh_work_frames(
 backend_pid integer not null,transaction_id xid8 not null,request_id uuid not null,
 before_row jsonb not null,after_row jsonb not null,before_seen boolean not null default false,after_seen boolean not null default false,
 primary key(backend_pid,transaction_id)
);
do $$declare t text;begin foreach t in array array['refresh_lifecycles','refresh_heads','refresh_frames','refresh_work_frames'] loop
 execute format('alter table person_private.%I enable row level security',t);
 execute format('revoke all on person_private.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
revoke all on sequence person_private.refresh_lifecycles_sequence_seq from public,anon,authenticated,service_role;
create table person_private.refresh_admission_frames(backend_pid integer not null,transaction_id xid8 not null,request_id uuid not null,primary key(backend_pid,transaction_id));
alter table person_private.refresh_admission_frames enable row level security;
revoke all on person_private.refresh_admission_frames from public,anon,authenticated,service_role;
do $$declare d text;n text:=E'begin\n';begin
 d:=pg_get_functiondef('person_private.transition_claim(text,uuid,text,text,text,uuid,integer)'::regprocedure);
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'refresh_claim_definition';end if;
 execute replace(d,n,n||E' if p_family=''refresh'' and not exists(select 1 from person_private.refresh_admission_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and p_resource=''refresh:''||request_id::text) then raise exception ''refresh_admission_required'';end if;\n');
end$$;

create function person_private.refresh_scope(p_org uuid) returns person_private.transition_control language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
begin
 if p_org is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a'::uuid or current_setting('transaction_isolation')<>'read committed' then raise exception 'refresh_scope';end if;
 return person_private.transition_lock();
end$$;
create function person_private.refresh_valid(e person_private.refresh_lifecycles) returns boolean language sql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
 select e.request_id is not null and e.seal_hash=person_private.intake_hash(to_jsonb(e)-'seal_hash') and
 exists(select 1 from person_private.transition_work w where w.id=e.work_id and w.organization_id=e.organization_id and w.scope='tt_person' and w.family='refresh' and w.resource_key='refresh:'||e.request_id::text and w.input_hash=e.input_hash and to_jsonb(w)-array['status','finished_at']=e.work_snapshot-array['status','finished_at'])
$$;
-- Exact private readback, including trigger-altered columns. Identity sequence is
-- retained on updates and minted only by INSERT; never infer ordering from time.
create function person_private.refresh_set(p_old jsonb,p_new jsonb) returns person_private.refresh_lifecycles language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.refresh_lifecycles;saved person_private.refresh_lifecycles;actual person_private.refresh_lifecycles;
begin
 e:=jsonb_populate_record(null::person_private.refresh_lifecycles,p_new);
 if p_old is null then
  e.sequence:=nextval('person_private.refresh_lifecycles_sequence_seq');
 else
  select * into actual from person_private.refresh_lifecycles where request_id=e.request_id;
  if to_jsonb(actual) is distinct from p_old then raise exception 'refresh_private_changed';end if;
 end if;
 e.seal_hash:=person_private.intake_hash(to_jsonb(e)-'seal_hash');
 if p_old is null then insert into person_private.refresh_lifecycles overriding system value select(e).* returning * into saved;
 else
  update person_private.refresh_lifecycles set phase=e.phase,provider_started_at=e.provider_started_at,source_snapshot=e.source_snapshot,source_hash=e.source_hash,
   expected_queue=e.expected_queue,expected_attempt=e.expected_attempt,archives=e.archives,recovery_result=e.recovery_result,payload_result=e.payload_result,seal_hash=e.seal_hash
   where request_id=e.request_id returning * into saved;
 end if;
 select * into actual from person_private.refresh_lifecycles where request_id=e.request_id;
 if to_jsonb(saved) is distinct from to_jsonb(e) or to_jsonb(actual) is distinct from to_jsonb(e) or person_private.refresh_valid(actual) is distinct from true then raise exception 'refresh_private_actual';end if;
 return actual;
end$$;

create function person_private.refresh_context(p_request uuid,p_late boolean default false) returns person_private.refresh_lifecycles language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.refresh_lifecycles;w person_private.transition_work;c person_private.transition_control;
begin
 select * into e from person_private.refresh_lifecycles where request_id=p_request;
 select * into w from person_private.transition_work where id=e.work_id;
 select * into c from person_private.transition_control where singleton;
 if person_private.refresh_valid(e) is distinct from true or current_setting('person.work_id',true) is distinct from w.id::text or
 w.token_hash is distinct from md5(current_setting('person.work_token',true)) or w.generation<>c.generation or (c.enabled and c.phase='held') then raise exception 'refresh_context';end if;
 if not p_late and (w.status<>'active' or w.lease_until<=clock_timestamp()) then raise exception 'refresh_expired';end if;
 if p_late and w.status not in ('active','uncertain') then raise exception 'refresh_context';end if;
 return e;
end$$;
create function person_private.refresh_queue_matches(e person_private.refresh_lifecycles,q jsonb) returns boolean language sql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
 select q=e.expected_queue or exists(
  select 1 from person_private.refresh_lifecycles actor cross join lateral jsonb_array_elements(actor.archives) a
  where actor.candidate_id=e.candidate_id and person_private.refresh_valid(actor) and a->'before'=e.expected_queue and a->'after'=q
 )
$$;
create function person_private.refresh_images(p_request uuid) returns void language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.refresh_lifecycles;q jsonb;a jsonb;s public.candidate_enrichments;
begin
 select * into e from person_private.refresh_lifecycles where request_id=p_request;
 if person_private.refresh_valid(e) is distinct from true or not exists(select 1 from person_private.refresh_heads where queue_id=e.queue_id and request_id=e.request_id) or
 exists(select 1 from person_private.refresh_lifecycles x where x.queue_id=e.queue_id and x.sequence>e.sequence) then raise exception 'refresh_head_proof';end if;
 select to_jsonb(x) into q from public.refresh_queue x where id=e.queue_id;
 select to_jsonb(x) into a from public.person_refresh_attempts x where queue_id=e.queue_id;
 if person_private.refresh_queue_matches(e,q) is distinct from true or a is distinct from e.expected_attempt then raise exception 'refresh_public_changed';end if;
 if e.source_snapshot is not null then
  select * into s from public.candidate_enrichments where id=(e.source_snapshot->>'id')::uuid;
  if s.id is null or s.candidate_id is distinct from e.candidate_id or s.organization_id is distinct from e.organization_id or
   person_private.enrichment_evidence_hash(s) is distinct from e.source_hash or to_jsonb(s) is distinct from e.source_snapshot then raise exception 'refresh_source_changed';end if;
 end if;
end$$;
create function person_private.refresh_frame_check(p_table text,p_when text,p_op text,p_old jsonb,p_new jsonb) returns void language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare f person_private.refresh_frames;e person_private.refresh_lifecycles;
begin
 select * into f from person_private.refresh_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if f.backend_pid is null or f.relation_name<>p_table or f.before_row is distinct from p_old or f.after_row is distinct from p_new or
 p_op is distinct from (case when p_old is null then 'INSERT' else 'UPDATE' end) then raise exception 'refresh_write_frame';end if;
 e:=person_private.refresh_context(f.request_id,true);
 if p_when='BEFORE' then
  if f.before_seen or f.after_seen then raise exception 'refresh_frame_reused';end if;
  update person_private.refresh_frames set before_seen=true where backend_pid=f.backend_pid and transaction_id=f.transaction_id;
 else
  if not f.before_seen or f.after_seen then raise exception 'refresh_frame_reused';end if;
  update person_private.refresh_frames set after_seen=true where backend_pid=f.backend_pid and transaction_id=f.transaction_id;
 end if;
end$$;
create function person_private.refresh_guard() returns trigger language plpgsql security definer set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare o jsonb:=to_jsonb(old);n jsonb:=to_jsonb(new);required boolean;owned boolean;
begin
 if tg_level='STATEMENT' then
  if tg_op='TRUNCATE' then raise exception 'refresh_truncate';end if;
  perform person_private.transition_lock();return null;
 end if;
 if exists(select 1 from person_private.refresh_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and relation_name=tg_table_name) then
  perform person_private.refresh_frame_check(tg_table_name,tg_when,tg_op,o,n);return new;
 end if;
 owned:=exists(select 1 from person_private.refresh_heads where queue_id=any(array[(o->>(case when tg_table_name='refresh_queue' then 'id' else 'queue_id' end))::uuid,(n->>(case when tg_table_name='refresh_queue' then 'id' else 'queue_id' end))::uuid]));
 required:=person_private.normalization_required();
 if not required and not owned then return coalesce(new,old);end if;
 -- Fresh queue input is accepted while held. A queue row is not an admission.
 if tg_table_name='refresh_queue' and tg_op='INSERT' and not owned then
  if new.organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a' and new.status='queued' and new.processed_at is null and
   new.id is not null and new.queued_at is not null and exists(select 1 from public.candidates where id=new.candidate_id) then return new;end if;
  raise exception 'refresh_queue_input';
 end if;
 raise exception 'refresh_write_frame';
end$$;
do $$declare t text;begin foreach t in array array['refresh_queue','person_refresh_attempts'] loop
 execute format('create trigger refresh_statement before insert or update or delete or truncate on public.%I for each statement execute function person_private.refresh_guard()',t);
 execute format('create trigger refresh_before before insert or update or delete on public.%I for each row execute function person_private.refresh_guard()',t);
 execute format('create trigger refresh_after after insert or update or delete on public.%I for each row execute function person_private.refresh_guard()',t);
 execute format('revoke truncate on public.%I from public,anon,authenticated,service_role',t);
end loop;end$$;

create function person_private.refresh_write(p_request uuid,p_table text,p_old jsonb,p_new jsonb) returns void language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.refresh_lifecycles;key text;cols text;returned jsonb;actual jsonb;f person_private.refresh_frames;
begin
 e:=person_private.refresh_context(p_request,true);
 if p_table not in ('refresh_queue','person_refresh_attempts','candidate_enrichments') or p_new is null then raise exception 'refresh_write_scope';end if;
 if p_new->>'candidate_id' is distinct from e.candidate_id::text or p_new->>'organization_id' is distinct from e.organization_id::text then raise exception 'refresh_write_scope';end if;
 key:=case when p_table='person_refresh_attempts' then 'queue_id' else 'id' end;
 if p_table='person_refresh_attempts' and p_new->>key<>e.queue_id::text then raise exception 'refresh_write_scope';end if;
 if p_table='refresh_queue' and p_new->>'id'<>e.queue_id::text and
  (p_old is null or p_new-'status' is distinct from p_old-'status' or p_new->>'status'<>'archived_'||(p_old->>'id')||'_'||(p_old->>'status')) then raise exception 'refresh_archive_scope';end if;
 if p_table='candidate_enrichments' and (p_old is not null or not e.paid or e.provider_started_at is null or
  p_new->>'id' is distinct from e.expected_attempt->>'ledger_id' or p_new->>'linkedin_username' is distinct from e.username or
  p_new->>'provider' is distinct from 'harvest' or p_new->>'operation' is distinct from 'full_profile' or p_new->>'cache_status' is distinct from 'miss' or p_new->>'status' is distinct from 'ok' or
  p_new->'raw_payload' is null or p_new->>'cost_credits' is distinct from '1') then raise exception 'refresh_source_scope';end if;
 execute format('select to_jsonb(x) from public.%I x where %I=($1->>%L)::uuid',p_table,key,key) into actual using p_new;
 if actual is distinct from p_old then raise exception 'refresh_write_changed';end if;
 insert into person_private.refresh_frames(backend_pid,transaction_id,request_id,relation_name,before_row,after_row) values(pg_backend_pid(),pg_current_xact_id(),p_request,p_table,p_old,p_new);
 select string_agg(quote_ident(attname),',' order by attnum) into cols from pg_attribute where attrelid=format('public.%I',p_table)::regclass and attnum>0 and not attisdropped;
 if p_old is null then execute format('insert into public.%I select (jsonb_populate_record(null::public.%I,$1)).* returning to_jsonb(%I)',p_table,p_table,p_table) into returned using p_new;
 else execute format('update public.%I set (%s)=(select %s from jsonb_populate_record(null::public.%I,$1)) where %I=($1->>%L)::uuid returning to_jsonb(%I)',p_table,cols,cols,p_table,key,key,p_table) into returned using p_new;end if;
 execute format('select to_jsonb(x) from public.%I x where %I=($1->>%L)::uuid',p_table,key,key) into actual using p_new;
 select * into f from person_private.refresh_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if returned is distinct from p_new or actual is distinct from p_new or f.request_id is distinct from p_request or f.relation_name is distinct from p_table or f.before_row is distinct from p_old or f.after_row is distinct from p_new or not f.before_seen or not f.after_seen then raise exception 'refresh_write_actual';end if;
 delete from person_private.refresh_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if exists(select 1 from person_private.refresh_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'refresh_frame_cleanup';end if;
 perform person_private.refresh_context(p_request,true);
end$$;
-- Reuse the existing enrichment source trigger, without granting an application
-- capability to refresh. Retained refresh sources remain immutable when disarmed.
do $$declare d text;n text:=E'begin\n';addition text;begin
 d:=pg_get_functiondef('person_private.application_harvest_immutable()'::regprocedure);
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'refresh_enrichment_definition';end if;
 addition:=E' if exists(select 1 from person_private.refresh_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and relation_name=''candidate_enrichments'') then perform person_private.refresh_frame_check(tg_table_name,tg_when,tg_op,o,n);return new;end if;\n if exists(select 1 from person_private.refresh_lifecycles where source_snapshot->>''id''=any(array[old.id::text,new.id::text])) then raise exception ''refresh_source_owned'';end if;\n';
 execute replace(d,n,n||addition);
end$$;

create function person_private.refresh_work_guard() returns trigger language plpgsql security definer set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.refresh_lifecycles;f person_private.refresh_work_frames;
begin
 select * into e from person_private.refresh_lifecycles where work_id=old.id;
 if e.request_id is null then return coalesce(new,old);end if;
 select * into f from person_private.refresh_work_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if tg_op<>'UPDATE' or person_private.refresh_valid(e) is distinct from true or f.request_id is distinct from e.request_id or
 f.before_row is distinct from to_jsonb(old) or f.after_row is distinct from to_jsonb(new) or
 to_jsonb(new)-array['status','finished_at'] is distinct from to_jsonb(old)-array['status','finished_at'] or
 (new.status='completed' and (e.phase not in ('retry','review') or (e.paid and e.provider_started_at is not null and e.source_snapshot is null))) or
 (new.status='uncertain' and (e.phase<>'uncertain' or not e.paid or e.provider_started_at is null or e.source_snapshot is not null)) or
 new.status not in ('completed','uncertain') then raise exception 'refresh_work_proof';end if;
 if tg_when='BEFORE' then
  if f.before_seen or f.after_seen then raise exception 'refresh_work_frame_reused';end if;
  update person_private.refresh_work_frames set before_seen=true where backend_pid=f.backend_pid and transaction_id=f.transaction_id;
 else
  if not f.before_seen or f.after_seen then raise exception 'refresh_work_frame_reused';end if;
  update person_private.refresh_work_frames set after_seen=true where backend_pid=f.backend_pid and transaction_id=f.transaction_id;
 end if;return new;
end$$;
create trigger refresh_work_before before update or delete on person_private.transition_work for each row execute function person_private.refresh_work_guard();
create trigger refresh_work_after after update on person_private.transition_work for each row execute function person_private.refresh_work_guard();
create function person_private.refresh_work_status(p_request uuid,p_status text) returns void language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.refresh_lifecycles;w person_private.transition_work;expected jsonb;saved jsonb;f person_private.refresh_work_frames;
begin
 e:=person_private.refresh_context(p_request,true);perform person_private.refresh_images(p_request);
 select * into w from person_private.transition_work where id=e.work_id;
 expected:=to_jsonb(w)||jsonb_build_object('status',p_status,'finished_at',clock_timestamp());
 insert into person_private.refresh_work_frames(backend_pid,transaction_id,request_id,before_row,after_row) values(pg_backend_pid(),pg_current_xact_id(),p_request,to_jsonb(w),expected);
 update person_private.transition_work set status=p_status,finished_at=(expected->>'finished_at')::timestamptz where id=w.id returning to_jsonb(transition_work) into saved;
 select * into f from person_private.refresh_work_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if saved is distinct from expected or (select to_jsonb(x) from person_private.transition_work x where id=w.id) is distinct from expected or
 f.request_id is distinct from p_request or f.before_row is distinct from to_jsonb(w) or f.after_row is distinct from expected or not f.before_seen or not f.after_seen then raise exception 'refresh_work_actual';end if;
 delete from person_private.refresh_work_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if exists(select 1 from person_private.refresh_work_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'refresh_work_cleanup';end if;
end$$;
create function person_private.refresh_terminal(p_request uuid,p_attempt jsonb) returns person_private.refresh_lifecycles language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.refresh_lifecycles;q jsonb;oldq jsonb;newq jsonb;prior jsonb;archives jsonb;
begin
 e:=person_private.refresh_context(p_request,true);archives:=e.archives;
 select to_jsonb(x) into q from public.refresh_queue x where id=e.queue_id;
 prior:=p_attempt->'previous_queue_rows';
 for oldq in select to_jsonb(x) from public.refresh_queue x where candidate_id=e.candidate_id and organization_id=e.organization_id and status='patch_failed' and id<>e.queue_id order by id for update loop
  newq:=oldq||jsonb_build_object('status','archived_'||(oldq->>'id')||'_patch_failed');
  perform person_private.refresh_write(p_request,'refresh_queue',oldq,newq);
  prior:=prior||jsonb_build_array(oldq);archives:=archives||jsonb_build_array(jsonb_build_object('before',oldq,'after',newq));
 end loop;
 p_attempt:=p_attempt||jsonb_build_object('previous_queue_rows',prior);
 newq:=q||jsonb_build_object('status','patch_failed','processed_at',clock_timestamp());
 perform person_private.refresh_write(p_request,'refresh_queue',q,newq);
 perform person_private.refresh_write(p_request,'person_refresh_attempts',e.expected_attempt,p_attempt);
 return person_private.refresh_set(to_jsonb(e),to_jsonb(e)||jsonb_build_object('expected_queue',newq,'expected_attempt',p_attempt,'archives',archives));
end$$;
create function person_private.refresh_enter(p_org uuid,p_request uuid,p_queue uuid,p_token uuid,p_late boolean default false,p_stored_replay boolean default false) returns person_private.refresh_lifecycles language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.refresh_lifecycles;w person_private.transition_work;c person_private.transition_control;
begin
 c:=person_private.refresh_scope(p_org);
 perform pg_advisory_xact_lock(72015,hashtext(p_request::text));
 select * into e from person_private.refresh_lifecycles where request_id=p_request;
 select * into w from person_private.transition_work where id=e.work_id for update;
 if person_private.refresh_valid(e) is distinct from true or e.queue_id is distinct from p_queue or e.organization_id is distinct from p_org or p_token is null or w.token_hash is distinct from md5(p_token::text) then raise exception 'refresh_binding';end if;
 perform set_config('person.work_id',w.id::text,true);perform set_config('person.work_token',p_token::text,true);
 if p_stored_replay and (e.payload_result is not null or w.status='completed') then return e;end if;
 perform person_private.refresh_context(p_request,p_late);
 perform pg_advisory_xact_lock(72009,hashtext(e.candidate_id::text));
 perform 1 from public.refresh_queue where id=e.queue_id for update;
 perform 1 from public.person_refresh_attempts where queue_id=e.queue_id for update;
 perform person_private.refresh_context(p_request,p_late);perform person_private.refresh_images(p_request);
 return e;
end$$;

create function person_private.refresh_claim(p_org uuid,p_request uuid,p_queue uuid,p_token uuid,p_cap integer,p_paid boolean) returns jsonb language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare ctl person_private.transition_control;q public.refresh_queue;peek public.refresh_queue;a public.person_refresh_attempts;e person_private.refresh_lifecycles;prior person_private.refresh_lifecycles;
 username text;initial_username text;h text;admission jsonb;w person_private.transition_work;source public.candidate_enrichments;need_paid boolean;spent bigint;reason text;target jsonb;result jsonb;options jsonb;
begin
 ctl:=person_private.refresh_scope(p_org);
 if p_request is null or p_queue is null or p_token is null or p_cap is null or p_cap not between 0 and 10000 or p_paid is null then raise exception 'refresh_input';end if;
 options:=jsonb_build_object('dailyCap',p_cap,'allowPaid',p_paid);
 perform pg_advisory_xact_lock(72015,hashtext(p_request::text));
 select * into e from person_private.refresh_lifecycles where request_id=p_request;
 if found then
  select * into w from person_private.transition_work where id=e.work_id for update;
  if person_private.refresh_valid(e) is distinct from true or e.organization_id<>p_org or e.queue_id<>p_queue or e.options<>options or w.token_hash<>md5(p_token::text) then raise exception 'refresh_binding';end if;
  return e.claim_result;
 end if;
 if ctl.enabled and ctl.phase<>'open' then raise exception 'refresh_held';end if;
 select * into peek from public.refresh_queue where id=p_queue and organization_id=p_org;
 if not found then return jsonb_build_object('status','missing');end if;
 select lower(btrim(linkedin_username)) into initial_username from public.candidates where id=peek.candidate_id;
 if initial_username is null then raise exception 'refresh_identity';end if;
 h:=person_private.intake_hash(jsonb_build_array(to_jsonb(peek),initial_username,options));
 begin
  if exists(select 1 from person_private.transition_work where organization_id=p_org and family='refresh' and resource_key='refresh:'||p_request::text) then raise exception 'refresh_admission';end if;
  insert into person_private.refresh_admission_frames values(pg_backend_pid(),pg_current_xact_id(),p_request);
  admission:=person_private.transition_claim('tt_person',p_org,'refresh','refresh:'||p_request::text,h,p_token,600);
  delete from person_private.refresh_admission_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
  if exists(select 1 from person_private.refresh_admission_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'refresh_admission_cleanup';end if;
  if admission->>'status' is distinct from 'admitted' or exists(select 1 from person_private.refresh_lifecycles where work_id=(admission->>'work_id')::uuid) then raise exception 'refresh_admission';end if;
  select * into w from person_private.transition_work where id=(admission->>'work_id')::uuid;
  perform set_config('person.work_id',w.id::text,true);perform set_config('person.work_token',p_token::text,true);
  perform pg_advisory_xact_lock(72010,0);
  perform pg_advisory_xact_lock(72009,hashtext(peek.candidate_id::text));
  select * into q from public.refresh_queue where id=p_queue and organization_id=p_org for update;
  select * into a from public.person_refresh_attempts where queue_id=p_queue for update;
  select * into prior from person_private.refresh_lifecycles where request_id=(select request_id from person_private.refresh_heads where queue_id=p_queue);
  if to_jsonb(q) is distinct from to_jsonb(peek) then raise exception 'refresh_queue_changed';end if;
  if a.queue_id is not null and prior.request_id is null then raise exception 'refresh_history_review';end if;
  if prior.request_id is not null then
   perform person_private.refresh_images(prior.request_id);
   if exists(select 1 from person_private.transition_work where id=prior.work_id and status<>'completed') then raise sqlstate 'PRB01';end if;
   if prior.source_snapshot is not null then source:=jsonb_populate_record(null::public.candidate_enrichments,prior.source_snapshot);end if;
  end if;
  if q.status not in ('queued','patch_failed') then raise sqlstate 'PRM01';end if;
  if exists(select 1 from person_private.refresh_lifecycles x join person_private.transition_work tw on tw.id=x.work_id where x.candidate_id=q.candidate_id and x.queue_id<>q.id and tw.status<>'completed') then raise sqlstate 'PRB01';end if;
  select lower(btrim(linkedin_username)) into username from public.candidates where id=q.candidate_id for share;
  if username is distinct from initial_username then raise exception 'refresh_identity_changed';end if;
  if w.lease_until<=clock_timestamp() then raise exception 'refresh_expired';end if;
  if a.queue_id is null then
   a:=jsonb_populate_record(null::public.person_refresh_attempts,jsonb_build_object('queue_id',q.id,'candidate_id',q.candidate_id,'organization_id',p_org,'phase','ready','attempts',0,'linkedin_username',username,'linkedin_url',person_private.application_identity_url(username),'previous_queue_rows','[]'::jsonb,'created_at',clock_timestamp(),'updated_at',clock_timestamp()));
  end if;
  if (length(username) not between 1 and 200 or username ~ '[[:space:]/?#%]') or username<>a.linkedin_username then reason:='identity_changed';
  elsif exists(select 1 from public.person_source_holds where candidate_id=q.candidate_id and resolved_at is null) then reason:='source_hold';
  elsif not exists(select 1 from public.candidate_profile_state where candidate_id=q.candidate_id) then reason:='not_migrated';
  elsif a.attempts>=3 then reason:='attempt_limit';
  elsif exists(select 1 from public.person_refresh_attempts where candidate_id=q.candidate_id and paid_requested_at is not null and ledger_snapshot is null) then reason:='paid_response_unknown';end if;
  if reason is null and source.id is null then
   select * into source from public.candidate_enrichments where organization_id=p_org and candidate_id=q.candidate_id and lower(linkedin_username)=username and provider='harvest' and operation='full_profile' and status='ok' and cache_status='miss' and raw_payload is not null and created_at between clock_timestamp()-interval '30 days' and clock_timestamp() order by created_at desc,id desc limit 1 for share;
  end if;
  need_paid:=source.id is null;
  if reason is null and need_paid and (q.status='patch_failed' or not p_paid) then reason:='cached_source_missing';end if;
  if reason is null and need_paid then
   select (select count(*) from public.candidate_enrichments where provider='harvest' and cache_status='miss' and created_at >=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC')+
    (select count(*) from public.person_refresh_attempts where paid_requested_at>=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC' and ledger_snapshot is null) into spent;
   if spent>=p_cap then raise sqlstate 'PRC01';end if;
  end if;
  target:=to_jsonb(a);
  if reason is null then
   target:=target||jsonb_build_object('phase','claimed','claim_token',p_token,'lease_until',w.lease_until,'attempts',a.attempts+1,'ledger_id',coalesce(source.id,a.ledger_id,gen_random_uuid()),'ledger_snapshot',case when source.id is null then null else to_jsonb(source) end,'paid_token',case when need_paid then p_token else a.paid_token end,'paid_requested_at',case when need_paid then clock_timestamp() else a.paid_requested_at end,'error_code',null,'updated_at',clock_timestamp());
   result:=jsonb_build_object('status','claimed','queueId',q.id,'candidateId',q.candidate_id,'requestId',p_request,'token',p_token,'workId',w.id,'needsHarvest',need_paid,'linkedinUrl',a.linkedin_url);
  else result:=jsonb_build_object('status','review','reason',reason,'workId',w.id);end if;
  e:=person_private.refresh_set(null,jsonb_build_object('request_id',p_request,'work_id',w.id,'queue_id',q.id,'candidate_id',q.candidate_id,'organization_id',p_org,'username',a.linkedin_username,'input_hash',h,'options',options,'phase','claimed','paid',reason is null and need_paid,
   'source_snapshot',case when source.id is null then null else to_jsonb(source) end,'source_hash',case when source.id is null then null else person_private.enrichment_evidence_hash(source) end,
   'work_snapshot',to_jsonb(w),'expected_queue',to_jsonb(q),'expected_attempt',target,'archives','[]'::jsonb,'claim_result',result));
  perform person_private.refresh_write(p_request,'person_refresh_attempts',case when prior.request_id is null then null else prior.expected_attempt end,target);
  insert into person_private.refresh_heads values(q.id,p_request) on conflict(queue_id) do update set request_id=excluded.request_id;
  if not exists(select 1 from person_private.refresh_heads where queue_id=q.id and request_id=p_request) then raise exception 'refresh_head_actual';end if;
  perform person_private.refresh_images(p_request);perform person_private.refresh_context(p_request);
  if reason is not null then
   e:=person_private.refresh_terminal(p_request,target||jsonb_build_object('phase','review','lease_until',null,'error_code',reason,'updated_at',clock_timestamp()));
   e:=person_private.refresh_set(to_jsonb(e),to_jsonb(e)||jsonb_build_object('phase','review','recovery_result',result));
   perform person_private.refresh_work_status(p_request,'completed');
  end if;
  return result;
 exception when sqlstate 'PRC01' then return jsonb_build_object('status','budget');
 when sqlstate 'PRB01' then return jsonb_build_object('status','busy');
 when sqlstate 'PRM01' then return jsonb_build_object('status','missing');end;
end$$;

-- Only the first committed NULL->started transition grants permission for the
-- caller to make the provider request. A repeated/lost response is uncertain.
create function person_private.refresh_provider_start(p_org uuid,p_request uuid,p_queue uuid,p_token uuid) returns jsonb language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.refresh_lifecycles;u text;
begin
 e:=person_private.refresh_enter(p_org,p_request,p_queue,p_token);
 if not e.paid or e.source_snapshot is not null then raise exception 'refresh_provider_ineligible';end if;
 if e.provider_started_at is not null then return jsonb_build_object('status','uncertain');end if;
 select lower(btrim(linkedin_username)) into u from public.candidates where id=e.candidate_id for share;
 perform person_private.refresh_context(p_request);
 if u is distinct from e.username or exists(select 1 from public.person_source_holds where candidate_id=e.candidate_id and resolved_at is null) or
 not exists(select 1 from public.candidate_profile_state where candidate_id=e.candidate_id) then raise exception 'refresh_candidate_changed';end if;
 e:=person_private.refresh_set(to_jsonb(e),to_jsonb(e)||jsonb_build_object('provider_started_at',clock_timestamp()));
 perform person_private.refresh_context(p_request);perform person_private.refresh_images(p_request);
 return jsonb_build_object('status','start','linkedinUrl',person_private.application_identity_url(e.username));
end$$;

create function person_private.refresh_fail(p_org uuid,p_request uuid,p_queue uuid,p_token uuid) returns jsonb language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.refresh_lifecycles;target jsonb;result jsonb;unknown_paid boolean;
begin
 -- Completed failures can be read back without authority to mutate any row.
 e:=person_private.refresh_enter(p_org,p_request,p_queue,p_token,true,true);
 if e.phase in ('retry','review','uncertain') and e.recovery_result is not null then return e.recovery_result;end if;
 e:=person_private.refresh_enter(p_org,p_request,p_queue,p_token,true,false);
 unknown_paid:=e.paid and e.provider_started_at is not null and e.source_snapshot is null;
 result:=jsonb_build_object('status',case when unknown_paid then 'uncertain' else 'retry' end);
 target:=e.expected_attempt||jsonb_build_object('phase',case when unknown_paid then 'review' else 'ready' end,'lease_until',null,'error_code',case when unknown_paid then 'paid_response_unknown' else 'save_retry_required' end,'updated_at',clock_timestamp());
 -- A committed start marker is the uncertainty boundary. An unstarted
 -- reservation can be released; a started one is retained until source capture.
 if e.paid and e.provider_started_at is null then target:=target||jsonb_build_object('paid_token',null,'paid_requested_at',null);end if;
 e:=person_private.refresh_terminal(p_request,target);
 e:=person_private.refresh_set(to_jsonb(e),to_jsonb(e)||jsonb_build_object('phase',case when unknown_paid then 'uncertain' else 'retry' end,'recovery_result',result));
 perform person_private.refresh_work_status(p_request,case when unknown_paid then 'uncertain' else 'completed' end);
 return result;
end$$;

create function person_private.refresh_store_payload(p_org uuid,p_request uuid,p_queue uuid,p_token uuid,p_raw jsonb) returns jsonb language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.refresh_lifecycles;s public.candidate_enrichments;target jsonb;result jsonb;w person_private.transition_work;late boolean;
begin
 if jsonb_typeof(p_raw) is distinct from 'object' or (coalesce(p_raw->'experience','null') in ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb) and coalesce(p_raw->'headline','null') in ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)) then raise exception 'refresh_empty_payload';end if;
 e:=person_private.refresh_enter(p_org,p_request,p_queue,p_token,true,true);
 if not e.paid or e.provider_started_at is null or e.expected_attempt->>'paid_token' is distinct from p_token::text then raise exception 'refresh_paid_token';end if;
 if e.source_snapshot is not null then
  select * into s from public.candidate_enrichments where id=(e.source_snapshot->>'id')::uuid;
  if p_raw is distinct from e.source_snapshot->'raw_payload' or to_jsonb(s) is distinct from e.source_snapshot or person_private.enrichment_evidence_hash(s) is distinct from e.source_hash then raise exception 'refresh_payload_changed';end if;
  return e.payload_result;
 end if;
 select * into w from person_private.transition_work where id=e.work_id;
 -- Retain the known provider-start time, including late delivery. Receipt time
 -- must not turn an old response into apparently newer profile evidence.
 s:=jsonb_populate_record(null::public.candidate_enrichments,jsonb_build_object('id',e.expected_attempt->>'ledger_id','candidate_id',e.candidate_id,'organization_id',e.organization_id,'linkedin_username',e.username,'provider','harvest','operation','full_profile','cache_status','miss','status','ok','raw_payload',p_raw,'cost_credits',1,'created_at',e.provider_started_at));
 perform person_private.refresh_write(p_request,'candidate_enrichments',null,to_jsonb(s));
 late:=w.status='uncertain' or w.lease_until<=clock_timestamp();
 target:=e.expected_attempt||jsonb_build_object('ledger_snapshot',to_jsonb(s),'error_code',null,'updated_at',clock_timestamp());
 result:=jsonb_build_object('status',case when late then 'retry' else 'stored' end);
 if late then
  target:=target||jsonb_build_object('phase','ready','lease_until',null);
  e:=person_private.refresh_terminal(p_request,target);
 else
  perform person_private.refresh_write(p_request,'person_refresh_attempts',e.expected_attempt,target);
 end if;
 e:=person_private.refresh_set(to_jsonb(e),to_jsonb(e)||jsonb_build_object('expected_attempt',target||jsonb_build_object('previous_queue_rows',case when late then e.expected_attempt->'previous_queue_rows' else target->'previous_queue_rows' end),'source_snapshot',to_jsonb(s),'source_hash',person_private.enrichment_evidence_hash(s),'payload_result',result,'phase',case when late then 'retry' else 'claimed' end,'recovery_result',case when late then result else null end));
 perform person_private.refresh_images(p_request);
 -- Queue/attempt/private writes may also have waited after source capture.
 if not late and w.lease_until<=clock_timestamp() then
  late:=true;result:=jsonb_build_object('status','retry');
  e:=person_private.refresh_terminal(p_request,e.expected_attempt||jsonb_build_object('phase','ready','lease_until',null,'updated_at',clock_timestamp()));
  e:=person_private.refresh_set(to_jsonb(e),to_jsonb(e)||jsonb_build_object('phase','retry','payload_result',result,'recovery_result',result));
 end if;
 if late then perform person_private.refresh_work_status(p_request,'completed');end if;
 return result;
end$$;

-- A checked helper cannot be committed halfway through its parent operation.
-- Recheck the latest public images and each retained source at transaction end.
create function person_private.refresh_deferred() returns trigger language plpgsql security definer set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare q uuid;e person_private.refresh_lifecycles;s public.candidate_enrichments;w person_private.transition_work;
begin
 if tg_table_name='candidate_enrichments' then
  for e in select * from person_private.refresh_lifecycles where expected_attempt->>'ledger_id'=new.id::text and paid and provider_started_at is not null loop
   if person_private.refresh_valid(e) is distinct from true or e.source_snapshot is null or e.source_snapshot is distinct from to_jsonb(new) or e.source_hash is distinct from person_private.enrichment_evidence_hash(new) then raise exception 'refresh_source_incomplete';end if;
  end loop;
  return null;
 end if;
 q:=case when tg_table_name='refresh_queue' then (to_jsonb(new)->>'id')::uuid else (to_jsonb(new)->>'queue_id')::uuid end;
 select x.* into e from person_private.refresh_lifecycles x join person_private.refresh_heads h on h.request_id=x.request_id where h.queue_id=q;
 if e.request_id is null then
  if tg_table_name in ('refresh_lifecycles','refresh_heads') then raise exception 'refresh_head_proof';end if;
  return null;
 end if;
 perform person_private.refresh_images(e.request_id);
 select * into w from person_private.transition_work where id=e.work_id;
 if (e.phase='claimed' and w.status<>'active') or (e.phase='uncertain' and w.status<>'uncertain') or (e.phase in ('retry','review') and w.status<>'completed') then raise exception 'refresh_work_incomplete';end if;
 if exists(select 1 from person_private.refresh_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
 exists(select 1 from person_private.refresh_work_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
 exists(select 1 from person_private.refresh_admission_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'refresh_frame_incomplete';end if;
 return null;
end$$;
do $$declare t text;begin foreach t in array array['refresh_queue','person_refresh_attempts'] loop
 execute format('create constraint trigger refresh_complete after insert or update on public.%I deferrable initially deferred for each row execute function person_private.refresh_deferred()',t);
end loop;
foreach t in array array['refresh_lifecycles','refresh_heads'] loop
 execute format('create constraint trigger refresh_complete after insert or update on person_private.%I deferrable initially deferred for each row execute function person_private.refresh_deferred()',t);
end loop;end$$;
create constraint trigger refresh_source_complete after insert on public.candidate_enrichments deferrable initially deferred for each row execute function person_private.refresh_deferred();
do $$declare p regprocedure;begin
 for p in select oid::regprocedure from pg_proc where pronamespace='person_private'::regnamespace and proname like 'refresh_%' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',p);
 end loop;
end$$;
