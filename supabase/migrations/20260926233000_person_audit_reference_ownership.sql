-- PREPARED ONLY. Candidate-owned reference proof for the separate auditor.
-- No candidate/source repairs or restrictive writer guards are enabled here.
set local lock_timeout='2s';
set local statement_timeout='30s';

-- Same committed epoch gate as receipts, with OLD and NEW owners retained.
-- Reference-only updates: ranking, sighting timestamps and revision-only noise
-- do not produce markers. Source envelope fields are precisely those witnessed.
create trigger person_postcutover_reference_epoch after insert or update or delete on public.candidate_contacts
 for each row execute function person_private.audit_epoch('id,candidate_id,source_id,source');
create trigger person_postcutover_reference_epoch after insert or update or delete on public.candidate_identities
 for each row execute function person_private.audit_epoch('candidate_id,source_id');
create trigger person_postcutover_reference_epoch after insert or update or delete on public.candidate_educations
 for each row execute function person_private.audit_epoch('candidate_id,source_id');
create trigger person_postcutover_reference_epoch after insert or update or delete on public.candidate_skills
 for each row execute function person_private.audit_epoch('candidate_id,source_id');
create trigger person_postcutover_reference_epoch after insert or update or delete on public.candidate_profile_state
 for each row execute function person_private.audit_epoch('candidate_id,lists_source_id,jobs_source_id,educations_source_id,skills_source_id,header');
create trigger person_postcutover_reference_epoch after insert or update or delete on public.candidate_sources
 for each row execute function person_private.audit_epoch('id,candidate_id,source,source_ref,payload_hash,parser_version,provider,raw_in,enrichment_id,fetched_at');
create trigger person_postcutover_reference_insert after insert on public.candidate_experiences
 for each row when (new.source='person') execute function person_private.audit_epoch('candidate_id,source_id,source');
create trigger person_postcutover_reference_update after update on public.candidate_experiences
 for each row when (old.source='person' or new.source='person') execute function person_private.audit_epoch('candidate_id,source_id,source');
create trigger person_postcutover_reference_delete after delete on public.candidate_experiences
 for each row when (old.source='person') execute function person_private.audit_epoch('candidate_id,source_id,source');

-- A malformed attribution affects both its declared owner and the owner of
-- the referenced event. Existing audit_epoch marks the first; mark the latter
-- with one primary-key lookup, without payloads or additional row locks.
create function person_private.postcutover_attribution_reference_epoch() returns trigger
language plpgsql security definer set search_path='' as $$
declare actual_owner uuid;
begin
 perform pg_advisory_xact_lock_shared(72006,0);
 select candidate_id into actual_owner from public.person_change_events where id=new.event_id;
 -- An older repeatable-read snapshot must not silently skip an event which
 -- its FK can see but its statement snapshot cannot.
 if actual_owner is null then raise exception 'audit_reference_event_unavailable';end if;
 if actual_owner is distinct from new.candidate_id then
  insert into public.person_audit_epochs(scope_kind,scope_key) values('candidate',actual_owner::text) on conflict do nothing;
 end if;
 return null;
end$$;
revoke all on function person_private.postcutover_attribution_reference_epoch() from public,anon,authenticated,service_role;
create trigger person_postcutover_reference_epoch after insert on public.person_change_attributions
 for each row execute function person_private.postcutover_attribution_reference_epoch();

-- Query attributions independently using (candidate_id,event_id). Reading only
-- event-joined rows hides misattributions pointing to a foreign event. Compact
-- references disclose no foreign payload, and fixed scalar fields bound bytes.
create function person_private.postcutover_reference_snapshot(p_candidate uuid) returns jsonb
language plpgsql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare result jsonb; refs jsonb;
begin
 result:=person_private.postcutover_snapshot(p_candidate);
 if result->>'status'<>'ready' then return result;end if;
 select coalesce(jsonb_agg(jsonb_build_object('event_id',x.event_id::text,'candidate_id',x.candidate_id,'operation_id',x.operation_id) order by x.event_id),'[]') into refs
 from (select event_id,candidate_id,operation_id from public.person_change_attributions where candidate_id=p_candidate order by event_id limit 201)x;
 if jsonb_array_length(refs)>200 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','attribution_refs_limit');end if;
 result:=result||jsonb_build_object('reference_version',1,'attribution_refs',refs);
 if octet_length(result::text)>8000000 then return jsonb_build_object('candidate_id',p_candidate,'status','review','reason','snapshot_size_limit');end if;
 return result;
