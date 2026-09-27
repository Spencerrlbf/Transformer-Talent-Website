-- PREPARED ONLY. Checked TT intake; workflow completion/source admission follows.
set local lock_timeout='2s';set local statement_timeout='30s';
create table person_private.intake_mutation_frames(backend_pid integer not null,transaction_id xid8 not null,work_id uuid not null,application_id uuid not null,candidate_id uuid not null,kind text not null,before_row jsonb,after_row jsonb not null,primary key(backend_pid,transaction_id));
create table person_private.intake_metadata_witnesses(operation_id uuid primary key references person_private.application_audit_operations(operation_id),work_id uuid not null,candidate_id uuid not null,receipt_hash text not null,before_resume_hash text not null,after_resume_hash text not null,matching_text_hash text,vector_hash text,after_metadata_hash text not null);
alter table person_private.intake_mutation_frames enable row level security;alter table person_private.intake_metadata_witnesses enable row level security;
revoke all on person_private.intake_mutation_frames,person_private.intake_metadata_witnesses from public,anon,authenticated,service_role;
create function person_private.intake_frame_open(p_work uuid,p_application uuid,p_candidate uuid,p_kind text,p_before jsonb,p_after jsonb) returns void language sql security definer set search_path='' as $$insert into person_private.intake_mutation_frames values(pg_backend_pid(),pg_current_xact_id(),p_work,p_application,p_candidate,p_kind,p_before,p_after)$$;
create function person_private.intake_frame_clear() returns void language sql security definer set search_path='' as $$delete from person_private.intake_mutation_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()$$;
create function person_private.intake_mutation_guard() returns trigger language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare f person_private.intake_mutation_frames;p person_private.application_projection_frames;o jsonb:=to_jsonb(old);n jsonb:=to_jsonb(new);k text;
begin
 if not person_private.normalization_required() then return coalesce(new,old);end if;
 if tg_table_name='website_applications' then
  if o->>'organization_id' is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a' and n->>'organization_id' is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a' then return new;end if;
  select * into f from person_private.intake_mutation_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
  if f.backend_pid is null and not exists(select 1 from unnest(array['candidate_id','pool_created_person','parsed_profile','resume_text','name','contact']) key where o->key is distinct from n->key) then return new;end if;
  if f.kind is distinct from 'finalize' or f.application_id<>new.id or (f.before_row-'updated_at') is distinct from (o-'updated_at') or (f.after_row-'updated_at') is distinct from (n-'updated_at') then raise exception 'application_finalize_frame';end if;return new;
 end if;
 if tg_op='DELETE' then raise exception 'candidate_mutation_delete';end if;
 select * into f from person_private.intake_mutation_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if f.candidate_id=new.id then
  if tg_op='INSERT' and f.kind='seed' then
   if not n @> f.after_row or exists(select 1 from jsonb_each(n) x where not f.after_row ? x.key and x.key not in ('created_at','updated_at') and x.value not in ('null'::jsonb,'[]'::jsonb,'{}'::jsonb,'""'::jsonb) and not (x.key='embedding_type' and x.value='"unknown"'::jsonb) and not (x.key='linkedin_enrichment_status' and x.value='"not_applicable"'::jsonb) and not (x.key='open_profile' and x.value='false'::jsonb)) then raise exception 'candidate_seed_fields';end if;return new;
  elsif tg_op='UPDATE' and f.kind in ('details','preferences') and old.id=f.candidate_id and f.before_row-'updated_at'=o-'updated_at' and f.after_row-'updated_at'=n-'updated_at' then return new;
  end if;
 end if;
 if f.backend_pid is not null then raise exception 'candidate_mutation_frame';end if;
 if tg_op='UPDATE' then
  select * into p from person_private.application_projection_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
  if p.candidate_id=new.id and old.id=new.id and person_private.projection_profile(o)=p.before_profile and person_private.projection_profile(n)=p.after_profile then
   for k in select jsonb_object_keys(p.before_profile) loop o:=o-k;n:=n-k;end loop;
   if o-'updated_at'=n-'updated_at' then return new;end if;
  end if;
  if p.backend_pid is null and o=n then return new;end if;
 end if;
 raise exception 'candidate_mutation_frame';
