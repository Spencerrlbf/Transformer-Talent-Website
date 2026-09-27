-- PREPARED ONLY. Checked directory observation retention, not save admission.
set local lock_timeout='2s';set local statement_timeout='30s';
create table person_private.directory_inputs(
 receipt_id bigint primary key references public.person_directory_receipts(id),
 version integer not null check(version=1),binding jsonb not null,input_hash text not null
);
create table person_private.directory_input_frames(
 backend_pid integer not null,transaction_id xid8 not null,relation_name text not null,
 operation text not null,before_row jsonb,after_row jsonb not null,
 before_seen boolean not null default false,after_seen boolean not null default false,
 primary key(backend_pid,transaction_id)
);
alter table person_private.directory_inputs enable row level security;
alter table person_private.directory_input_frames enable row level security;
revoke all on person_private.directory_inputs,person_private.directory_input_frames from public,anon,authenticated,service_role;

create function person_private.directory_binding(r public.person_directory_receipts) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('version',1,'organization_id','801865a7-6533-41d2-9c45-e4a90e6ad51a',
 'receipt_id',r.id,'workspace_id',r.workspace_id,'contact_id',r.contact_id,
 'snapshot_hash',r.snapshot_hash,'snapshot',r.snapshot,'captured_epoch',extract(epoch from r.captured_at))
$$;
create function person_private.directory_verify(p_receipt bigint) returns boolean
language plpgsql set search_path='' as $$
declare r public.person_directory_receipts;b person_private.directory_inputs;x jsonb;
begin
 select * into b from person_private.directory_inputs where receipt_id=p_receipt;
 if not found then return false;end if;
 select * into r from public.person_directory_receipts where id=p_receipt;
 x:=person_private.directory_binding(r);
 if r.id is null or b.version<>1 or b.binding::text is distinct from x::text or b.input_hash is distinct from person_private.intake_hash(x) then raise exception 'directory_input_certificate';end if;
 return true;
end$$;
create function person_private.directory_input_statement() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='TRUNCATE' then raise exception 'directory_input_truncate';end if;
 perform person_private.transition_lock();
 return null;
end$$;
create function person_private.directory_input_guard() returns trigger
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare f person_private.directory_input_frames;protected boolean;
begin
 if tg_table_name='person_directory_receipts' and tg_op<>'INSERT' then
  select exists(select 1 from person_private.directory_inputs where receipt_id=old.id) into protected;
  if protected and (tg_op='DELETE' or person_private.directory_binding(new)::text is distinct from person_private.directory_binding(old)::text) then raise exception 'directory_input_immutable';end if;
  -- Mutable receipt completion/derivative columns belong to subsequent admitted
  -- operations. This foundation protects only retained input identity.
  if tg_op='UPDATE' and person_private.directory_binding(new)::text=person_private.directory_binding(old)::text then return new;end if;
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
end$$;
do $$declare t text;begin
 foreach t in array array['person_directory_scans','person_directory_receipts','person_directory_state'] loop
  execute format('create trigger person_directory_input_statement before insert or update or delete or truncate on public.%I for each statement execute function person_private.directory_input_statement()',t);
  execute format('create trigger person_directory_input_before before insert or update or delete on public.%I for each row execute function person_private.directory_input_guard()',t);
  execute format('create trigger person_directory_input_after after insert or update or delete on public.%I for each row execute function person_private.directory_input_guard()',t);
 end loop;
end$$;

