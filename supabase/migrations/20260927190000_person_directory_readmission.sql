-- PREPARED ONLY. Same-source outcome reconsideration; no worker activation.
set local lock_timeout='2s';set local statement_timeout='30s';
-- This complete chain is installed before any certified directory writer is
-- activated. Never infer a historical head from timestamps or matching results.
do $$begin if exists(select 1 from person_private.directory_executions where completed_at is not null) then raise exception 'directory_head_install_requires_empty_history';end if;end$$;
alter table person_private.directory_executions add column admission_hash text;
create index directory_execution_all_receipts on person_private.directory_executions(receipt_id);
create table person_private.directory_heads(receipt_id bigint primary key references person_private.directory_inputs(receipt_id),execution_id uuid not null unique references person_private.directory_executions(id),work_id uuid not null,completion_hash text not null);
create table person_private.directory_admissions(execution_id uuid primary key references person_private.directory_executions(id),work_id uuid not null,transaction_id xid8 not null,input_hash text not null,prior_head jsonb,receipt_before jsonb not null,ready_receipt jsonb not null,reentered boolean not null);
create table person_private.directory_head_frames(backend_pid integer not null,transaction_id xid8 not null,execution_id uuid not null,before_row jsonb,after_row jsonb not null,before_seen boolean not null default false,after_seen boolean not null default false,primary key(backend_pid,transaction_id));
do $$declare t text;begin foreach t in array array['directory_heads','directory_admissions','directory_head_frames'] loop execute format('alter table person_private.%I enable row level security',t);execute format('revoke all on person_private.%I from public,anon,authenticated,service_role',t);end loop;end$$;
create function person_private.directory_completion_hash(p_id uuid) returns text language sql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$select person_private.intake_hash(to_jsonb(e)) from person_private.directory_executions e where id=p_id$$;
create function person_private.directory_head_valid(p_head jsonb,p_receipt bigint) returns boolean
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;w person_private.transition_work;
begin
 select * into e from person_private.directory_executions where id=(p_head->>'execution_id')::uuid;
 select * into w from person_private.transition_work where id=e.work_id;
 return e.id is not null and e.receipt_id=p_receipt and e.result is not null and e.completed_at is not null and w.id=e.work_id and w.status='completed' and w.finished_at is not null and
 w.family='directory' and w.scope='tt_person' and w.organization_id=e.organization_id and w.input_hash=e.input_hash and w.resource_key='directory:'||e.receipt_id::text||':'||e.id::text and
 p_head=jsonb_build_object('receipt_id',e.receipt_id,'execution_id',e.id,'work_id',e.work_id,'completion_hash',person_private.directory_completion_hash(e.id));
end$$;
-- Historical certificates deliberately use retained observations, never today's
-- person/state/hold eligibility. Current-row validation remains the live path.
do $$declare b text;needle text;begin
 b:=pg_get_functiondef('person_private.directory_suppression_valid(uuid,jsonb,jsonb)'::regprocedure);
 b:=replace(b,'person_private.directory_suppression_valid(p_id uuid, p_proof jsonb, p_before jsonb)','person_private.directory_suppression_history_valid(p_id uuid, p_proof jsonb, p_before jsonb)');
 needle:='person_private.publication_candidate(cid) is distinct from target or ';
 if position(needle in b)=0 then raise exception 'directory_history_definition';end if;b:=replace(b,needle,'');execute b;
 b:=pg_get_functiondef('person_private.directory_outcome_valid(uuid)'::regprocedure);
 b:=replace(b,'person_private.directory_outcome_valid(p_id uuid)','person_private.directory_outcome_history_valid(p_id uuid)');
 needle:='observed:=person_private.directory_outcome_observe(p_id,proof.identities);';
 if position(needle in b)=0 then raise exception 'directory_history_definition';end if;b:=replace(b,needle,'observed:=proof.observations;');
 b:=replace(b,'person_private.directory_suppression_valid(p_id,proof.suppression','person_private.directory_suppression_history_valid(p_id,proof.suppression');
 needle:='to_jsonb(r)=proof.receipt_after';
 if position(needle in b)=0 then raise exception 'directory_history_definition';end if;
 b:=replace(b,needle,'person_private.directory_binding(jsonb_populate_record(null::public.person_directory_receipts,proof.receipt_after))=person_private.directory_binding(r)');
 needle:=' return ((expected';if position(needle in b)=0 then raise exception 'directory_history_definition';end if;
 b:=replace(b,needle,' return w.status=''completed'' and w.finished_at is not null and ((expected');execute b;
end$$;

