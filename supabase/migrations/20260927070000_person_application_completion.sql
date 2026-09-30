-- PREPARED ONLY. Checked application results and completion are one transaction.
set local lock_timeout='2s';set local statement_timeout='30s';
create table person_private.application_completions(
 work_id uuid primary key references person_private.application_work(work_id),
 application_id uuid not null unique references public.website_applications(id),organization_id uuid not null,
 input_hash text not null,person_key uuid not null,proof_kind text not null check(proof_kind in ('tt_ready','tenant_binding')),
 proof_hash text not null,result_payload_hash text not null,actual_result_hash text not null,
 transaction_id xid8 not null,completed_at timestamptz not null,
 check(proof_hash ~ '^[a-f0-9]{64}$' and result_payload_hash ~ '^[a-f0-9]{64}$' and actual_result_hash ~ '^[a-f0-9]{64}$')
);
create table person_private.application_result_frames(
 backend_pid integer not null,transaction_id xid8 not null,work_id uuid not null,application_id uuid not null,
 before_row jsonb not null,after_row jsonb not null,primary key(backend_pid,transaction_id)
);
alter table person_private.application_completions enable row level security;
alter table person_private.application_result_frames enable row level security;
revoke all on person_private.application_completions,person_private.application_result_frames from public,anon,authenticated,service_role;

create function person_private.application_result_fields(p jsonb) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_object_agg(k,p->k) from unnest(array['id','organization_id','candidate_id','pool_created_person','harvest_profile','parsed_profile','resume_text','name','contact','matched_role_ids','screening','status']) k
$$;
create function person_private.application_result_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare f person_private.application_result_frames;i person_private.intake_mutation_frames;o jsonb:=to_jsonb(old);n jsonb:=to_jsonb(new);
begin
 if not person_private.normalization_required() then return new;end if;
 select * into f from person_private.application_result_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if f.backend_pid is not null then
  if f.application_id<>new.id or f.before_row-'updated_at' is distinct from o-'updated_at' or f.after_row-'updated_at' is distinct from n-'updated_at' then raise exception 'application_result_frame';end if;return new;
 end if;
 if not exists(select 1 from person_private.application_work where application_id=old.id) then return new;end if;
 if person_private.application_result_fields(o)-array['id','organization_id']=person_private.application_result_fields(n)-array['id','organization_id'] then return new;end if;
 -- First TT intake already has its own exact checked mutation frame. It may
 -- finalize receipt fields, but cannot borrow that frame to publish results.
 select * into i from person_private.intake_mutation_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if i.kind='finalize' and i.application_id=new.id and o->>'organization_id'='801865a7-6533-41d2-9c45-e4a90e6ad51a' and
  not exists(select 1 from unnest(array['harvest_profile','matched_role_ids','screening','status']) k where o->k is distinct from n->k) then return new;end if;
 raise exception 'application_result_frame';
end$$;
create trigger person_application_result_before before update on public.website_applications for each row execute function person_private.application_result_guard();
create trigger person_application_result_after after update on public.website_applications for each row execute function person_private.application_result_guard();

create function person_private.application_result_keys(p jsonb,required text[],allowed text[]) returns boolean language sql immutable set search_path='' as $$
 select case when jsonb_typeof(p)='object' then p ?& required and not exists(select 1 from jsonb_object_keys(p) k where not k=any(allowed)) else false end
$$;
create function person_private.application_result_answers(p jsonb,p_max integer) returns void language plpgsql immutable set search_path='' as $$
declare x jsonb;
begin
 if jsonb_typeof(p) is distinct from 'array' or jsonb_array_length(p)>p_max then raise exception 'application_result_screening';end if;
 for x in select value from jsonb_array_elements(p) loop
  if not person_private.application_result_keys(x,array['question','answer','evidence'],array['question','answer','evidence']) or jsonb_typeof(x->'question')<>'string' or jsonb_typeof(x->'answer')<>'string' or x->>'answer' not in ('yes','no','unclear') or jsonb_typeof(x->'evidence')<>'string' then raise exception 'application_result_screening';end if;
 end loop;
