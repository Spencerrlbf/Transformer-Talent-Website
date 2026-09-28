-- PREPARED ONLY. Checked edits to Transformer Talent application rows that the
-- source fence otherwise refuses: follow-up date and preferences, the resume
-- pointer and applicant-added suggested roles, with the follow-up mirror onto the
-- linked pool person. Contact and name edits are not admitted here. Tenant rows are
-- outside the TT fence and keep their existing writers.
set local lock_timeout='2s';set local statement_timeout='30s';

create table person_private.application_edit_frames(
 backend_pid integer not null,transaction_id xid8 not null,application_id uuid not null,
 before_row jsonb not null,after_row jsonb not null,primary key(backend_pid,transaction_id));
create table person_private.application_edit_mirror_frames(
 backend_pid integer not null,transaction_id xid8 not null,candidate_id uuid not null,
 before_row jsonb not null,after_row jsonb not null,primary key(backend_pid,transaction_id));
do $$declare t text;begin foreach t in array array['application_edit_frames','application_edit_mirror_frames'] loop
 execute format('alter table person_private.%I enable row level security',t);
 execute format('revoke all on person_private.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
create function person_private.application_edit_cleanup() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from person_private.application_edit_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) or
  exists(select 1 from person_private.application_edit_mirror_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id())
 then raise exception 'application_edit_cleanup';end if;
 return null;
end$$;
create constraint trigger application_edit_cleanup after insert on person_private.application_edit_frames
 deferrable initially deferred for each row execute function person_private.application_edit_cleanup();
create constraint trigger application_edit_mirror_cleanup after insert on person_private.application_edit_mirror_frames
 deferrable initially deferred for each row execute function person_private.application_edit_cleanup();

-- Columns each kind may change. Nothing else on the row can differ.
create function person_private.application_edit_columns(p_kind text) returns text[] language sql immutable set search_path='' as $$
 select case p_kind
  when 'followup' then array['follow_up_at','preferred_roles','preferred_locations','preferred_workplace','comp_expectation','visa_status','location']
  when 'followup_date' then array['follow_up_at']
  when 'followup_clear' then array['follow_up_at']
  when 'resume' then array['resume_path']
  when 'roles' then array['role_ids','role_titles'] end
$$;
create function person_private.application_edit_mirror_columns(p_kind text) returns text[] language sql immutable set search_path='' as $$
 select case p_kind
  when 'followup' then array['follow_up_at','role_preferences','visa_status']
  when 'followup_date' then array['follow_up_at']
  when 'followup_clear' then array['follow_up_at'] end
$$;
-- Processing claims a frozen input that includes these columns, so an edit waits
-- until the application's processing has completed. Rows accepted before the new
-- path (no processing version) keep their existing editability.
create function person_private.application_edit_state(a public.website_applications) returns text language sql stable security definer set search_path='' as $$
 select case
  when a.id is null or a.organization_id is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a' then 'not_found'
  when exists(select 1 from person_private.application_work aw join person_private.transition_work w on w.id=aw.work_id where aw.application_id=a.id and w.status<>'completed') then 'processing'
  when a.person_processing_version is not null and not exists(select 1 from person_private.application_work aw join person_private.transition_work w on w.id=aw.work_id where aw.application_id=a.id and w.status='completed') then 'processing'
  else 'ready' end
$$;

create function person_private.application_edit_check(o jsonb,n jsonb,p_op text) returns void language plpgsql security definer set search_path='' as $$
declare f person_private.application_edit_frames;
begin
 select * into f from person_private.application_edit_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if p_op<>'UPDATE' or f.application_id::text is distinct from n->>'id' or f.before_row is distinct from o or f.after_row is distinct from n then raise exception 'application_edit_frame';end if;
end$$;
create function person_private.application_edit_mirror_check(o jsonb,n jsonb,p_op text) returns void language plpgsql security definer set search_path='' as $$
declare f person_private.application_edit_mirror_frames;
begin
 select * into f from person_private.application_edit_mirror_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if p_op<>'UPDATE' or f.candidate_id::text is distinct from n->>'id' or f.before_row-'updated_at' is distinct from o-'updated_at' or f.after_row-'updated_at' is distinct from n-'updated_at' then raise exception 'application_edit_mirror_frame';end if;
end$$;