end$$;
revoke all on function person_private.postcutover_reference_snapshot(uuid) from public,anon,authenticated;
grant execute on function person_private.postcutover_reference_snapshot(uuid) to service_role;

-- Version the same set-based compact boundary: every prior result is stale.
create or replace function person_private.postcutover_boundaries(p_ids uuid[] default null)
returns table(candidate_id uuid,boundary jsonb)
language sql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
 with people as materialized (
  select c.id,c.directory_contact_id from public.candidates c where p_ids is null
  union all select c.id,c.directory_contact_id from unnest(p_ids) u(id) join public.candidates c on c.id=u.id where p_ids is not null
 ),
 cap as (select e.candidate_id,max(e.id) n from public.person_change_events e join people p on p.id=e.candidate_id group by e.candidate_id),
 ep as (select e.scope_key,count(*) n from public.person_audit_epochs e where e.scope_kind='candidate' and exists(select 1 from people p where p.id::text=e.scope_key) group by e.scope_key),
 links as materialized (
  select id, directory_contact_id contact_id from people where directory_contact_id is not null
  union select r.candidate_id,r.contact_id from public.person_directory_receipts r join people p on p.id=r.candidate_id
  union select r.candidate_id,r.directory_contact_id from public.person_directory_primary r join people p on p.id=r.candidate_id
 ),
 de as (select e.scope_key,count(*) n from public.person_audit_epochs e where e.scope_kind='directory' and exists(select 1 from links l where l.contact_id::text=e.scope_key) group by e.scope_key),
 dirs as (select l.id,jsonb_agg(jsonb_build_object('contact_id',l.contact_id,'epoch',coalesce(de.n,0)::text) order by l.contact_id) proof
  from links l left join de on de.scope_key=l.contact_id::text group by l.id),
 lookup_links as materialized (
  select distinct e.candidate_id,'companies' t,e.company_id::text rid from public.candidate_experiences e join people p on p.id=e.candidate_id where e.source='person' and e.company_id is not null
  union select e.candidate_id,'schools',e.school_id::text from public.candidate_educations e join people p on p.id=e.candidate_id where e.school_id is not null
  union select e.candidate_id,'skills',e.skill_id::text from public.candidate_skills e join people p on p.id=e.candidate_id
 ),
 lookup_rows as materialized (
  select 'companies' t,c.id::text rid,md5(jsonb_build_object('id',c.id,'name',c.name,'linkedin_id',c.linkedin_id,'linkedin_username',c.linkedin_username,'linkedin_url',c.linkedin_url,'logo_url',c.logo_url,'normalized_name',c.normalized_name,'linkedin_url_normalized',c.linkedin_url_normalized,'identity_basis',c.identity_basis,'is_placeholder',c.is_placeholder,'tier',c.tier,'tier_list_version',c.tier_list_version,'merged_into',c.merged_into,'created_from',c.created_from)::text) h from public.companies c where c.id = any(array(select l.rid::uuid from lookup_links l where l.t='companies'))
  union all select 'schools',x.id::text,md5(to_jsonb(x)::text) from public.schools x where x.id = any(array(select l.rid::uuid from lookup_links l where l.t='schools'))
  union all select 'skills',x.id::text,md5(to_jsonb(x)::text) from public.skills x where x.id = any(array(select l.rid::bigint from lookup_links l where l.t='skills'))
 ),
 le as (select e.table_name,e.row_id,count(*) n from public.person_postcutover_lookup_epochs e where exists(select 1 from lookup_links l where l.t=e.table_name and l.rid=e.row_id) group by e.table_name,e.row_id),
 lookups as (select l.candidate_id,
  md5(string_agg(l.t||':'||l.rid||':'||coalesce(r.h,'missing'),'|' order by l.t,l.rid)) witness,
  jsonb_agg(jsonb_build_object('key',l.t||':'||l.rid,'epoch',coalesce(le.n,0)::text) order by l.t,l.rid) epochs
  from lookup_links l left join lookup_rows r on r.t=l.t and r.rid=l.rid left join le on le.table_name=l.t and le.row_id=l.rid group by l.candidate_id)
 select p.id,jsonb_build_object('anchor_hash',a.anchor_hash,'revision',st.rev::text,'capture',coalesce(cap.n,0)::text,
  'reference_version',1,'candidate_epoch',coalesce(ep.n,0)::text,'directory_epochs',coalesce(dirs.proof,'[]'),
  'lookup_witness',coalesce(lookups.witness,md5('')),'lookup_epochs',coalesce(lookups.epochs,'[]'))
 from people p left join public.person_audit_anchors a on a.candidate_id=p.id left join public.candidate_profile_state st on st.candidate_id=p.id
 left join cap on cap.candidate_id=p.id left join ep on ep.scope_key=p.id::text left join dirs on dirs.id=p.id left join lookups on lookups.candidate_id=p.id;