end$$;
create function person_private.application_result_scorecard(p jsonb) returns void language plpgsql immutable set search_path='' as $$
declare x jsonb;k text;s jsonb:=p->'stack';y jsonb:=p->'years';sen jsonb:=p->'seniority';
begin
 if not person_private.application_result_keys(p,array['tier','reason','stack','years','seniority','gaps'],array['tier','reason','stack','years','seniority','gaps']) or jsonb_typeof(p->'tier')<>'string' or p->>'tier' not in ('STRONG','POSSIBLE','WEAK') or jsonb_typeof(p->'reason')<>'string' then raise exception 'application_result_screening';end if;
 if not person_private.application_result_keys(s,array['items','matched','total'],array['items','matched','total']) or jsonb_typeof(s->'items')<>'array' or jsonb_array_length(s->'items')>12 or jsonb_typeof(s->'matched')<>'number' or jsonb_typeof(s->'total')<>'number' then raise exception 'application_result_screening';end if;
 for x in select value from jsonb_array_elements(s->'items') loop
  if not person_private.application_result_keys(x,array['term','evidenced'],array['term','evidenced','years','source']) or jsonb_typeof(x->'term')<>'string' or jsonb_typeof(x->'evidenced')<>'boolean' or (x ? 'years' and (jsonb_typeof(x->'years')<>'number' or (x->>'years')::numeric<0)) or (x ? 'source' and (jsonb_typeof(x->'source')<>'string' or x->>'source' not in ('dated','listed','resume'))) then raise exception 'application_result_screening';end if;
 end loop;
 if (s->>'total')::numeric<>jsonb_array_length(s->'items') or (s->>'matched')::numeric<>(select count(*) from jsonb_array_elements(s->'items') items(item) where item->'evidenced'='true') then raise exception 'application_result_screening';end if;
 if not person_private.application_result_keys(y,array['required','actual','met'],array['required','actual','met']) or jsonb_typeof(y->'met') not in ('boolean','null') then raise exception 'application_result_screening';end if;
 foreach k in array array['required','actual'] loop
  if jsonb_typeof(y->k) not in ('number','null') or (y->>k)::numeric<0 then raise exception 'application_result_screening';end if;
 end loop;
 if not person_private.application_result_keys(sen,array['level','signals'],array['level','signals']) or jsonb_typeof(sen->'level')<>'string' or sen->>'level' not in ('staff+','senior','mid','junior','unknown') then raise exception 'application_result_screening';end if;
 perform person_private.application_result_answers(sen->'signals',4);
 if jsonb_typeof(p->'gaps')<>'array' or jsonb_array_length(p->'gaps')>100 or exists(select 1 from jsonb_array_elements(p->'gaps') gaps(item) where jsonb_typeof(item)<>'string') then raise exception 'application_result_screening';end if;
