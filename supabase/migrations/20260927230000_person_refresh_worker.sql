-- Prepared worker admission only. Do not install or activate before release.
-- Keep the fixed Unicode contract and all ownership history authoritative.
do $patch$ declare d text;n text;begin
 d:=pg_get_functiondef('person_private.refresh_claim(uuid,uuid,uuid,uuid,integer,boolean)'::regprocedure);
 n:='if a.queue_id is not null and prior.request_id is null then';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'refresh_claim_definition';end if;
 d:=replace(d,n,'if prior.request_id is null and (a.queue_id is not null or exists(select 1 from person_private.refresh_heads where queue_id=p_queue) or exists(select 1 from person_private.refresh_lifecycles where queue_id=p_queue)) then');
 n:='(length(username) not between 1 and 200 or username ~ ''[[:space:]/?#%]'')';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'refresh_claim_identity_definition';end if;
 execute replace(d,n,'person_private.application_accept_username(username) is distinct from true');
end $patch$;

create function person_private.refresh_worker_cached(p_candidate uuid,p_org uuid,p_username text) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.candidate_enrichments where candidate_id=p_candidate and organization_id=p_org and lower(linkedin_username)=p_username and provider='harvest' and operation='full_profile' and status='ok' and cache_status='miss' and raw_payload is not null and created_at between statement_timestamp()-interval '30 days' and statement_timestamp())
$$;
-- Nonlocking observation. Claim/recovery recheck under the established lock order.
-- Damage is explicitly counted as review, never transformed into pristine work.
create function person_private.refresh_worker_kind(p_queue uuid) returns text language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare q public.refresh_queue;e person_private.refresh_lifecycles;w person_private.transition_work;u text;begin
 select * into q from public.refresh_queue where id=p_queue;
 if q.id is null or q.organization_id<>'801865a7-6533-41d2-9c45-e4a90e6ad51a' then return 'review';end if;
 select * into e from person_private.refresh_lifecycles where request_id=(select request_id from person_private.refresh_heads where queue_id=p_queue);
 if e.request_id is null then
  if exists(select 1 from public.person_refresh_attempts where queue_id=p_queue) or exists(select 1 from person_private.refresh_heads where queue_id=p_queue) or exists(select 1 from person_private.refresh_lifecycles where queue_id=p_queue) then return 'review';end if;
  select lower(btrim(linkedin_username)) into u from public.candidates where id=q.candidate_id;
  if person_private.application_accept_username(u) is distinct from true or not exists(select 1 from public.candidate_profile_state where candidate_id=q.candidate_id) or exists(select 1 from public.person_source_holds where candidate_id=q.candidate_id and resolved_at is null) then return 'review';end if;
  if q.status in ('queued','patch_failed') then return 'pristine';end if;return 'review';
 end if;
 perform person_private.refresh_images(e.request_id);
 select * into w from person_private.transition_work where id=e.work_id;
 if e.phase='done' then
  if person_private.refresh_save_completion_valid(e.request_id) is distinct from true then return 'review';end if;return 'done';
 elsif e.phase='review' and w.status='completed' then return 'review';
 elsif e.phase='uncertain' and w.status='uncertain' then return 'uncertain';
 elsif e.phase='retry' and w.status='completed' then return 'retry';
 elsif e.phase='claimed' and w.status='active' then
  if w.lease_until<=clock_timestamp() then return 'expired';end if;return 'active';
 end if;return 'review';
exception when others then return 'review';end$$;