$$;

create or replace function public.person_postcutover_audit_inputs_with_witness(p_ids jsonb) returns jsonb
language plpgsql stable set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare result jsonb; snapshots jsonb; ready_ids uuid[]; boundary_rows jsonb:='{}';
begin
 if current_setting('statement_timeout')::interval<=interval '0 seconds' or current_setting('statement_timeout')::interval>interval '15 seconds' then raise exception 'audit_statement_timeout';end if;
 if jsonb_typeof(p_ids) is distinct from 'array' or jsonb_array_length(p_ids) not between 1 and 20
  or (select count(distinct value::uuid) from jsonb_array_elements_text(p_ids))<>jsonb_array_length(p_ids) then raise exception 'audit_batch';end if;
 select jsonb_agg(person_private.postcutover_reference_snapshot(value::uuid) order by value) into snapshots from jsonb_array_elements_text(p_ids);
 select array_agg((x->>'candidate_id')::uuid) into ready_ids from jsonb_array_elements(snapshots)x where x->>'status'='ready';
 if cardinality(ready_ids)>0 then
  select jsonb_object_agg(candidate_id,boundary) into boundary_rows from person_private.postcutover_boundaries(ready_ids);
 end if;
 select jsonb_agg(case when octet_length(j::text)>8000000 then jsonb_build_object('candidate_id',id,'status','review','reason','snapshot_size_limit') else j end order by id)
 into result from (
  select x->>'candidate_id' id,case when x->>'status'<>'ready' then x else
   x||jsonb_build_object('boundary',boundary_rows->(x->>'candidate_id'),'lookup_witness',boundary_rows->(x->>'candidate_id')->>'lookup_witness',
    'expected_contact_ranks',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'new_rank',r.new_rank::text) order by r.id),'[]') from public.person_contact_ranks((x->>'candidate_id')::uuid) r)) end j
  from jsonb_array_elements(snapshots)x
 ) q;
 return result;
end $$;

