-- PREPARED ONLY. Publication of certified derivative results: after the paid
-- vectors are stored (or when every chunk was already available), the person's
-- chunk embeddings are replaced exactly as the legacy completion does, the job is
-- marked done through the journal, and the lifecycle closes as `published`.
-- No provider call happens here.
set local lock_timeout='2s';set local statement_timeout='30s';

alter table person_private.derivative_lifecycles drop constraint derivative_lifecycles_phase_check;
alter table person_private.derivative_lifecycles add constraint derivative_lifecycles_phase_check check(phase in ('claimed','stored','uncertain','retry','superseded','published','failed'));
alter table person_private.derivative_lifecycles add column publish_result jsonb;

do $$declare d text;n text;o text;begin
 -- Consumer writes: the lifecycle may record its publication; a published lifecycle
 -- is frozen and may complete its work record.
 d:=pg_get_functiondef('person_private.derivative_consumer_write(uuid,text,jsonb,jsonb)'::regprocedure);o:=d;
 d:=replace(d,'''recovery_result'',''seal_hash'']','''recovery_result'',''publish_result'',''seal_hash'']');
 if d=o then raise exception 'derivative_publish_definition';end if;
 n:='(e.phase in (''retry'',''superseded'') and p_new-''seal_hash'' is distinct from p_old-''seal_hash'')';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'derivative_publish_definition';end if;
 d:=replace(d,n,'(e.phase in (''retry'',''superseded'',''published'') and p_new-''seal_hash'' is distinct from p_old-''seal_hash'')');
 n:='(e.phase in (''retry'',''superseded'') and p_new->>''status''=''completed'')';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'derivative_publish_definition';end if;
 execute replace(d,n,'(e.phase in (''retry'',''superseded'',''published'') and p_new->>''status''=''completed'')');
 -- Commit-time proof: a published lifecycle has completed work and no unknown paid result.
 d:=pg_get_functiondef('person_private.derivative_lifecycle_deferred()'::regprocedure);
 n:='(e.phase in (''retry'',''superseded'') and (w.status<>''completed''';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'derivative_publish_definition';end if;
 execute replace(d,n,'(e.phase in (''retry'',''superseded'',''published'') and (w.status<>''completed''');
 -- Journal: the consumer may mark its own job done, recording the completed hash.
 d:=pg_get_functiondef('person_private.derivative_consumer_journal_end(person_private.derivative_job_changes)'::regprocedure);o:=d;
 d:=replace(d,'array[''desired_revision'',''status'',''attempts'',''claim_token'',''lease_until'',''claim_missing'',''error_code'',''updated_at'']',
  'array[''desired_revision'',''status'',''attempts'',''claim_token'',''lease_until'',''claim_missing'',''error_code'',''updated_at'',''completed_hash'']');
 if d=o then raise exception 'derivative_publish_definition';end if;
 n:=E' then raise exception ''derivative_journal_consumer'';end if;\n';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'derivative_publish_definition';end if;
 d:=replace(d,n,n||E' if j.after_row->>''status'' is distinct from ''done'' and j.after_row->''completed_hash'' is distinct from j.before_row->''completed_hash'' then raise exception ''derivative_journal_consumer'';end if;\n');
 n:=E'  else raise exception ''derivative_journal_recovery'';end if;';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'derivative_publish_definition';end if;
 execute replace(d,n,E'  elsif j.after_row->>''status''=''done'' then\n   if e.phase<>''published'' or w.status not in (''active'',''completed'') or j.after_row->>''claim_token'' is not null or j.after_row->>''lease_until'' is not null or j.after_row->>''claim_missing'' is not null or j.after_row->>''error_code'' is not null or\n    j.after_row->''completed_hash'' is distinct from j.after_row->''desired_hash'' or j.after_row->''desired_hash'' is distinct from e.canonical->''hash'' then raise exception ''derivative_journal_recovery'';end if;\n'||n);
end$$;

