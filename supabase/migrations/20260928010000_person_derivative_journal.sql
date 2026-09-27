-- PREPARED ONLY. Checked producer history; no consumer or provider activation.
-- CLI timestamp renamed after recruiter admission to preserve dependency order.
set local lock_timeout='2s';set local statement_timeout='30s';

create table person_private.derivative_job_changes(
 id uuid primary key,candidate_id uuid not null references public.candidates(id),
 sequence bigint not null check(sequence>0),previous_id uuid references person_private.derivative_job_changes(id),
 work_id uuid not null references person_private.transition_work(id),execution_id uuid,
 owner_binding jsonb not null,before_row jsonb,after_row jsonb not null,
 recorded_at timestamptz not null,transaction_id xid8 not null,seal_hash text not null,
 unique(candidate_id,sequence),unique(previous_id)
);
create index derivative_job_changes_work on person_private.derivative_job_changes(work_id);
create table person_private.derivative_job_heads(
 candidate_id uuid primary key references public.candidates(id),
 change_id uuid not null unique references person_private.derivative_job_changes(id),
 sequence bigint not null check(sequence>0)
);
create table person_private.derivative_journal_frames(
 backend_pid integer not null,transaction_id xid8 not null,
 change_row jsonb not null,before_head jsonb,after_head jsonb not null,
 primary key(backend_pid,transaction_id)
);
do $$declare t text;begin
 foreach t in array array['derivative_job_changes','derivative_job_heads','derivative_journal_frames'] loop
  execute format('alter table person_private.%I enable row level security',t);
  execute format('revoke all on person_private.%I from public,anon,authenticated,service_role',t);
 end loop;
end$$;

-- Lease, token and outcome may legitimately change after this short producer
-- transaction. Identity fields never do; no producer-completion recursion.
create function person_private.derivative_owner_binding(w person_private.transition_work) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('id',w.id,'organization_id',w.organization_id,'scope',w.scope,
  'family',w.family,'resource_key',w.resource_key,'input_hash',w.input_hash,'generation',w.generation)
$$;
create function person_private.derivative_job_change_valid(p_id uuid) returns boolean
language sql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
 select coalesce((select j.seal_hash=person_private.intake_hash(to_jsonb(j)-'seal_hash') and
  j.owner_binding=person_private.derivative_owner_binding(w) and w.scope='tt_person' and
  w.organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a' and w.family in ('application','directory','refresh') and
  j.after_row->>'candidate_id'=j.candidate_id::text and
  (j.before_row is null or j.before_row->>'candidate_id'=j.candidate_id::text) and
  ((j.sequence=1 and j.previous_id is null) or (j.sequence>1 and exists(
   select 1 from person_private.derivative_job_changes prior where prior.id=j.previous_id and
    prior.candidate_id=j.candidate_id and prior.sequence=j.sequence-1 and prior.after_row=j.before_row and
    prior.seal_hash=person_private.intake_hash(to_jsonb(prior)-'seal_hash'))))
 from person_private.derivative_job_changes j join person_private.transition_work w on w.id=j.work_id
 where j.id=p_id),false)
$$;
create function person_private.derivative_job_head_matches(p_candidate uuid,p_row jsonb) returns boolean
language sql stable set search_path='' as $$
 select coalesce((select j.candidate_id=h.candidate_id and j.sequence=h.sequence and j.after_row=p_row and
  person_private.derivative_job_change_valid(j.id) and not exists(
   select 1 from person_private.derivative_job_changes newer where newer.candidate_id=h.candidate_id and newer.sequence>h.sequence)
 from person_private.derivative_job_heads h join person_private.derivative_job_changes j on j.id=h.change_id
 where h.candidate_id=p_candidate),false)
$$;
create function person_private.derivative_job_current(p_candidate uuid) returns boolean
language sql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
 select person_private.derivative_job_head_matches(p_candidate,
  (select to_jsonb(j) from public.person_derivative_jobs j where j.candidate_id=p_candidate))
$$;

create function person_private.derivative_journal_guard() returns trigger
language plpgsql security definer set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare f person_private.derivative_journal_frames;
begin
 if tg_level='STATEMENT' then
  if tg_op='TRUNCATE' then raise exception 'derivative_journal_immutable';end if;return null;
 end if;
 select * into f from person_private.derivative_journal_frames
 where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if f.backend_pid is null then raise exception 'derivative_journal_frame';end if;
 if tg_table_name='derivative_job_changes' then
  if tg_op<>'INSERT' or to_jsonb(new) is distinct from f.change_row then raise exception 'derivative_journal_immutable';end if;
 else
  if tg_op='DELETE' or to_jsonb(new) is distinct from f.after_head or
   (case when tg_op='INSERT' then null else to_jsonb(old) end) is distinct from f.before_head then raise exception 'derivative_journal_head';end if;
 end if;
 return new;
