-- Prepared writer evidence helpers. No live writer activation or source repair.
set local lock_timeout='3s';
create function person_private.audit_candidate_hash(p_row jsonb) returns text
language sql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
 select encode(sha256(convert_to(jsonb_object_agg(k,case
  when k in ('created_at','linkedin_enrichment_date') and p_row->>k is not null
   then to_jsonb(extract(epoch from (p_row->>k)::timestamptz))
  else coalesce(p_row->k,'null'::jsonb) end)::text,'UTF8')),'hex')
 from unnest(array['id','created_at','source','full_name','headline','profile_summary','location','profile_picture_url',
 'linkedin_username','linkedin_url','airtable_id','directory_contact_id','email','phone','contact','work_experience',
 'education','education_schools','education_degrees','education_fields','top_skills','all_skills_text','skills_endorsements',
 'linkedin_data','linkedin_enrichment_date','current_title','current_company','current_company_id','previous_companies'])k;
$$;
revoke all on function person_private.audit_candidate_hash(jsonb) from public,anon,authenticated;
grant execute on function person_private.audit_candidate_hash(jsonb) to service_role;
-- Suppression alone admits no normalized facts. A later anchor still needs a
-- fresh historical verification, exact source witness, and no unresolved hold.
do $$declare definition text; needle text:='or exists(select 1 from public.person_directory_receipts where candidate_id=p_candidate)'; replacement text:=$replace$or exists(select 1 from public.person_directory_receipts d where d.candidate_id=p_candidate and not (
 d.phase='suppressed' and not d.created_person and not d.projected and coalesce(d.documents,'[]'::jsonb)='[]'::jsonb and d.source_reviews='[]'::jsonb
 and d.result->>'status' is not distinct from 'suppressed' and d.result->>'candidateId' is not distinct from p_candidate::text
 and d.result->>'created' is not distinct from 'false'
 and (d.snapshot->'board'->>'do_not_contact'='true' or d.snapshot->'board'->>'status'='Do Not Contact') is true))$replace$;
begin
 definition:=pg_get_functiondef('person_private.audit_anchor_snapshot(uuid)'::regprocedure);
 if position(needle in definition)=0 then raise exception 'audit_anchor_definition_changed';end if;
 execute replace(definition,needle,replacement);
end$$;

-- Install before preparing anchors. JSON timestamp rendering must not depend
-- on which app/CLI connection happened to produce or validate the proof.
alter function person_private.audit_anchor_snapshot(uuid) set timezone='UTC';
alter function person_private.audit_anchor_snapshot(uuid) set datestyle='ISO,YMD';
create function person_private.audit_auxiliary_proof(p_candidate uuid) returns jsonb
language sql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
 with inputs as (
 select 'legacy_hash' k,coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') rows from (select * from public.candidate_emails where candidate_id=p_candidate order by id limit 1001)x
 union all select 'v2_hash',coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') from (select * from public.candidate_emails_v2 where candidate_id=p_candidate order by id limit 1001)x
 union all select 'outreach_hash',coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') from (select id,candidate_id,communication_type,status,email_used,communication_date,response_date from public.candidate_communications where candidate_id=p_candidate and communication_type='email' and status in ('bounced','replied') order by id limit 1001)x)
 select jsonb_build_object('proof',jsonb_object_agg(k,md5(rows::text)),'n',max(jsonb_array_length(rows))) from inputs;
$$;
revoke all on function person_private.audit_auxiliary_proof(uuid) from public,anon,authenticated;
grant execute on function person_private.audit_auxiliary_proof(uuid) to service_role;