-- A definite provider failure (an HTTP error response: no result, not billed):
-- the lifecycle closes as `failed`, the job returns to pending, the work completes.
-- A lost response stays unknown (`uncertain`) as before.
do $$declare d text;n text;o text;begin
 d:=pg_get_functiondef('person_private.derivative_consumer_write(uuid,text,jsonb,jsonb)'::regprocedure);
 n:='(e.phase in (''retry'',''superseded'',''published'') and p_new-''seal_hash'' is distinct from p_old-''seal_hash'')';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'derivative_failed_definition';end if;
 d:=replace(d,n,'(e.phase in (''retry'',''superseded'',''published'',''failed'') and p_new-''seal_hash'' is distinct from p_old-''seal_hash'')');
 n:='(e.phase in (''retry'',''superseded'',''published'') and p_new->>''status''=''completed'')';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'derivative_failed_definition';end if;
 execute replace(d,n,'(e.phase in (''retry'',''superseded'',''published'',''failed'') and p_new->>''status''=''completed'')');
 d:=pg_get_functiondef('person_private.derivative_lifecycle_deferred()'::regprocedure);
 n:=' exists(select 1 from person_private.derivative_admission_frames';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'derivative_failed_definition';end if;
 execute replace(d,n,' (e.phase=''failed'' and (w.status<>''completed'' or e.provider_started_at is null or e.vectors is not null)) or'||E'\n'||n);
 d:=pg_get_functiondef('person_private.derivative_consumer_journal_end(person_private.derivative_job_changes)'::regprocedure);
 n:='if e.phase not in (''retry'',''superseded'') or w.status<>''completed'' or j.after_row->>''claim_token'' is not null or j.after_row->>''lease_until'' is not null or j.after_row->>''claim_missing'' is not null or j.after_row->>''error_code'' is not null then';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'derivative_failed_definition';end if;
 execute replace(d,n,'if e.phase not in (''retry'',''superseded'',''failed'') or w.status<>''completed'' or j.after_row->>''claim_token'' is not null or j.after_row->>''lease_until'' is not null or j.after_row->>''claim_missing'' is not null or (j.after_row->>''error_code'' is not null and not (e.phase=''failed'' and j.after_row->>''error_code''=''provider_failed'')) then');
 -- A failed request is resolved: it does not block the person's next paid start.
 foreach n in array array['person_private.derivative_claim_begin(uuid,uuid,uuid,uuid)','person_private.derivative_provider_start(uuid,jsonb)'] loop
  d:=pg_get_functiondef(n::regprocedure);o:=d;
  d:=replace(d,'old.provider_started_at is not null and old.vectors is null','old.provider_started_at is not null and old.vectors is null and old.phase<>''failed''');
  if d=o then raise exception 'derivative_failed_definition %',n;end if;
  execute d;
 end loop;
end$$;
create function person_private.derivative_provider_failed(p_request uuid,p_http integer) returns jsonb
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.derivative_lifecycles;j public.person_derivative_jobs;w person_private.transition_work;result jsonb;
begin
 if p_http is null or p_http not between 400 and 599 then raise exception 'derivative_failure_input';end if;
 e:=person_private.derivative_consumer_context(p_request);
 if e.phase='failed' then return e.payload_result;end if;
 if e.phase<>'claimed' or e.provider_started_at is null or e.vectors is not null then raise exception 'derivative_failure_ineligible';end if;
 result:=jsonb_build_object('status','failed','http',p_http);
 e:=person_private.derivative_lifecycle_set(to_jsonb(e),to_jsonb(e)||jsonb_build_object('phase','failed','payload_result',result,'recovery_result',result));
 select * into j from public.person_derivative_jobs where candidate_id=e.candidate_id;
 if person_private.derivative_job_owned(e,j) then
  perform person_private.derivative_consumer_write(p_request,'person_derivative_jobs',to_jsonb(j),to_jsonb(j)||jsonb_build_object('status','pending','claim_token',null,'lease_until',null,'claim_missing',null,'error_code','provider_failed','updated_at',clock_timestamp()));
 end if;
 select * into w from person_private.transition_work where id=e.work_id;
 perform person_private.derivative_consumer_write(p_request,'transition_work',to_jsonb(w),to_jsonb(w)||jsonb_build_object('status','completed','finished_at',clock_timestamp()));
 return result;
end$$;
revoke all on function person_private.derivative_provider_failed(uuid,integer) from public,anon,authenticated,service_role;