end$$;
do $$declare t text;begin foreach t in array array['derivative_job_changes','derivative_job_heads'] loop
 execute format('create trigger derivative_journal_statement before truncate on person_private.%I for each statement execute function person_private.derivative_journal_guard()',t);
 execute format('create trigger derivative_journal_before before insert or update or delete on person_private.%I for each row execute function person_private.derivative_journal_guard()',t);
 execute format('create trigger derivative_journal_after after insert or update or delete on person_private.%I for each row execute function person_private.derivative_journal_guard()',t);
end loop;end$$;

create function person_private.derivative_journal_deferred() returns trigger
language plpgsql security definer set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare j person_private.derivative_job_changes;w person_private.transition_work;
begin
 if tg_table_name='derivative_job_changes' then
  select * into j from person_private.derivative_job_changes where id=new.id;
  if to_jsonb(j) is distinct from to_jsonb(new) then raise exception 'derivative_journal_actual';end if;
 else select * into j from person_private.derivative_job_changes where id=new.change_id;end if;
 if person_private.derivative_job_change_valid(j.id) is distinct from true or
  person_private.derivative_job_current(j.candidate_id) is distinct from true or
  exists(select 1 from person_private.derivative_journal_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
  exists(select 1 from person_private.derivative_producer_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
 then raise exception 'derivative_journal_actual';end if;
 -- A later legitimate append may already be the head in the same transaction.
 -- Validate this certificate separately from that latest public job image.
 if j.transaction_id=pg_current_xact_id() then
  select * into w from person_private.transition_work where id=j.work_id;
  if not ((w.status='active' and w.lease_until>clock_timestamp()) or
   (w.status='completed' and w.finished_at is not null and w.finished_at<=w.lease_until))
  then raise exception 'derivative_journal_expired';end if;
 end if;
 return null;
end$$;
create constraint trigger derivative_journal_proof after insert on person_private.derivative_job_changes
 deferrable initially deferred for each row execute function person_private.derivative_journal_deferred();
create constraint trigger derivative_head_proof after insert or update on person_private.derivative_job_heads
 deferrable initially deferred for each row execute function person_private.derivative_journal_deferred();

create function person_private.derivative_journal_work_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from person_private.derivative_job_changes where work_id=old.id) and
  (tg_op='DELETE' or person_private.derivative_owner_binding(new) is distinct from person_private.derivative_owner_binding(old))
 then raise exception 'derivative_journal_owner';end if;
 return coalesce(new,old);
end$$;
create trigger derivative_journal_work_before before update or delete on person_private.transition_work
 for each row execute function person_private.derivative_journal_work_guard();
create trigger derivative_journal_work_after after update or delete on person_private.transition_work
 for each row execute function person_private.derivative_journal_work_guard();

create function person_private.derivative_job_record(p_execution uuid,p_work uuid,p_candidate uuid,p_before jsonb,p_after jsonb) returns void
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare f person_private.derivative_producer_frames;w person_private.transition_work;
 old_head person_private.derivative_job_heads;target_head person_private.derivative_job_heads;
 j person_private.derivative_job_changes;returned jsonb;actual jsonb;frame person_private.derivative_journal_frames;
begin
 perform person_private.projection_owner(p_execution);
 select * into f from person_private.derivative_producer_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 select * into w from person_private.transition_work where id=p_work;
 if f.work_id is distinct from p_work or f.candidate_id is distinct from p_candidate or
  f.before_row is distinct from p_before or f.after_row is distinct from p_after or
  not coalesce(f.before_seen and f.after_seen,false) or
  w.family is null or w.family not in ('application','directory','refresh') or
  w.organization_id<>'801865a7-6533-41d2-9c45-e4a90e6ad51a' or w.scope<>'tt_person' or
  current_setting('person.work_id',true) is distinct from w.id::text or
  (select to_jsonb(x) from public.person_derivative_jobs x where candidate_id=p_candidate) is distinct from p_after
 then raise exception 'derivative_journal_scope';end if;
 if exists(select 1 from person_private.derivative_journal_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'derivative_journal_nested';end if;
 -- Producer already holds candidate and job locks. Never acquire another
 -- producer's work lock here; the immutable binding is read without locking.
 select * into old_head from person_private.derivative_job_heads where candidate_id=p_candidate for update;
 if old_head.candidate_id is not null then
  if person_private.derivative_job_head_matches(p_candidate,p_before) is distinct from true then raise exception 'derivative_journal_before';end if;
 elsif exists(select 1 from person_private.derivative_job_changes where candidate_id=p_candidate) then raise exception 'derivative_journal_missing_head';
 end if;
 -- Genesis may retain an untrusted legacy before-image. It does not certify an
 -- old consumer token, attempt history or provider outcome as a consumer request.
 j:=jsonb_populate_record(null::person_private.derivative_job_changes,jsonb_build_object(
  'id',gen_random_uuid(),'candidate_id',p_candidate,'sequence',coalesce(old_head.sequence,0)+1,
  'previous_id',old_head.change_id,'work_id',p_work,'execution_id',p_execution,
  'owner_binding',person_private.derivative_owner_binding(w),'before_row',p_before,'after_row',p_after,
  'recorded_at',clock_timestamp(),'transaction_id',pg_current_xact_id()::text));
 j.seal_hash:=person_private.intake_hash(to_jsonb(j)-'seal_hash');
 target_head:=row(p_candidate,j.id,j.sequence)::person_private.derivative_job_heads;
 insert into person_private.derivative_journal_frames values(pg_backend_pid(),pg_current_xact_id(),to_jsonb(j),
  case when old_head.candidate_id is null then null else to_jsonb(old_head) end,to_jsonb(target_head));
 insert into person_private.derivative_job_changes select j.* returning to_jsonb(derivative_job_changes) into returned;
 select to_jsonb(x) into actual from person_private.derivative_job_changes x where id=j.id;
 if returned is distinct from to_jsonb(j) or actual is distinct from to_jsonb(j) then raise exception 'derivative_journal_actual';end if;
 if old_head.candidate_id is null then insert into person_private.derivative_job_heads select target_head.* returning to_jsonb(derivative_job_heads) into returned;
 else update person_private.derivative_job_heads set change_id=j.id,sequence=j.sequence where candidate_id=p_candidate returning to_jsonb(derivative_job_heads) into returned;end if;
 select to_jsonb(x) into actual from person_private.derivative_job_heads x where candidate_id=p_candidate;
 select * into frame from person_private.derivative_journal_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if returned is distinct from to_jsonb(target_head) or actual is distinct from to_jsonb(target_head) or
  frame.change_row is distinct from to_jsonb(j) or frame.after_head is distinct from to_jsonb(target_head) or
  frame.before_head is distinct from (case when old_head.candidate_id is null then null else to_jsonb(old_head) end)
 then raise exception 'derivative_journal_actual';end if;
 delete from person_private.derivative_journal_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if exists(select 1 from person_private.derivative_journal_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
  person_private.derivative_job_current(p_candidate) is distinct from true then raise exception 'derivative_journal_actual';end if;
 perform person_private.projection_owner(p_execution);
end$$;

-- Preserve the shared checked producer and its family dispatch. Append after
-- its exact public readback; recheck owner/lease after all new writes/cleanup.
do $$declare d text;n text;begin
 d:=pg_get_functiondef('person_private.derivative_enqueue(uuid,uuid,text,jsonb,jsonb)'::regprocedure);
 n:=E' perform person_private.projection_owner(p_execution);\n delete from person_private.derivative_producer_frames';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'derivative_journal_definition';end if;
 d:=replace(d,n,E' perform person_private.derivative_job_record(p_execution,wid,p_candidate,case when old_job.candidate_id is null then null else to_jsonb(old_job) end,to_jsonb(target));\n delete from person_private.derivative_producer_frames');
 n:=E' return to_jsonb(target);';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'derivative_journal_return_definition';end if;
 d:=replace(d,n,E' perform person_private.projection_owner(p_execution);\n if exists(select 1 from person_private.derivative_producer_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or person_private.derivative_job_current(p_candidate) is distinct from true then raise exception ''derivative_journal_actual'';end if;\n return to_jsonb(target);');
 execute d;
 -- Ownership survives disabling the controller and accidental head loss.
 d:=pg_get_functiondef('person_private.derivative_producer_guard()'::regprocedure);
 n:='if f.backend_pid is null and not person_private.normalization_required() then';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'derivative_journal_guard_definition';end if;
 d:=replace(d,n,$guard$if f.backend_pid is null and not person_private.normalization_required() and
  not exists(select 1 from person_private.derivative_job_heads where candidate_id=any(array[old.candidate_id,new.candidate_id])) and
  not exists(select 1 from person_private.derivative_job_changes where candidate_id=any(array[old.candidate_id,new.candidate_id])) then$guard$);
 execute d;
end$$;
do $$declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='person_private' and p.proname in ('derivative_owner_binding','derivative_job_change_valid','derivative_job_head_matches','derivative_job_current','derivative_journal_guard','derivative_journal_deferred','derivative_journal_work_guard','derivative_job_record') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end$$;
