-- PREPARED ONLY: transactional application contact/preferences evidence.
-- Default-off callers only; no production writer/guard activation.
set local lock_timeout='2s';
set local statement_timeout='30s';
create sequence person_private.application_intent_order as bigint no cycle cache 1;
revoke all on sequence person_private.application_intent_order from public,anon,authenticated,service_role;
create table person_private.application_intents (
 application_id uuid primary key,organization_id uuid not null,linkedin_username text not null,
 intent_hash text not null,intent_order bigint not null unique,input_snapshot jsonb not null
);
create index application_intents_identity_order on person_private.application_intents(organization_id,linkedin_username,intent_order desc);
create table person_private.application_preference_decisions (
 event_id bigint primary key,candidate_id uuid not null,application_id uuid not null references person_private.application_intents(application_id),
 decision_order bigint not null unique,event_hash text not null
);
create index application_preference_decisions_candidate on person_private.application_preference_decisions(candidate_id,event_id);
alter table person_private.application_intents enable row level security;
alter table person_private.application_preference_decisions enable row level security;
revoke all on person_private.application_intents,person_private.application_preference_decisions from public,anon,authenticated,service_role;
create trigger person_application_decision_epoch after insert on person_private.application_preference_decisions
 for each row execute function person_private.audit_epoch('candidate_id');

create function person_private.application_future_accept() returns trigger
language plpgsql security definer set search_path='' set timezone='UTC' as $$
begin
 if new.source<>'future' or new.person_intent_hash is null or new.person_processing_version is distinct from 1 then return new;end if;
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'application_isolation';end if;
 if new.linkedin_username is null or new.linkedin_username<>lower(new.linkedin_username) then raise exception 'application_intent_identity';end if;
 if tg_when='BEFORE' then
  perform pg_advisory_xact_lock(72007,hashtext(new.linkedin_username));
  new.created_at:=clock_timestamp();
 else
  insert into person_private.application_intents(application_id,organization_id,linkedin_username,intent_hash,intent_order,input_snapshot)
   values(new.id,new.organization_id,new.linkedin_username,new.person_intent_hash,nextval('person_private.application_intent_order'),person_private.application_work_input(to_jsonb(new)));
 end if;
 return new;
end$$;
revoke all on function person_private.application_future_accept() from public,anon,authenticated,service_role;
create trigger person_application_future_accept before insert on public.website_applications for each row execute function person_private.application_future_accept();
create trigger person_application_future_record after insert on public.website_applications for each row execute function person_private.application_future_accept();