-- No service access: only the five typed observation RPCs can construct frames.
create function person_private.directory_mutate(p_table text,p_before jsonb,p_after jsonb) returns void
language plpgsql set search_path='' set timezone='UTC' as $$
declare returned jsonb;actual jsonb;f person_private.directory_input_frames;cols text;key text;key_type text;
begin
 if p_table not in ('person_directory_scans','person_directory_receipts','person_directory_state') or p_after is null or
  (p_table='person_directory_receipts' and p_before is not null) then raise exception 'directory_input_mutation';end if;
 if exists(select 1 from person_private.directory_input_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'directory_input_nested';end if;
 key:=case p_table when 'person_directory_scans' then 'workspace_id' when 'person_directory_state' then 'contact_id' else 'id' end;
 key_type:=case when p_table='person_directory_receipts' then 'bigint' else 'uuid' end;
 if p_after->>key is null or (p_before is not null and p_before->>key is distinct from p_after->>key) then raise exception 'directory_input_key';end if;
 insert into person_private.directory_input_frames(backend_pid,transaction_id,relation_name,operation,before_row,after_row)
 values(pg_backend_pid(),pg_current_xact_id(),p_table,case when p_before is null then 'INSERT' else 'UPDATE' end,p_before,p_after);
 if p_before is null then
  execute format('insert into public.%I overriding system value select x.* from jsonb_populate_record(null::public.%I,$1) x returning to_jsonb(%I)',p_table,p_table,p_table) into returned using p_after;
 else
  select string_agg(quote_ident(attname),',' order by attnum) into cols from pg_attribute where attrelid=format('public.%I',p_table)::regclass and attnum>0 and not attisdropped;
  execute format('update public.%I set (%s)=(select %s from jsonb_populate_record(null::public.%I,$1)) where %I=($1->>%L)::%s returning to_jsonb(%I)',p_table,cols,cols,p_table,key,key,key_type,p_table) into returned using p_after;
 end if;
 execute format('select to_jsonb(t) from public.%I t where %I=($1->>%L)::%s',p_table,key,key,key_type) into actual using p_after;
 select * into f from person_private.directory_input_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if returned is distinct from p_after or actual is distinct from p_after or f.backend_pid is null or
 f.relation_name is distinct from p_table or f.before_row is distinct from p_before or f.after_row is distinct from p_after or
 f.operation is distinct from (case when p_before is null then 'INSERT' else 'UPDATE' end) or not f.before_seen or not f.after_seen then raise exception 'directory_input_result';end if;
 delete from person_private.directory_input_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
end$$;

create function person_private.directory_scope(p_org uuid,p_workspace uuid) returns person_private.transition_control
language plpgsql set search_path='' as $$
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'directory_input_isolation';end if;
 if p_org is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a'::uuid or p_workspace is null then raise exception 'directory_input_scope';end if;
 return person_private.transition_lock();
end$$;
create function person_private.directory_lease(p_workspace uuid,p_token uuid) returns public.person_directory_scans
language plpgsql set search_path='' as $$
declare s public.person_directory_scans;
begin
 select * into s from public.person_directory_scans where workspace_id=p_workspace for update;
 if s.workspace_id is null or p_token is null or s.token is distinct from p_token or s.lease_until is null or s.lease_until<=clock_timestamp() then raise exception 'directory_input_lease';end if;
 return s;
end$$;
create function person_private.directory_unexpired(s public.person_directory_scans) returns void
language plpgsql set search_path='' as $$begin
 if s.lease_until is null or s.lease_until<=clock_timestamp() then raise exception 'directory_input_lease';end if;
end$$;
create function person_private.directory_shape(p_snapshot jsonb) returns uuid
language plpgsql set search_path='' as $$
declare k text;
begin
 if jsonb_typeof(p_snapshot) is distinct from 'object' or octet_length(p_snapshot::text)>2097152 or
 jsonb_typeof(p_snapshot->'board') is distinct from 'object' or
 p_snapshot->'board'->>'contact_id' is null or p_snapshot->'board'->>'contact_id' !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' or
 coalesce(jsonb_typeof(p_snapshot->'harvest'),'missing') not in ('object','null') then raise exception 'directory_input_shape';end if;
 foreach k in array array['exps','edus','emails','phones','facts','identifiers'] loop
  if jsonb_typeof(p_snapshot->k) is distinct from 'array' then raise exception 'directory_input_shape';end if;
  if jsonb_array_length(p_snapshot->k)>10000 or exists(select 1 from jsonb_array_elements(p_snapshot->k) x where jsonb_typeof(x)<>'object') then raise exception 'directory_input_shape';end if;
 end loop;
 return (p_snapshot->'board'->>'contact_id')::uuid;
end$$;
create function person_private.directory_equivalent(a jsonb,b jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare k text;keys text[]:=array['exps','edus','emails','phones','facts','identifiers'];x jsonb;y jsonb;
begin
 if (a-keys) is distinct from (b-keys) then return false;end if;
 foreach k in array keys loop
  if jsonb_typeof(a->k) is distinct from 'array' or jsonb_typeof(b->k) is distinct from 'array' then return false;end if;
  select coalesce(jsonb_agg(v order by v::text collate "C"),'[]') into x from jsonb_array_elements(a->k) v;
  select coalesce(jsonb_agg(v order by v::text collate "C"),'[]') into y from jsonb_array_elements(b->k) v;
  if x is distinct from y then return false;end if;
 end loop;return true;
end$$;

create function public.person_directory_claim(p_org uuid,p_workspace uuid,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare ctl person_private.transition_control;s public.person_directory_scans;b jsonb;
begin
 ctl:=person_private.directory_scope(p_org,p_workspace);
 if p_token is null then raise exception 'directory_input_token';end if;
 if ctl.enabled and ctl.phase<>'open' then return jsonb_build_object('status','held');end if;
 -- Serialize creation before the workspace row exists, as well as later claims.
 perform pg_advisory_xact_lock(72013,hashtext(p_workspace::text));
 select * into s from public.person_directory_scans where workspace_id=p_workspace for update;
 if s.workspace_id is not null and s.token is not null and s.lease_until>clock_timestamp() then
  if s.token<>p_token then return jsonb_build_object('status','busy');end if;
 else
  if s.workspace_id is not null then b:=to_jsonb(s);else s.workspace_id:=p_workspace;s.cursor:='00000000-0000-0000-0000-000000000000';s.cycle:=1;end if;
  s.token:=p_token;s.lease_until:=clock_timestamp()+interval '10 minutes';s.updated_at:=clock_timestamp();
  perform person_private.directory_mutate('person_directory_scans',b,to_jsonb(s));
 end if;
 perform person_private.directory_unexpired(s);
 return jsonb_build_object('status','claimed','token',s.token,'cursor',s.cursor,'cycle',s.cycle);
end$$;
create function public.person_directory_checkpoint(p_org uuid,p_workspace uuid,p_token uuid,p_cursor uuid,p_release boolean,p_complete boolean) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare ctl person_private.transition_control;s public.person_directory_scans;n public.person_directory_scans;
begin
 ctl:=person_private.directory_scope(p_org,p_workspace);s:=person_private.directory_lease(p_workspace,p_token);n:=s;
 if p_cursor is null or p_release is null or p_complete is null then raise exception 'directory_input_checkpoint';end if;
 if ctl.enabled and ctl.phase<>'open' and (p_complete or p_cursor<>s.cursor) then raise exception 'directory_input_held';end if;
 if p_cursor<s.cursor then raise exception 'directory_input_cursor';end if;
 n.cursor:=case when p_complete then '00000000-0000-0000-0000-000000000000'::uuid else p_cursor end;
 n.cycle:=s.cycle+case when p_complete then 1 else 0 end;n.token:=case when p_release then null else s.token end;
 n.lease_until:=case when p_release then null else clock_timestamp()+interval '10 minutes' end;n.updated_at:=clock_timestamp();
 perform person_private.directory_mutate('person_directory_scans',to_jsonb(s),to_jsonb(n));
 perform person_private.directory_unexpired(s);
 return jsonb_build_object('status','checkpointed');
end$$;
create function public.person_directory_stage(p_org uuid,p_workspace uuid,p_token uuid,p_hash text,p_snapshot jsonb) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare s public.person_directory_scans;t public.person_directory_state;n public.person_directory_state;
 r public.person_directory_receipts;contact uuid;b jsonb;cert person_private.directory_inputs;saved person_private.directory_inputs;pending boolean:=false;
begin
 perform person_private.directory_scope(p_org,p_workspace);
 contact:=person_private.directory_shape(p_snapshot);
 if p_hash is null or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'directory_input_hash';end if;
 s:=person_private.directory_lease(p_workspace,p_token);
 perform pg_advisory_xact_lock(72011,hashtext(contact::text));
 select * into t from public.person_directory_state where contact_id=contact for update;
 if t.contact_id is not null then
  if t.workspace_id<>p_workspace then raise exception 'directory_input_workspace';end if;
  select * into strict r from public.person_directory_receipts where id=t.latest_receipt_id for share;
  if r.workspace_id<>p_workspace or r.contact_id<>contact then raise exception 'directory_input_state';end if;
  perform person_private.directory_unexpired(s);
  if not person_private.directory_verify(r.id) then return jsonb_build_object('receiptId',r.id::text,'phase','input_review','projected',false);end if;
  if r.snapshot_hash=p_hash and not person_private.directory_equivalent(r.snapshot,p_snapshot) then raise exception 'directory_input_collision';end if;
  pending:=r.phase='ready' and r.snapshot_hash<>p_hash;
  if pending then return jsonb_build_object('receiptId',r.id::text,'phase','ready','projected',r.projected,'pendingPrevious',true);end if;
 end if;
 if r.id is null or r.snapshot_hash<>p_hash then
  r:=jsonb_populate_record(null::public.person_directory_receipts,jsonb_build_object(
   'id',nextval('public.person_directory_receipts_id_seq'),'workspace_id',p_workspace,'contact_id',contact,'snapshot_hash',p_hash,
   'snapshot',p_snapshot,'captured_at',clock_timestamp(),'created_person',false,'phase','ready','source_reviews','[]'::jsonb,
   'projected',false,'derivative_attempts',0,'derivative_done',false,'attempts',0,'updated_at',clock_timestamp()));
  perform person_private.directory_mutate('person_directory_receipts',null,to_jsonb(r));
  cert.receipt_id:=r.id;cert.version:=1;cert.binding:=person_private.directory_binding(r);cert.input_hash:=person_private.intake_hash(cert.binding);
  insert into person_private.directory_inputs select cert.* returning * into saved;
  if to_jsonb(saved) is distinct from to_jsonb(cert) then raise exception 'directory_input_certificate';end if;
  if not person_private.directory_verify(r.id) then raise exception 'directory_input_certificate';end if;
 end if;
 n:=t;if t.contact_id is not null then b:=to_jsonb(t);end if;
 n.contact_id:=contact;n.workspace_id:=p_workspace;n.latest_receipt_id:=r.id;n.seen_cycle:=s.cycle;
 perform person_private.directory_mutate('person_directory_state',b,to_jsonb(n));
 perform person_private.directory_unexpired(s);
 if not person_private.directory_verify(r.id) then raise exception 'directory_input_certificate';end if;
 return jsonb_build_object('receiptId',r.id::text,'phase',r.phase,'projected',r.projected,'reviewCount',jsonb_array_length(r.source_reviews));
end$$;
create function public.person_directory_inspect(p_org uuid,p_workspace uuid,p_token uuid,p_items jsonb) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare s public.person_directory_scans;t public.person_directory_state;n public.person_directory_state;r public.person_directory_receipts;item jsonb;contact uuid;result jsonb:='[]';certified boolean;
begin
 perform person_private.directory_scope(p_org,p_workspace);
 if jsonb_typeof(p_items) is distinct from 'array' then raise exception 'directory_input_page';end if;
 if jsonb_array_length(p_items)>100 or octet_length(p_items::text)>16777216 then raise exception 'directory_input_page';end if;
 s:=person_private.directory_lease(p_workspace,p_token);
 -- Every caller takes contacts in the same order; save never takes the scan lock.
 for item in select value from jsonb_array_elements(p_items) order by value->'snapshot'->'board'->>'contact_id' loop
  contact:=person_private.directory_shape(item->'snapshot');
  if item->>'snapshot_hash' is null or item->>'snapshot_hash' !~ '^[a-f0-9]{64}$' then raise exception 'directory_input_hash';end if;
  perform pg_advisory_xact_lock(72011,hashtext(contact::text));
  select * into t from public.person_directory_state where contact_id=contact for update;
  if t.contact_id is null then continue;end if;
  if t.workspace_id<>p_workspace then raise exception 'directory_input_workspace';end if;
  select * into strict r from public.person_directory_receipts where id=t.latest_receipt_id for share;
  if r.workspace_id<>p_workspace or r.contact_id<>contact then raise exception 'directory_input_state';end if;
  certified:=person_private.directory_verify(r.id);
  if certified and r.snapshot_hash=item->>'snapshot_hash' and not person_private.directory_equivalent(r.snapshot,item->'snapshot') then raise exception 'directory_input_collision';end if;
  if not certified or (r.phase='done' and r.snapshot_hash=item->>'snapshot_hash') then
   if certified then n:=t;n.seen_cycle:=s.cycle;perform person_private.directory_mutate('person_directory_state',to_jsonb(t),to_jsonb(n));end if;
   result:=result||jsonb_build_array(jsonb_build_object('contactId',contact,'receiptId',r.id::text,'phase',case when certified then r.phase else 'input_review' end,'projected',certified and r.projected,'reviewCount',jsonb_array_length(r.source_reviews)));
  end if;
 end loop;
 perform person_private.directory_unexpired(s);return result;
end$$;
create function public.person_directory_pending(p_org uuid,p_workspace uuid,p_token uuid,p_limit integer) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare s public.person_directory_scans;r public.person_directory_receipts;ids jsonb:='[]';reviews jsonb:='[]';
begin
 perform person_private.directory_scope(p_org,p_workspace);
 if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'directory_input_limit';end if;
 s:=person_private.directory_lease(p_workspace,p_token);
 -- Read immutable input only; execution later rechecks latest receipt under its
 -- own contact lock. Never acquire a receipt then a state lock in this reader.
 for r in select q.* from public.person_directory_receipts q join public.person_directory_state t on t.latest_receipt_id=q.id
  where t.workspace_id=p_workspace and q.phase='ready' order by q.id limit p_limit loop
  if r.workspace_id<>p_workspace or not exists(select 1 from public.person_directory_state t where t.latest_receipt_id=r.id and t.contact_id=r.contact_id and t.workspace_id=r.workspace_id) then raise exception 'directory_input_state';end if;
  if person_private.directory_verify(r.id) then ids:=ids||to_jsonb(r.id::text);else reviews:=reviews||to_jsonb(r.id::text);end if;
 end loop;
 perform person_private.directory_unexpired(s);
 if jsonb_array_length(reviews)>0 then return jsonb_build_object('status','input_review','receiptIds',ids,'reviewReceiptIds',reviews);end if;
 return jsonb_build_object('status','ready','receiptIds',ids);
end$$;
revoke all on function person_private.directory_binding(public.person_directory_receipts),person_private.directory_verify(bigint),person_private.directory_input_statement(),person_private.directory_input_guard(),person_private.directory_mutate(text,jsonb,jsonb),person_private.directory_scope(uuid,uuid),person_private.directory_lease(uuid,uuid),person_private.directory_unexpired(public.person_directory_scans),person_private.directory_shape(jsonb),person_private.directory_equivalent(jsonb,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.person_directory_claim(uuid,uuid,uuid),public.person_directory_checkpoint(uuid,uuid,uuid,uuid,boolean,boolean),public.person_directory_stage(uuid,uuid,uuid,text,jsonb),public.person_directory_inspect(uuid,uuid,uuid,jsonb),public.person_directory_pending(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.person_directory_claim(uuid,uuid,uuid),public.person_directory_checkpoint(uuid,uuid,uuid,uuid,boolean,boolean),public.person_directory_stage(uuid,uuid,uuid,text,jsonb),public.person_directory_inspect(uuid,uuid,uuid,jsonb),public.person_directory_pending(uuid,uuid,uuid,integer) to service_role;