create function public.person_application_edit_ready(p_application uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c person_private.transition_control;a public.website_applications;
begin
 select * into c from person_private.transition_control where singleton;
 if c.enabled and c.phase<>'open' then return jsonb_build_object('status','unavailable');end if;
 select * into a from public.website_applications where id=p_application;
 return jsonb_build_object('status',person_private.application_edit_state(a));
end$$;

create function public.person_application_edit(p_application uuid,p_kind text,p_patch jsonb,p_mirror jsonb default null) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' set datestyle='ISO,YMD' as $$
declare c person_private.transition_control;a public.website_applications;o jsonb;n jsonb;actual jsonb;cols text[];mcols text[];
 cand public.candidates;co jsonb;cn jsonb;state text;mirrored boolean:=false;sets text;username text;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'application_edit_isolation';end if;
 cols:=person_private.application_edit_columns(p_kind);mcols:=person_private.application_edit_mirror_columns(p_kind);
 if p_application is null or cols is null or p_patch is null or jsonb_typeof(p_patch)<>'object' or p_patch='{}'::jsonb or
  exists(select 1 from jsonb_object_keys(p_patch) k where not k=any(cols)) or
  (p_mirror is not null and (mcols is null or jsonb_typeof(p_mirror)<>'object' or exists(select 1 from jsonb_object_keys(p_mirror) k where not k=any(mcols))))
 then raise exception 'application_edit_input';end if;
 -- Controller, then the applicant's username, then business rows (documented order).
 c:=person_private.transition_lock();
 if c.enabled and c.phase<>'open' then return jsonb_build_object('status','unavailable');end if;
 select * into a from public.website_applications where id=p_application;
 if a.id is null or a.organization_id is distinct from '801865a7-6533-41d2-9c45-e4a90e6ad51a' then return jsonb_build_object('status','not_found');end if;
 username:=a.linkedin_username;
 if username is not null then perform pg_advisory_xact_lock(72007,hashtext(username));end if;
 select * into a from public.website_applications where id=p_application for update;
 if a.linkedin_username is distinct from username then return jsonb_build_object('status','unavailable');end if;
 state:=person_private.application_edit_state(a);
 if state<>'ready' then return jsonb_build_object('status',state);end if;
 o:=to_jsonb(a);n:=to_jsonb(jsonb_populate_record(a,p_patch));
 if n is distinct from o then
  insert into person_private.application_edit_frames values(pg_backend_pid(),pg_current_xact_id(),a.id,o,n);
  select string_agg(format('%I=r.%I',k,k),',') into sets from unnest(cols) k where p_patch ? k;
  execute format('update public.website_applications t set %s from jsonb_populate_record(null::public.website_applications,$1) r where t.id=$2',sets) using n,a.id;
  select to_jsonb(t) into actual from public.website_applications t where id=a.id;
  if actual is distinct from n then raise exception 'application_edit_actual';end if;
  delete from person_private.application_edit_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 end if;
 if p_mirror is not null and a.candidate_id is not null then
  select * into cand from public.candidates where id=a.candidate_id for update;
  if cand.id is not null then
   co:=to_jsonb(cand);cn:=to_jsonb(jsonb_populate_record(cand,p_mirror));
   if cn is distinct from co then
    insert into person_private.application_edit_mirror_frames values(pg_backend_pid(),pg_current_xact_id(),cand.id,co,cn);
    select string_agg(format('%I=r.%I',k,k),',') into sets from unnest(mcols) k where p_mirror ? k;
    execute format('update public.candidates t set %s from jsonb_populate_record(null::public.candidates,$1) r where t.id=$2',sets) using cn,cand.id;
    select to_jsonb(t) into actual from public.candidates t where id=cand.id;
    if actual-'updated_at' is distinct from cn-'updated_at' then raise exception 'application_edit_actual';end if;
    delete from person_private.application_edit_mirror_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
    mirrored:=true;
   end if;
  end if;
 end if;
 return jsonb_build_object('status','saved','changed',n is distinct from o,'mirrored',mirrored);
end$$;

-- The TT source fence and the candidate mutation fence accept only these exact frames.
do $$declare d text;n text;begin
 d:=pg_get_functiondef('person_private.application_source_guard()'::regprocedure);
 n:='if not person_private.normalization_required() then return coalesce(new,old);end if;';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'application_edit_source_definition';end if;
 execute replace(d,n,n||E'\n if exists(select 1 from person_private.application_edit_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then perform person_private.application_edit_check(o,n,tg_op);return new;end if;');
 d:=pg_get_functiondef('person_private.intake_mutation_guard()'::regprocedure);
 n:=E'begin\n if tg_table_name=''candidates'' and exists(select 1 from person_private.recruiter_frames';
 if array_length(string_to_array(d,n),1)<>2 then raise exception 'application_edit_mirror_definition';end if;
 execute replace(d,n,E'begin\n if tg_table_name=''candidates'' and exists(select 1 from person_private.application_edit_mirror_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()) then perform person_private.application_edit_mirror_check(o,n,tg_op);return new;end if;\n if tg_table_name=''candidates'' and exists(select 1 from person_private.recruiter_frames');
end$$;

do $$declare p regprocedure;begin
 for p in select oid::regprocedure from pg_proc where pronamespace='person_private'::regnamespace and proname like 'application_edit_%' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',p);
 end loop;
end$$;
revoke all on function public.person_application_edit(uuid,text,jsonb,jsonb),public.person_application_edit_ready(uuid) from public,anon,authenticated;
grant execute on function public.person_application_edit(uuid,text,jsonb,jsonb),public.person_application_edit_ready(uuid) to service_role;