end$$;
create function person_private.application_result_validate(p jsonb,p_org uuid) returns void language plpgsql security definer set search_path='' as $$
declare tenant boolean:=p_org<>'801865a7-6533-41d2-9c45-e4a90e6ad51a';allowed text[]:=array['version','matched_role_ids','screening'];x jsonb;y jsonb;role_id text;k text;
begin
 if tenant then allowed:=allowed||array['name','harvest_profile','parsed_profile','resume_text','resume_contacts'];end if;
 if p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>2097152 or p->'version' is distinct from '1'::jsonb or not p ?& allowed or exists(select 1 from jsonb_object_keys(p) key where not key=any(allowed)) then raise exception 'application_result_shape';end if;
 if jsonb_typeof(p->'matched_role_ids')<>'array' or jsonb_array_length(p->'matched_role_ids')>(case when tenant then 5 else 10 end) then raise exception 'application_result_matches';end if;
 if p->'screening'<>'null' and (jsonb_typeof(p->'screening')<>'array' or jsonb_array_length(p->'screening')>5) then raise exception 'application_result_screening';end if;
 for x in select value from jsonb_array_elements(p->'matched_role_ids') loop
  if jsonb_typeof(x)<>'string' or length(x#>>'{}') not between 1 and 160 then raise exception 'application_result_matches';end if;
 end loop;
 if (select count(*)<>count(distinct value) from jsonb_array_elements(p->'matched_role_ids')) then raise exception 'application_result_matches';end if;
 for x in select value from jsonb_array_elements(case when p->'screening'='null' then '[]'::jsonb else p->'screening' end) loop
  if jsonb_typeof(x)<>'object' or not x ?& array['job_id','qualified','fit_score','answers','cached'] or exists(select 1 from jsonb_object_keys(x) key where not key=any(array['job_id','qualified','fit_score','answers','cached','scorecard','inferred_signals'])) or
   jsonb_typeof(x->'job_id')<>'string' or length(x->>'job_id') not between 1 and 160 or jsonb_typeof(x->'qualified')<>'boolean' or jsonb_typeof(x->'cached')<>'boolean' or jsonb_typeof(x->'fit_score')<>'number' or (x->>'fit_score')::numeric not between 0 and 1 or jsonb_typeof(x->'answers')<>'array' or jsonb_array_length(x->'answers')>100 or octet_length(x::text)>262144 then raise exception 'application_result_screening';end if;
  perform person_private.application_result_answers(x->'answers',100);
  if x ? 'scorecard' then perform person_private.application_result_scorecard(x->'scorecard');end if;
  if x ? 'inferred_signals' and (jsonb_typeof(x->'inferred_signals')<>'array' or jsonb_array_length(x->'inferred_signals')>3) then raise exception 'application_result_screening';end if;
  for y in select value from jsonb_array_elements(coalesce(x->'inferred_signals','[]')) loop
   if not person_private.application_result_keys(y,array['signal','basis','probe'],array['signal','basis','probe']) or jsonb_typeof(y->'signal')<>'string' or jsonb_typeof(y->'basis')<>'string' or jsonb_typeof(y->'probe')<>'string' then raise exception 'application_result_screening';end if;
  end loop;
 end loop;
 for role_id in select value#>>'{}' from jsonb_array_elements(p->'matched_role_ids') union select value->>'job_id' from jsonb_array_elements(case when p->'screening'='null' then '[]'::jsonb else p->'screening' end) loop
  perform 1 from public.org_roles where organization_id=p_org and external_id=role_id for share;
  if not found then
   if tenant then raise exception 'application_result_role';end if;
   perform 1 from public.site_role_embeddings where job_id=role_id for share;
   if not found then raise exception 'application_result_role';end if;
  end if;
 end loop;
 if tenant then
  if jsonb_typeof(p->'name')<>'string' or length(p->>'name')>500 or jsonb_typeof(p->'harvest_profile') not in ('object','null') or jsonb_typeof(p->'parsed_profile') not in ('object','null') or jsonb_typeof(p->'resume_text') not in ('string','null') or length(p->>'resume_text')>60000 then raise exception 'application_result_profile';end if;
  x:=p->'resume_contacts';
  if jsonb_typeof(x)<>'object' or not x ?& array['phone','emails'] or exists(select 1 from jsonb_object_keys(x) key where key not in ('phone','emails')) or jsonb_typeof(x->'phone') not in ('string','null') or length(x->>'phone')>40 or jsonb_typeof(x->'emails')<>'array' or jsonb_array_length(x->'emails')>200 then raise exception 'application_result_contact';end if;
  if nullif(p->>'resume_text','') is null and (x->'phone'<>'null' or jsonb_array_length(x->'emails')>0) then raise exception 'application_result_contact';end if;
  if x->'phone'<>'null' and ((x->>'phone') !~ '^[0-9[:space:]()+.#extEXT-]+$' or length(regexp_replace(x->>'phone','[^0-9]','','g')) not between 9 and 21) then raise exception 'application_result_contact';end if;
  for y in select value from jsonb_array_elements(x->'emails') loop
   if jsonb_typeof(y)<>'string' or length(y#>>'{}')>160 or (y#>>'{}') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'application_result_contact';end if;
  end loop;
 end if;
end$$;

create function person_private.application_completion_proof(p_work uuid) returns person_private.application_completions language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare c person_private.application_completions;a person_private.application_work;w person_private.transition_work;ready person_private.application_intake_ready;b person_private.application_candidates;t person_private.tenant_application_bindings;r public.person_application_receipts;
begin
 select * into c from person_private.application_completions where work_id=p_work;
 select * into a from person_private.application_work where work_id=p_work;select * into w from person_private.transition_work where id=p_work;
 if c.work_id is null or a.work_id is null or w.id is null or w.family<>'application' or c.application_id<>a.application_id or c.organization_id<>a.organization_id or c.input_hash<>a.input_hash or w.organization_id<>a.organization_id or w.resource_key<>a.application_id::text or w.input_hash<>a.input_hash or c.input_hash<>person_private.intake_hash(a.input_snapshot) then raise exception 'application_completion_required';end if;
 -- A caller may have read ownership before waiting for the work lock. Historical
 -- result proof survives edits, but completion cannot cross the current tenant.
 perform 1 from public.website_applications where id=a.application_id and organization_id=a.organization_id for share;
 if not found then raise exception 'application_scope';end if;
 if c.proof_kind='tt_ready' then
  select * into ready from person_private.application_intake_ready where work_id=p_work;
  select * into b from person_private.application_candidates where work_id=p_work;
  select * into r from public.person_application_receipts where application_id=a.application_id;
  if a.organization_id<>'801865a7-6533-41d2-9c45-e4a90e6ad51a' or ready.work_id is null or b.work_id is null or r.application_id is null or c.person_key<>b.candidate_id or r.candidate_id<>b.candidate_id or ready.candidate_id<>b.candidate_id or ready.application_id<>a.application_id or c.proof_hash<>person_private.intake_hash(to_jsonb(ready)) then raise exception 'application_completion_required';end if;
  perform person_private.intake_ready_proof(ready,jsonb_build_object('work_id',p_work,'application_id',a.application_id,'candidate_id',b.candidate_id,'receipt',to_jsonb(r)));
 else
  select * into t from person_private.tenant_application_bindings where work_id=p_work;
  if a.organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a' or t.work_id is null or t.application_id<>a.application_id or t.organization_id<>a.organization_id or t.input_hash<>a.input_hash or t.person_application_id<>c.person_key or c.proof_hash<>person_private.intake_hash(to_jsonb(t)) then raise exception 'application_completion_required';end if;
 end if;
 return c;
end$$;

create function public.person_application_work_complete(p_result jsonb) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare headers jsonb;wid text;token text;w person_private.transition_work;a person_private.application_work;c person_private.application_completions;ready person_private.application_intake_ready;b person_private.application_candidates;t person_private.tenant_application_bindings;r public.person_application_receipts;
 app public.website_applications;target public.website_applications;saved public.website_applications;linked record;tenant boolean;person uuid;proof jsonb;kind text;contact jsonb;known text[]:='{}';has_phone boolean;extra text;current_input jsonb;receipt jsonb;before_row jsonb;after_row jsonb;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'application_isolation';end if;
 headers:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}');wid:=coalesce(nullif(current_setting('person.work_id',true),''),headers->>'x-person-work-id');token:=coalesce(nullif(current_setting('person.work_token',true),''),headers->>'x-person-work-token');
 if wid is null or token is null or wid !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' or token !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then raise exception 'transition_admission';end if;
 w:=person_private.transition_owned(wid::uuid,token::uuid);
 if w.status='completed' then
  c:=person_private.application_completion_proof(w.id);
  if c.result_payload_hash is distinct from person_private.intake_hash(p_result) then raise exception 'application_result_replay';end if;
  return jsonb_build_object('status','completed','work_id',w.id);
 end if;
 tenant:=w.organization_id<>'801865a7-6533-41d2-9c45-e4a90e6ad51a';
 if tenant then
  a:=person_private.tenant_application_context();select * into t from person_private.tenant_application_bindings where work_id=w.id;
  if t.work_id is null then raise exception 'application_completion_binding';end if;
  -- Take UPDATE strength before calling the binder's current-row SHARE read.
  perform pg_advisory_xact_lock(72008,hashtext(a.organization_id::text||':'||coalesce(nullif(a.input_snapshot->>'linkedin_username',''),'app:'||a.application_id::text)));
  select * into app from public.website_applications where id=a.application_id for update;
  perform public.person_application_tenant_bind();person:=t.person_application_id;proof:=to_jsonb(t);kind:='tenant_binding';
 else
  a:=person_private.application_context();perform pg_advisory_xact_lock(72007,hashtext(a.input_snapshot->>'linkedin_username'));
  select * into app from public.website_applications where id=a.application_id for update;
  perform person_private.application_source_context();select * into b from person_private.application_candidates where work_id=w.id;select * into ready from person_private.application_intake_ready where work_id=w.id;select * into r from public.person_application_receipts where application_id=a.application_id;
  if b.work_id is null or ready.work_id is null or r.application_id is null or b.application_id<>a.application_id or ready.application_id<>a.application_id or b.candidate_id<>r.candidate_id or b.candidate_id<>ready.candidate_id then raise exception 'application_completion_ready';end if;
  perform pg_advisory_xact_lock(hashtext(b.candidate_id::text));perform 1 from public.candidates where id=b.candidate_id for share;if not found then raise exception 'application_completion_ready';end if;
  perform person_private.intake_ready_proof(ready,jsonb_build_object('work_id',w.id,'application_id',a.application_id,'candidate_id',b.candidate_id,'receipt',to_jsonb(r)));
  person:=b.candidate_id;proof:=to_jsonb(ready);kind:='tt_ready';receipt:=r.application_snapshot;
 end if;
 if app.id is null or app.organization_id is distinct from a.organization_id or app.source='transformer_talent' then raise exception 'application_completion_input';end if;
 current_input:=person_private.application_work_input(to_jsonb(app));
 -- Contact edits are merged/preserved, never overwritten from the accepted copy.
 if current_input-array['name','contact'] is distinct from a.input_snapshot-array['name','contact'] then raise exception 'application_completion_input';end if;
 perform person_private.application_result_validate(p_result,a.organization_id);target:=app;
 if tenant then
  if app.name is distinct from a.input_snapshot->>'name' or (app.candidate_id is not null and app.candidate_id<>person) then raise exception 'application_completion_input';end if;
  target.name:=case when nullif(a.input_snapshot->>'name','') is not null then a.input_snapshot->>'name' else p_result->>'name' end;
  target.harvest_profile:=nullif(p_result->'harvest_profile','null');target.parsed_profile:=nullif(p_result->'parsed_profile','null');target.resume_text:=p_result->>'resume_text';
  contact:=coalesce(app.contact,'{}');if jsonb_typeof(contact)<>'object' then raise exception 'application_result_contact';end if;
  has_phone:=nullif(btrim(contact->>'phone'),'') is not null;known:=array[lower(app.email),lower(contact->>'email')];
  if contact ? 'otherEmails' and jsonb_typeof(contact->'otherEmails') not in ('array','null') then raise exception 'application_result_contact';end if;
  known:=known||array(select lower(value#>>'{}') from jsonb_array_elements(coalesce(nullif(contact->'otherEmails','null'),'[]')));
  -- Preserve every matching linked contact; no sourced write or identity merge.
  for linked in select sc.id,sc.contact from public.sourced_candidates sc where sc.organization_id=a.organization_id and sc.linkedin_username=nullif(a.input_snapshot->>'linkedin_username','') order by sc.id for share loop
   if linked.contact is not null and jsonb_typeof(linked.contact)<>'object' then raise exception 'application_result_contact';end if;
   has_phone:=has_phone or nullif(btrim(linked.contact->>'phone'),'') is not null;
   known:=known||lower(linked.contact->>'email')||array(select lower(value#>>'{}') from jsonb_array_elements(coalesce(nullif(linked.contact->'otherEmails','null'),'[]')));
  end loop;
  if not has_phone and p_result->'resume_contacts'->'phone'<>'null' then contact:=jsonb_set(contact,'{phone}',p_result->'resume_contacts'->'phone');end if;
  select value#>>'{}' into extra from jsonb_array_elements(p_result->'resume_contacts'->'emails') with ordinality x(value,n) where not exists(select 1 from unnest(known) v where v=lower(value#>>'{}')) order by n limit 1;
  if extra is not null and jsonb_array_length(coalesce(nullif(contact->'otherEmails','null'),'[]'))<8 then contact:=jsonb_set(contact,'{otherEmails}',coalesce(nullif(contact->'otherEmails','null'),'[]')||jsonb_build_array(extra));end if;
  target.contact:=case when contact='{}' and app.contact is null then null else contact end;
 else
  if app.candidate_id is distinct from person or app.pool_created_person is distinct from r.created_person or app.name is distinct from receipt->>'name' or app.parsed_profile is distinct from nullif(receipt->'parsed_profile','null') or app.resume_text is distinct from receipt->>'resume_text' or (app.harvest_profile is not null and app.harvest_profile is distinct from nullif(receipt->'harvest_profile','null')) then raise exception 'application_completion_input';end if;
  target.harvest_profile:=nullif(receipt->'harvest_profile','null');
 end if;
 target.candidate_id:=person;target.matched_role_ids:=array(select value#>>'{}' from jsonb_array_elements(p_result->'matched_role_ids'));target.screening:=nullif(p_result->'screening','null');target.status:='processed';
 if tenant then perform person_private.tenant_application_context();else perform person_private.application_context();end if;
 before_row:=to_jsonb(app);after_row:=to_jsonb(target);
 insert into person_private.application_result_frames values(pg_backend_pid(),pg_current_xact_id(),w.id,a.application_id,before_row,after_row);
 if not tenant then perform person_private.intake_frame_open(w.id,a.application_id,person,'finalize',before_row,after_row);end if;
 update public.website_applications set candidate_id=target.candidate_id,name=target.name,contact=target.contact,harvest_profile=target.harvest_profile,parsed_profile=target.parsed_profile,resume_text=target.resume_text,matched_role_ids=target.matched_role_ids,screening=target.screening,status=target.status where id=a.application_id and organization_id=a.organization_id returning * into saved;
 if not found or to_jsonb(saved)-'updated_at' is distinct from after_row-'updated_at' then raise exception 'application_result_actual';end if;
 if not tenant then perform person_private.intake_frame_clear();end if;
 delete from person_private.application_result_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if tenant then perform person_private.tenant_application_context();else perform person_private.application_context();end if;
 insert into person_private.application_completions values(w.id,a.application_id,a.organization_id,a.input_hash,person,kind,person_private.intake_hash(proof),person_private.intake_hash(p_result),person_private.intake_hash(person_private.application_result_fields(to_jsonb(saved))),pg_current_xact_id(),clock_timestamp());
 perform person_private.application_completion_proof(w.id);
 if tenant then perform person_private.tenant_application_context();else perform person_private.application_context();end if;
 update person_private.transition_work set status='completed',finished_at=clock_timestamp() where id=w.id returning * into w;
 if not found or w.status<>'completed' or w.finished_at is null then raise exception 'application_completion_actual';end if;
 if w.lease_until<=clock_timestamp() then raise exception 'transition_expired';end if;
 return jsonb_build_object('status','completed','work_id',w.id);
end$$;

-- All direct/public lifecycle routes must consume the same private witness.
create or replace function person_private.application_work_finish(p_id uuid,p_token uuid,p_outcome text) returns jsonb language plpgsql security definer set search_path='' as $$
declare a person_private.application_work;w person_private.transition_work;
begin
 if p_outcome is null or p_outcome not in ('completed','uncertain') then raise exception 'transition_input';end if;
 w:=person_private.transition_owned(p_id,p_token);
 if w.status='completed' then
  perform person_private.application_completion_proof(p_id);
  if p_outcome<>'completed' then raise exception 'transition_state';end if;
  return jsonb_build_object('status','completed','work_id',p_id);
 end if;
 if p_outcome='completed' then raise exception 'application_completion_required';end if;
 a:=person_private.application_work_owned(p_id,p_token);if a.effects_started_at is null then raise exception 'application_effects_required';end if;
 update person_private.transition_work set status='uncertain',finished_at=clock_timestamp() where id=p_id;
 return jsonb_build_object('status','uncertain','work_id',p_id);
end$$;
do $$declare body text;needle text:='   return result;';begin
 body:=pg_get_functiondef('person_private.application_work_claim(uuid,uuid,uuid,integer,text)'::regprocedure);
 if array_length(string_to_array(body,needle),1)<>2 then raise exception 'application_claim_definition';end if;
 body:=replace(body,needle,'   if result->>''status''=''completed'' then perform person_private.application_completion_proof((result->>''work_id'')::uuid);end if;'||chr(10)||needle);execute body;
end$$;
revoke all on function person_private.application_result_fields(jsonb),person_private.application_result_guard(),person_private.application_result_validate(jsonb,uuid),person_private.application_completion_proof(uuid) from public,anon,authenticated,service_role;
revoke all on function person_private.application_result_keys(jsonb,text[],text[]),person_private.application_result_answers(jsonb,integer),person_private.application_result_scorecard(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.person_application_work_complete(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.person_application_work_complete(jsonb) to service_role;
