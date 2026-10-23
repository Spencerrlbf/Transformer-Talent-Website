-- PREPARED ONLY. Exact application ownership bridges; no global writer fence.
set local lock_timeout='2s';
set local statement_timeout='30s';
create table person_private.application_candidates(
 work_id uuid primary key references person_private.application_work(work_id),
 application_id uuid not null unique references public.website_applications(id),
 candidate_id uuid not null references public.candidates(id),
 linkedin_username text not null,
 created_person boolean not null,
 transaction_id xid8 not null default pg_current_xact_id()
);
create table person_private.application_harvest(
 work_id uuid primary key references person_private.application_work(work_id),
 ledger_id uuid not null unique references public.candidate_enrichments(id) deferrable initially deferred,
 payload_hash text not null,
 attached_candidate_id uuid references public.candidates(id)
);
alter table person_private.application_candidates enable row level security;
alter table person_private.application_harvest enable row level security;
revoke all on person_private.application_candidates,person_private.application_harvest from public,anon,authenticated,service_role;

-- Exclusive work ownership precedes username/application/candidate locks. A
-- controller drain never needs those business locks. No network spans this lock.
create function person_private.application_context() returns person_private.application_work
language plpgsql security definer set search_path='' as $$
declare h jsonb;wid text;tok text;a person_private.application_work;w person_private.transition_work;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'application_isolation';end if;
 h:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}');
 wid:=coalesce(nullif(current_setting('person.work_id',true),''),h->>'x-person-work-id');
 tok:=coalesce(nullif(current_setting('person.work_token',true),''),h->>'x-person-work-token');
 if wid is null or tok is null or wid !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' or tok !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then raise exception 'transition_admission';end if;
 select * into a from person_private.application_work where work_id=wid::uuid;
 if not found or a.organization_id<>'801865a7-6533-41d2-9c45-e4a90e6ad51a' then raise exception 'application_scope';end if;
 w:=person_private.transition_owned(a.work_id,tok::uuid);
 perform person_private.transition_assert('tt_person',a.organization_id,'application',a.application_id::text);
 select * into strict a from person_private.application_work where work_id=w.id for update;
 if w.status<>'active' or w.lease_until<=clock_timestamp() or w.token_hash<>md5((tok::uuid)::text) or a.effects_started_at is null or a.input_review_reason is not null then raise exception 'transition_admission';end if;
 return a;
end$$;
-- Caller takes work first; then serialize identity and prove the live owner.
create function person_private.application_source_context() returns person_private.application_work
language plpgsql security definer set search_path='' as $$
declare a person_private.application_work;
begin
 a:=person_private.application_context();
 perform pg_advisory_xact_lock(72007,hashtext(a.input_snapshot->>'linkedin_username'));
 perform 1 from public.website_applications where id=a.application_id and organization_id=a.organization_id and linkedin_username=a.input_snapshot->>'linkedin_username' for share;
 if not found then raise exception 'application_scope';end if;
 -- Lease time continues passing while business locks are contested.
 return person_private.application_context();
end$$;
create function public.person_application_intake_lock(p_application uuid) returns void
language plpgsql security definer set search_path='' as $$
declare a person_private.application_work;
begin a:=person_private.application_context();if a.application_id is distinct from p_application then raise exception 'application_scope';end if;end$$;

create function person_private.application_identity_url(p_username text) returns text
language plpgsql immutable set search_path='' as $$
declare b bytea:=convert_to(p_username,'UTF8');out text:='https://www.linkedin.com/in/';v integer;
begin
 for i in 0..length(b)-1 loop v:=get_byte(b,i);out:=out||case when v between 48 and 57 or v between 65 and 90 or v between 97 and 122 or v in(45,46,95) then chr(v) else '%'||upper(lpad(to_hex(v),2,'0')) end;end loop;
 return out;
