-- Prepared, read-only evidence collection. A ready snapshot is NOT an audit pass.
-- Historical runners and accounting are unchanged. No function writes rows.
set local lock_timeout='3s';
create index person_directory_receipts_contact_idx on public.person_directory_receipts(contact_id,id);

create function person_private.postcutover_snapshot(p_candidate uuid) returns jsonb
language plpgsql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare a public.person_audit_anchors%rowtype; row_data jsonb; result jsonb; part jsonb; normalized jsonb:='{}';
 links uuid[]; epochs jsonb; candidate_epoch bigint; version bigint; revision bigint; aux jsonb;
 used_bytes bigint:=0; part_bytes bigint; row_count bigint; auxiliary_count bigint;
begin
 select to_jsonb(c)-array['resume_embedding','matching_embedding','resume_text','notes'] into row_data from public.candidates c where c.id=p_candidate;
 if not found then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','candidate_missing');end if;
 select * into a from public.person_audit_anchors where candidate_id=p_candidate;
 if not found then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','anchor_required');end if;
 select array_agg(contact_id order by contact_id) into links from (
  select distinct contact_id from (
   select (row_data->>'directory_contact_id')::uuid contact_id
   union all select contact_id from public.person_directory_receipts where candidate_id=p_candidate
   union all select directory_contact_id from public.person_directory_primary where candidate_id=p_candidate
  ) u where contact_id is not null order by contact_id limit 201
 ) x;
 if cardinality(links)>200 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','directory_scope_limit');end if;
 select count(*) into candidate_epoch from (select 1 from public.person_audit_epochs where scope_kind='candidate' and scope_key=p_candidate::text limit 10001)x;
 select coalesce(jsonb_agg(jsonb_build_object('contact_id',d,'epoch',n::text) order by d),'[]') into epochs from unnest(links)d
 cross join lateral(select count(*) n from (select 1 from public.person_audit_epochs where scope_kind='directory' and scope_key=d::text limit 10001)x)e;
 if candidate_epoch>10000 or exists(select 1 from jsonb_array_elements(epochs)e where (e->>'epoch')::bigint>10000) then
  return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','epoch_limit');end if;
 select coalesce(max(id),0) into version from public.person_change_events where candidate_id=p_candidate;
 select rev into revision from public.candidate_profile_state where candidate_id=p_candidate;
 -- Preflight hash-only auxiliary collections too: their shared proof helper
 -- builds arrays internally. Never enter it with an oversized source set.
 select max(n),coalesce(sum(bytes),0) into auxiliary_count,used_bytes from (
  select count(*) n,coalesce(sum(octet_length(to_jsonb(x)::text)),0) bytes from (select * from public.candidate_emails where candidate_id=p_candidate order by id limit 1001)x
  union all select count(*),coalesce(sum(octet_length(to_jsonb(x)::text)),0) from (select * from public.candidate_emails_v2 where candidate_id=p_candidate order by id limit 1001)x
  union all select count(*),coalesce(sum(octet_length(to_jsonb(x)::text)),0) from (select id,candidate_id,communication_type,status,email_used,communication_date,response_date from public.candidate_communications where candidate_id=p_candidate and communication_type='email' and status in ('bounced','replied') order by id limit 1001)x
 ) q;
 if auxiliary_count>1000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','auxiliary_limit');end if;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select person_private.audit_auxiliary_proof(p_candidate) into aux;
 if (aux->>'n')::int>1000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','auxiliary_limit');end if;
 result:=jsonb_build_object('candidate_id',p_candidate,'status','ready','schema','person-postcutover-snapshot-1',
  'candidate',row_data,'candidate_contract_hash',person_private.audit_candidate_hash(row_data),
  'anchor',to_jsonb(a)||jsonb_build_object('revision',a.revision::text,'captured_version',a.captured_version::text),
  'anchor_hash_valid',a.anchor_hash=person_private.audit_anchor_hash(to_jsonb(a)),
  'anchor_contract_hash',person_private.audit_candidate_hash(a.before_image),'auxiliary',aux,
  'boundary',jsonb_build_object('anchor_hash',a.anchor_hash,'revision',revision::text,'capture',version::text,'candidate_epoch',candidate_epoch::text,'directory_epochs',epochs));
 used_bytes:=used_bytes+octet_length(result::text);
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 -- Every bounded collection is byte-counted before aggregation. STABLE keeps
 -- both reads on the same snapshot. The final exact check includes JSON syntax.
 -- All five captured tables, including transient INSERT/DELETE facts. Creator
 -- INSERT is included even when it is exactly the frozen creation boundary.
 select count(*),coalesce(sum(octet_length((j)::text)),0) into row_count,part_bytes from (
  select e.id event_id,(to_jsonb(e)||jsonb_build_object('id',e.id::text,'transaction_id',e.transaction_id::text,
   'payload',case when e.source_table='candidate_communications' then (select jsonb_object_agg(k,e.payload->k) from unnest(array['id','candidate_id','communication_type','status','email_used','communication_date','response_date'])k) else e.payload end,
   'previous_payload',case when e.previous_payload is null then null when e.source_table='candidate_communications' then (select jsonb_object_agg(k,e.previous_payload->k) from unnest(array['id','candidate_id','communication_type','status','email_used','communication_date','response_date'])k) else e.previous_payload end,
   'actual_event_hash',md5(jsonb_build_array(e.id,e.candidate_id,e.source_table,e.source_row_id,e.operation,e.transaction_id::text,e.previous_payload,e.payload)::text),
   'actual_changed_fields',(select coalesce(jsonb_agg(k order by k),'[]') from (select jsonb_object_keys(coalesce(e.previous_payload,'{}')) k union select jsonb_object_keys(e.payload))keys where e.previous_payload->k is distinct from e.payload->k),
   'before_contract_hash',case when e.source_table='candidates' then person_private.audit_candidate_hash(e.previous_payload) end,
   'after_contract_hash',case when e.source_table='candidates' then person_private.audit_candidate_hash(e.payload) end,
   'attribution',(select to_jsonb(x)||jsonb_build_object('event_id',x.event_id::text) from public.person_change_attributions x where x.event_id=e.id))) j
  from (select * from public.person_change_events where candidate_id=p_candidate
   and (id>a.captured_version or id::text=a.external_proof->>'creator_event_id') order by id limit 201)e
 )x;
 if row_count>200 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','event_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(j order by event_id),'[]') into part from (
  select e.id event_id,(to_jsonb(e)||jsonb_build_object('id',e.id::text,'transaction_id',e.transaction_id::text,
   'payload',case when e.source_table='candidate_communications' then (select jsonb_object_agg(k,e.payload->k) from unnest(array['id','candidate_id','communication_type','status','email_used','communication_date','response_date'])k) else e.payload end,
   'previous_payload',case when e.previous_payload is null then null when e.source_table='candidate_communications' then (select jsonb_object_agg(k,e.previous_payload->k) from unnest(array['id','candidate_id','communication_type','status','email_used','communication_date','response_date'])k) else e.previous_payload end,
   'actual_event_hash',md5(jsonb_build_array(e.id,e.candidate_id,e.source_table,e.source_row_id,e.operation,e.transaction_id::text,e.previous_payload,e.payload)::text),
   'actual_changed_fields',(select coalesce(jsonb_agg(k order by k),'[]') from (select jsonb_object_keys(coalesce(e.previous_payload,'{}')) k union select jsonb_object_keys(e.payload))keys where e.previous_payload->k is distinct from e.payload->k),
   'before_contract_hash',case when e.source_table='candidates' then person_private.audit_candidate_hash(e.previous_payload) end,
   'after_contract_hash',case when e.source_table='candidates' then person_private.audit_candidate_hash(e.payload) end,
   'attribution',(select to_jsonb(x)||jsonb_build_object('event_id',x.event_id::text) from public.person_change_attributions x where x.event_id=e.id))) j
  from (select * from public.person_change_events where candidate_id=p_candidate
   and (id>a.captured_version or id::text=a.external_proof->>'creator_event_id') order by id limit 201)e
 )x;
 result:=result||jsonb_build_object('events',part);
 select count(*),coalesce(sum(octet_length((j)::text)),0) into row_count,part_bytes from (select to_jsonb(x)||jsonb_build_object('transaction_id',x.transaction_id::text) j from public.person_audit_operations x where candidate_id=p_candidate order by created_at,id limit 201) rows;
 if row_count>200 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','operations_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(j),'[]') into part from (select to_jsonb(x)||jsonb_build_object('transaction_id',x.transaction_id::text) j from public.person_audit_operations x where candidate_id=p_candidate order by created_at,id limit 201) rows;
 result:=result||jsonb_build_object('operations',part);
 select count(*),coalesce(sum(octet_length((j)::text)),0) into row_count,part_bytes from (select to_jsonb(x)||jsonb_build_object('application_snapshot',x.application_snapshot-array['resume_text','resume_embedding','matching_embedding','notes'],'application_snapshot_hash',md5(x.application_snapshot::text)) j from public.person_application_receipts x where candidate_id=p_candidate order by application_id limit 201) rows;
 if row_count>200 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','application_receipts_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(j),'[]') into part from (select to_jsonb(x)||jsonb_build_object('application_snapshot',x.application_snapshot-array['resume_text','resume_embedding','matching_embedding','notes'],'application_snapshot_hash',md5(x.application_snapshot::text)) j from public.person_application_receipts x where candidate_id=p_candidate order by application_id limit 201) rows;
 result:=result||jsonb_build_object('application_receipts',part);
 select count(*),coalesce(sum(octet_length((j)::text)),0) into row_count,part_bytes from (select to_jsonb(x)-array['claim_token','paid_token','previous_queue_rows'] j from public.person_refresh_attempts x where candidate_id=p_candidate order by queue_id limit 201) rows;
 if row_count>200 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','refresh_receipts_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(j),'[]') into part from (select to_jsonb(x)-array['claim_token','paid_token','previous_queue_rows'] j from public.person_refresh_attempts x where candidate_id=p_candidate order by queue_id limit 201) rows;
 result:=result||jsonb_build_object('refresh_receipts',part);
 select count(*),coalesce(sum(octet_length((j)::text)),0) into row_count,part_bytes from (select to_jsonb(x)-array['derivative_text','derivative_token']||jsonb_build_object('id',x.id::text) j from public.person_directory_receipts x where candidate_id=p_candidate or contact_id=any(links) order by id limit 201) rows;
 if row_count>200 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','directory_receipts_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(j),'[]') into part from (select to_jsonb(x)-array['derivative_text','derivative_token']||jsonb_build_object('id',x.id::text) j from public.person_directory_receipts x where candidate_id=p_candidate or contact_id=any(links) order by id limit 201) rows;
 result:=result||jsonb_build_object('directory_receipts',part);
 select count(*),coalesce(sum(octet_length((j)::text)),0) into row_count,part_bytes from (select to_jsonb(x) j from public.person_recruiter_receipts x where candidate_id=p_candidate order by id limit 201) rows;
 if row_count>200 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','recruiter_receipts_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(j),'[]') into part from (select to_jsonb(x) j from public.person_recruiter_receipts x where candidate_id=p_candidate order by id limit 201) rows;
 result:=result||jsonb_build_object('recruiter_receipts',part);
 select count(*),coalesce(sum(octet_length((j)::text)),0) into row_count,part_bytes from (select to_jsonb(x)||jsonb_build_object('latest_receipt_id',x.latest_receipt_id::text,'applied_receipt_id',x.applied_receipt_id::text) j from public.person_directory_state x where contact_id=any(links) order by contact_id limit 201) rows;
 if row_count>200 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','directory_state_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(j),'[]') into part from (select to_jsonb(x)||jsonb_build_object('latest_receipt_id',x.latest_receipt_id::text,'applied_receipt_id',x.applied_receipt_id::text) j from public.person_directory_state x where contact_id=any(links) order by contact_id limit 201) rows;
 result:=result||jsonb_build_object('directory_state',part);
 select count(*),coalesce(sum(octet_length((j)::text)),0) into row_count,part_bytes from (select to_jsonb(x)||jsonb_build_object('receipt_id',x.receipt_id::text) j from public.person_directory_primary x where candidate_id=p_candidate order by kind limit 1001) rows;
 if row_count>1000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','directory_primary_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(j),'[]') into part from (select to_jsonb(x)||jsonb_build_object('receipt_id',x.receipt_id::text) j from public.person_directory_primary x where candidate_id=p_candidate order by kind limit 1001) rows;
 result:=result||jsonb_build_object('directory_primary',part);
 select count(*),coalesce(sum(octet_length((j)::text)),0) into row_count,part_bytes from (select to_jsonb(x) j from public.person_recruiter_primary x where candidate_id=p_candidate order by kind limit 1001) rows;
 if row_count>1000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','recruiter_primary_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(j),'[]') into part from (select to_jsonb(x) j from public.person_recruiter_primary x where candidate_id=p_candidate order by kind limit 1001) rows;
 result:=result||jsonb_build_object('recruiter_primary',part);
 select count(*),coalesce(sum(octet_length((j)::text)),0) into row_count,part_bytes from (select to_jsonb(x) j from (select id,organization_id,candidate_id,linkedin_username,provider,operation,status,cache_status,created_at,raw_payload from public.candidate_enrichments where candidate_id=p_candidate and organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a' and provider='harvest' and status='ok' order by created_at,id limit 1001)x) rows;
 if row_count>1000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','ledger_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(j),'[]') into part from (select to_jsonb(x) j from (select id,organization_id,candidate_id,linkedin_username,provider,operation,status,cache_status,created_at,raw_payload from public.candidate_enrichments where candidate_id=p_candidate and organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a' and provider='harvest' and status='ok' order by created_at,id limit 1001)x) rows;
 result:=result||jsonb_build_object('ledger',part);
 select count(*),coalesce(sum(octet_length((j)::text)),0) into row_count,part_bytes from (select to_jsonb(x)-array['resume_text','resume_embedding','matching_embedding','notes'] j from public.website_applications x where candidate_id=p_candidate and organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a' order by created_at,id limit 1001) rows;
 if row_count>1000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','applications_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(j),'[]') into part from (select to_jsonb(x)-array['resume_text','resume_embedding','matching_embedding','notes'] j from public.website_applications x where candidate_id=p_candidate and organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a' order by created_at,id limit 1001) rows;
 result:=result||jsonb_build_object('applications',part);
 select count(*),coalesce(sum(octet_length((j)::text)),0) into row_count,part_bytes from (select to_jsonb(x) j from public.person_source_holds x where candidate_id=p_candidate and resolved_at is null order by ledger_id,evidence_hash limit 1001) rows;
 if row_count>1000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','holds_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(j),'[]') into part from (select to_jsonb(x) j from public.person_source_holds x where candidate_id=p_candidate and resolved_at is null order by ledger_id,evidence_hash limit 1001) rows;
 result:=result||jsonb_build_object('holds',part);
 select count(*),coalesce(sum(octet_length((j)::text)),0) into row_count,part_bytes from (select to_jsonb(x)||jsonb_build_object('id',x.id::text,'revision',x.revision::text) j from public.person_projection_history x where candidate_id=p_candidate order by id limit 201) rows;
 if row_count>200 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','history_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(j),'[]') into part from (select to_jsonb(x)||jsonb_build_object('id',x.id::text,'revision',x.revision::text) j from public.person_projection_history x where candidate_id=p_candidate order by id limit 201) rows;
 result:=result||jsonb_build_object('history',part);
 select count(*),coalesce(sum(octet_length((to_jsonb(x))::text)),0) into row_count,part_bytes from (select * from public.candidate_sources where candidate_id=p_candidate  order by id limit 1001)x;
 if row_count>1000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','sources_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into part from (select * from public.candidate_sources where candidate_id=p_candidate  order by id limit 1001)x;
 normalized:=normalized||jsonb_build_object('sources',part);
 select count(*),coalesce(sum(octet_length((to_jsonb(x))::text)),0) into row_count,part_bytes from (select * from public.candidate_identities where candidate_id=p_candidate  order by kind,value limit 1001)x;
 if row_count>1000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','identities_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into part from (select * from public.candidate_identities where candidate_id=p_candidate  order by kind,value limit 1001)x;
 normalized:=normalized||jsonb_build_object('identities',part);
 select count(*),coalesce(sum(octet_length((to_jsonb(x))::text)),0) into row_count,part_bytes from (select * from public.candidate_experiences where candidate_id=p_candidate and source='person' order by sort_order,id limit 1001)x;
 if row_count>1000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','jobs_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into part from (select * from public.candidate_experiences where candidate_id=p_candidate and source='person' order by sort_order,id limit 1001)x;
 normalized:=normalized||jsonb_build_object('jobs',part);
 select count(*),coalesce(sum(octet_length((to_jsonb(x))::text)),0) into row_count,part_bytes from (select * from public.candidate_educations where candidate_id=p_candidate  order by sort_order,id limit 1001)x;
 if row_count>1000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','educations_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into part from (select * from public.candidate_educations where candidate_id=p_candidate  order by sort_order,id limit 1001)x;
 normalized:=normalized||jsonb_build_object('educations',part);
 select count(*),coalesce(sum(octet_length((to_jsonb(x))::text)),0) into row_count,part_bytes from (select * from public.candidate_skills where candidate_id=p_candidate  order by skill_id limit 1001)x;
 if row_count>1000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','skills_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('skill_id',x.skill_id::text)),'[]') into part from (select * from public.candidate_skills where candidate_id=p_candidate  order by skill_id limit 1001)x;
 normalized:=normalized||jsonb_build_object('skills',part);
 select count(*),coalesce(sum(octet_length((to_jsonb(x))::text)),0) into row_count,part_bytes from (select * from public.candidate_contacts where candidate_id=p_candidate  order by kind,value_normalized limit 1001)x;
 if row_count>1000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','contacts_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into part from (select * from public.candidate_contacts where candidate_id=p_candidate  order by kind,value_normalized limit 1001)x;
 normalized:=normalized||jsonb_build_object('contacts',part);
 select count(*),coalesce(sum(octet_length(to_jsonb(x)::text)),0) into row_count,part_bytes from (select * from public.identity_conflicts where candidate_ids && array[p_candidate] order by id limit 1001)x;
 if row_count>1000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','conflicts_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into part from (select * from public.identity_conflicts where candidate_ids && array[p_candidate] order by id limit 1001)x;
 normalized:=normalized||jsonb_build_object('conflicts',part);
 select to_jsonb(x)||jsonb_build_object('rev',x.rev::text) into part from public.candidate_profile_state x where candidate_id=p_candidate;
 normalized:=normalized||jsonb_build_object('state',part);
 select to_jsonb(x) into part from public.candidate_contact_summary x where candidate_id=p_candidate;
 normalized:=normalized||jsonb_build_object('summary',part);
 select to_jsonb(x)||jsonb_build_object('revision',x.revision::text) into part from public.person_projection_state x where candidate_id=p_candidate;
 result:=result||jsonb_build_object('projection',part);
 select count(*),coalesce(sum(octet_length((to_jsonb(x))::text)),0) into row_count,part_bytes from (select id,name,linkedin_id,linkedin_username,linkedin_url,logo_url,normalized_name,linkedin_url_normalized,identity_basis,is_placeholder,tier,tier_list_version,merged_into,created_from from public.companies) x where x.id in (select (v->>'company_id')::uuid from jsonb_array_elements(normalized->'jobs')v);
 if row_count>1000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','lookup_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') into part from (select id,name,linkedin_id,linkedin_username,linkedin_url,logo_url,normalized_name,linkedin_url_normalized,identity_basis,is_placeholder,tier,tier_list_version,merged_into,created_from from public.companies) x where x.id in (select (v->>'company_id')::uuid from jsonb_array_elements(normalized->'jobs')v);
 normalized:=normalized||jsonb_build_object('companies',part);
 select count(*),coalesce(sum(octet_length((to_jsonb(x))::text)),0) into row_count,part_bytes from public.schools x where x.id in (select (v->>'school_id')::uuid from jsonb_array_elements(normalized->'educations')v);
 if row_count>1000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','lookup_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') into part from public.schools x where x.id in (select (v->>'school_id')::uuid from jsonb_array_elements(normalized->'educations')v);
 normalized:=normalized||jsonb_build_object('schools',part);
 select count(*),coalesce(sum(octet_length((to_jsonb(x))::text)),0) into row_count,part_bytes from public.skills x where x.id in (select (v->>'skill_id')::bigint from jsonb_array_elements(normalized->'skills')v);
 if row_count>1000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','lookup_limit');end if;
 used_bytes:=used_bytes+part_bytes+64+row_count*2;
 if used_bytes>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 select coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('id',x.id::text) order by x.id),'[]') into part from public.skills x where x.id in (select (v->>'skill_id')::bigint from jsonb_array_elements(normalized->'skills')v);
 normalized:=normalized||jsonb_build_object('skill_lookup',part);
 result:=result||jsonb_build_object('normalized',normalized);
 if octet_length(result::text)>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 return result;
end$$;
revoke all on function person_private.postcutover_snapshot(uuid) from public,anon,authenticated;
grant execute on function person_private.postcutover_snapshot(uuid) to service_role;

create function public.person_postcutover_audit_inputs(p_ids jsonb) returns jsonb
language plpgsql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare result jsonb;
begin
 if current_setting('statement_timeout')::interval<=interval '0 seconds' or current_setting('statement_timeout')::interval>interval '15 seconds' then raise exception 'audit_statement_timeout';end if;
 if jsonb_typeof(p_ids) is distinct from 'array' or jsonb_array_length(p_ids) not between 1 and 20
  or (select count(distinct value::uuid) from jsonb_array_elements_text(p_ids))<>jsonb_array_length(p_ids) then raise exception 'audit_batch';end if;
 select jsonb_agg(person_private.postcutover_snapshot(value::uuid) order by value::uuid) into result from jsonb_array_elements_text(p_ids);
 return result;
end$$;
revoke all on function public.person_postcutover_audit_inputs(jsonb) from public,anon,authenticated;
grant execute on function public.person_postcutover_audit_inputs(jsonb) to service_role;
