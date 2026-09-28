-- PREPARED ONLY. Independent chunk-consumer authority and private paid recovery.
-- CLI-created timestamp moved after the producer journal dependency. No HTTP,
-- candidate embedding replacement, enqueue fan-out or production activation.
set local lock_timeout='2s';set local statement_timeout='30s';
create table person_private.derivative_lifecycles(
 request_id uuid primary key,work_id uuid not null unique references person_private.transition_work(id),
 candidate_id uuid not null references public.candidates(id),organization_id uuid not null,
 canonical jsonb not null,parts jsonb not null,available jsonb not null,missing jsonb not null,
 work_snapshot jsonb not null,claim_result jsonb not null,
 phase text not null check(phase in ('claimed','stored','uncertain','retry','superseded')),
 provider_started_at timestamptz,vectors jsonb,payload_transaction xid8,payload_result jsonb,recovery_result jsonb,seal_hash text not null
);
create index derivative_lifecycle_candidate on person_private.derivative_lifecycles(candidate_id);
create table person_private.derivative_admission_frames(
 backend_pid integer not null,transaction_id xid8 not null,request_id uuid not null,candidate_id uuid not null,
 work_id uuid,primary key(backend_pid,transaction_id)
);
create table person_private.derivative_consumer_frames(
 backend_pid integer not null,transaction_id xid8 not null,request_id uuid not null,
 work_id uuid not null,candidate_id uuid not null,relation_name text not null,
 before_row jsonb,after_row jsonb not null,before_seen boolean not null default false,after_seen boolean not null default false,
 primary key(backend_pid,transaction_id)
);
do $$declare t text;begin foreach t in array array['derivative_lifecycles','derivative_admission_frames','derivative_consumer_frames'] loop
 execute format('alter table person_private.%I enable row level security',t);
 execute format('revoke all on person_private.%I from public,anon,authenticated,service_role',t);
end loop;end$$;

create function person_private.derivative_lifecycle_valid(e person_private.derivative_lifecycles) returns boolean
language sql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
 select coalesce(e.request_id is not null and e.seal_hash=person_private.intake_hash(to_jsonb(e)-'seal_hash') and
 exists(select 1 from person_private.transition_work w where w.id=e.work_id and w.family='derivative' and w.scope='tt_person' and
 w.organization_id=e.organization_id and e.organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a' and
 w.resource_key='derivative:'||e.request_id::text and
 to_jsonb(w)-array['status','finished_at']=e.work_snapshot-array['status','finished_at']),false)
$$;
create function person_private.derivative_consumer_context(p_request uuid,p_late boolean default false) returns person_private.derivative_lifecycles
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.derivative_lifecycles;w person_private.transition_work;c person_private.transition_control;
begin
 select * into e from person_private.derivative_lifecycles where request_id=p_request;
 select * into w from person_private.transition_work where id=e.work_id;
 select * into c from person_private.transition_control where singleton;
 if person_private.derivative_lifecycle_valid(e) is distinct from true or current_setting('person.work_id',true) is distinct from w.id::text or
 w.token_hash is distinct from md5(current_setting('person.work_token',true)) or w.generation<>c.generation or (c.enabled and c.phase='held') or
 w.status not in ('active','uncertain') then raise exception 'derivative_context';end if;
 if not p_late and (w.status<>'active' or w.lease_until<=clock_timestamp()) then raise exception 'derivative_expired';end if;
 return e;
end$$;
create function person_private.derivative_consumer_enter(p_org uuid,p_request uuid,p_candidate uuid,p_token uuid,p_late boolean default false,p_replay boolean default false) returns person_private.derivative_lifecycles
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.derivative_lifecycles;w person_private.transition_work;
begin
 if p_org is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a'::uuid or current_setting('transaction_isolation')<>'read committed' then raise exception 'derivative_scope';end if;
 perform person_private.transition_lock();perform pg_advisory_xact_lock(72018,hashtext(p_request::text));
 select * into e from person_private.derivative_lifecycles where request_id=p_request;
 select * into w from person_private.transition_work where id=e.work_id for update;
 if person_private.derivative_lifecycle_valid(e) is distinct from true or e.candidate_id is distinct from p_candidate or e.organization_id is distinct from p_org or
 p_token is null or w.token_hash is distinct from md5(p_token::text) then raise exception 'derivative_binding';end if;
 perform set_config('person.work_id',w.id::text,true);perform set_config('person.work_token',p_token::text,true);
 if p_replay and (w.status='completed' or e.payload_result is not null) then return e;end if;
 perform person_private.derivative_consumer_context(p_request,p_late);
 perform pg_advisory_xact_lock(72009,hashtext(p_candidate::text));
 perform 1 from public.candidates where id=p_candidate for update;
 perform 1 from public.person_derivative_jobs where candidate_id=p_candidate for update;
 if person_private.derivative_job_current(p_candidate) is distinct from true then raise exception 'derivative_job_changed';end if;
 perform person_private.derivative_consumer_context(p_request,p_late);return e;
end$$;

