-- Forward upgrade for databases that installed the earlier
-- 20260928060000_person_application_contact.sql body (the reviewed copy did).
-- Replaces person_application_contact_fill with the release definition, which
-- accepts the " ext NNN" phone extension that contact extraction already
-- produces (release review RR-11). Identical to the chain file's definition;
-- scripts/person-release-upgrade/test-forward-definitions.mjs proves that.
-- Fresh installs reach the same definition from the chain file, so this is a
-- no-op there. Data is untouched.
set local lock_timeout='2s';set local statement_timeout='30s';

create or replace function public.person_application_contact_fill(p_application uuid,p_phone text,p_emails jsonb) returns jsonb
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