create function person_private.directory_admission_valid(p_id uuid) returns boolean
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;a person_private.directory_admissions;p person_private.directory_executions;r public.person_directory_receipts;target jsonb;
begin
 select * into e from person_private.directory_executions where id=p_id;
 select * into a from person_private.directory_admissions where execution_id=p_id;
 select * into r from public.person_directory_receipts where id=e.receipt_id;
 if e.id is null or a.execution_id is null or a.work_id<>e.work_id or a.transaction_id<>e.transaction_id or a.input_hash<>e.input_hash or e.admission_hash is distinct from person_private.intake_hash(to_jsonb(a)) or
  person_private.directory_binding(jsonb_populate_record(null::public.person_directory_receipts,a.receipt_before)) is distinct from person_private.directory_binding(r) or
  person_private.directory_binding(jsonb_populate_record(null::public.person_directory_receipts,a.ready_receipt)) is distinct from person_private.directory_binding(r) then return false;end if;
 if a.prior_head is not null then
  if person_private.directory_head_valid(a.prior_head,e.receipt_id) is distinct from true then return false;end if;
  select * into p from person_private.directory_executions where id=(a.prior_head->>'execution_id')::uuid;
  -- Seal only the immediate predecessor's admission row; never recursively
  -- traverse a potentially long chain of unchanged reviews.
  if p.receipt_after is distinct from a.receipt_before or p.admission_hash is null or
   p.admission_hash is distinct from (select person_private.intake_hash(to_jsonb(prior_admission)) from person_private.directory_admissions prior_admission where execution_id=p.id) then return false;end if;
 end if;
 if a.reentered then
  if p.id is null or p.disposition<>'outcome' or a.receipt_before->>'phase' not in ('review','suppressed') or a.receipt_before->'result' is distinct from p.result or person_private.directory_outcome_history_valid(p.id) is distinct from true then return false;end if;
  target:=a.receipt_before||jsonb_build_object('phase','ready','candidate_id',null,'created_person',false,'result',null,'error_code',null,'updated_at',a.ready_receipt->'updated_at');
  return a.ready_receipt=target and a.ready_receipt->>'updated_at' is not null;
 end if;
 return a.ready_receipt=a.receipt_before and ((a.prior_head is null and a.ready_receipt->>'phase'='ready' and a.ready_receipt->'attempts'='0'::jsonb) or (p.disposition='normalized' and a.ready_receipt->>'phase'='done'));
end$$;

create function person_private.directory_admit(p_id uuid) returns void
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;r public.person_directory_receipts;s public.person_directory_state;h person_private.directory_heads;p person_private.directory_executions;a person_private.directory_admissions;saved person_private.directory_admissions;head jsonb;target jsonb;reenter boolean:=false;
begin
 e:=person_private.directory_context(p_id);
 if e.admission_hash is not null or exists(select 1 from person_private.directory_admissions where execution_id=p_id) then raise exception 'directory_admission_reentry';end if;
 select * into r from public.person_directory_receipts where id=e.receipt_id for update;
 select * into s from public.person_directory_state where contact_id=e.contact_id for update;
 select * into h from person_private.directory_heads where receipt_id=e.receipt_id for update;
 perform person_private.directory_context(p_id);
 head:=case when h.receipt_id is null then null else to_jsonb(h) end;
 target:=to_jsonb(r);
 if head is null then
  if exists(select 1 from person_private.directory_executions where receipt_id=e.receipt_id and id<>e.id) or r.phase<>'ready' then raise exception 'directory_head_missing';end if;
 else
  if person_private.directory_head_valid(head,e.receipt_id) is distinct from true then raise exception 'directory_head_invalid';end if;
  select * into p from person_private.directory_executions where id=h.execution_id;
  if p.receipt_after is distinct from to_jsonb(r) then raise exception 'directory_head_receipt';end if;
  if r.phase in ('review','suppressed') then
   if s.latest_receipt_id is distinct from e.receipt_id or s.workspace_id is distinct from e.workspace_id or p.disposition<>'outcome' or person_private.directory_outcome_history_valid(p.id) is distinct from true or person_private.directory_admission_valid(p.id) is distinct from true then raise exception 'directory_readmission_proof';end if;
   reenter:=true;target:=target||jsonb_build_object('phase','ready','candidate_id',null,'created_person',false,'result',null,'error_code',null,'updated_at',clock_timestamp());
  elsif r.phase<>'done' or p.disposition<>'normalized' then raise exception 'directory_readmission_ineligible';end if;
 end if;
 a:=row(e.id,e.work_id,e.transaction_id,e.input_hash,head,to_jsonb(r),target,reenter)::person_private.directory_admissions;
 insert into person_private.directory_admissions select a.* returning * into saved;
 if to_jsonb(saved) is distinct from to_jsonb(a) or (select to_jsonb(x) from person_private.directory_admissions x where execution_id=p_id) is distinct from to_jsonb(a) then raise exception 'directory_admission_actual';end if;
 if target is distinct from to_jsonb(r) then perform person_private.directory_mutate('person_directory_receipts',to_jsonb(r),target);end if;
 perform person_private.directory_context(p_id);
 update person_private.directory_executions set admission_hash=person_private.intake_hash(to_jsonb(a)) where id=p_id;
 if person_private.directory_admission_valid(p_id) is distinct from true or (select to_jsonb(x) from public.person_directory_receipts x where id=e.receipt_id) is distinct from target then raise exception 'directory_admission_witness';end if;
