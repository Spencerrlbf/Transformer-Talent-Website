-- PREPARED ONLY. Network Send into Transformer Talent's own pipeline once the TT
-- source fence is enforced. The Send row copies the pool person's published profile
-- and contact; it is a pipeline entry, not a source for the person. A private
-- witness lets the post-cutover audit recognize it as admitted, not as a pending
-- application. Sends into a client company's pipeline are tenant rows and are
-- unchanged.
set local lock_timeout='2s';set local statement_timeout='30s';

create table person_private.application_send_witnesses(
 application_id uuid primary key references public.website_applications(id),
 candidate_id uuid not null,transaction_id xid8 not null,row_hash text not null,
 inserted_row jsonb not null,event_id bigint not null,event_hash text not null,
 created_at timestamptz not null default clock_timestamp());
create table person_private.application_send_frames(
 backend_pid integer not null,transaction_id xid8 not null,application_id uuid not null,after_row jsonb not null,
 primary key(backend_pid,transaction_id));
do $$declare t text;begin foreach t in array array['application_send_witnesses','application_send_frames'] loop
 execute format('alter table person_private.%I enable row level security',t);
 execute format('revoke all on person_private.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
create function person_private.application_send_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'application_send_immutable';end$$;
create trigger application_send_immutable before update or delete on person_private.application_send_witnesses
 for each row execute function person_private.application_send_immutable();
create trigger application_send_no_truncate before truncate on person_private.application_send_witnesses
 for each statement execute function person_private.application_send_immutable();
create function person_private.application_send_cleanup() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from person_private.application_send_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then raise exception 'application_send_cleanup';end if;
 return null;
end$$;
create constraint trigger application_send_cleanup after insert on person_private.application_send_frames
 deferrable initially deferred for each row execute function person_private.application_send_cleanup();

create function person_private.application_send_check(o jsonb,n jsonb,p_op text) returns void language plpgsql security definer set search_path='' as $$
declare f person_private.application_send_frames;
begin
 select * into f from person_private.application_send_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if p_op<>'INSERT' or f.application_id::text is distinct from n->>'id' or f.after_row is distinct from n then raise exception 'application_send_frame';end if;
end$$;

-- One Send: the exact TT pipeline row, witnessed. Refused while draining or held.
create function public.person_network_send(p_row jsonb,p_mode text default 'live') returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare c person_private.transition_control;job text;cid uuid;n jsonb;actual jsonb;aid uuid:=gen_random_uuid();cand public.candidates;email_value text;phone_value text;published boolean;event public.person_change_events;witness jsonb;witness_at timestamptz;
 allowed text[]:=array['organization_id','name','email','linkedin_url','linkedin_username','role_ids','role_titles','status','source','candidate_id','parsed_profile','harvest_profile','screening','contact'];
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'network_send_isolation';end if;
 if p_mode not in ('legacy','shadow','live') or p_mode is null or jsonb_typeof(p_row) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_row) k where not k=any(allowed)) or
  p_row->>'organization_id' is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a' or p_row->>'source' is distinct from 'transformer_talent' or
  p_row->>'status' is distinct from 'processed' or jsonb_typeof(p_row->'role_ids') is distinct from 'array' or jsonb_array_length(p_row->'role_ids')<>1 or
  jsonb_typeof(p_row->'role_ids'->0) is distinct from 'string' or p_row->>'candidate_id' !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' or
  jsonb_typeof(p_row->'name') is distinct from 'string' or jsonb_typeof(p_row->'email') is distinct from 'string'
 then raise exception 'network_send_input';end if;
 job:=p_row->'role_ids'->>0;cid:=(p_row->>'candidate_id')::uuid;
 c:=person_private.transition_lock();
 if c.enabled and c.phase<>'open' then return jsonb_build_object('status','unavailable');end if;
 if p_row->>'linkedin_username' is not null then perform pg_advisory_xact_lock(72007,hashtext(p_row->>'linkedin_username'));end if;
 -- The person's writer lock serializes Sends even without a LinkedIn username.
 perform pg_advisory_xact_lock(hashtext(cid::text));
 select * into cand from public.candidates where id=cid for key share;
 if cand.id is null then return jsonb_build_object('status','candidate_not_found');end if;
 -- Identity and profile fields come from the pool person's own record, which
 -- publication keeps equal to the published profile.
 if p_row->>'linkedin_username' is distinct from cand.linkedin_username or p_row->>'linkedin_url' is distinct from cand.linkedin_url or
  p_row->>'name' is distinct from coalesce(nullif(cand.full_name,''),'Candidate') or
  p_row->'parsed_profile' is distinct from jsonb_build_object('current_title',nullif(trim(cand.current_title),''),'current_company',nullif(trim(cand.current_company),''),'location',nullif(trim(cand.location),''))
 then raise exception 'network_send_profile';end if;
 -- Resolve the same effective contact as poolEmails / publishedPoolContacts while
 -- holding the candidate writer lock. An old caller snapshot is never admitted.
 select p_mode='live' and exists(select 1 from public.person_projection_state where candidate_id=cid) into published;
 if published then
  if not exists(select 1 from public.person_projection_state p join public.candidate_profile_state st on st.candidate_id=p.candidate_id and st.rev=p.revision where p.candidate_id=cid)
   or exists(select 1 from public.person_source_holds where candidate_id=cid and resolved_at is null) then return jsonb_build_object('status','unavailable');end if;
  select value_normalized into email_value from public.candidate_contacts where candidate_id=cid and kind='email' and rank is not null and status='active' and not never_primary and public.tt_email_check_class(quality,result)<>'bad' order by rank,value_normalized collate "C" limit 1;
  select value_normalized into phone_value from public.candidate_contacts where candidate_id=cid and kind='phone' and rank is not null and status='active' and not never_primary order by rank,value_normalized collate "C" limit 1;
 else
  email_value:=nullif(trim(coalesce(cand.contact->>'email',cand.email)),'');
  phone_value:=coalesce(nullif(trim(cand.contact->>'phone'),''),nullif(trim(cand.phone),''));
  if email_value is null then
   select trim(e.email) into email_value from (
    select email_address::text email,email_type,is_primary,quality,result from public.candidate_emails where candidate_id=cid
    union all select email_normalized::text,email_type,is_primary,quality,result from public.candidate_emails_v2 where candidate_id=cid
   ) e where nullif(trim(e.email),'') is not null and e.quality is distinct from 'bad' and e.result is distinct from 'invalid'
   order by (case when e.quality='good' and e.result='ok' then 0 else 10 end)+(case when e.email_type='personal' then 0 else 2 end)+(case when e.is_primary then 0 else 1 end),lower(trim(e.email)) collate "C",trim(e.email) collate "C" limit 1;
  end if;
 end if;
 if p_row->>'email' is distinct from coalesce(email_value,'') or
  coalesce(p_row->'contact','null'::jsonb) is distinct from (case when published or email_value is not null or phone_value is not null then jsonb_build_object('email',email_value,'phone',phone_value) else 'null'::jsonb end)
 then return jsonb_build_object('status','contact_changed');end if;
 if exists(select 1 from public.website_applications where organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a' and candidate_id=cid and role_ids @> array[job]) then
  return jsonb_build_object('status','already_sent');end if;
 n:=to_jsonb(jsonb_populate_record(null::public.website_applications,
  jsonb_build_object('id',aid,'created_at',clock_timestamp(),'role_titles','[]'::jsonb,'preferred_locations','[]'::jsonb,'preferred_roles','[]'::jsonb,'preferred_workplace','[]'::jsonb)||p_row));
 insert into person_private.application_send_frames values(pg_backend_pid(),pg_current_xact_id(),aid,n);
 insert into public.website_applications select (jsonb_populate_record(null::public.website_applications,n)).*;
 select to_jsonb(t) into actual from public.website_applications t where id=aid;
 if actual is distinct from n then raise exception 'network_send_actual';end if;
 delete from person_private.application_send_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 select * into event from public.person_change_events where candidate_id=cid and source_table='website_applications' and source_row_id=aid::text and operation='INSERT' and transaction_id=pg_current_xact_id();
 if event.id is null or event.previous_payload is not null or event.payload is distinct from actual-array['resume_embedding','matching_embedding','resume_text','notes'] or
  (select count(*) from public.person_change_events where candidate_id=cid and source_table='website_applications' and source_row_id=aid::text and operation='INSERT' and transaction_id=pg_current_xact_id())<>1 then raise exception 'network_send_witness';end if;
 witness_at:=clock_timestamp();
 witness:=jsonb_build_object('application_id',aid,'candidate_id',cid,'transaction_id',pg_current_xact_id(),'row_hash',md5(actual::text),'inserted_row',actual,'event_id',event.id,'event_hash',md5(jsonb_build_array(event.id,event.candidate_id,event.source_table,event.source_row_id,event.operation,event.transaction_id::text,event.previous_payload,event.payload)::text),'created_at',witness_at);
 insert into person_private.application_send_witnesses select (jsonb_populate_record(null::person_private.application_send_witnesses,witness)).*;
 if (select to_jsonb(w) from person_private.application_send_witnesses w where application_id=aid) is distinct from witness then raise exception 'network_send_witness';end if;
 return jsonb_build_object('status','sent','applicationId',aid);
end$$;

do $$declare d text;n text;begin
 -- The TT source fence accepts exactly the witnessed Send row.
 d:=pg_get_functiondef('person_private.application_source_guard()'::regprocedure);
 n:='if not person_private.normalization_required() then return coalesce(new,old);end if;';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'network_send_definition';end if;
 execute replace(d,n,n||E'\n if exists(select 1 from person_private.application_send_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then perform person_private.application_send_check(o,n,tg_op);return new;end if;');
 -- The audit snapshot carries this person's Send witnesses.
 d:=pg_get_functiondef('person_private.postcutover_snapshot(uuid)'::regprocedure);
 n:='result:=result||jsonb_build_object(''application_receipts'',part);';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'network_send_snapshot_definition';end if;
 execute replace(d,n,n||E'\n if (select count(*) from person_private.application_send_witnesses where candidate_id=p_candidate)>200 then return jsonb_build_object(''candidate_id'',p_candidate,''status'',''review'',''reason'',''application_sends_limit'');end if;\n result:=result||jsonb_build_object(''application_sends'',(select coalesce(jsonb_agg(to_jsonb(w)||jsonb_build_object(''transaction_id'',w.transaction_id::text,''event_id'',w.event_id::text,''actual_row_hash'',md5(w.inserted_row::text),''insert_event'',(select to_jsonb(e)||jsonb_build_object(''id'',e.id::text,''transaction_id'',e.transaction_id::text,''actual_event_hash'',md5(jsonb_build_array(e.id,e.candidate_id,e.source_table,e.source_row_id,e.operation,e.transaction_id::text,e.previous_payload,e.payload)::text)) from public.person_change_events e where e.id=w.event_id)) order by w.application_id),''[]''::jsonb) from person_private.application_send_witnesses w where w.candidate_id=p_candidate));\n if octet_length(result::text)>8000000 then return jsonb_build_object(''candidate_id'',p_candidate,''status'',''review'',''reason'',''snapshot_size_limit'');end if;');
end$$;

revoke all on function person_private.application_send_check(jsonb,jsonb,text),person_private.application_send_cleanup(),person_private.application_send_immutable() from public,anon,authenticated,service_role;
revoke all on function public.person_network_send(jsonb,text) from public,anon,authenticated;
grant execute on function public.person_network_send(jsonb,text) to service_role;
