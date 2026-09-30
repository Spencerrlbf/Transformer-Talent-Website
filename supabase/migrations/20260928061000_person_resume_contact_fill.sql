-- PREPARED ONLY. Authenticated resume upload gap-fill; no production activation.
-- Separate immutable evidence preserves the row shape and seals of historical
-- recruiter saves. New values are unverified/nonmanual; existing values are never
-- promoted and recruiter primary choices (including a clear) are untouched.
set local lock_timeout='2s';set local statement_timeout='30s';
create table person_private.resume_contact_fills(
 id uuid primary key references person_private.recruiter_saves(id),
 evidence jsonb not null,seal_hash text not null
);
alter table person_private.resume_contact_fills enable row level security;
revoke all on person_private.resume_contact_fills from public,anon,authenticated,service_role;

create function person_private.resume_fill_snapshot(p_org uuid,p_id uuid,p_app uuid,p_candidate uuid,p_path text,p_sha text) returns jsonb
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare ctl person_private.transition_control;a public.website_applications;username text;c jsonb;
begin
 if p_org is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a'::uuid or p_id is null or p_app is null or p_candidate is null or p_path is null or length(p_path)>180 or p_sha is null or p_sha !~ '^[a-f0-9]{64}$' or current_setting('transaction_isolation')<>'read committed' then raise exception 'resume_fill_input';end if;
 ctl:=person_private.transition_lock();
 if ctl.enabled and ctl.phase<>'open' then return jsonb_build_object('status','unavailable');end if;
 select * into a from public.website_applications where id=p_app;
 if a.organization_id is distinct from p_org then return jsonb_build_object('status','not_found');end if;
 username:=a.linkedin_username;
 if username is not null then perform pg_advisory_xact_lock(72007,hashtext(username));end if;
 select * into a from public.website_applications where id=p_app for update;
 if a.linkedin_username is distinct from username or a.organization_id is distinct from p_org or a.candidate_id is distinct from p_candidate or a.resume_path is distinct from p_path or a.person_resume_sha256 is distinct from p_sha then return jsonb_build_object('status','stale');end if;
 if person_private.application_edit_state(a)<>'ready' then return jsonb_build_object('status','unavailable');end if;
 perform pg_advisory_xact_lock(72016,hashtext(p_id::text));
 perform pg_advisory_xact_lock(hashtext(p_candidate::text));
 select to_jsonb(x) into c from public.candidates x where id=p_candidate for update;
 if c is null then return jsonb_build_object('status','not_found');end if;
 if (select count(*) from public.candidate_contacts where candidate_id=p_candidate)>1000 then raise exception 'resume_fill_contact_limit';end if;
 return jsonb_build_object('status','ready','snapshot',jsonb_build_object(
  'application',jsonb_build_object('id',a.id,'organization_id',a.organization_id,'candidate_id',a.candidate_id,'resume_path',a.resume_path,'person_resume_sha256',a.person_resume_sha256,'email',a.email),
  'contact',c->'contact','contacts',(select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') from public.candidate_contacts x where candidate_id=p_candidate),
  'choices',(select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'chosen_value',chosen_value) order by kind),'[]') from public.person_recruiter_primary where candidate_id=p_candidate)));
end$$;
create function person_private.resume_fill_phone(p text) returns text language plpgsql immutable set search_path='' as $$
declare s text;digits text;plus boolean;
begin
 if p is null then return null;end if;
 s:=regexp_replace(trim(p),'\s*(ext\.?|extension|x|#)\s*\d+\s*$','','i');
 s:=regexp_replace(s,'^(\+?\d{7,})\.\d+$','\1');plus:=left(s,1)='+' or left(s,2)='00';
 if left(s,2)='00' then s:=substr(s,3);end if;
 digits:=regexp_replace(s,'\D','','g');if length(digits)<7 or length(digits)>15 then return null;end if;
 if plus then return '+'||digits;end if;
 if length(digits)=10 and digits ~ '^[2-9]\d{2}[2-9]' then return '+1'||digits;end if;
 if length(digits)=11 and digits ~ '^1[2-9]\d{2}[2-9]' then return '+'||digits;end if;return digits;