end$$;
create trigger person_intake_mutation before insert or update or delete on public.candidates for each row execute function person_private.intake_mutation_guard();
create trigger person_intake_application_finalize before update on public.website_applications for each row execute function person_private.intake_mutation_guard();
-- Recheck the final row after every BEFORE trigger has run. No late trigger can
-- expand the permitted mutation; the synchronous frame is still open here.
create trigger person_intake_mutation_after after insert or update or delete on public.candidates for each row execute function person_private.intake_mutation_guard();
create trigger person_intake_application_finalize_after after update on public.website_applications for each row execute function person_private.intake_mutation_guard();
create trigger person_intake_no_truncate before truncate on public.candidates for each statement execute function person_private.audit_proof_no_truncate();
revoke truncate on public.candidates from public,anon,authenticated,service_role;
-- The existing checked binder alone opens the minimal seed frame. Preserve its
-- identity resolution and deferred receipt/source completeness unchanged.
do $$declare body text;needle text:='   insert into public.candidates(id,full_name,first_name,last_name,linkedin_username,linkedin_url,source,status)';begin
 body:=pg_get_functiondef('public.person_application_candidate_bind(uuid,text)'::regprocedure);
 if array_length(string_to_array(body,needle),1)<>2 then raise exception 'application_binding_definition';end if;
 body:=replace(body,needle,'   perform person_private.intake_frame_open(a.work_id,a.application_id,cid,''seed'',null,jsonb_build_object(''id'',cid,''full_name'',name,''first_name'',(regexp_split_to_array(name,''\s+''))[1],''last_name'',nullif(array_to_string((regexp_split_to_array(name,''\s+''))[2:2147483647],'' ''),''''),''linkedin_username'',username,''linkedin_url'',person_private.application_identity_url(username),''source'',''website_applicant'',''status'',''applicant''));'||chr(10)||needle);
 body:=replace(body,'   created:=true;inserted:=true;','   perform person_private.intake_frame_clear();created:=true;inserted:=true;');execute body;
end$$;

create function person_private.intake_mutation_context(p_operation uuid) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare a person_private.application_work;b person_private.application_candidates;r public.person_application_receipts;p person_private.application_audit_operations;o public.person_audit_operations;d jsonb;s jsonb;sid uuid;n integer:=0;
begin
 a:=person_private.application_source_context();select * into b from person_private.application_candidates where work_id=a.work_id;
 select * into p from person_private.application_audit_operations where operation_id=p_operation;select * into o from public.person_audit_operations where id=p_operation;
 if b.work_id is null or p.operation_id is null or p.work_id<>a.work_id or p.candidate_id<>b.candidate_id or p.transaction_id<>pg_current_xact_id() or o.transaction_id is distinct from p.transaction_id or o.candidate_id<>b.candidate_id or o.writer<>'application' or o.receipt_ref<>'application:'||a.application_id::text then raise exception 'intake_mutation_operation';end if;
 perform pg_advisory_xact_lock(hashtext(b.candidate_id::text));perform 1 from public.candidates where id=b.candidate_id for update;perform person_private.application_context();
 if exists(select 1 from public.person_source_holds where candidate_id=b.candidate_id and resolved_at is null) then raise exception 'audit_source_hold';end if;
 select * into r from public.person_application_receipts where application_id=a.application_id and candidate_id=b.candidate_id and created_person=b.created_person;
 if r.application_id is null or not exists(select 1 from public.candidate_profile_state where candidate_id=b.candidate_id) or jsonb_array_length(r.documents) is distinct from (case when r.harvest_ledger_id is null then 2 else 3 end) then raise exception 'intake_mutation_receipt';end if;
 for d in select value from jsonb_array_elements(r.documents) loop
  n:=n+1;s:=d->'source';
  if d->>'candidate_id' is distinct from b.candidate_id::text or s->>'parser_version' is distinct from 'person-v3' then raise exception 'intake_mutation_receipt';end if;
  select id into sid from public.candidate_sources where candidate_id=b.candidate_id and source=s->>'source' and provider is not distinct from s->>'provider' and source_ref is not distinct from s->>'source_ref' and payload_hash=s->>'payload_hash' and parser_version=s->>'parser_version' and fetched_at=(s->>'fetched_at')::timestamptz and raw_in=s->>'raw_in' and enrichment_id is not distinct from nullif(s->>'enrichment_id','')::uuid;
  if not found or (n=1 and not exists(select 1 from public.candidate_identities where candidate_id=b.candidate_id and kind='tt_application_id' and value=a.application_id::text and source_id=sid)) then raise exception 'intake_mutation_receipt';end if;
 end loop;
 return jsonb_build_object('work_id',a.work_id,'application_id',a.application_id,'candidate_id',b.candidate_id,'created',b.created_person,'first',b.transaction_id=pg_current_xact_id(),'receipt',to_jsonb(r));
end$$;
-- Match JavaScript UTF-16 units without losing a half-surrogate at a slice bound.
create function person_private.utf16_unit(p_value integer) returns bytea language sql immutable set search_path='' as $$select decode(lpad(to_hex(p_value & 255),2,'0')||lpad(to_hex(p_value >> 8),2,'0'),'hex')$$;
create function person_private.utf16_bytes(p_value text) returns bytea language sql immutable set search_path='' as $$
 select coalesce(string_agg(case when ascii(ch)>65535 then person_private.utf16_unit(55296+((ascii(ch)-65536)>>10))||person_private.utf16_unit(56320+((ascii(ch)-65536)&1023)) else person_private.utf16_unit(ascii(ch)) end,''::bytea order by n),''::bytea) from regexp_split_to_table(coalesce(p_value,''),'') with ordinality x(ch,n) where ch<>''
$$;
create function person_private.resume_utf16_prefix(p_value text) returns text language sql immutable set search_path='' as $$
 select coalesce(string_agg(case when units<=50000 then ch when prior<50000 then chr(65533) else '' end,'' order by n),'') from (
 select ch,n,sum(case when ascii(ch)>65535 then 2 else 1 end) over(order by n) units,coalesce(sum(case when ascii(ch)>65535 then 2 else 1 end) over(order by n rows between unbounded preceding and 1 preceding),0) prior from regexp_split_to_table(left(p_value,50000),'') with ordinality x(ch,n) where ch<>'') x where prior<50000
$$;
create function person_private.application_matching_units(p_profile jsonb,p_resume text) returns bytea language plpgsql immutable set search_path='' as $$
declare value text;
begin
 value:=nullif(p_profile->>'profile_summary','');
 if value is null then value:=nullif(concat_ws(' ',nullif(p_profile->>'current_title',''),case when nullif(p_profile->>'current_company','') is not null then 'at '||(p_profile->>'current_company') end),'');end if;
 if value is not null then return person_private.utf16_bytes(value);end if;
 return substring(person_private.utf16_bytes(left(coalesce(p_resume,''),2000)) from 1 for 4000);
end$$;
create function person_private.intake_metadata_hash(p_row jsonb) returns text language sql immutable set search_path='' as $$
 select encode(sha256(convert_to(jsonb_build_array(p_row->'resume_text',p_row->'total_experience_years',p_row->'matching_embedding',p_row->'embedding_type')::text,'UTF8')),'hex')
$$;
create function public.person_application_candidate_details(p_operation uuid,p_mode text,p_vector jsonb default null,p_text_hash text default null) returns void language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare ctx jsonb;receipt jsonb;snapshot jsonb;c public.candidates;target public.candidates;saved public.candidates;patch jsonb:='{}';before_row jsonb;after_row jsonb;text_hash text;years numeric;witness person_private.intake_metadata_witnesses;
begin
 ctx:=person_private.intake_mutation_context(p_operation);receipt:=ctx->'receipt';snapshot:=receipt->'application_snapshot';
 if p_mode is null or p_mode not in ('shadow','live') then raise exception 'intake_mutation_mode';end if;
 select * into strict c from public.candidates where id=(ctx->>'candidate_id')::uuid;before_row:=to_jsonb(c);
 if (ctx->>'first')::boolean then
  if (ctx->>'created')::boolean and jsonb_typeof(snapshot->'parsed_profile'->'total_experience_years')='number' then
   years:=(snapshot->'parsed_profile'->>'total_experience_years')::numeric;
   if years>=0 and trunc(years)=years then patch:=patch||jsonb_build_object('total_experience_years',years::integer);end if;
  end if;
  if nullif(c.resume_text,'') is null and nullif(snapshot->>'resume_text','') is not null then patch:=patch||jsonb_build_object('resume_text',person_private.resume_utf16_prefix(snapshot->>'resume_text'));end if;
  target:=jsonb_populate_record(c,patch);
  text_hash:=encode(sha256(person_private.application_matching_units(to_jsonb(target),target.resume_text)),'hex');
  if p_vector is not null and (p_mode='live' or (ctx->>'created')::boolean) and c.matching_embedding is null and p_text_hash=text_hash and p_text_hash=encode(sha256(person_private.application_matching_units(snapshot->'parsed_profile',snapshot->>'resume_text')),'hex') then
   if jsonb_typeof(p_vector)<>'array' or jsonb_array_length(p_vector)<>1536 or exists(select 1 from jsonb_array_elements(p_vector) v where jsonb_typeof(v)<>'number') then raise exception 'person_intake_vector';end if;
   -- Field input uses the actual candidates type, independent of extension schema.
   patch:=patch||jsonb_build_object('matching_embedding',p_vector::text,'embedding_type','website_applicant');
  end if;
  target:=jsonb_populate_record(c,patch);after_row:=to_jsonb(target);
  select * into witness from person_private.intake_metadata_witnesses where operation_id=p_operation;
  if found then
   if witness.work_id is distinct from (ctx->>'work_id')::uuid or witness.candidate_id<>c.id or witness.receipt_hash is distinct from encode(sha256(convert_to(receipt::text,'UTF8')),'hex') or witness.after_metadata_hash is distinct from person_private.intake_metadata_hash(before_row) or witness.after_metadata_hash is distinct from person_private.intake_metadata_hash(after_row) then raise exception 'intake_metadata_replay';end if;
   perform person_private.application_context();return;
  end if;
  if before_row<>after_row then
   perform person_private.intake_frame_open((ctx->>'work_id')::uuid,(ctx->>'application_id')::uuid,c.id,'details',before_row,after_row);
   update public.candidates set total_experience_years=target.total_experience_years,resume_text=target.resume_text,matching_embedding=target.matching_embedding,embedding_type=target.embedding_type where id=c.id returning * into saved;
   if not found or to_jsonb(saved)-'updated_at' is distinct from after_row-'updated_at' then raise exception 'intake_metadata_write';end if;
   perform person_private.intake_frame_clear();
  end if;
  insert into person_private.intake_metadata_witnesses values(p_operation,(ctx->>'work_id')::uuid,c.id,encode(sha256(convert_to(receipt::text,'UTF8')),'hex'),encode(sha256(convert_to(coalesce(c.resume_text,''),'UTF8')),'hex'),encode(sha256(convert_to(coalesce(target.resume_text,''),'UTF8')),'hex'),text_hash,case when target.matching_embedding is not null then encode(sha256(convert_to(target.matching_embedding::text,'UTF8')),'hex') end,person_private.intake_metadata_hash(after_row));
 end if;
 perform person_private.application_context();
exception when others then perform person_private.intake_frame_clear();raise;
end$$;
create function public.person_application_finalize(p_operation uuid) returns void language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare ctx jsonb;r jsonb;s jsonb;app public.website_applications;target public.website_applications;boundary bigint;eid bigint;
begin
 ctx:=person_private.intake_mutation_context(p_operation);r:=ctx->'receipt';s:=r->'application_snapshot';
 select * into strict app from public.website_applications where id=(ctx->>'application_id')::uuid for update;
 target:=jsonb_populate_record(app,jsonb_build_object('candidate_id',ctx->>'candidate_id','pool_created_person',(ctx->>'created')::boolean,'parsed_profile',s->'parsed_profile','resume_text',s->'resume_text','name',s->'name','contact',s->'contact'));
 select coalesce(max(id),0) into boundary from public.person_change_events where candidate_id=(ctx->>'candidate_id')::uuid;
 perform person_private.intake_frame_open((ctx->>'work_id')::uuid,app.id,(ctx->>'candidate_id')::uuid,'finalize',to_jsonb(app),to_jsonb(target));
 update public.website_applications set candidate_id=target.candidate_id,pool_created_person=target.pool_created_person,parsed_profile=target.parsed_profile,resume_text=target.resume_text,name=target.name,contact=target.contact where id=app.id;
 perform person_private.intake_frame_clear();
 select id into strict eid from public.person_change_events where candidate_id=target.candidate_id and source_table='website_applications' and source_row_id=app.id::text and transaction_id=pg_current_xact_id() and id>boundary;
 perform person_private.attribute_change(eid,p_operation,'application_finalize');perform person_private.application_context();
exception when others then perform person_private.intake_frame_clear();raise;
end$$;
create function public.person_application_preferences(p_operation uuid) returns void language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare ctx jsonb;s jsonb;c public.candidates;target public.candidates;boundary bigint;eid bigint;
begin
 ctx:=person_private.intake_mutation_context(p_operation);s:=ctx->'receipt'->'application_snapshot';
 if s->>'source' is distinct from 'future' or nullif(s->>'person_intent_hash','') is null or nullif(s->>'follow_up_at','') is null then return;end if;
 if not person_private.application_preference_witness((ctx->>'application_id')::uuid,s) then return;end if;
 select * into strict c from public.candidates where id=(ctx->>'candidate_id')::uuid;
 target:=jsonb_populate_record(c,jsonb_build_object('follow_up_at',s->'follow_up_at','role_preferences',jsonb_build_object('roles',coalesce(s->'preferred_roles','[]'),'locations',coalesce(s->'preferred_locations','[]'),'workplace',coalesce(s->'preferred_workplace','[]'),'salary',s->'comp_expectation'),'visa_status',coalesce(nullif(s->>'visa_status',''),c.visa_status)));
 select coalesce(max(id),0) into boundary from public.person_change_events where candidate_id=c.id;
 perform person_private.intake_frame_open((ctx->>'work_id')::uuid,(ctx->>'application_id')::uuid,c.id,'preferences',to_jsonb(c),to_jsonb(target));
 update public.candidates set follow_up_at=target.follow_up_at,role_preferences=target.role_preferences,visa_status=target.visa_status where id=c.id;
 perform person_private.intake_frame_clear();
 select id into strict eid from public.person_change_events where candidate_id=c.id and source_table='candidates' and source_row_id=c.id::text and transaction_id=pg_current_xact_id() and id>boundary;
 perform person_private.attribute_change(eid,p_operation,'application_preferences');perform person_private.application_context();
exception when others then perform person_private.intake_frame_clear();raise;
end$$;
revoke all on function person_private.intake_frame_open(uuid,uuid,uuid,text,jsonb,jsonb),person_private.intake_frame_clear(),person_private.intake_mutation_guard(),person_private.intake_mutation_context(uuid),person_private.intake_metadata_hash(jsonb),person_private.utf16_unit(integer),person_private.utf16_bytes(text),person_private.resume_utf16_prefix(text),person_private.application_matching_units(jsonb,text) from public,anon,authenticated,service_role;
revoke all on function public.person_application_candidate_details(uuid,text,jsonb,text),public.person_application_finalize(uuid),public.person_application_preferences(uuid) from public,anon,authenticated,service_role;
grant execute on function public.person_application_candidate_details(uuid,text,jsonb,text),public.person_application_finalize(uuid),public.person_application_preferences(uuid) to service_role;
