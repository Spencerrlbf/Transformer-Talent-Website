-- Prepared only: preserve a verified legacy witness before normalized writers.
-- No candidate/source repair, historical acknowledgement, or external writes.
set local lock_timeout='3s';
alter table public.person_audit_anchors add column external_proof jsonb not null default '{}' check(jsonb_typeof(external_proof)='object');

create function person_private.audit_anchor_snapshot(p_candidate uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare row_data jsonb; legacy_rows jsonb; v2_rows jsonb; comm_rows jsonb; catalog jsonb; revision bigint; version bigint; verification jsonb; result jsonb; existing text;
begin
 select anchor_hash into existing from public.person_audit_anchors where candidate_id=p_candidate;
 if found then return jsonb_build_object('candidate_id',p_candidate,'status','anchored','anchor_hash',existing);end if;
 select to_jsonb(c)-array['resume_embedding','matching_embedding','resume_text','notes'] into row_data from public.candidates c where c.id=p_candidate;
 if not found then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','candidate_missing');end if;
 if exists(select 1 from public.person_source_holds where candidate_id=p_candidate and resolved_at is null) then
  return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','source_hold');
 end if;
 if exists(select 1 from public.person_projection_state where candidate_id=p_candidate)
  or exists(select 1 from public.person_application_receipts where candidate_id=p_candidate)
  or exists(select 1 from public.person_refresh_attempts where candidate_id=p_candidate)
  or exists(select 1 from public.person_directory_receipts where candidate_id=p_candidate)
  or exists(select 1 from public.person_recruiter_receipts where candidate_id=p_candidate)
  or exists(select 1 from public.person_audit_operations where candidate_id=p_candidate) then
  return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','normalized_writes_present');
 end if;
 select rev into revision from public.candidate_profile_state where candidate_id=p_candidate;
 select coalesce(max(id),0) into version from public.person_change_events where candidate_id=p_candidate;
 -- Latest across every status: an older success cannot hide a newer review.
 select to_jsonb(x)||jsonb_build_object('run_notes',r.notes) into verification
 from (select * from public.person_reconcile_people where candidate_id=p_candidate order by checked_at desc,run_id desc limit 1)x
 join public.backfill_runs r on r.run_id=x.run_id;
 if revision is null or verification is null or verification->>'status' is distinct from 'verified'
  or verification->>'counted' is distinct from 'true' or (verification->>'revision')::bigint is distinct from revision
  or (verification->>'captured_version')::bigint is distinct from version
  or verification->'checks'->>'integrity_ok' is distinct from 'true'
  or verification->'checks'->>'external_stable' is distinct from 'true'
  or verification->'run_notes'->>'kind' is distinct from 'reconcile'
  or verification->'run_notes'->>'parser' is distinct from 'person-v3'
  or verification->'run_notes'->>'commit' is distinct from 'c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc' then
  return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','historical_verification_required');
 end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') into legacy_rows from
  (select * from public.candidate_emails where candidate_id=p_candidate order by id limit 1001)x;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') into v2_rows from
  (select * from public.candidate_emails_v2 where candidate_id=p_candidate order by id limit 1001)x;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') into comm_rows from
  (select id,candidate_id,communication_type,status,email_used,communication_date,response_date from public.candidate_communications
   where candidate_id=p_candidate and communication_type='email' and status in ('bounced','replied') order by id limit 1001)x;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') into catalog from
  (select * from public.candidate_sources where candidate_id=p_candidate order by id limit 1001)x;
 if greatest(jsonb_array_length(legacy_rows),jsonb_array_length(v2_rows),jsonb_array_length(comm_rows),jsonb_array_length(catalog))>1000 then
  return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','anchor_source_limit');
 end if;
 result:=jsonb_build_object('candidate_id',p_candidate,'status','ready','row',row_data,'legacy',legacy_rows,'v2',v2_rows,'comms',comm_rows,
  'source_catalog',catalog,'revision',revision::text,'captured_version',version::text,'verification',verification,
  'external_proof',jsonb_build_object('v2_hash',md5(v2_rows::text),'legacy_hash',md5(legacy_rows::text),'outreach_hash',md5(comm_rows::text)));
 if octet_length(result::text)>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','anchor_size_limit');end if;
 return result||jsonb_build_object('proof',md5(result::text));
end$$;
revoke all on function person_private.audit_anchor_snapshot(uuid) from public,anon,authenticated;
grant execute on function person_private.audit_anchor_snapshot(uuid) to service_role;

create function public.person_audit_anchor_inputs(p_ids jsonb) returns jsonb
language plpgsql stable set search_path='' as $$
declare result jsonb;
begin
 if current_setting('statement_timeout')::interval<=interval '0 seconds' or current_setting('statement_timeout')::interval>interval '20 seconds' then raise exception 'audit_statement_timeout';end if;
 if jsonb_typeof(p_ids) is distinct from 'array' or jsonb_array_length(p_ids) not between 1 and 100
  or (select count(distinct value) from jsonb_array_elements_text(p_ids))<>jsonb_array_length(p_ids) then raise exception 'audit_batch';end if;
 select jsonb_agg(person_private.audit_anchor_snapshot(value::uuid) order by value::uuid) into result from jsonb_array_elements_text(p_ids);
 return result;
end$$;

create function public.person_audit_anchor_page(p_after uuid,p_limit integer) returns jsonb
language plpgsql stable set search_path='' as $$
declare result jsonb;
begin
 if current_setting('statement_timeout')::interval<=interval '0 seconds' or current_setting('statement_timeout')::interval>interval '20 seconds' then raise exception 'audit_statement_timeout';end if;
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'audit_batch';end if;
 select coalesce(jsonb_agg(id order by id),'[]') into result from
  (select c.id from public.candidates c where (p_after is null or c.id>p_after)
   and not exists(select 1 from public.person_audit_anchors a where a.candidate_id=c.id) order by c.id limit p_limit)x;
 return result;
end$$;

create function person_private.audit_anchor_hash(p_anchor jsonb) returns text
language sql immutable set search_path='' as $$
 select encode(sha256(convert_to((p_anchor-array['created_at','anchor_hash'])::text,'UTF8')),'hex');
$$;
revoke all on function person_private.audit_anchor_hash(jsonb) from public,anon,authenticated;
grant execute on function person_private.audit_anchor_hash(jsonb) to service_role;

create function public.person_audit_anchor_commit(p_items jsonb) returns jsonb
language plpgsql volatile set search_path='' set lock_timeout='3s' as $$
declare item jsonb; cid uuid; snap jsonb; doc jsonb; src jsonb; source_row jsonb; envelope jsonb; old public.person_audit_anchors%rowtype; payload jsonb; result jsonb:='[]';
begin
 if current_setting('statement_timeout')::interval<=interval '0 seconds' or current_setting('statement_timeout')::interval>interval '20 seconds' then raise exception 'audit_statement_timeout';end if;
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'audit_isolation';end if;
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 10
  or (select count(distinct value->>'candidate_id') from jsonb_array_elements(p_items))<>jsonb_array_length(p_items) then raise exception 'audit_batch';end if;
 perform pg_advisory_xact_lock_shared(72005,0);
 for item in select value from jsonb_array_elements(p_items) order by value->>'candidate_id' loop
  cid:=(item->>'candidate_id')::uuid;doc:=item->'doc';src:=doc->'source';
  perform pg_advisory_xact_lock(hashtext(cid::text));
  perform 1 from public.candidates where id=cid for key share;
  perform pg_advisory_xact_lock(72004,hashtext(cid::text));
  select * into old from public.person_audit_anchors where candidate_id=cid;
  if found then
   if old.kind<>'legacy' or old.legacy_doc is distinct from doc or old.external_proof->>'preparation_proof' is distinct from item->>'proof' then raise exception 'audit_anchor_conflict';end if;
   result:=result||jsonb_build_array(jsonb_build_object('candidate_id',cid,'status','unchanged','anchor_hash',old.anchor_hash));continue;
  end if;
  -- Separate statement after locks: STABLE helper observes this fresh snapshot.
  select person_private.audit_anchor_snapshot(cid) into snap;
  if snap->>'status' is distinct from 'ready' or snap->>'proof' is distinct from item->>'proof' then
   result:=result||jsonb_build_array(jsonb_build_object('candidate_id',cid,'status','pending','reason',coalesce(snap->>'reason','anchor_snapshot_changed')));continue;
  end if;
  if doc->>'candidate_id' is distinct from cid::text or src->>'source' is distinct from 'legacy_import'
   or src->>'parser_version' is distinct from 'person-v3' or src->>'source_ref' is distinct from cid::text
   or jsonb_typeof(doc) is distinct from 'object' then raise exception 'audit_document_identity';end if;
  envelope:=jsonb_build_object('content',doc-'source','source',src->>'source','ref',src->'source_ref','at',src->'fetched_at','v','person-v3');
  if item->>'canonical' is null or (item->>'canonical')::jsonb is distinct from envelope
   or encode(sha256(convert_to(item->>'canonical','UTF8')),'hex') is distinct from src->>'payload_hash' then raise exception 'audit_document_hash';end if;
  select s into source_row from jsonb_array_elements(snap->'source_catalog')s
   where s->>'source'='legacy_import' and s->>'source_ref'=cid::text and s->>'payload_hash'=src->>'payload_hash'
    and s->>'parser_version'='person-v3' and (s->>'fetched_at')::timestamptz=(src->>'fetched_at')::timestamptz limit 1;
  if source_row is null or source_row->'provider' is distinct from src->'provider'
   or source_row->'raw_in' is distinct from src->'raw_in' or source_row->'enrichment_id' is distinct from src->'enrichment_id' then raise exception 'audit_source_metadata';end if;
  payload:=jsonb_build_object('candidate_id',cid,'kind','legacy','baseline_run',snap->'verification'->>'run_id','parser_version','person-v3','legacy_doc',doc,
   'before_image',snap->'row','source_catalog',snap->'source_catalog','revision',(snap->>'revision')::bigint,'captured_version',(snap->>'captured_version')::bigint,
   'creator_ref',null,'external_proof',(snap->'external_proof')||jsonb_build_object('preparation_proof',snap->>'proof'));
  insert into public.person_audit_anchors(candidate_id,kind,baseline_run,parser_version,legacy_doc,before_image,source_catalog,revision,captured_version,creator_ref,external_proof,anchor_hash)
   values(cid,'legacy',payload->>'baseline_run','person-v3',doc,payload->'before_image',payload->'source_catalog',(payload->>'revision')::bigint,(payload->>'captured_version')::bigint,null,payload->'external_proof',person_private.audit_anchor_hash(payload));
  result:=result||jsonb_build_array(jsonb_build_object('candidate_id',cid,'status','created','anchor_hash',person_private.audit_anchor_hash(payload)));
 end loop;
 return result;
end$$;
revoke all on function public.person_audit_anchor_inputs(jsonb),public.person_audit_anchor_page(uuid,integer),public.person_audit_anchor_commit(jsonb) from public,anon,authenticated;
grant execute on function public.person_audit_anchor_inputs(jsonb),public.person_audit_anchor_page(uuid,integer),public.person_audit_anchor_commit(jsonb) to service_role;
