-- PREPARED ONLY. Contact edits on Transformer Talent applications (Spencer,
-- 2026-09-28): a linked applicant's contact is edited on the pool person through the
-- certified recruiter path (website code). Only an application with no linked pool
-- person edits its own contact copy, here, as a checked `contact` edit.
set local lock_timeout='2s';set local statement_timeout='30s';

create or replace function person_private.application_edit_columns(p_kind text) returns text[] language sql immutable set search_path='' as $$
 select case p_kind
  when 'followup' then array['follow_up_at','preferred_roles','preferred_locations','preferred_workplace','comp_expectation','visa_status','location']
  when 'followup_date' then array['follow_up_at']
  when 'followup_clear' then array['follow_up_at']
  when 'resume' then array['resume_path','person_resume_sha256']
  when 'roles' then array['role_ids','role_titles']
  when 'contact' then array['contact'] end
$$;

-- The contact block the drawer saves: email, phone, github and up to 8 other emails.
create function person_private.application_edit_contact_valid(p jsonb) returns boolean language sql immutable set search_path='' as $$
 select jsonb_typeof(p)='object'
  and not exists(select 1 from jsonb_object_keys(p) k where k not in ('email','phone','github','otherEmails'))
  and not exists(select 1 from jsonb_each(p) x where x.key in ('email','phone','github') and not (jsonb_typeof(x.value)='null' or (jsonb_typeof(x.value)='string' and length(x.value#>>'{}')<=200)))
  and (not (p ? 'otherEmails') or (jsonb_typeof(p->'otherEmails')='array' and jsonb_array_length(p->'otherEmails')<=8
   and not exists(select 1 from jsonb_array_elements(p->'otherEmails') e where jsonb_typeof(e)<>'string' or length(e#>>'{}')>200)))
$$;

do $$declare d text;n text;begin
 -- Value shapes: contact must be a valid contact block.
 d:=pg_get_functiondef('person_private.application_edit_valid(text,jsonb,jsonb)'::regprocedure);
 n:='  and (p_kind<>''resume'' or (p_patch ? ''resume_path'' and p_patch ? ''person_resume_sha256''))';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'application_contact_definition';end if;
 execute replace(d,n,n||E'\n  and (p_kind<>''contact'' or (p_patch ? ''contact'' and person_private.application_edit_contact_valid(p_patch->''contact'')))');
 -- A linked applicant's contact belongs to the pool person, never this copy.
 d:=pg_get_functiondef('public.person_application_edit(uuid,text,jsonb,jsonb)'::regprocedure);
 n:=' if state<>''ready'' then return jsonb_build_object(''status'',state);end if;';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'application_contact_definition';end if;
 execute replace(d,n,n||E'\n if p_kind=''contact'' and a.candidate_id is not null then return jsonb_build_object(''status'',''linked'');end if;');
 -- Contact is a result field and an intake field: accept only the exact edit frame.
 d:=pg_get_functiondef('person_private.application_result_guard()'::regprocedure);
 n:=' if not person_private.normalization_required() then return new;end if;';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'application_contact_definition';end if;
 execute replace(d,n,n||E'\n if exists(select 1 from person_private.application_edit_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then perform person_private.application_edit_check(o,n,tg_op);return new;end if;');
 d:=pg_get_functiondef('person_private.intake_mutation_guard()'::regprocedure);
 n:=E'begin\n if tg_table_name=''candidates'' and exists(select 1 from person_private.application_edit_mirror_frames';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'application_contact_definition';end if;
 execute replace(d,n,E'begin\n if tg_table_name=''website_applications'' and exists(select 1 from person_private.application_edit_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then perform person_private.application_edit_check(o,n,tg_op);return new;end if;\n if tg_table_name=''candidates'' and exists(select 1 from person_private.application_edit_mirror_frames');
end$$;
revoke all on function person_private.application_edit_contact_valid(jsonb) from public,anon,authenticated,service_role;

-- Resume contact fill for an unlinked TT application: the existing fill rule (an
-- empty phone, one unknown email appended, up to 8), decided under the row lock so a
-- concurrent recruiter save wins. Known values include the person's sourced record.
create function public.person_application_contact_fill(p_application uuid,p_phone text,p_emails jsonb) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare a public.website_applications;src jsonb;cur jsonb;known text[];extra text;others jsonb;filled jsonb:='{}'::jsonb;r jsonb;username text;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'application_edit_isolation';end if;
 if p_application is null or (p_phone is not null and (length(p_phone)>40 or p_phone !~ '^\+?[0-9 ().-]{7,40}( ext [0-9]{1,6})?$')) or jsonb_typeof(coalesce(p_emails,'[]'::jsonb))<>'array' or
  jsonb_array_length(coalesce(p_emails,'[]'::jsonb))>10 or
  exists(select 1 from jsonb_array_elements(coalesce(p_emails,'[]'::jsonb)) e where jsonb_typeof(e)<>'string' or length(e#>>'{}')>160 or e#>>'{}' !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')
 then raise exception 'application_edit_input';end if;
 perform person_private.transition_lock();
 select * into a from public.website_applications where id=p_application;
 if a.id is null or a.organization_id is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a' then return jsonb_build_object('status','not_found');end if;
 username:=a.linkedin_username;
 if username is not null then perform pg_advisory_xact_lock(72007,hashtext(username));end if;
 select * into a from public.website_applications where id=p_application for update;
 if a.candidate_id is not null then return jsonb_build_object('status','linked');end if;
 if a.linkedin_username is distinct from username then return jsonb_build_object('status','unavailable');end if;
 if username is not null then
  select s.contact into src from public.sourced_candidates s where s.organization_id=a.organization_id and s.linkedin_username=lower(username) limit 1;
 end if;
 cur:=coalesce(a.contact,'{}'::jsonb);src:=coalesce(src,'{}'::jsonb);
 known:=array(select lower(x) from unnest(array[cur->>'email',src->>'email',a.email]) x where x is not null and x<>'')||
  array(select lower(e#>>'{}') from jsonb_array_elements(coalesce(case when jsonb_typeof(cur->'otherEmails')='array' then cur->'otherEmails' end,'[]'::jsonb)||coalesce(case when jsonb_typeof(src->'otherEmails')='array' then src->'otherEmails' end,'[]'::jsonb)) e);
 if p_phone is not null and coalesce(nullif(trim(cur->>'phone'),''),nullif(trim(src->>'phone'),'')) is null then
  cur:=cur||jsonb_build_object('phone',p_phone);filled:=filled||jsonb_build_object('phone',p_phone);
 end if;
 select e#>>'{}' into extra from jsonb_array_elements(coalesce(p_emails,'[]'::jsonb)) with ordinality x(e,i) where not lower(e#>>'{}')=any(known) order by i limit 1;
 if extra is not null then
  others:=coalesce(case when jsonb_typeof(cur->'otherEmails')='array' then cur->'otherEmails' end,'[]'::jsonb);
  if jsonb_array_length(others)<8 then
   others:=others||to_jsonb(extra);cur:=cur||jsonb_build_object('otherEmails',others);filled:=filled||jsonb_build_object('otherEmails',others);
  end if;
 end if;
 if filled='{}'::jsonb then return jsonb_build_object('status','unchanged');end if;
 r:=public.person_application_edit(p_application,'contact',jsonb_build_object('contact',cur));
 return r||jsonb_build_object('filled',filled);
end$$;
revoke all on function public.person_application_contact_fill(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.person_application_contact_fill(uuid,text,jsonb) to service_role;
