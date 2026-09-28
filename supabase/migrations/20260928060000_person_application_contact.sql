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