create or replace function public.person_postcutover_audit_record_many(p_run text,p_items jsonb,p_pass integer default 1) returns jsonb
language plpgsql volatile set search_path='' set timezone='UTC' set datestyle='ISO,YMD' set lock_timeout='2s' as $$
declare r public.person_postcutover_audit_runs%rowtype; item jsonb; cid uuid; current jsonb; st text; rs text; out jsonb:='[]'; ids text[]; boundaries jsonb;
begin
 if current_setting('statement_timeout')::interval<=interval '0 seconds' or current_setting('statement_timeout')::interval>interval '15 seconds' then raise exception 'audit_statement_timeout';end if;
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'audit_isolation';end if;
 perform pg_advisory_xact_lock(72005,0);
 perform pg_advisory_xact_lock(72006,0);
 select * into r from public.person_postcutover_audit_runs where run_id=p_run for update;
 if not found or r.status<>'running' then raise exception 'audit_run_page';end if;
 if r.pass is distinct from p_pass then raise exception 'audit_run_pass';end if;
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 20 then raise exception 'audit_batch';end if;
 select array_agg(x->>'candidate_id') into ids from jsonb_array_elements(p_items) x;
 if (select count(distinct v) from unnest(ids) v)<>jsonb_array_length(p_items) then raise exception 'audit_batch';end if;
 select array_agg(x->>'candidate_id') into ids from jsonb_array_elements(p_items)x where jsonb_typeof(x->'boundary')='object';
 if cardinality(ids)>0 then select jsonb_object_agg(candidate_id,boundary) into boundaries from person_private.postcutover_boundaries(ids::uuid[]);end if;
 for item in select x from jsonb_array_elements(p_items) x loop
  cid:=(item->>'candidate_id')::uuid;
  if item->>'status' is null or item->>'status' not in ('verified','pending','review') or (jsonb_typeof(item->'boundary') is null or jsonb_typeof(item->'boundary') not in ('object','null'))
   or jsonb_typeof(coalesce(item->'checks','{}'))<>'object' or jsonb_typeof(coalesce(item->'lookup_ids','[]'))<>'array' then raise exception 'audit_item';end if;
  if not exists(select 1 from public.candidates where id=cid) then raise exception 'audit_candidate_missing';end if;
  current:=coalesce(boundaries->cid::text,'{}'::jsonb);
  -- A review reached before any boundary existed (no anchor, snapshot not
  -- ready) stays a compact review without evaluating oversized collections. Verified and pending
  -- outcomes must have been planned at exactly the current boundary.
  if jsonb_typeof(item->'boundary')='null' then
   if item->>'status'<>'review' then raise exception 'audit_item';end if;
   st:='review'; rs:=item->>'reason';
  elsif item->>'status'='verified' and item->'checks'->'reference_version' is distinct from '1'::jsonb then st:='review'; rs:='reference_proof_required';
  elsif current=item->'boundary' then st:=item->>'status'; rs:=item->>'reason';
  else st:='pending'; rs:='boundary_moved'; end if;
  insert into public.person_postcutover_audit_results(run_id,candidate_id,status,reason,boundary,lookup_ids,checks,snapshot_hash,external_hash)
  values (p_run,cid,st,rs,current,coalesce((select array_agg(v) from jsonb_array_elements_text(coalesce(item->'lookup_ids','[]')) v),'{}'),coalesce(item->'checks','{}'),item->>'snapshot_hash',r.external_start->>'hash')
  on conflict (run_id,candidate_id) do update set status=excluded.status,reason=excluded.reason,boundary=excluded.boundary,lookup_ids=excluded.lookup_ids,checks=excluded.checks,snapshot_hash=excluded.snapshot_hash,external_hash=excluded.external_hash,checked_at=clock_timestamp();
  out:=out||jsonb_build_object('candidate_id',cid,'status',st,'reason',rs);
 end loop;
 return out;
end $$;

create or replace function public.person_postcutover_audit_page(p_run text,p_after uuid,p_limit integer,p_pass integer default 1) returns jsonb
language plpgsql stable set search_path='' as $$
declare r public.person_postcutover_audit_runs%rowtype; ids uuid[]; checked_ids uuid[]; wanted jsonb; current_rows jsonb:='{}';
begin
 select * into r from public.person_postcutover_audit_runs where run_id=p_run;
 if not found or r.status<>'running' or p_limit not between 1 and r.batch then raise exception 'audit_run_page';end if;
 if r.pass is distinct from p_pass then raise exception 'audit_run_pass';end if;
 select coalesce(array_agg(id order by id),'{}') into ids from (select id from public.candidates where p_after is null or id>p_after order by id limit p_limit)x;
 if r.scope='all' then wanted:=to_jsonb(ids);
 else
  select array_agg(x.candidate_id) into checked_ids from public.person_postcutover_audit_results x
   where x.run_id=p_run and x.candidate_id=any(ids) and x.status='verified' and x.checks->'reference_version'='1'::jsonb and x.external_hash is not distinct from r.external_start->>'hash';
  if cardinality(checked_ids)>0 then select jsonb_object_agg(candidate_id,boundary) into current_rows from person_private.postcutover_boundaries(checked_ids);end if;
  select coalesce(jsonb_agg(cid order by cid),'[]') into wanted from unnest(ids)cid
   left join public.person_postcutover_audit_results x on x.run_id=p_run and x.candidate_id=cid
   where x.candidate_id is null or x.status<>'verified' or x.boundary is distinct from current_rows->cid::text or x.external_hash is distinct from r.external_start->>'hash';
 end if;
 return jsonb_build_object('ids',wanted,'after',coalesce(ids[cardinality(ids)],p_after),'examined',cardinality(ids),'exhausted',cardinality(ids)<p_limit);
end $$;