end$$;
create function public.person_application_candidate_bind(p_application uuid,p_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a person_private.application_work;b person_private.application_candidates;app jsonb;ids uuid[];cid uuid;username text;name text;created boolean:=false;inserted boolean:=false;
begin
 a:=person_private.application_source_context();if a.application_id is distinct from p_application then raise exception 'application_scope';end if;
 username:=a.input_snapshot->>'linkedin_username';
 if username is null or username='' or username<>lower(btrim(username)) then raise exception 'application_identity';end if;
 perform pg_advisory_xact_lock(72007,hashtext(username));
 select to_jsonb(x) into app from public.website_applications x where id=a.application_id and organization_id=a.organization_id for update;
 if not found or app->>'linkedin_username' is distinct from username then raise exception 'application_scope';end if;
 select array_agg(x.id) into ids from (select id from public.candidates where linkedin_username=username union select candidate_id from public.candidate_identities where kind='linkedin_username' and value=username) x;
 select * into b from person_private.application_candidates where work_id=a.work_id;
 if found then
  if b.application_id<>a.application_id or b.linkedin_username<>username or cardinality(ids) is distinct from 1 or ids[1]<>b.candidate_id then raise exception 'application_candidate_changed';end if;
  cid:=b.candidate_id;created:=b.created_person;
 else
  -- An old mutable receipt can never bootstrap fresh work authority.
  if exists(select 1 from public.person_application_receipts where application_id=a.application_id) then raise exception 'application_legacy_receipt';end if;
  if coalesce(cardinality(ids),0)>1 then raise exception 'application_candidate_changed';end if;
  cid:=ids[1];
  if cid is null then
   cid:=gen_random_uuid();name:=coalesce(nullif(a.input_snapshot->>'name',''),nullif(p_name,''),username);
   if length(name)>10000 then raise exception 'application_name_limit';end if;
   perform pg_advisory_xact_lock(hashtext(cid::text));
   insert into public.candidates(id,full_name,first_name,last_name,linkedin_username,linkedin_url,source,status)
    values(cid,name,(regexp_split_to_array(name,'\s+'))[1],nullif(array_to_string((regexp_split_to_array(name,'\s+'))[2:2147483647],' '),''),username,person_private.application_identity_url(username),'website_applicant','applicant');
   created:=true;inserted:=true;
  end if;
  if nullif(app->>'candidate_id','') is not null and app->>'candidate_id'<>cid::text then raise exception 'application_candidate_changed';end if;
  insert into person_private.application_candidates(work_id,application_id,candidate_id,linkedin_username,created_person) values(a.work_id,a.application_id,cid,username,created);
 end if;
 perform person_private.application_context();
 return jsonb_build_object('candidate_id',cid,'created_person',created,'inserted_now',inserted);
end$$;

-- A standalone seed/reservation cannot commit a half-created candidate. Normal
-- intake produces the binding, receipt and normalized state in one transaction.
create function person_private.application_binding_complete() returns trigger
language plpgsql security definer set search_path='' as $$
declare r public.person_application_receipts;d jsonb;src jsonb;sid uuid;n integer:=0;a person_private.application_work;
begin
 a:=person_private.application_context();
 if a.work_id<>new.work_id then raise exception 'application_binding_incomplete';end if;
 select * into r from public.person_application_receipts where application_id=new.application_id and candidate_id=new.candidate_id and created_person=new.created_person;
 if not found or jsonb_array_length(r.documents)<>(case when r.harvest_ledger_id is null then 2 else 3 end) or
 not exists(select 1 from public.candidate_profile_state where candidate_id=new.candidate_id) then raise exception 'application_binding_incomplete';end if;
 for d in select value from jsonb_array_elements(r.documents) loop
  n:=n+1;src:=d->'source';
  if d->>'candidate_id' is distinct from new.candidate_id::text or src->>'parser_version' is distinct from 'person-v3' or src->>'payload_hash' is null then raise exception 'application_binding_incomplete';end if;
  if n<=2 and (src->>'source' is distinct from 'application' or src->>'provider' is distinct from (case when n=1 then 'website' else 'website-resume' end) or src->>'source_ref' is distinct from (new.application_id::text||(case when n=1 then '' else ':profile' end)) or src->>'raw_in' is distinct from 'inline' or src->>'enrichment_id' is not null) then raise exception 'application_binding_incomplete';end if;
  if n=3 and (src->>'source' is distinct from 'harvest' or src->>'enrichment_id' is distinct from r.harvest_ledger_id::text) then raise exception 'application_binding_incomplete';end if;
  select id into sid from public.candidate_sources where candidate_id=new.candidate_id and source=src->>'source' and provider is not distinct from src->>'provider' and source_ref is not distinct from src->>'source_ref' and payload_hash=src->>'payload_hash' and parser_version=src->>'parser_version' and fetched_at=(src->>'fetched_at')::timestamptz and raw_in=src->>'raw_in' and enrichment_id is not distinct from nullif(src->>'enrichment_id','')::uuid;
  if not found then raise exception 'application_binding_incomplete';end if;
  if n=1 and not exists(select 1 from public.candidate_identities where candidate_id=new.candidate_id and kind='tt_application_id' and value=new.application_id::text and source_id=sid) then raise exception 'application_binding_incomplete';end if;
 end loop;
 return null;
end$$;
create constraint trigger application_binding_complete after insert on person_private.application_candidates deferrable initially deferred for each row execute function person_private.application_binding_complete();

create function person_private.application_receipt_owned() returns trigger
language plpgsql security definer set search_path='' as $$
declare a person_private.application_work;b person_private.application_candidates;h jsonb;guarded boolean;input jsonb;
begin
 h:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}');
 guarded:=exists(select 1 from person_private.application_candidates where application_id=new.application_id or application_id=old.application_id) or
 nullif(current_setting('person.work_id',true),'') is not null or h ? 'x-person-work-id' or (select enabled from person_private.transition_control where singleton);
 if not guarded then return coalesce(new,old);end if;
 if tg_op<>'INSERT' then raise exception 'application_receipt_immutable';end if;
 a:=person_private.application_context();
 select * into b from person_private.application_candidates where work_id=a.work_id;
 if b.work_id is null or new.application_id<>a.application_id or new.candidate_id<>b.candidate_id or new.created_person<>b.created_person or
 new.application_snapshot->>'id' is distinct from a.application_id::text or new.application_snapshot->>'organization_id' is distinct from a.organization_id::text or
 new.application_snapshot->>'linkedin_username' is distinct from b.linkedin_username or jsonb_array_length(new.documents)=0 or
 exists(select 1 from jsonb_array_elements(new.documents) d where d->>'candidate_id' is distinct from b.candidate_id::text) then raise exception 'application_receipt_scope';end if;
 input:=person_private.application_work_input(new.application_snapshot);
 -- Only resolved name/contact are allowed to differ from accepted inputs.
 if (input-'name'-'contact')<>(a.input_snapshot-'name'-'contact') then raise exception 'application_receipt_input';end if;
 if new.harvest_ledger_id is not null then
  perform public.person_application_harvest_attach(new.harvest_ledger_id);
 end if;
 return new;