end$$;
create function person_private.resume_fill_plan(p_snapshot jsonb,p_extracted jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare c jsonb:=coalesce(nullif(p_snapshot->'contact','null'),'{}');contacts jsonb:=p_snapshot->'contacts';phone text:=p_extracted->>'phone';phone_key text;email text;known text[];others jsonb;
begin
 if jsonb_typeof(p_extracted) is distinct from 'object' or p_extracted-array['phone','emails']<>'{}' or not(p_extracted ?& array['phone','emails']) or (phone is not null and (length(phone)>40 or phone !~ '^\+?[0-9 ().-]{7,40}( ext [0-9]{1,6})?$')) or jsonb_typeof(p_extracted->'emails') is distinct from 'array' or jsonb_array_length(p_extracted->'emails')>10 or exists(select 1 from jsonb_array_elements(p_extracted->'emails') e where jsonb_typeof(e)<>'string' or length(e#>>'{}')>160 or e#>>'{}' !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or lower(e#>>'{}')<>e#>>'{}') then raise exception 'resume_fill_extracted';end if;
 phone_key:=person_private.resume_fill_phone(phone);
 if phone_key is null or nullif(trim(c->>'phone'),'') is not null or exists(select 1 from jsonb_array_elements(p_snapshot->'choices') x where x->>'kind'='phone') or exists(select 1 from jsonb_array_elements(contacts) x where x->>'kind'='phone' and ((x->>'status'='active' and not (x->>'never_primary')::boolean) or x->>'value_normalized'=phone_key)) then phone:=null;end if;
 if jsonb_typeof(c->'otherEmails')='array' then others:=c->'otherEmails';
 else
  select coalesce(jsonb_agg(value_normalized order by rank,value_normalized),'[]') into others from (
   select x->>'value_normalized' value_normalized,(x->>'rank')::bigint rank,row_number() over(order by (x->>'rank')::bigint,x->>'value_normalized') n
   from jsonb_array_elements(contacts) x where x->>'kind'='email' and x->>'rank' is not null and x->>'status'='active' and not (x->>'never_primary')::boolean and public.tt_email_check_class(x->>'quality',x->>'result')<>'bad'
  ) q where n>1;
 end if;
 known:=array(select lower(trim(x)) from unnest(array[p_snapshot->'application'->>'email',c->>'email']) x where x is not null)||array(select lower(e#>>'{}') from jsonb_array_elements(others) e)||array(select x->>'value_normalized' from jsonb_array_elements(contacts) x where x->>'kind'='email');
 if jsonb_array_length(others)<8 then select x.e#>>'{}' into email from jsonb_array_elements(p_extracted->'emails') with ordinality x(e,i) where not (x.e#>>'{}')=any(known) order by i limit 1;end if;
 if phone is not null then c:=c||jsonb_build_object('phone',phone);end if;
 if email is not null and jsonb_typeof(c->'otherEmails')='array' then c:=c||jsonb_build_object('otherEmails',others||to_jsonb(email));end if;
 return jsonb_build_object('requested',c,'phone',phone,'email',email);
end$$;
create function person_private.resume_fill_begin(p_org uuid,p_id uuid,p_actor uuid,p_input jsonb,p_hash text,p_snapshot jsonb,p_requested jsonb,p_mode text,p_extracted jsonb) returns jsonb
language plpgsql set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare locked jsonb;plan jsonb;r jsonb;e jsonb;s person_private.recruiter_saves;
begin
 if p_input-array['applicationId','candidateId','actorId','path','sha256','extracted']<>'{}'::jsonb or p_input->>'actorId' is distinct from p_actor::text or p_input->'extracted' is distinct from p_extracted then raise exception 'resume_fill_binding';end if;
 locked:=person_private.resume_fill_snapshot(p_org,p_id,(p_input->>'applicationId')::uuid,(p_input->>'candidateId')::uuid,p_input->>'path',p_input->>'sha256');
 if locked->>'status' is distinct from 'ready' or locked->'snapshot' is distinct from p_snapshot then raise exception 'resume_fill_changed';end if;
 plan:=person_private.resume_fill_plan(p_snapshot,p_extracted);
 if plan->'requested' is distinct from p_requested or (plan->>'phone' is null and plan->>'email' is null) or exists(select 1 from person_private.recruiter_saves where id=p_id) then raise exception 'resume_fill_patch';end if;
 r:=person_private.recruiter_begin(p_org,p_id,(p_input->>'candidateId')::uuid,p_actor,p_hash,p_requested,p_mode);
 if r->>'status' is distinct from 'admitted' then raise exception 'resume_fill_admission';end if;
 select * into strict s from person_private.recruiter_saves where id=p_id;
 e:=jsonb_build_object('version',1,'input',p_input,'snapshot',p_snapshot,'requested',p_requested,'work_id',s.work_id,'organization_id',s.organization_id,'actor_id',s.actor_id,'input_hash',s.input_hash,'edited_at',s.edited_at,'mode',s.mode);
 insert into person_private.resume_contact_fills values(p_id,e,person_private.intake_hash(e));
 if (select evidence from person_private.resume_contact_fills where id=p_id) is distinct from e or (select seal_hash from person_private.resume_contact_fills where id=p_id) is distinct from person_private.intake_hash(e) then raise exception 'resume_fill_actual';end if;
 return r;
end$$;
create function person_private.resume_fill_valid(s person_private.recruiter_saves) returns boolean language plpgsql stable set search_path='' as $$
declare f person_private.resume_contact_fills;e jsonb;
begin
 select * into f from person_private.resume_contact_fills where id=s.id;e:=f.evidence;
 if f.id is null then return s.document is null or s.document->'source'->>'provider' is distinct from 'website-resume-upload';end if;
 return f.seal_hash=person_private.intake_hash(e) and e->>'work_id'=s.work_id::text and e->>'organization_id'=s.organization_id::text and e->>'actor_id'=s.actor_id::text and e->>'input_hash'=s.input_hash and (e->>'edited_at')::timestamptz=s.edited_at and e->>'mode'=s.mode and e->'requested'=s.requested_contact and e->'snapshot'->'contact'=s.candidate_before->'contact' and e->'snapshot'->'contacts'=s.prior_contacts and (s.audit_operation is null or s.audit_operation->'evidence'->'resume_fill'=e)
  and (s.transaction_id<>pg_current_xact_id() or (
   (select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'chosen_value',chosen_value) order by kind),'[]') from public.person_recruiter_primary where candidate_id=s.candidate_id)=e->'snapshot'->'choices'
   and exists(select 1 from public.website_applications a where a.id=(e->'input'->>'applicationId')::uuid and a.organization_id=s.organization_id and a.candidate_id=s.candidate_id and a.resume_path=e->'input'->>'path' and a.person_resume_sha256=e->'input'->>'sha256')));
end$$;
-- Independently check person-v3 contact labels at the certified admission boundary.
create function person_private.resume_fill_email_label(p text) returns text language sql immutable set search_path='' as $$
 select case when split_part(p,'@',2) ~ '^(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|aol|icloud|me|mac|protonmail|proton|pm|gmx|mail|yandex|qq|163|126|sina|foxmail|zoho|fastmail|hey|tutanota|tuta|rediffmail|comcast|verizon|att|sbcglobal|bellsouth|cox|charter|earthlink|naver|daum|hanmail|web|t-online|free|orange|laposte|libero|seznam|wp|o2|inbox|rambler|bk|list)\.[a-z.]+$' then 'personal'
 when split_part(p,'@',2) ~ '(^|\.)edu$|\.edu\.[a-z]{2}$|\.ac\.[a-z]{2}$' then 'academic' else 'business' end
$$;
create function person_private.resume_fill_seal(p_id uuid,p_doc jsonb,p_choices jsonb,p_flags jsonb) returns void language plpgsql set search_path='' as $$
declare s person_private.recruiter_saves;e jsonb;plan jsonb;src jsonb;item jsonb;phone text;email text;
begin
 s:=person_private.recruiter_context(p_id);select evidence into strict e from person_private.resume_contact_fills where id=p_id;
 plan:=person_private.resume_fill_plan(e->'snapshot',e->'input'->'extracted');phone:=plan->>'phone';email:=plan->>'email';src:=p_doc->'source';
 if not (src ?& array['source','provider','source_ref','fetched_at','raw_in','enrichment_id','parser_version','payload_hash']) or src-array['source','provider','source_ref','fetched_at','raw_in','enrichment_id','parser_version','payload_hash','tier_list_version']<>'{}'::jsonb or src->>'payload_hash' !~ '^[a-f0-9]{64}$' or p_doc-array['candidate_id','mode','source','identities','header','contacts']<>'{}'::jsonb or p_doc->'header' is distinct from '{"photo":null,"summary":null,"headline":null,"location":null,"full_name":null,"open_to_work":null,"current_title":null,"current_company":null,"location_country":null}'::jsonb or person_private.resume_fill_valid(s) is distinct from true or s.document is not null or p_choices is distinct from '{}'::jsonb or jsonb_typeof(p_flags) is distinct from 'array' or jsonb_array_length(p_flags)<>(phone is not null)::int+(email is not null)::int or p_doc->>'candidate_id' is distinct from s.candidate_id::text or p_doc->>'mode' is distinct from 'contacts_only' or src->>'source' is distinct from 'application' or src->>'provider' is distinct from 'website-resume-upload' or src->>'source_ref' is distinct from p_id::text or src->>'raw_in' is distinct from 'inline' or src->>'enrichment_id' is not null or (src->>'fetched_at')::timestamptz is distinct from s.edited_at or src->>'parser_version' is distinct from 'person-v3' or p_doc->'identities' is distinct from '[]'::jsonb or jsonb_typeof(p_doc->'contacts') is distinct from 'array' or jsonb_array_length(p_doc->'contacts')<>jsonb_array_length(p_flags) then raise exception 'resume_fill_document';end if;
 for item in select value from jsonb_array_elements(p_doc->'contacts') loop
  if not(item ?& array['kind','value_raw','value_normalized','label','status','never_primary','is_manual','source_detail','quality','result','resultcode','subresult','verifier','verified_at','verification_raw','legacy_email_id','legacy_email_ids','legacy_primary']) or item-array['kind','value_raw','value_normalized','label','status','never_primary','is_manual','source_detail','quality','result','resultcode','subresult','verifier','verified_at','verification_raw','legacy_email_id','legacy_email_ids','legacy_primary']<>'{}'::jsonb or item->>'label' is distinct from (case when item->>'kind'='phone' then 'unknown' else person_private.resume_fill_email_label(email) end) or item->>'kind' not in ('phone','email') or item->>'value_raw' is distinct from (case when item->>'kind'='phone' then phone else email end) or item->>'value_normalized' is distinct from (case when item->>'kind'='phone' then person_private.resume_fill_phone(phone) else email end) or item->>'status' is distinct from 'active' or item->'is_manual' is distinct from 'false'::jsonb or item->'never_primary' is distinct from 'false'::jsonb or item->>'source_detail' is distinct from 'application_resume' or exists(select 1 from jsonb_each(item) x where x.key=any(array['quality','result','resultcode','subresult','verifier','verified_at','verification_raw','legacy_email_id']) and x.value<>'null'::jsonb) or item->'legacy_primary' is distinct from 'false'::jsonb or item->'legacy_email_ids' is distinct from '[]'::jsonb then raise exception 'resume_fill_contact';end if;
  if not exists(select 1 from jsonb_array_elements(p_flags) x where x=jsonb_build_object('kind',item->>'kind','value_normalized',item->>'value_normalized','existed',false,'never_primary',null)) then raise exception 'resume_fill_flags';end if;
 end loop;
 if (select count(distinct x->>'kind') from jsonb_array_elements(p_doc->'contacts') x)<>jsonb_array_length(p_flags) then raise exception 'resume_fill_duplicates';end if;
 perform person_private.recruiter_set(to_jsonb(s),to_jsonb(s)||jsonb_build_object('document',p_doc,'choices',p_choices,'prior_flags',p_flags));
end$$;
-- Extend shared stages only at their provenance touch-points. Ordinary manual
-- seals keep their original checks; no historical row hashes are changed.
do $$declare d text;n text;begin
 d:=pg_get_functiondef('person_private.recruiter_seal(uuid,jsonb,jsonb,jsonb)'::regprocedure);n:=' s:=person_private.recruiter_context(p_id);src:=p_doc->''source'';';
 if position(n in d)=0 then raise exception 'resume_fill_definition';end if;
 execute replace(d,n,' if exists(select 1 from person_private.resume_contact_fills where id=p_id) then perform person_private.resume_fill_seal(p_id,p_doc,p_choices,p_flags);return;end if;'||n);
 d:=pg_get_functiondef('person_private.recruiter_audit_begin(uuid)'::regprocedure);n:='jsonb_build_object(''guard'',guard,''prior_contact_flags'',dx.prior_flags)';
 if position(n in d)=0 then raise exception 'resume_fill_definition';end if;
 execute replace(d,n,n||'||case when exists(select 1 from person_private.resume_contact_fills where id=p_id) then jsonb_build_object(''resume_fill'',(select evidence from person_private.resume_contact_fills where id=p_id)) else ''{}''::jsonb end');
 d:=pg_get_functiondef('person_private.recruiter_normalize(uuid)'::regprocedure);n:='cs.source=''recruiter''';if position(n in d)=0 then raise exception 'resume_fill_definition';end if;d:=replace(d,n,'cs.source=s.document->''source''->>''source''');n:='cs.provider=''website-recruiter''';if position(n in d)=0 then raise exception 'resume_fill_definition';end if;d:=replace(d,n,'cs.provider=s.document->''source''->>''provider''');
 n:='(select jsonb_agg(to_jsonb(x) order by x.kind) from public.person_recruiter_primary x where candidate_id=s.candidate_id)';if position(n in d)=0 then raise exception 'resume_fill_definition';end if;
 d:=replace(d,n,'coalesce('||n||',''[]''::jsonb)');execute d;
 d:=pg_get_functiondef('person_private.recruiter_current_valid(person_private.recruiter_saves)'::regprocedure);if position(n in d)=0 then raise exception 'resume_fill_definition';end if;execute replace(d,n,'coalesce('||n||',case when s.primary_rows=''[]''::jsonb then ''[]''::jsonb end)');
 d:=pg_get_functiondef('person_private.recruiter_completion_valid(uuid,boolean)'::regprocedure);n:=' return person_private.recruiter_valid(s) and';if position(n in d)=0 then raise exception 'resume_fill_definition';end if;execute replace(d,n,' return person_private.resume_fill_valid(s) and person_private.recruiter_valid(s) and');
end$$;
create function person_private.resume_fill_immutable() returns trigger language plpgsql set search_path='' as $$begin raise exception 'resume_fill_immutable';end$$;
create trigger resume_fill_immutable before update or delete on person_private.resume_contact_fills for each row execute function person_private.resume_fill_immutable();
create function person_private.resume_fill_deferred() returns trigger language plpgsql set search_path='' as $$begin if person_private.recruiter_completion_valid(new.id) is distinct from true then raise exception 'resume_fill_incomplete';end if;return null;end$$;
create constraint trigger resume_fill_complete after insert on person_private.resume_contact_fills deferrable initially deferred for each row execute function person_private.resume_fill_deferred();
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='person_private'::regnamespace and proname like 'resume_fill_%' loop execute format('revoke all on function %s from public,anon,authenticated,service_role',p);end loop;end$$;