end$$;

-- The global completion validator checks the admission link and exact head.
-- The work BEFORE guard proves the old head; the AFTER helper installs the new
-- head before deferred completion. Neither can fall back to an older result.
do $$declare b text;begin
 b:=pg_get_functiondef('person_private.directory_completion_valid(uuid)'::regprocedure);
 b:=replace(b,'person_private.directory_completion_valid(p_id uuid)','person_private.directory_completion_body(p_id uuid)');execute b;
end$$;
create or replace function person_private.directory_completion_valid(p_id uuid) returns boolean
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;a person_private.directory_admissions;w person_private.transition_work;head jsonb;
begin
 if person_private.directory_completion_body(p_id) is distinct from true or person_private.directory_admission_valid(p_id) is distinct from true then return false;end if;
 select * into e from person_private.directory_executions where id=p_id;select * into a from person_private.directory_admissions where execution_id=p_id;
 select * into w from person_private.transition_work where id=e.work_id;
 select to_jsonb(h) into head from person_private.directory_heads h where receipt_id=e.receipt_id;
 if e.disposition='outcome' and (select receipt_before from person_private.directory_outcomes where execution_id=p_id) is distinct from a.ready_receipt then return false;end if;
 if w.status='active' then return head is not distinct from a.prior_head;end if;
 return w.status='completed' and head->>'execution_id'=p_id::text and person_private.directory_head_valid(head,e.receipt_id);
end$$;
create function person_private.directory_head_guard() returns trigger
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare f person_private.directory_head_frames;e person_private.directory_executions;a person_private.directory_admissions;w person_private.transition_work;before_row jsonb;after_row jsonb;
begin
 if tg_op not in ('INSERT','UPDATE') then raise exception 'directory_head_frame';end if;
 select * into f from person_private.directory_head_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 select * into e from person_private.directory_executions where id=f.execution_id;select * into a from person_private.directory_admissions where execution_id=e.id;select * into w from person_private.transition_work where id=e.work_id;
 before_row:=case when tg_op='INSERT' then null else to_jsonb(old) end;after_row:=to_jsonb(new);
 if f.backend_pid is null or e.id is null or e.transaction_id<>pg_current_xact_id() or e.backend_pid<>pg_backend_pid() or w.status is distinct from 'completed' or current_setting('person.work_id',true) is distinct from e.work_id::text or w.token_hash is distinct from md5(current_setting('person.work_token',true)) or
  person_private.directory_admission_valid(e.id) is distinct from true or f.before_row is distinct from a.prior_head or f.before_row is distinct from before_row or f.after_row is distinct from after_row or after_row is distinct from jsonb_build_object('receipt_id',e.receipt_id,'execution_id',e.id,'work_id',e.work_id,'completion_hash',person_private.directory_completion_hash(e.id)) then raise exception 'directory_head_frame';end if;
 if tg_when='BEFORE' then
  if f.before_seen or f.after_seen then raise exception 'directory_head_reentry';end if;
  update person_private.directory_head_frames set before_seen=true where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 else
  if not f.before_seen or f.after_seen then raise exception 'directory_head_reentry';end if;
  update person_private.directory_head_frames set after_seen=true where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 end if;return new;