-- Publish after the caller entered the consumer context (same transaction).
create function person_private.derivative_publish(p_request uuid,p_input jsonb) returns jsonb
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare e person_private.derivative_lifecycles;j public.person_derivative_jobs;w person_private.transition_work;desired jsonb:='[]'::jsonb;
 part jsonb;x jsonb;idx integer;vec jsonb;target jsonb;result jsonb;
begin
 e:=person_private.derivative_consumer_context(p_request);
 if e.phase='published' then return e.publish_result;end if;
 if not ((e.phase='stored' and e.vectors is not null) or (e.phase='claimed' and jsonb_array_length(e.missing)=0 and e.provider_started_at is null)) then raise exception 'derivative_publish_ineligible';end if;
 select * into j from public.person_derivative_jobs where candidate_id=e.candidate_id;
 if not person_private.derivative_job_owned(e,j) then return person_private.derivative_close(p_request);end if;
 perform person_private.derivative_input_check(e.candidate_id,p_input);
 if p_input->>'hash' is distinct from e.canonical->>'hash' then return person_private.derivative_close(p_request);end if;
 -- Every part of the canonical manifest, with its vector: reused or newly paid.
 for part in select value from jsonb_array_elements(e.parts) loop
  vec:=null;
  select a->'vector' into vec from jsonb_array_elements(e.available) a where a->'part'=part limit 1;
  if vec is null then
   select m.i-1 into idx from jsonb_array_elements(e.missing) with ordinality m(value,i) where m.value=part limit 1;
   if idx is not null then vec:=e.vectors->idx;end if;
  end if;
  if vec is null or not person_private.derivative_vectors_valid(jsonb_build_array(vec),1) then raise exception 'derivative_publish_vectors';end if;
  desired:=desired||jsonb_build_array(jsonb_build_object('part',part,'vector',vec));
 end loop;
 -- Same replacement as the legacy completion: keep reusable rows, delete the rest, insert the missing.
 delete from public.candidate_embeddings r where r.organization_id=e.organization_id and r.candidate_id=e.candidate_id and not exists(
  select 1 from jsonb_array_elements(desired) d where r.source_type=d->'part'->>'source_type' and r.chunk_index=(d->'part'->>'chunk_index')::int and
   r.content_hash=d->'part'->>'content_hash' and r.content=d->'part'->>'content' and r.model='text-embedding-3-small' and r.dimensions=1536);
 for x in select value from jsonb_array_elements(desired) loop
  if not exists(select 1 from public.candidate_embeddings r where r.organization_id=e.organization_id and r.candidate_id=e.candidate_id and
   r.source_type=x->'part'->>'source_type' and r.chunk_index=(x->'part'->>'chunk_index')::int and r.content_hash=x->'part'->>'content_hash') then
   insert into public.candidate_embeddings(organization_id,candidate_id,source_type,chunk_index,content,content_hash,model,dimensions,embedding)
   values(e.organization_id,e.candidate_id,x->'part'->>'source_type',(x->'part'->>'chunk_index')::int,x->'part'->>'content',x->'part'->>'content_hash',
    'text-embedding-3-small',1536,(x->>'vector')::public.vector);
  end if;
 end loop;
 if (select count(*) from public.candidate_embeddings r where r.organization_id=e.organization_id and r.candidate_id=e.candidate_id)<>jsonb_array_length(desired) then raise exception 'derivative_publish_actual';end if;
 result:=jsonb_build_object('status','published','chunks',jsonb_array_length(desired),'paid',jsonb_array_length(e.missing));
 e:=person_private.derivative_lifecycle_set(to_jsonb(e),to_jsonb(e)||jsonb_build_object('phase','published','publish_result',result));
 target:=to_jsonb(j)||jsonb_build_object('status','done','completed_hash',j.desired_hash,'claim_token',null,'lease_until',null,'claim_missing',null,'error_code',null,'updated_at',clock_timestamp());
 perform person_private.derivative_consumer_write(p_request,'person_derivative_jobs',to_jsonb(j),target);
 select * into w from person_private.transition_work where id=e.work_id;
 perform person_private.derivative_consumer_write(p_request,'transition_work',to_jsonb(w),to_jsonb(w)||jsonb_build_object('status','completed','finished_at',clock_timestamp()));
 return result;
end$$;
revoke all on function person_private.derivative_publish(uuid,jsonb) from public,anon,authenticated,service_role;