create function person_private.application_future_latest(p_application uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare j person_private.application_intents;app public.website_applications;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'application_isolation';end if;
 select * into j from person_private.application_intents where application_id=p_application;
 if not found then raise exception 'application_intent_proof';end if;
 -- Normal intake already holds this lock. An accidental inverse-order caller
 -- fails immediately rather than waiting while it holds candidate row locks.
 if not pg_try_advisory_xact_lock(72007,hashtext(j.linkedin_username)) then raise exception 'application_intent_lock';end if;
 select * into app from public.website_applications where id=p_application;
 if app.organization_id is distinct from j.organization_id or app.linkedin_username is distinct from j.linkedin_username or app.person_intent_hash is distinct from j.intent_hash then raise exception 'application_intent_proof';end if;
 return not exists(select 1 from person_private.application_intents other where other.organization_id=j.organization_id and other.linkedin_username=j.linkedin_username and other.intent_order>j.intent_order);
end$$;
revoke all on function person_private.application_future_latest(uuid) from public,anon,authenticated,service_role;
grant execute on function person_private.application_future_latest(uuid) to service_role;

create function person_private.application_preference_witness(p_application uuid,p_snapshot jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare j person_private.application_intents;k text;
begin
 if p_snapshot->>'organization_id' is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a' then return false;end if;
 if not person_private.application_future_latest(p_application) then return false;end if;
 select * into strict j from person_private.application_intents where application_id=p_application;
 if j.organization_id<>'801865a7-6533-41d2-9c45-e4a90e6ad51a' then return false;end if;
 foreach k in array array['organization_id','linkedin_username','person_intent_hash','source','follow_up_at','preferred_roles','preferred_locations','preferred_workplace','comp_expectation','visa_status'] loop
  if j.input_snapshot->k is distinct from p_snapshot->k then return false;end if;
 end loop;
 return true;
end$$;
revoke all on function person_private.application_preference_witness(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function person_private.application_preference_witness(uuid,jsonb) to service_role;

create or replace function person_private.validate_change_attribution(p_event bigint,p_operation uuid,p_scope text) returns text[]
language plpgsql set search_path='' as $$
declare e public.person_change_events%rowtype; o public.person_audit_operations%rowtype; changed text[]; allowed text[]; expected_writer text;r public.person_application_receipts;expected jsonb;
begin
 select * into e from public.person_change_events where id=p_event;
 select * into o from public.person_audit_operations where id=p_operation;
 if e.id is null or o.id is null or e.candidate_id<>o.candidate_id then raise exception 'audit_event_identity';end if;
 if e.transaction_id is distinct from pg_current_xact_id() or o.transaction_id<>pg_current_xact_id() then raise exception 'audit_event_transaction';end if;
 select coalesce(array_agg(k order by k),'{}') into changed from (
  select jsonb_object_keys(coalesce(e.previous_payload,'{}')) k union select jsonb_object_keys(e.payload)
 ) keys where e.previous_payload->k is distinct from e.payload->k;
 case p_scope
 when 'profile' then allowed:=array['full_name','current_title','current_company','current_company_id','work_experience','education','education_schools','education_degrees','education_fields','top_skills','all_skills_text','previous_companies','headline','profile_summary','location','profile_picture_url','email','phone','updated_at'];
 when 'refresh_metadata' then expected_writer:='refresh';allowed:=array['linkedin_enrichment_date','calculated_experience_years','updated_at'];
 when 'directory_metadata' then expected_writer:='directory';allowed:=array['directory_contact_id','directory_sync_hash','source','status','follow_up_at','linkedin_enrichment_date','calculated_experience_years','updated_at'];
 when 'recruiter_contact' then expected_writer:='recruiter';allowed:=array['contact','updated_at'];
 when 'application_finalize' then expected_writer:='application';allowed:=array['candidate_id','pool_created_person','parsed_profile','name','contact','updated_at'];
 when 'application_preferences' then expected_writer:='application';allowed:=array['follow_up_at','role_preferences','visa_status','updated_at'];
 when 'creation' then
  if o.writer not in ('application','directory') or e.operation<>'INSERT' or e.previous_payload is not null then raise exception 'audit_event_writer';end if;
  -- Only the minimal identity seed is attributable as creation. Nonempty
  -- imported facts must go through a separately captured profile publication.
  if exists(select 1 from jsonb_each(e.payload) x
   where not x.key=any(array['id','full_name','first_name','last_name','linkedin_username','linkedin_url','source','status','created_at','updated_at'])
    and x.value not in ('null'::jsonb,'[]'::jsonb,'{}'::jsonb,'""'::jsonb)
    and not (x.key='embedding_type' and x.value='"unknown"'::jsonb)
    and not (x.key='linkedin_enrichment_status' and x.value='"not_applicable"'::jsonb)
    and not (x.key='open_profile' and x.value='false'::jsonb)
  ) then raise exception 'audit_event_fields';end if;
  allowed:=changed;
 else raise exception 'audit_event_scope';end case;
 if expected_writer is not null and o.writer<>expected_writer then raise exception 'audit_event_writer';end if;
 if p_scope='application_finalize' then
  if e.operation is distinct from 'UPDATE' or e.previous_payload is null then raise exception 'audit_event_scope';end if;
  if e.source_row_id is null or o.receipt_ref is distinct from ('application:'||e.source_row_id) then raise exception 'audit_event_receipt';end if;
  if e.source_table is distinct from 'website_applications' or e.payload->>'organization_id' is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a' or e.payload->>'candidate_id' is distinct from o.candidate_id::text or (e.previous_payload->>'candidate_id' is not null and e.previous_payload->>'candidate_id'<>o.candidate_id::text) then raise exception 'audit_event_identity';end if;
 else
  if e.source_table is distinct from 'candidates' or e.source_row_id is distinct from o.candidate_id::text or e.payload->>'id' is distinct from o.candidate_id::text then raise exception 'audit_event_identity';end if;
  if p_scope<>'creation' and (e.operation<>'UPDATE' or e.previous_payload is null) then raise exception 'audit_event_scope';end if;
 end if;
 if p_scope in ('application_finalize','application_preferences') then
  select * into r from public.person_application_receipts where 'application:'||application_id::text=o.receipt_ref and candidate_id=o.candidate_id;
  if not found then raise exception 'audit_application_receipt';end if;
  if p_scope='application_finalize' then
   if e.payload->>'candidate_id' is distinct from r.candidate_id::text or e.payload->'pool_created_person' is distinct from to_jsonb(r.created_person) or e.payload->'parsed_profile' is distinct from r.application_snapshot->'parsed_profile' then raise exception 'audit_application_receipt';end if;
   if ('name'=any(changed) and e.payload->'name' is distinct from r.application_snapshot->'name') or ('contact'=any(changed) and e.payload->'contact' is distinct from r.application_snapshot->'contact') then raise exception 'audit_application_receipt';end if;
  else
   if not person_private.application_preference_witness(r.application_id,r.application_snapshot) then raise exception 'audit_application_intent';end if;
   expected:=jsonb_build_object('roles',coalesce(r.application_snapshot->'preferred_roles','[]'),'locations',coalesce(r.application_snapshot->'preferred_locations','[]'),'workplace',coalesce(r.application_snapshot->'preferred_workplace','[]'),'salary',r.application_snapshot->'comp_expectation');
   if e.payload->'follow_up_at' is distinct from r.application_snapshot->'follow_up_at' or e.payload->'role_preferences' is distinct from expected or
    ('visa_status'=any(changed) and (nullif(r.application_snapshot->>'visa_status','') is null or e.payload->'visa_status' is distinct from r.application_snapshot->'visa_status')) then raise exception 'audit_application_preferences';end if;
  end if;
 end if;
 if not changed<@allowed then raise exception 'audit_event_fields';end if;
 return changed;
end$$;

create function person_private.application_preference_decision(p_event bigint,p_operation uuid) returns void
language plpgsql security definer set search_path='' as $$
declare e public.person_change_events;o public.person_audit_operations;
begin
 -- Revalidate values, latestness, transaction and retained username lock.
 perform person_private.validate_change_attribution(p_event,p_operation,'application_preferences');
 select * into strict e from public.person_change_events where id=p_event;
 select * into strict o from public.person_audit_operations where id=p_operation;
 insert into person_private.application_preference_decisions(event_id,candidate_id,application_id,decision_order,event_hash)
 values(e.id,e.candidate_id,substring(o.receipt_ref from 13)::uuid,nextval('person_private.application_intent_order'),
 md5(jsonb_build_array(e.id,e.candidate_id,e.source_table,e.source_row_id,e.operation,e.transaction_id::text,e.previous_payload,e.payload)::text));
end$$;
revoke all on function person_private.application_preference_decision(bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function person_private.application_preference_decision(bigint,uuid) to service_role;
create or replace function person_private.attribute_change(p_event bigint,p_operation uuid,p_scope text) returns void
language plpgsql set search_path='' as $$
declare e public.person_change_events%rowtype; changed text[];
begin
 changed:=person_private.validate_change_attribution(p_event,p_operation,p_scope);
 select * into strict e from public.person_change_events where id=p_event;
 insert into public.person_change_attributions(event_id,candidate_id,operation_id,scope,changed_fields,event_hash)
 values(e.id,e.candidate_id,p_operation,p_scope,changed,
  md5(jsonb_build_array(e.id,e.candidate_id,e.source_table,e.source_row_id,e.operation,e.transaction_id::text,e.previous_payload,e.payload)::text));
 if p_scope='application_preferences' then perform person_private.application_preference_decision(p_event,p_operation);end if;
end$$;

-- Bounded proof includes pending/unlinked intents. A later accepted intent has
-- a greater shared-sequence order and cannot invalidate a past valid decision.
create function person_private.application_preference_proofs(p_candidate uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('event_id',d.event_id::text,'candidate_id',d.candidate_id,'application_id',d.application_id,
 'decision_order',d.decision_order::text,'event_hash',d.event_hash,'intent_order',j.intent_order::text,'intent_hash',j.intent_hash,
 'latest_application_id',(select latest.application_id from person_private.application_intents latest where latest.organization_id=j.organization_id and latest.linkedin_username=j.linkedin_username and latest.intent_order<d.decision_order order by intent_order desc limit 1)) order by d.event_id),'[]')
 from (select * from person_private.application_preference_decisions where candidate_id=p_candidate order by event_id limit 201)d
 join person_private.application_intents j on j.application_id=d.application_id
$$;
revoke all on function person_private.application_preference_proofs(uuid) from public,anon,authenticated,service_role;
grant execute on function person_private.application_preference_proofs(uuid) to service_role;

create or replace function person_private.postcutover_reference_snapshot(p_candidate uuid) returns jsonb
language plpgsql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare result jsonb; refs jsonb; preferences jsonb;
begin
 result:=person_private.postcutover_snapshot(p_candidate);
 if result->>'status'<>'ready' then return result;end if;
 select coalesce(jsonb_agg(jsonb_build_object('event_id',x.event_id::text,'candidate_id',x.candidate_id,'operation_id',x.operation_id) order by x.event_id),'[]') into refs
 from (select event_id,candidate_id,operation_id from public.person_change_attributions where candidate_id=p_candidate order by event_id limit 201)x;
 if jsonb_array_length(refs)>200 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','attribution_refs_limit');end if;
 preferences:=person_private.application_preference_proofs(p_candidate);
 if jsonb_array_length(preferences)>200 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','application_preferences_limit');end if;
 result:=result||jsonb_build_object('reference_version',1,'attribution_refs',refs,'application_preference_proofs',preferences);
 if octet_length(result::text)>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 return result;
end$$;