create function person_private.derivative_consumer_frame_check(p_table text,p_when text,p_op text,p_old jsonb,p_new jsonb) returns void
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare f person_private.derivative_consumer_frames;
begin
 select * into f from person_private.derivative_consumer_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if f.backend_pid is null or f.relation_name is distinct from p_table or f.before_row is distinct from p_old or f.after_row is distinct from p_new or
 p_op is distinct from (case when p_old is null then 'INSERT' else 'UPDATE' end) then raise exception 'derivative_consumer_frame';end if;
 if p_when='BEFORE' then
  if f.before_seen or f.after_seen then raise exception 'derivative_consumer_reentry';end if;
  update person_private.derivative_consumer_frames set before_seen=true where backend_pid=f.backend_pid and transaction_id=f.transaction_id;
 else
  if not f.before_seen or f.after_seen then raise exception 'derivative_consumer_reentry';end if;
  update person_private.derivative_consumer_frames set after_seen=true where backend_pid=f.backend_pid and transaction_id=f.transaction_id;
 end if;
end$$;
create function person_private.derivative_lifecycle_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_level='STATEMENT' then if tg_op='TRUNCATE' then raise exception 'derivative_lifecycle_immutable';end if;return null;end if;
 perform person_private.derivative_consumer_frame_check(tg_table_name,tg_when,tg_op,to_jsonb(old),to_jsonb(new));return new;
end$$;
create trigger derivative_lifecycle_statement before truncate on person_private.derivative_lifecycles for each statement execute function person_private.derivative_lifecycle_guard();
create trigger derivative_lifecycle_before before insert or update or delete on person_private.derivative_lifecycles for each row execute function person_private.derivative_lifecycle_guard();
create trigger derivative_lifecycle_after after insert or update or delete on person_private.derivative_lifecycles for each row execute function person_private.derivative_lifecycle_guard();
create function person_private.derivative_work_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' and new.family='derivative' then
  if not exists(select 1 from person_private.derivative_admission_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and new.resource_key='derivative:'||request_id::text)
  then raise exception 'derivative_admission_required';end if;return new;
 end if;
 if tg_op<>'INSERT' and (old.family='derivative' or new.family='derivative' or exists(select 1 from person_private.derivative_lifecycles where work_id=any(array[old.id,new.id]))) then
  perform person_private.derivative_consumer_frame_check(tg_table_name,tg_when,tg_op,to_jsonb(old),to_jsonb(new));
 end if;return coalesce(new,old);
end$$;
create trigger derivative_work_before before insert or update or delete on person_private.transition_work for each row execute function person_private.derivative_work_guard();
create trigger derivative_work_after after insert or update or delete on person_private.transition_work for each row execute function person_private.derivative_work_guard();

-- Explicit consumer authority in the shared journal, never projection authority.
create function person_private.derivative_consumer_authority(p_work uuid,p_candidate uuid) returns void language plpgsql set search_path='' as $$
declare e person_private.derivative_lifecycles;
begin
 select * into e from person_private.derivative_lifecycles where work_id=p_work;
 if e.candidate_id is distinct from p_candidate then raise exception 'derivative_journal_consumer';end if;
 perform person_private.derivative_consumer_context(e.request_id,true);
