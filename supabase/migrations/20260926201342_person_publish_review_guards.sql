-- PREPARED ONLY: no guard activation or historical row rewrites.
-- Reuse identical validation for explicit attribution and deferred enforcement.
set local lock_timeout='2s';
set local statement_timeout='30s';

create function person_private.validate_change_attribution(p_event bigint,p_operation uuid,p_scope text) returns text[]
language plpgsql set search_path='' as $$
declare e public.person_change_events%rowtype; o public.person_audit_operations%rowtype; changed text[]; allowed text[]; expected_writer text;
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
 when 'application_finalize' then expected_writer:='application';allowed:=array['candidate_id','pool_created_person','parsed_profile','updated_at'];
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
 if not changed<@allowed then raise exception 'audit_event_fields';end if;
 return changed;
end$$;

revoke all on function person_private.validate_change_attribution(bigint,uuid,text) from public,anon,authenticated;
grant execute on function person_private.validate_change_attribution(bigint,uuid,text) to service_role;
create or replace function person_private.attribute_change(p_event bigint,p_operation uuid,p_scope text) returns void
language plpgsql set search_path='' as $$
declare e public.person_change_events%rowtype; changed text[];
begin
 changed:=person_private.validate_change_attribution(p_event,p_operation,p_scope);
 select * into strict e from public.person_change_events where id=p_event;
 insert into public.person_change_attributions(event_id,candidate_id,operation_id,scope,changed_fields,event_hash)
 values(e.id,e.candidate_id,p_operation,p_scope,changed,
  md5(jsonb_build_array(e.id,e.candidate_id,e.source_table,e.source_row_id,e.operation,e.transaction_id::text,e.previous_payload,e.payload)::text));
end$$;

-- Reject obvious legacy updates immediately. The deferred check below also
-- requires the exact captured event's attribution, after the writer adds it.
-- Contract metadata/contact/identity fields use the same hash as audit chains.
create or replace function person_private.profile_write_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from person_private.write_guard where id and enabled) then return new;end if;
 if person_private.audit_candidate_hash(to_jsonb(old)) is distinct from person_private.audit_candidate_hash(to_jsonb(new))
  and not exists(select 1 from public.person_audit_operations o where o.candidate_id=new.id and o.transaction_id=pg_current_xact_id()) then
  raise exception 'person_profile_write_guard' using errcode='P0001';
 end if;
 return new;
end$$;

create function person_private.profile_attribution_guard() returns trigger
language plpgsql security definer set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare a public.person_change_attributions%rowtype; o public.person_audit_operations%rowtype;
 anchor public.person_audit_anchors%rowtype; changed text[];
begin
 if not exists(select 1 from person_private.write_guard where id and enabled) then return null;end if;
 if new.operation='UPDATE' and person_private.audit_candidate_hash(new.previous_payload)
    is not distinct from person_private.audit_candidate_hash(new.payload) then return null;end if;
 select * into a from public.person_change_attributions where event_id=new.id;
 select * into o from public.person_audit_operations where id=a.operation_id;
 select * into anchor from public.person_audit_anchors where candidate_id=new.candidate_id;
 if a.event_id is null or o.id is null or anchor.candidate_id is null
  or a.candidate_id is distinct from new.candidate_id or o.candidate_id is distinct from new.candidate_id
  or new.transaction_id is distinct from pg_current_xact_id() or o.transaction_id is distinct from new.transaction_id
  or a.event_hash is distinct from md5(jsonb_build_array(new.id,new.candidate_id,new.source_table,new.source_row_id,new.operation,new.transaction_id::text,new.previous_payload,new.payload)::text)
  or anchor.anchor_hash is distinct from person_private.audit_anchor_hash(to_jsonb(anchor))
  or o.evidence->'guard'->>'anchor_hash' is distinct from anchor.anchor_hash
  or o.evidence->'guard'->>'version' is distinct from 'candidate-audit-1'
 then raise exception 'person_profile_write_guard' using errcode='P0001';end if;
 begin
  changed:=person_private.validate_change_attribution(new.id,o.id,a.scope);
 exception when raise_exception then
  raise exception 'person_profile_write_guard' using errcode='P0001';
 end;
 if a.changed_fields is distinct from changed then raise exception 'person_profile_write_guard' using errcode='P0001';end if;
 if new.operation='INSERT' then
  if a.scope is distinct from 'creation' or anchor.kind is distinct from 'receipt_created'
   or anchor.creator_ref is distinct from o.receipt_ref
   or anchor.external_proof->>'creator_event_id' is distinct from new.id::text
   or o.evidence->>'creator_event_id' is distinct from new.id::text
   or person_private.audit_candidate_hash(anchor.before_image) is distinct from person_private.audit_candidate_hash(new.payload)
   or not (
    (o.writer='application' and exists(select 1 from public.person_application_receipts r
     join public.website_applications app on app.id=r.application_id
     where 'application:'||r.application_id::text=o.receipt_ref and r.candidate_id=new.candidate_id and r.created_person
      and app.organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a'))
    or (o.writer='directory' and exists(select 1 from public.person_directory_receipts r
     where 'directory:'||r.id::text=o.receipt_ref and r.candidate_id=new.candidate_id and r.created_person))
   ) then raise exception 'person_profile_write_guard' using errcode='P0001';end if;
 end if;
 return null;
end$$;
revoke all on function person_private.profile_attribution_guard() from public,anon,authenticated,service_role;
-- Deferred so same-transaction creation can retain its real receipt and anchor,
-- and every profile update can attach its exact event proof before COMMIT.
create constraint trigger person_profile_attribution_guard after insert on public.person_change_events
 deferrable initially deferred for each row
 when (new.source_table='candidates' and new.operation in ('INSERT','UPDATE'))
 execute function person_private.profile_attribution_guard();