create function person_private.refresh_worker_pick(p_org uuid,p_limit integer) returns jsonb language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare ctl person_private.transition_control;result jsonb;begin
 ctl:=person_private.refresh_scope(p_org);
 if p_limit is null or p_limit not between 1 and 500 then raise exception 'refresh_worker_input';end if;
 if ctl.enabled and ctl.phase='held' then return jsonb_build_object('phase','held','recovery','[]'::jsonb,'queued','[]'::jsonb,'review',0,'uncertain',0);end if;
 with classified as materialized (
  select q.id,q.candidate_id,q.priority,q.queued_at,person_private.refresh_worker_kind(q.id) kind,
   person_private.refresh_worker_cached(q.candidate_id,p_org,lower(btrim(c.linkedin_username))) cached
  from public.refresh_queue q join public.candidates c on c.id=q.candidate_id
  where q.organization_id=p_org and q.status in ('queued','patch_failed')
 ), recoverable as materialized (
  select distinct on(candidate_id) * from classified where kind in ('retry','expired') order by candidate_id,priority,queued_at,id
 ), recovery as materialized (
  select * from recoverable order by priority,queued_at,id limit 50
 ), pristine as materialized (
  select distinct on(candidate_id) * from classified x where kind='pristine' and not exists(select 1 from recoverable r where r.candidate_id=x.candidate_id)
   and not exists(select 1 from classified owned where owned.candidate_id=x.candidate_id and owned.kind in ('active','uncertain','review'))
  order by candidate_id,cached desc,priority,queued_at,id
 ), queued as materialized (
  select * from pristine where not ctl.enabled or ctl.phase='open' order by cached desc,priority,queued_at,id limit p_limit
 ) select jsonb_build_object('phase',case when ctl.enabled then ctl.phase else 'open' end,
  'recovery',coalesce((select jsonb_agg(jsonb_build_object('organizationId',e.organization_id,'queueId',e.queue_id,'requestId',e.request_id,'token',e.claim_result->>'token','dailyCap',e.options->'dailyCap','allowPaid',e.options->'allowPaid','candidateId',e.candidate_id) order by r.priority,r.queued_at,r.id) from recovery r join person_private.refresh_heads h on h.queue_id=r.id join person_private.refresh_lifecycles e on e.request_id=h.request_id),'[]'::jsonb),
  'queued',coalesce((select jsonb_agg(jsonb_build_object('queueId',id,'candidateId',candidate_id,'freeOnly',cached) order by cached desc,priority,queued_at,id) from queued),'[]'::jsonb),
  'review',(select count(*) from classified where kind='review'),'uncertain',(select count(*) from classified where kind='uncertain')) into result;
 return result;
end$$;

create function person_private.refresh_worker_recover(p_org uuid,p_request uuid,p_queue uuid,p_token uuid) returns jsonb language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare ctl person_private.transition_control;e person_private.refresh_lifecycles;w person_private.transition_work;begin
 ctl:=person_private.refresh_scope(p_org);
 if ctl.enabled and ctl.phase='held' then return jsonb_build_object('status','held');end if;
 perform pg_advisory_xact_lock(72015,hashtext(p_request::text));
 select * into e from person_private.refresh_lifecycles where request_id=p_request;
 select * into w from person_private.transition_work where id=e.work_id for update;
 if person_private.refresh_valid(e) is distinct from true or e.queue_id is distinct from p_queue or e.organization_id is distinct from p_org or p_token is null or w.token_hash is distinct from md5(p_token::text) then raise exception 'refresh_binding';end if;
 if e.phase='done' then
  if person_private.refresh_save_completion_valid(p_request) is distinct from true then raise exception 'refresh_save_incomplete';end if;return e.recovery_result;
 end if;
 perform pg_advisory_xact_lock(72009,hashtext(e.candidate_id::text));
 perform 1 from public.refresh_queue where id=e.queue_id for update;
 perform 1 from public.person_refresh_attempts where queue_id=e.queue_id for update;
 if not exists(select 1 from person_private.refresh_heads where queue_id=p_queue and request_id=p_request) then return jsonb_build_object('status','busy');end if;
 perform person_private.refresh_images(p_request);
 -- Historical completed work can survive a controller seal/reopen generation.
 if w.status='completed' and e.phase in ('retry','review') and e.recovery_result is not null then return e.recovery_result;end if;
 if w.status='uncertain' and e.phase='uncertain' then return jsonb_build_object('status','uncertain');end if;
 if w.status<>'active' or e.phase<>'claimed' then raise exception 'refresh_recovery_state';end if;
 if w.lease_until>clock_timestamp() then return jsonb_build_object('status','busy');end if;
 return person_private.refresh_fail(p_org,p_request,p_queue,p_token);