end$$;
do $$declare d text;n text;begin
 d:=pg_get_functiondef('person_private.derivative_producer_guard()'::regprocedure);n:=E'begin\n';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'derivative_guard_definition';end if;
 d:=replace(d,n,n||E' if exists(select 1 from person_private.derivative_consumer_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and relation_name=''person_derivative_jobs'') then\n  if tg_level=''ROW'' then perform person_private.derivative_consumer_frame_check(tg_table_name,tg_when,tg_op,to_jsonb(old),to_jsonb(new));return new;end if;return null;\n end if;\n');execute d;
 d:=pg_get_functiondef('person_private.derivative_job_record(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure);
 n:='perform person_private.projection_owner(p_execution);';
 if array_length(string_to_array(d,n),1)<>3 then raise exception 'derivative_record_definition';end if;
 d:=replace(d,n,'if exists(select 1 from person_private.transition_work where id=p_work and family=''derivative'') then perform person_private.derivative_consumer_authority(p_work,p_candidate);else perform person_private.projection_owner(p_execution);end if;');
 n:='select * into f from person_private.derivative_producer_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'derivative_record_frame_definition';end if;
 d:=replace(d,n,n||E'\n if exists(select 1 from person_private.transition_work where id=p_work and family=''derivative'') then select (jsonb_populate_record(null::person_private.derivative_producer_frames,to_jsonb(cf))).* into f from person_private.derivative_consumer_frames cf where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and relation_name=''person_derivative_jobs'';end if;');
 n:=d;d:=replace(d,'''application'',''directory'',''refresh''','''application'',''directory'',''refresh'',''derivative''');if d=n then raise exception 'derivative_record_family_definition';end if;execute d;
 d:=pg_get_functiondef('person_private.derivative_job_change_valid(uuid)'::regprocedure);
 n:=d;d:=replace(d,'w.family in (''application'',''directory'',''refresh'')','(w.family in (''application'',''directory'',''refresh'') or (w.family=''derivative'' and exists(select 1 from person_private.derivative_lifecycles e where e.work_id=w.id and e.candidate_id=j.candidate_id and person_private.derivative_lifecycle_valid(e))))');if d=n then raise exception 'derivative_change_valid_definition';end if;execute d;
 d:=pg_get_functiondef('person_private.derivative_journal_deferred()'::regprocedure);
 n:='if not ((w.status=''active'' and w.lease_until>clock_timestamp()) or';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'derivative_deferred_definition';end if;
 d:=replace(d,n,'if w.family<>''derivative'' and not ((w.status=''active'' and w.lease_until>clock_timestamp()) or');
 n:=d;d:=replace(d,'select * into w from person_private.transition_work where id=j.work_id;',E'select * into w from person_private.transition_work where id=j.work_id;\n  if w.family=''derivative'' then perform person_private.derivative_consumer_journal_end(j);end if;');if d=n then raise exception 'derivative_deferred_end_definition';end if;execute d;
 d:=pg_get_functiondef('person_private.transition_claim(text,uuid,text,text,text,uuid,integer)'::regprocedure);n:=E'begin\n';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'derivative_claim_definition';end if;
 execute replace(d,n,n||E' if p_family=''derivative'' and not exists(select 1 from person_private.derivative_admission_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and p_resource=''derivative:''||request_id::text) then raise exception ''derivative_admission_required'';end if;\n');
end$$;

-- One exact frame for each private, work or public-job mutation. Journal append
-- observes the actual job before removing the consumer frame.
create function person_private.derivative_consumer_write(p_request uuid,p_table text,p_old jsonb,p_new jsonb) returns void
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.derivative_lifecycles;a person_private.derivative_admission_frames;w person_private.transition_work;
 schema_name text;key text;cols text;actual jsonb;returned jsonb;f person_private.derivative_consumer_frames;wid uuid;cid uuid;
begin
 select * into e from person_private.derivative_lifecycles where request_id=p_request;
 if e.request_id is not null then
  perform person_private.derivative_consumer_context(p_request,true);wid:=e.work_id;cid:=e.candidate_id;
 else
  select * into a from person_private.derivative_admission_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and request_id=p_request;
  wid:=a.work_id;cid:=a.candidate_id;
  if a.request_id is null or p_table<>'derivative_lifecycles' or p_old is not null then raise exception 'derivative_admission_required';end if;
 end if;
 if p_table='derivative_lifecycles' then
  schema_name:='person_private';key:='request_id';
  if p_new->>'request_id' is distinct from p_request::text or p_new->>'work_id' is distinct from wid::text or p_new->>'candidate_id' is distinct from cid::text or
   (p_old is not null and p_new-array['phase','provider_started_at','vectors','payload_transaction','payload_result','recovery_result','seal_hash'] is distinct from p_old-array['phase','provider_started_at','vectors','payload_transaction','payload_result','recovery_result','seal_hash']) then raise exception 'derivative_lifecycle_binding';end if;
 if p_old is not null and (
   (e.provider_started_at is not null and p_new->'provider_started_at' is distinct from p_old->'provider_started_at') or
   (e.vectors is not null and (p_new->'vectors' is distinct from e.vectors or p_new->'payload_transaction' is distinct from p_old->'payload_transaction')) or
   (e.payload_result is not null and p_new->'payload_result' is distinct from e.payload_result and e.payload_transaction is distinct from pg_current_xact_id()) or
   (e.phase in ('retry','superseded') and p_new-'seal_hash' is distinct from p_old-'seal_hash') or
   (e.phase in ('stored','uncertain') and p_new->>'phase'='claimed')) then raise exception 'derivative_immutable';end if;
  if p_new->'vectors' is distinct from 'null'::jsonb and p_new->'vectors' is not null and
   ((p_new->>'provider_started_at') is null or not person_private.derivative_vectors_valid(p_new->'vectors',jsonb_array_length(p_new->'missing')) or
   (e.vectors is null and (p_new->>'payload_transaction')::xid8 is distinct from pg_current_xact_id())) then raise exception 'derivative_vectors';end if;
 elsif p_table='transition_work' then
  schema_name:='person_private';key:='id';
  if p_old is null or p_new->>'id' is distinct from wid::text or p_new-array['status','finished_at'] is distinct from p_old-array['status','finished_at'] or
   not ((e.phase='uncertain' and p_new->>'status'='uncertain') or (e.phase in ('retry','superseded') and p_new->>'status'='completed')) then raise exception 'derivative_work_state';end if;
 elsif p_table='person_derivative_jobs' then
  schema_name:='public';key:='candidate_id';
  if p_old is null or p_new->>'candidate_id' is distinct from cid::text or person_private.derivative_job_head_matches(cid,p_old) is distinct from true then raise exception 'derivative_job_changed';end if;
 else raise exception 'derivative_write_scope';end if;
 execute format('select to_jsonb(x) from %I.%I x where %I=($1->>%L)::uuid',schema_name,p_table,key,key) into actual using p_new;
 if actual is distinct from p_old then raise exception 'derivative_write_changed';end if;
 insert into person_private.derivative_consumer_frames(backend_pid,transaction_id,request_id,work_id,candidate_id,relation_name,before_row,after_row)
 values(pg_backend_pid(),pg_current_xact_id(),p_request,wid,cid,p_table,p_old,p_new);
 select string_agg(quote_ident(attname),',' order by attnum) into cols from pg_attribute where attrelid=format('%I.%I',schema_name,p_table)::regclass and attnum>0 and not attisdropped;
 if p_old is null then execute format('insert into %I.%I select (jsonb_populate_record(null::%I.%I,$1)).* returning to_jsonb(%I)',schema_name,p_table,schema_name,p_table,p_table) into returned using p_new;
 else execute format('update %I.%I set (%s)=(select %s from jsonb_populate_record(null::%I.%I,$1)) where %I=($1->>%L)::uuid returning to_jsonb(%I)',schema_name,p_table,cols,cols,schema_name,p_table,key,key,p_table) into returned using p_new;end if;
 execute format('select to_jsonb(x) from %I.%I x where %I=($1->>%L)::uuid',schema_name,p_table,key,key) into actual using p_new;
 select * into f from person_private.derivative_consumer_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if actual is distinct from p_new or returned is distinct from p_new or f.request_id is distinct from p_request or f.relation_name is distinct from p_table or
 f.before_row is distinct from p_old or f.after_row is distinct from p_new or f.work_id is distinct from wid or f.candidate_id is distinct from cid or not coalesce(f.before_seen and f.after_seen,false) then raise exception 'derivative_write_actual';end if;
 if p_table='person_derivative_jobs' then perform person_private.derivative_job_record(null,wid,cid,p_old,p_new);end if;
 delete from person_private.derivative_consumer_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if exists(select 1 from person_private.derivative_consumer_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'derivative_frame_cleanup';end if;
end$$;
create function person_private.derivative_lifecycle_set(p_old jsonb,p_new jsonb) returns person_private.derivative_lifecycles
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.derivative_lifecycles;
begin
 e:=jsonb_populate_record(null::person_private.derivative_lifecycles,p_new);e.seal_hash:=person_private.intake_hash(to_jsonb(e)-'seal_hash');
 perform person_private.derivative_consumer_write(e.request_id,'derivative_lifecycles',p_old,to_jsonb(e));
 if person_private.derivative_lifecycle_valid(e) is distinct from true then raise exception 'derivative_lifecycle_actual';end if;return e;
end$$;

-- JavaScript trim and code-unit/UTF-8 bounds, used to verify the complete manifest.
create function person_private.derivative_trim(s text) returns text language sql immutable set search_path='' as $$
 select btrim(s,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
$$;
create function person_private.derivative_chunks(p_sources jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare source text;body text;chunk text;ch text;value text;n integer;units integer;bytes integer;u integer;out jsonb:='[]';
begin
 foreach source in array array['linkedin_profile','resume','summary'] loop
  body:=person_private.derivative_trim(p_sources->>source);chunk:='';n:=0;units:=0;bytes:=0;
  for i in 1..coalesce(length(body),0) loop
   ch:=substr(body,i,1);u:=case when ascii(ch)>65535 then 2 else 1 end;
   if units+u>2800 or bytes+octet_length(ch)>7500 then
    value:=person_private.derivative_trim(chunk);
    if value<>'' then out:=out||jsonb_build_array(jsonb_build_object('source_type',source,'chunk_index',n,'content',value,'content_hash',encode(sha256(convert_to(value,'UTF8')),'hex')));n:=n+1;end if;
    chunk:='';units:=0;bytes:=0;exit when n>=6;
   end if;
   chunk:=chunk||ch;units:=units+u;bytes:=bytes+octet_length(ch);
  end loop;
  value:=person_private.derivative_trim(chunk);
  if n<6 and value<>'' then out:=out||jsonb_build_array(jsonb_build_object('source_type',source,'chunk_index',n,'content',value,'content_hash',encode(sha256(convert_to(value,'UTF8')),'hex')));end if;
 end loop;return out;
end$$;
create function person_private.derivative_vectors_valid(v jsonb,n integer) returns boolean language plpgsql immutable set search_path='' as $$
declare vec jsonb;part jsonb;
begin
 if jsonb_typeof(v) is distinct from 'array' or jsonb_array_length(v)<>n or n not between 0 and 18 or octet_length(v::text)>1000000 then return false;end if;
 for vec in select value from jsonb_array_elements(v) loop
  if jsonb_typeof(vec) is distinct from 'array' or jsonb_array_length(vec)<>1536 then return false;end if;
  for part in select value from jsonb_array_elements(vec) loop
   if jsonb_typeof(part)<>'number' or abs((part#>>'{}')::numeric)>3.4028234663852886e38 then return false;end if;
  end loop;
 end loop;return true;
end$$;
create function person_private.derivative_input_check(p_candidate uuid,p_input jsonb) returns void language plpgsql set search_path='' as $$
declare j public.person_derivative_jobs;c public.candidates;
begin
 select * into j from public.person_derivative_jobs where candidate_id=p_candidate;
 select * into c from public.candidates where id=p_candidate;
 if p_input->'sources' is distinct from j.sources or p_input->>'hash' is distinct from j.desired_hash or
 encode(sha256(convert_to(p_input->>'bytes','UTF8')),'hex') is distinct from j.desired_hash or
 (p_input->>'bytes')::jsonb is distinct from jsonb_build_array(j.model,j.dimensions,j.sources) or
 j.model is distinct from 'text-embedding-3-small' or j.dimensions is distinct from 1536 or
 jsonb_typeof(j.sources) is distinct from 'object' or (select count(*) from jsonb_object_keys(j.sources))<>3 or
 exists(select 1 from jsonb_each(j.sources) s where s.key not in ('linkedin_profile','resume','summary') or jsonb_typeof(s.value)<>'string') or
 j.sources->>'resume' is distinct from coalesce(c.resume_text,'') or j.sources->>'summary' is distinct from coalesce(c.profile_summary,'') or
 not exists(select 1 from public.person_projection_state p join public.candidate_profile_state s using(candidate_id) where p.candidate_id=p_candidate and p.revision=s.rev and p.revision=(p_input->>'revision')::bigint and p.profile_hash=p_input->>'profileHash') or
 exists(select 1 from public.person_source_holds where candidate_id=p_candidate and resolved_at is null) then raise exception 'derivative_input_stale';end if;
end$$;
create function person_private.derivative_claim_begin(p_org uuid,p_request uuid,p_candidate uuid,p_token uuid) returns jsonb
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare ctl person_private.transition_control;e person_private.derivative_lifecycles;w person_private.transition_work;j public.person_derivative_jobs;admitted jsonb;
begin
 if p_org is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a'::uuid or p_request is null or p_candidate is null or p_token is null or current_setting('transaction_isolation')<>'read committed' then raise exception 'derivative_scope';end if;
 ctl:=person_private.transition_lock();perform pg_advisory_xact_lock(72018,hashtext(p_request::text));
 select * into e from person_private.derivative_lifecycles where request_id=p_request;
 if found then
  select * into w from person_private.transition_work where id=e.work_id for update;
  if person_private.derivative_lifecycle_valid(e) is distinct from true or e.candidate_id<>p_candidate or e.organization_id<>p_org or w.token_hash<>md5(p_token::text) then raise exception 'derivative_binding';end if;
  return e.claim_result;
 end if;
 if ctl.enabled and ctl.phase<>'open' then raise exception 'derivative_held';end if;
 begin
  if exists(select 1 from person_private.transition_work where organization_id=p_org and family='derivative' and resource_key='derivative:'||p_request::text) then raise exception 'derivative_orphan_work';end if;
  insert into person_private.derivative_admission_frames values(pg_backend_pid(),pg_current_xact_id(),p_request,p_candidate,null);
  admitted:=person_private.transition_claim('tt_person',p_org,'derivative','derivative:'||p_request::text,person_private.intake_hash(jsonb_build_array(p_org,p_request,p_candidate)),p_token,600);
  if admitted->>'status' is distinct from 'admitted' then raise exception 'derivative_admission';end if;
  select * into w from person_private.transition_work where id=(admitted->>'work_id')::uuid;
  update person_private.derivative_admission_frames set work_id=w.id where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
  perform set_config('person.work_id',w.id::text,true);perform set_config('person.work_token',p_token::text,true);
  perform pg_advisory_xact_lock(72009,hashtext(p_candidate::text));
  perform 1 from public.candidates where id=p_candidate for update;
  -- Wait for an unknown earlier paid result instead of consuming another attempt.
  if exists(select 1 from person_private.derivative_lifecycles old where old.candidate_id=p_candidate and old.provider_started_at is not null and old.vectors is null) then raise sqlstate 'DCB01';end if;
  select * into j from public.person_derivative_jobs where candidate_id=p_candidate for update;
  if j.candidate_id is null then raise sqlstate 'DCA01';end if;
  if person_private.derivative_job_current(p_candidate) is distinct from true then raise exception 'derivative_job_changed';end if;
  if exists(select 1 from person_private.derivative_job_changes where candidate_id=p_candidate and transaction_id=pg_current_xact_id()) then raise exception 'derivative_producer_uncommitted';end if;
  if exists(select 1 from person_private.derivative_job_changes g where g.candidate_id=p_candidate and g.sequence=1 and g.before_row is not null and
   (g.before_row->>'status'='processing' or ((g.before_row->>'attempts')::int>0 and g.before_row->>'status'<>'done'))) then raise sqlstate 'DCR01';end if;
  if j.status='processing' and j.lease_until>clock_timestamp() then raise sqlstate 'DCB01';end if;
  if j.status='done' then raise sqlstate 'DCD01';end if;
  if j.status='review' or j.attempts>=3 then raise sqlstate 'DCR01';end if;
  return jsonb_build_object('status','prepare');
 exception when sqlstate 'DCA01' then return jsonb_build_object('status','absent');
 when sqlstate 'DCB01' then return jsonb_build_object('status','busy');
 when sqlstate 'DCD01' then return jsonb_build_object('status','done');
 when sqlstate 'DCR01' then return jsonb_build_object('status','review');end;
end$$;
create function person_private.derivative_claim_seal(p_request uuid,p_input jsonb,p_parts jsonb) returns jsonb
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare a person_private.derivative_admission_frames;w person_private.transition_work;e person_private.derivative_lifecycles;prior person_private.derivative_lifecycles;
 j public.person_derivative_jobs;target jsonb;part jsonb;cached jsonb;available jsonb:='[]';missing jsonb:='[]';r public.candidate_embeddings;result jsonb;reusable uuid[];
begin
 select * into a from person_private.derivative_admission_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id() and request_id=p_request;
 select * into w from person_private.transition_work where id=a.work_id;
 if a.work_id is null or w.status is distinct from 'active' or w.lease_until<=clock_timestamp() or current_setting('person.work_id',true) is distinct from w.id::text or w.token_hash is distinct from md5(current_setting('person.work_token',true)) then raise exception 'derivative_admission';end if;
 perform person_private.derivative_input_check(a.candidate_id,p_input);
 if p_parts is distinct from person_private.derivative_chunks(p_input->'sources') then raise exception 'derivative_parts';end if;
 select * into j from public.person_derivative_jobs where candidate_id=a.candidate_id;
 select coalesce(array_agg(old.request_id),'{}') into reusable from person_private.derivative_lifecycles old
 where old.candidate_id=a.candidate_id and old.organization_id=w.organization_id and old.provider_started_at is not null and old.vectors is not null and
  old.canonical->'sources' is not null and (old.canonical->>'bytes')::jsonb->0=to_jsonb(j.model) and (old.canonical->>'bytes')::jsonb->1=to_jsonb(j.dimensions) and
  exists(select 1 from jsonb_array_elements(old.missing) m where m in (select value from jsonb_array_elements(p_parts))) and
  person_private.derivative_lifecycle_valid(old) and person_private.derivative_vectors_valid(old.vectors,jsonb_array_length(old.missing));
 for part in select value from jsonb_array_elements(p_parts) loop
  select * into r from public.candidate_embeddings where candidate_id=a.candidate_id and source_type=part->>'source_type' and chunk_index=(part->>'chunk_index')::int and content_hash=part->>'content_hash';
  if r.id is not null and r.organization_id<>w.organization_id then raise exception 'derivative_foreign_collision';end if;
  cached:=null;
  if r.id is not null and r.model=j.model and r.dimensions=j.dimensions and r.content=part->>'content' and encode(sha256(convert_to(r.content,'UTF8')),'hex')=r.content_hash and person_private.derivative_vectors_valid(jsonb_build_array(r.embedding::text::jsonb),1) then
   cached:=jsonb_build_object('part',part,'vector',r.embedding::text::jsonb,'rowId',r.id);
  else
   select jsonb_build_object('part',part,'vector',old.vectors->(p.ordinality::int-1),'requestId',old.request_id) into cached
   from person_private.derivative_lifecycles old cross join lateral jsonb_array_elements(old.missing) with ordinality p(value,ordinality)
   where old.request_id=any(reusable) and p.value=part order by old.request_id limit 1;
  end if;
  if cached is null then missing:=missing||jsonb_build_array(part);else available:=available||jsonb_build_array(cached);end if;
 end loop;
 result:=jsonb_build_object('status','claimed','workId',w.id,'requestId',p_request,'candidateId',a.candidate_id,'token',current_setting('person.work_token'),'missing',missing,'desiredHash',p_input->>'hash');
 e:=person_private.derivative_lifecycle_set(null,jsonb_build_object('request_id',p_request,'work_id',w.id,'candidate_id',a.candidate_id,'organization_id',w.organization_id,
  'canonical',p_input,'parts',p_parts,'available',available,'missing',missing,'work_snapshot',to_jsonb(w),'claim_result',result,'phase','claimed'));
 target:=to_jsonb(j)||jsonb_build_object('desired_revision',(p_input->>'revision')::bigint,'status','processing','attempts',j.attempts+1,'claim_token',current_setting('person.work_token')::uuid,'lease_until',w.lease_until,'claim_missing',missing,'error_code',null,'updated_at',clock_timestamp());
 perform person_private.derivative_consumer_write(p_request,'person_derivative_jobs',to_jsonb(j),target);
 delete from person_private.derivative_admission_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if exists(select 1 from person_private.derivative_admission_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'derivative_admission_cleanup';end if;
 perform person_private.derivative_consumer_context(p_request);return result;
end$$;

create function person_private.derivative_job_owned(e person_private.derivative_lifecycles,j public.person_derivative_jobs) returns boolean language sql stable set search_path='' as $$
 select coalesce(j.candidate_id=e.candidate_id and j.status='processing' and j.claim_token=(e.claim_result->>'token')::uuid and
 j.desired_hash=e.canonical->>'hash' and j.model='text-embedding-3-small' and j.dimensions=1536 and j.claim_missing=e.missing and
 j.sources=e.canonical->'sources' and person_private.derivative_job_current(j.candidate_id),false)
$$;
create function person_private.derivative_provider_start(p_request uuid,p_input jsonb) returns jsonb language plpgsql set search_path='' as $$
declare e person_private.derivative_lifecycles;j public.person_derivative_jobs;
begin
 e:=person_private.derivative_consumer_context(p_request,true);
 if e.provider_started_at is not null then return jsonb_build_object('status','uncertain');end if;
 perform person_private.derivative_consumer_context(p_request);
 select * into j from public.person_derivative_jobs where candidate_id=e.candidate_id;
 if not person_private.derivative_job_owned(e,j) or e.phase<>'claimed' or e.vectors is not null or jsonb_array_length(e.missing)=0 then raise exception 'derivative_provider_ineligible';end if;
 perform person_private.derivative_input_check(e.candidate_id,p_input);
 if p_input->>'hash' is distinct from e.canonical->>'hash' then raise exception 'derivative_input_stale';end if;
 if exists(select 1 from person_private.derivative_lifecycles old where old.candidate_id=e.candidate_id and old.request_id<>p_request and old.provider_started_at is not null and old.vectors is null) then raise exception 'derivative_paid_unresolved';end if;
 if exists(select 1 from jsonb_array_elements(e.missing) p join public.candidate_embeddings r on r.candidate_id=e.candidate_id and r.organization_id=e.organization_id and r.source_type=p->>'source_type' and r.chunk_index=(p->>'chunk_index')::int and r.content_hash=p->>'content_hash' and r.content=p->>'content' and r.model='text-embedding-3-small' and r.dimensions=1536
  where encode(sha256(convert_to(r.content,'UTF8')),'hex')=r.content_hash and person_private.derivative_vectors_valid(jsonb_build_array(r.embedding::text::jsonb),1)) or
 exists(select 1 from person_private.derivative_lifecycles old cross join lateral jsonb_array_elements(old.missing) p cross join jsonb_array_elements(e.missing) wanted where
  old.candidate_id=e.candidate_id and old.organization_id=e.organization_id and old.request_id<>p_request and old.provider_started_at is not null and old.vectors is not null and p=wanted and
  person_private.derivative_lifecycle_valid(old) and person_private.derivative_vectors_valid(old.vectors,jsonb_array_length(old.missing))) then
  perform person_private.derivative_close(p_request);return jsonb_build_object('status','reprepare');
 end if;
 if exists(select 1 from public.candidate_embeddings r cross join jsonb_array_elements(e.missing) p where r.candidate_id=e.candidate_id and r.source_type=p->>'source_type' and r.chunk_index=(p->>'chunk_index')::int and r.content_hash=p->>'content_hash' and r.organization_id<>e.organization_id) then raise exception 'derivative_foreign_collision';end if;
 e:=person_private.derivative_lifecycle_set(to_jsonb(e),to_jsonb(e)||jsonb_build_object('provider_started_at',clock_timestamp()));
 perform person_private.derivative_consumer_context(p_request);
 return jsonb_build_object('status','start','missing',e.missing,'model','text-embedding-3-small','dimensions',1536);
end$$;
create function person_private.derivative_close(p_request uuid,p_store boolean default false) returns jsonb language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.derivative_lifecycles;j public.person_derivative_jobs;w person_private.transition_work;unknown boolean;owned boolean;result jsonb;next_phase text;
begin
 e:=person_private.derivative_consumer_context(p_request,true);
 select * into j from public.person_derivative_jobs where candidate_id=e.candidate_id;
 unknown:=e.provider_started_at is not null and e.vectors is null;owned:=person_private.derivative_job_owned(e,j);
 next_phase:=case when unknown then 'uncertain' when owned then 'retry' else 'superseded' end;
 result:=jsonb_build_object('status',next_phase);
 if owned then
  perform person_private.derivative_consumer_write(p_request,'person_derivative_jobs',to_jsonb(j),to_jsonb(j)||
   case when unknown then jsonb_build_object('error_code','paid_response_unknown','updated_at',clock_timestamp())
   else jsonb_build_object('status','pending','claim_token',null,'lease_until',null,'claim_missing',null,'error_code',null,'updated_at',clock_timestamp()) end);
 end if;
 e:=person_private.derivative_lifecycle_set(to_jsonb(e),to_jsonb(e)||jsonb_build_object('phase',next_phase,'recovery_result',result)||case when p_store then jsonb_build_object('payload_result',result) else '{}'::jsonb end);
 select * into w from person_private.transition_work where id=e.work_id;
 perform person_private.derivative_consumer_write(p_request,'transition_work',to_jsonb(w),to_jsonb(w)||jsonb_build_object('status',case when unknown then 'uncertain' else 'completed' end,'finished_at',clock_timestamp()));
 return result;
end$$;
create function person_private.derivative_recover(p_org uuid,p_request uuid,p_candidate uuid,p_token uuid) returns jsonb language plpgsql set search_path='' as $$
declare e person_private.derivative_lifecycles;
begin
 e:=person_private.derivative_consumer_enter(p_org,p_request,p_candidate,p_token,true,true);
 if e.recovery_result is not null then return e.recovery_result;end if;
 e:=person_private.derivative_consumer_enter(p_org,p_request,p_candidate,p_token,true,false);
 return person_private.derivative_close(p_request);
end$$;
create function person_private.derivative_store_vectors(p_org uuid,p_request uuid,p_candidate uuid,p_token uuid,p_vectors jsonb) returns jsonb
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.derivative_lifecycles;w person_private.transition_work;j public.person_derivative_jobs;result jsonb;late boolean;
begin
 e:=person_private.derivative_consumer_enter(p_org,p_request,p_candidate,p_token,true,true);
 if e.provider_started_at is null or not person_private.derivative_vectors_valid(p_vectors,jsonb_array_length(e.missing)) then raise exception 'derivative_vectors';end if;
 if e.vectors is not null then
  if p_vectors is distinct from e.vectors then raise exception 'derivative_vectors_changed';end if;return e.payload_result;
 end if;
 e:=person_private.derivative_consumer_enter(p_org,p_request,p_candidate,p_token,true,false);
 select * into w from person_private.transition_work where id=e.work_id;
 select * into j from public.person_derivative_jobs where candidate_id=p_candidate;
 late:=w.status='uncertain' or w.lease_until<=clock_timestamp() or not person_private.derivative_job_owned(e,j);
 result:=jsonb_build_object('status',case when not person_private.derivative_job_owned(e,j) then 'superseded' when late then 'retry' else 'stored' end);
 e:=person_private.derivative_lifecycle_set(to_jsonb(e),to_jsonb(e)||jsonb_build_object('vectors',p_vectors,'payload_transaction',pg_current_xact_id()::text,'phase','stored','payload_result',result));
 if late or w.lease_until<=clock_timestamp() then
  result:=person_private.derivative_close(p_request,true);
 end if;
 return result;
end$$;

create function person_private.derivative_lifecycle_deferred() returns trigger language plpgsql security definer set search_path='' as $$
declare e person_private.derivative_lifecycles;w person_private.transition_work;
begin
 if tg_table_name='transition_work' then
  if new.family<>'derivative' then return null;end if;
  select * into e from person_private.derivative_lifecycles where work_id=new.id;
 else select * into e from person_private.derivative_lifecycles where request_id=new.request_id;end if;
 select * into w from person_private.transition_work where id=e.work_id;
 if person_private.derivative_lifecycle_valid(e) is distinct from true or person_private.derivative_job_current(e.candidate_id) is distinct from true or
 (e.phase='claimed' and (w.status<>'active' or w.lease_until<=clock_timestamp())) or
 -- Stored vectors are a known paid result: a lease that passes before commit must not roll them back.
 (e.phase='stored' and w.status<>'active') or
 (e.phase='uncertain' and (w.status<>'uncertain' or e.provider_started_at is null or e.vectors is not null)) or
 (e.phase in ('retry','superseded') and (w.status<>'completed' or (e.provider_started_at is not null and e.vectors is null))) or
 exists(select 1 from person_private.derivative_admission_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
 exists(select 1 from person_private.derivative_consumer_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
 then raise exception 'derivative_lifecycle_incomplete';end if;
 return null;
end$$;
create constraint trigger derivative_lifecycle_proof after insert or update on person_private.derivative_lifecycles deferrable initially deferred for each row execute function person_private.derivative_lifecycle_deferred();
create constraint trigger derivative_work_proof after insert or update on person_private.transition_work deferrable initially deferred for each row execute function person_private.derivative_lifecycle_deferred();
create function person_private.derivative_consumer_journal_end(j person_private.derivative_job_changes) returns void
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.derivative_lifecycles;w person_private.transition_work;own_token text;
begin
 select * into e from person_private.derivative_lifecycles where work_id=j.work_id;
 select * into w from person_private.transition_work where id=j.work_id;own_token:=e.claim_result->>'token';
 if person_private.derivative_lifecycle_valid(e) is distinct from true or j.execution_id is not null or j.before_row is null or
  j.before_row-array['desired_revision','status','attempts','claim_token','lease_until','claim_missing','error_code','updated_at'] is distinct from
  j.after_row-array['desired_revision','status','attempts','claim_token','lease_until','claim_missing','error_code','updated_at']
 then raise exception 'derivative_journal_consumer';end if;
 if j.before_row->>'claim_token' is distinct from own_token then
  if j.after_row->>'claim_token' is distinct from own_token or j.after_row->>'status' is distinct from 'processing' or
   j.after_row->'claim_missing' is distinct from e.missing or (j.after_row->>'attempts')::int is distinct from (j.before_row->>'attempts')::int+1 or
   (j.after_row->>'lease_until')::timestamptz is distinct from w.lease_until or j.after_row->>'error_code' is not null or
   (j.after_row->>'desired_revision')::bigint is distinct from (e.canonical->>'revision')::bigint or j.recorded_at>w.lease_until
  then raise exception 'derivative_journal_claim';end if;
 else
  if j.after_row->'desired_revision' is distinct from j.before_row->'desired_revision' or j.after_row->'attempts' is distinct from j.before_row->'attempts' then raise exception 'derivative_journal_recovery';end if;
  if j.after_row->>'status'='pending' then
   if e.phase not in ('retry','superseded') or w.status<>'completed' or j.after_row->>'claim_token' is not null or j.after_row->>'lease_until' is not null or j.after_row->>'claim_missing' is not null or j.after_row->>'error_code' is not null then raise exception 'derivative_journal_recovery';end if;
  elsif j.after_row->>'status'='processing' then
   if e.provider_started_at is null or j.after_row-'error_code'-'updated_at' is distinct from j.before_row-'error_code'-'updated_at' or j.after_row->>'error_code' is distinct from 'paid_response_unknown' or
    (e.phase='uncertain' and w.status<>'uncertain') or (e.phase not in ('uncertain','retry','superseded')) then raise exception 'derivative_journal_recovery';end if;
  else raise exception 'derivative_journal_recovery';end if;
 end if;
end$$;
do $$declare f record;begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='person_private'::regnamespace and proname like 'derivative_%' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end$$;