create or replace function public.person_postcutover_audit_finalize(p_run text,p_pass integer default 1) returns jsonb
language plpgsql volatile set search_path='' set timezone='UTC' set datestyle='ISO,YMD' set lock_timeout='2s' as $$
declare r public.person_postcutover_audit_runs%rowtype; eligible bigint; unverified bigint; reviews bigint; stale bigint; dir_stale bigint; lookup_stale bigint; holds bigint; dir_pending bigint; conflicts bigint; state text; external_stable boolean; ext jsonb;
begin
 if current_setting('statement_timeout')::interval<=interval '0 seconds' or current_setting('statement_timeout')::interval>interval '8 seconds' then raise exception 'audit_statement_timeout';end if;
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'audit_isolation';end if;
 perform pg_advisory_xact_lock(72005,0);
 perform pg_advisory_xact_lock(72006,0);
 select * into r from public.person_postcutover_audit_runs where run_id=p_run for update;
 if not found or r.status not in ('running','paused') then raise exception 'audit_run_finished';end if;
 if r.pass is distinct from p_pass then raise exception 'audit_run_pass';end if;
 with res as materialized(select * from public.person_postcutover_audit_results where run_id=p_run),
 cur as materialized (select * from person_private.postcutover_boundaries(array(select candidate_id from res where status='verified')))
 select count(*),count(*) filter(where res.candidate_id is null or res.status<>'verified'),count(*) filter(where res.status='review'),
  count(*) filter(where res.status='verified' and (res.checks->'reference_version' is distinct from '1'::jsonb or res.external_hash is distinct from r.external_start->>'hash' or res.boundary-array['directory_epochs','lookup_epochs','lookup_witness'] is distinct from cur.boundary-array['directory_epochs','lookup_epochs','lookup_witness'])),
  count(*) filter(where res.status='verified' and res.boundary->'directory_epochs' is distinct from cur.boundary->'directory_epochs'),
  count(*) filter(where res.status='verified' and (res.boundary->'lookup_epochs' is distinct from cur.boundary->'lookup_epochs' or res.boundary->>'lookup_witness' is distinct from cur.boundary->>'lookup_witness'))
 into eligible,unverified,reviews,stale,dir_stale,lookup_stale from public.candidates c left join res on res.candidate_id=c.id left join cur on cur.candidate_id=c.id;
 select count(*) into holds from public.person_source_holds where resolved_at is null;
 select count(*) into dir_pending from public.person_directory_state s left join public.person_directory_receipts rc on rc.id=s.latest_receipt_id
  where s.applied_receipt_id is distinct from s.latest_receipt_id or rc.phase in ('ready','review');
 select count(*) into conflicts from public.identity_conflicts where status='open';
 ext:=public.person_postcutover_audit_external_inputs();
 external_stable:=coalesce(r.scan_complete and r.external_start->>'complete'='true' and r.external_end->>'complete'='true'
  and r.external_start->>'pass'=r.pass::text and r.external_end->>'pass'=r.pass::text
  and r.external_start->>'hash'=r.external_end->>'hash'
  and r.external_start->>'scope_hash'=r.external_end->>'scope_hash' and r.external_end->>'scope_hash'=ext->>'scope_hash'
  and r.external_start->>'v2_hash'=r.external_end->>'v2_hash' and r.external_end->>'v2_hash'=ext->>'v2_hash'
  and r.external_end->>'contact_count'=ext->>'contact_count' and r.external_end->>'v2_rows'=ext->>'v2_rows',false);
 state:=case when reviews>0 then 'review_required'
  when unverified>0 or stale>0 or dir_stale>0 or lookup_stale>0 or holds>0 or dir_pending>0 or not external_stable then 'catchup_pending' else 'audited' end;
 update public.person_postcutover_audit_runs set status=state,finished_at=clock_timestamp(),updated_at=clock_timestamp(),
  counts=(select coalesce(jsonb_object_agg(status,n),'{}') from (select status,count(*) n from public.person_postcutover_audit_results where run_id=p_run group by status) x),
  notes=notes||jsonb_build_object('eligible',eligible,'unverified',unverified,'unresolved_review',reviews,'stale',stale,'directory_stale',dir_stale,'lookup_stale',lookup_stale,
   'source_date_holds',holds,'directory_pending',dir_pending,'open_identity_conflicts',conflicts,'external_stable',external_stable,'finalized_at',clock_timestamp())
  where run_id=p_run returning * into r;
 return to_jsonb(r);
end $$;