end$$;

-- One bounded local scan replaces paged REST reads. Never examines more than
-- the first 20,000 engaged candidates or inserts more than 500 fresh queue rows.
create function person_private.refresh_worker_topup(p_org uuid,p_limit integer) returns jsonb language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare ctl person_private.transition_control;c public.candidates;q public.refresh_queue;actual public.refresh_queue;expected public.refresh_queue;n integer:=0;begin
 ctl:=person_private.refresh_scope(p_org);
 if p_limit is null or p_limit not between 1 and 500 then raise exception 'refresh_worker_input';end if;
 if ctl.enabled and ctl.phase<>'open' then return jsonb_build_object('inserted',0,'phase',ctl.phase);end if;
 for c in with bounded as materialized (
  select * from public.candidates where source in ('directory','airtable_sync') and linkedin_username is not null order by updated_at desc,id limit 20000
 ), selected as materialized (select b.* from bounded b where person_private.application_accept_username(lower(btrim(b.linkedin_username))) and exists(select 1 from public.candidate_profile_state where candidate_id=b.id)
 and not exists(select 1 from public.person_source_holds where candidate_id=b.id and resolved_at is null)
 and not exists(select 1 from public.refresh_queue where candidate_id=b.id)
 and not exists(select 1 from public.person_refresh_attempts where candidate_id=b.id)
 and not exists(select 1 from person_private.refresh_lifecycles where candidate_id=b.id)
 and not person_private.refresh_worker_cached(b.id,p_org,lower(btrim(b.linkedin_username)))
 order by b.updated_at desc,b.id limit p_limit) select * from selected order by id loop
  perform pg_advisory_xact_lock(72009,hashtext(c.id::text));
  -- Re-read after lock waits; another worker may already have admitted a row.
  select * into c from public.candidates where id=c.id for share;
  if c.id is null or c.source not in ('directory','airtable_sync') or person_private.application_accept_username(lower(btrim(c.linkedin_username))) is distinct from true or
   exists(select 1 from public.refresh_queue where candidate_id=c.id) or exists(select 1 from public.person_refresh_attempts where candidate_id=c.id) or exists(select 1 from person_private.refresh_lifecycles where candidate_id=c.id) or
   exists(select 1 from public.person_source_holds where candidate_id=c.id and resolved_at is null) or not exists(select 1 from public.candidate_profile_state where candidate_id=c.id) or person_private.refresh_worker_cached(c.id,p_org,lower(btrim(c.linkedin_username))) then continue;end if;
  expected:=jsonb_populate_record(null::public.refresh_queue,jsonb_build_object('id',gen_random_uuid(),'organization_id',p_org,'candidate_id',c.id,'linkedin_username',lower(btrim(c.linkedin_username)),'linkedin_url',person_private.application_identity_url(lower(btrim(c.linkedin_username))),'priority',50,'reason','engaged_backfill','status','queued','queued_at',clock_timestamp(),'processed_at',null));
  insert into public.refresh_queue select(expected).* on conflict(candidate_id,status) do nothing returning * into q;
  if q.id is null then
   if exists(select 1 from public.refresh_queue where candidate_id=c.id and organization_id=p_org and status='queued') then continue;end if;
   raise exception 'refresh_topup_actual';
  end if;
  select * into actual from public.refresh_queue where id=expected.id;
  if to_jsonb(q) is distinct from to_jsonb(expected) or to_jsonb(actual) is distinct from to_jsonb(expected) then raise exception 'refresh_topup_actual';end if;
  n:=n+1;
 end loop;
 return jsonb_build_object('inserted',n,'phase','open');
end$$;

do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='person_private'::regnamespace and proname like 'refresh_worker_%' loop execute format('revoke all on function %s from public,anon,authenticated,service_role',p);end loop;end$$;