end$$;
create trigger directory_head_before before insert or update or delete on person_private.directory_heads for each row execute function person_private.directory_head_guard();
create trigger directory_head_after after insert or update or delete on person_private.directory_heads for each row execute function person_private.directory_head_guard();
create trigger directory_head_no_truncate before truncate on person_private.directory_heads for each statement execute function person_private.audit_proof_no_truncate();
create function person_private.directory_head_complete() returns trigger
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.directory_executions;a person_private.directory_admissions;target person_private.directory_heads;saved person_private.directory_heads;f person_private.directory_head_frames;actual jsonb;
begin
 select * into e from person_private.directory_executions where work_id=new.id;
 if e.id is null or old.status=new.status then return new;end if;
 if new.status<>'completed' or new.finished_at is null or new.lease_until<=clock_timestamp() or e.transaction_id<>pg_current_xact_id() or person_private.directory_completion_body(e.id) is distinct from true or person_private.directory_admission_valid(e.id) is distinct from true then raise exception 'directory_head_completion';end if;
 select * into a from person_private.directory_admissions where execution_id=e.id;
 select to_jsonb(h) into actual from person_private.directory_heads h where receipt_id=e.receipt_id for update;
 if actual is distinct from a.prior_head or exists(select 1 from person_private.directory_head_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'directory_head_cas';end if;
 target:=row(e.receipt_id,e.id,e.work_id,person_private.directory_completion_hash(e.id))::person_private.directory_heads;
 insert into person_private.directory_head_frames(backend_pid,transaction_id,execution_id,before_row,after_row) values(pg_backend_pid(),pg_current_xact_id(),e.id,a.prior_head,to_jsonb(target));
 if a.prior_head is null then insert into person_private.directory_heads select target.* returning * into saved;
 else update person_private.directory_heads h set execution_id=target.execution_id,work_id=target.work_id,completion_hash=target.completion_hash where h.receipt_id=e.receipt_id and to_jsonb(h)=a.prior_head returning * into saved;end if;
 select * into f from person_private.directory_head_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if to_jsonb(saved) is distinct from to_jsonb(target) or (select to_jsonb(h) from person_private.directory_heads h where receipt_id=e.receipt_id) is distinct from to_jsonb(target) or f.execution_id is distinct from e.id or f.before_row is distinct from a.prior_head or f.after_row is distinct from to_jsonb(target) or not coalesce(f.before_seen and f.after_seen,false) then raise exception 'directory_head_actual';end if;
 delete from person_private.directory_head_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if exists(select 1 from person_private.directory_head_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or person_private.directory_completion_valid(e.id) is distinct from true then raise exception 'directory_head_completion';end if;
 return new;
end$$;
create trigger directory_head_complete after update on person_private.transition_work for each row execute function person_private.directory_head_complete();

-- Admission is common to every certified save, before terminal resolution or
-- normal binding. Retained attempts are accepted only from the certified image.
do $$declare b text;needle text;begin
 b:=pg_get_functiondef('person_private.directory_outcome(uuid,jsonb)'::regprocedure);
 needle:=' if r.phase<>''ready'' then return null;end if;';if position(needle in b)=0 then raise exception 'directory_readmission_definition';end if;
 b:=replace(b,needle,E' perform person_private.directory_admit(p_id);\n select * into r from public.person_directory_receipts where id=e.receipt_id;\n'||needle);
 needle:='r.attempts<>0';if position(needle in b)=0 then raise exception 'directory_readmission_definition';end if;
 b:=replace(b,needle,'r.attempts is distinct from (select (ready_receipt->>''attempts'')::integer from person_private.directory_admissions where execution_id=p_id)');execute b;
 b:=pg_get_functiondef('person_private.directory_capture(uuid)'::regprocedure);
 needle:='x.completed_at is not null and x.result is not null;';if position(needle in b)=0 then raise exception 'directory_readmission_definition';end if;
 b:=replace(b,needle,'x.completed_at is not null and x.result is not null and x.disposition=''normalized'' and x.receipt_after=to_jsonb(p) order by x.completed_at desc,x.id desc limit 1;');execute b;
 b:=pg_get_functiondef('person_private.directory_bind(uuid,uuid,jsonb)'::regprocedure);
 needle:='mode=''shadow'' and completed_at is not null order by completed_at desc limit 1;';if position(needle in b)=0 then raise exception 'directory_readmission_definition';end if;
 b:=replace(b,needle,'mode=''shadow'' and completed_at is not null and disposition=''normalized'' and receipt_after=to_jsonb(r) order by completed_at desc,id desc limit 1;');execute b;
end$$;
do $$declare p record;begin for p in select oid::regprocedure signature from pg_proc where pronamespace='person_private'::regnamespace and proname in ('directory_completion_hash','directory_head_valid','directory_suppression_history_valid','directory_outcome_history_valid','directory_admission_valid','directory_admit','directory_completion_body','directory_head_guard','directory_head_complete') loop execute format('revoke all on function %s from public,anon,authenticated,service_role',p.signature);end loop;end$$;