end$$;
create trigger application_receipt_owned before insert or update or delete on public.person_application_receipts for each row execute function person_private.application_receipt_owned();

create function public.person_application_harvest_store(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a person_private.application_work;l person_private.application_harvest;lid uuid;h text;username text;
begin
 a:=person_private.application_source_context();username:=a.input_snapshot->>'linkedin_username';
 perform pg_advisory_xact_lock(72007,hashtext(username));
 perform 1 from public.website_applications where id=a.application_id and organization_id=a.organization_id and linkedin_username=username for share;
 if not found then raise exception 'application_scope';end if;
 if p_payload is null or jsonb_typeof(p_payload) not in ('object','array') or octet_length(p_payload::text)>8388608 then raise exception 'application_harvest_payload';end if;
 h:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');select * into l from person_private.application_harvest where work_id=a.work_id;
 if found then
  if l.payload_hash<>h then raise exception 'application_harvest_changed';end if;
  return jsonb_build_object('id',l.ledger_id);
 end if;
 lid:=gen_random_uuid();
 -- Private ownership exists before the public INSERT trigger checks it.
 insert into person_private.application_harvest(work_id,ledger_id,payload_hash) values(a.work_id,lid,h);
 insert into public.candidate_enrichments(id,organization_id,candidate_id,linkedin_username,provider,operation,cache_status,status,raw_payload,cost_credits)
 values(lid,a.organization_id,null,username,'harvest','full_profile','miss','ok',p_payload,1);
 perform person_private.application_context();
 return jsonb_build_object('id',lid);
end$$;
create function public.person_application_harvest_attach(p_ledger uuid) returns void
language plpgsql security definer set search_path='' as $$
declare a person_private.application_work;b person_private.application_candidates;l person_private.application_harvest;e public.candidate_enrichments;
begin
 a:=person_private.application_source_context();select * into b from person_private.application_candidates where work_id=a.work_id;
 if b.work_id is null then raise exception 'application_candidate_required';end if;
 select * into e from public.candidate_enrichments where id=p_ledger for update;
 if not found or e.organization_id<>a.organization_id or lower(e.linkedin_username) is distinct from b.linkedin_username or e.provider<>'harvest' or e.status<>'ok' or e.cache_status<>'miss' or e.raw_payload is null or (e.candidate_id is not null and e.candidate_id<>b.candidate_id) then raise exception 'application_harvest_owner';end if;
 perform person_private.application_context();
 select * into l from person_private.application_harvest where ledger_id=p_ledger;
 if found and l.work_id<>a.work_id then
  if e.candidate_id is distinct from b.candidate_id or not exists(select 1 from person_private.application_candidates ob join public.person_application_receipts r on r.application_id=ob.application_id and r.candidate_id=ob.candidate_id and r.harvest_ledger_id=p_ledger where ob.work_id=l.work_id and ob.candidate_id=b.candidate_id) then raise exception 'application_harvest_owner';end if;
  return; -- Finalized cache reuse never mutates the first owner's evidence.
 end if;
 if l.work_id=a.work_id then update person_private.application_harvest set attached_candidate_id=b.candidate_id where work_id=a.work_id;end if;
 if e.candidate_id is null then update public.candidate_enrichments set candidate_id=b.candidate_id where id=p_ledger;end if;
 perform person_private.application_context();
end$$;
create function person_private.application_harvest_immutable() returns trigger
language plpgsql security definer set search_path='' as $$
declare l person_private.application_harvest;a person_private.application_work;b person_private.application_candidates;
begin
 select * into l from person_private.application_harvest where ledger_id=coalesce(old.id,new.id);
 if not found then return coalesce(new,old);end if;
 if tg_op='DELETE' or (tg_op='UPDATE' and (to_jsonb(new)-'candidate_id') is distinct from (to_jsonb(old)-'candidate_id')) then raise exception 'application_harvest_immutable';end if;
 if tg_op='UPDATE' and (old.candidate_id is not null or l.attached_candidate_id is null or new.candidate_id is distinct from l.attached_candidate_id) then raise exception 'application_harvest_immutable';end if;
 a:=person_private.application_context();
 if a.work_id<>l.work_id then raise exception 'application_harvest_owner';end if;
 if tg_op='INSERT' then
  if new.candidate_id is not null or new.organization_id<>a.organization_id or new.linkedin_username is distinct from a.input_snapshot->>'linkedin_username' or new.provider<>'harvest' or new.operation<>'full_profile' or new.cache_status<>'miss' or new.status<>'ok' or new.cost_credits<>1 or encode(sha256(convert_to(new.raw_payload::text,'UTF8')),'hex') is distinct from l.payload_hash then raise exception 'application_harvest_owner';end if;
 else
  select * into b from person_private.application_candidates where work_id=a.work_id;
  if b.work_id is null or old.candidate_id is not null or new.candidate_id is distinct from b.candidate_id or l.attached_candidate_id is distinct from b.candidate_id then raise exception 'application_harvest_immutable';end if;
 end if;
 return new;
end$$;
create trigger application_harvest_immutable before insert or update or delete on public.candidate_enrichments for each row execute function person_private.application_harvest_immutable();

create function public.person_application_harvest_cache(p_since timestamptz,p_ledger uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a person_private.application_work;e public.candidate_enrichments;
begin
 a:=person_private.application_source_context();
 select x.* into e from public.candidate_enrichments x left join person_private.application_harvest l on l.ledger_id=x.id
 where x.organization_id=a.organization_id and x.linkedin_username=a.input_snapshot->>'linkedin_username' and x.provider='harvest' and x.status='ok' and x.cache_status='miss' and x.raw_payload is not null
 and (case when p_ledger is null then x.created_at>=p_since else x.id=p_ledger end)
 and (l.work_id is null or l.work_id=a.work_id or exists(select 1 from person_private.application_candidates b join public.person_application_receipts r on r.application_id=b.application_id and r.candidate_id=b.candidate_id and r.harvest_ledger_id=x.id where b.work_id=l.work_id and b.candidate_id=x.candidate_id))
 order by x.created_at desc,x.id desc limit 1;
 if not found then return null;end if;
 perform person_private.application_context();
 return jsonb_build_object('id',e.id,'raw_payload',e.raw_payload);
end$$;

revoke all on function person_private.application_source_context(),person_private.application_context(),person_private.application_identity_url(text),person_private.application_binding_complete(),person_private.application_receipt_owned(),person_private.application_harvest_immutable() from public,anon,authenticated,service_role;
revoke all on function public.person_application_intake_lock(uuid),public.person_application_candidate_bind(uuid,text),public.person_application_harvest_store(jsonb),public.person_application_harvest_attach(uuid),public.person_application_harvest_cache(timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function public.person_application_intake_lock(uuid),public.person_application_candidate_bind(uuid,text),public.person_application_harvest_store(jsonb),public.person_application_harvest_attach(uuid),public.person_application_harvest_cache(timestamptz,uuid) to service_role;
