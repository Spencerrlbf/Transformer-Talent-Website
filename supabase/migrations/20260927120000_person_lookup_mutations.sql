-- PREPARED ONLY. Exact shared lookup mutations at the existing writer sites.
set local lock_timeout='2s';set local statement_timeout='30s';
create table person_private.lookup_mutation_frames(
 backend_pid integer not null,transaction_id xid8 not null,work_id uuid not null,
 relation_name text not null,operation text not null,target_id text not null,
 before_row jsonb,after_row jsonb not null,before_seen boolean not null default false,
 after_seen boolean not null default false,primary key(backend_pid,transaction_id)
);
alter table person_private.lookup_mutation_frames enable row level security;
revoke all on person_private.lookup_mutation_frames from public,anon,authenticated,service_role;
create function person_private.lookup_mutation_guard() returns trigger language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare f person_private.lookup_mutation_frames;
begin
 if not person_private.normalization_required() then return coalesce(new,old);end if;
 select * into f from person_private.lookup_mutation_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 if f.backend_pid is null or f.relation_name<>tg_table_name or f.operation<>tg_op or tg_op not in ('INSERT','UPDATE') or
  f.target_id is distinct from to_jsonb(new)->>'id' or f.after_row is distinct from to_jsonb(new) or
  (tg_op='UPDATE' and f.before_row is distinct from to_jsonb(old)) or
  (tg_when='BEFORE' and (f.before_seen or f.after_seen)) or
  (tg_when='AFTER' and (not f.before_seen or f.after_seen)) then raise exception 'lookup_mutation_frame';end if;
 update person_private.lookup_mutation_frames set before_seen=true,after_seen=(tg_when='AFTER') where backend_pid=f.backend_pid and transaction_id=f.transaction_id;
 return new;
end$$;
do $$declare t text;begin
 foreach t in array array['companies','schools','skills'] loop
  execute format('create trigger person_lookup_mutation_before before insert or update or delete on public.%I for each row execute function person_private.lookup_mutation_guard()',t);
  execute format('create trigger person_lookup_mutation_after after insert or update or delete on public.%I for each row execute function person_private.lookup_mutation_guard()',t);
  execute format('create trigger person_lookup_mutation_truncate before truncate on public.%I for each statement execute function person_private.audit_proof_no_truncate()',t);
 end loop;
end$$;

-- Internal-only synchronous helpers. Values are calculated at the original core
-- DML sites, never supplied by a public arbitrary-row endpoint.
create function person_private.lookup_insert(p_table text,p_values jsonb,p_candidate uuid,p_source uuid) returns setof jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare f person_private.normalization_frames;e jsonb;got jsonb;actual jsonb;g person_private.lookup_mutation_frames;required boolean;defaults jsonb;
begin
 if p_table not in ('companies','schools','skills') or p_table is null then raise exception 'lookup_mutation_table';end if;
 required:=person_private.normalization_required();
 if required then f:=person_private.normalization_frame(p_candidate,p_source);if p_candidate is null or p_source is null then raise exception 'lookup_mutation_source';end if;end if;
 defaults:=jsonb_build_object('created_at',now());
 if p_table='skills' then defaults:=defaults||jsonb_build_object('id',nextval(pg_get_serial_sequence('public.skills','id')));
 else defaults:=defaults||jsonb_build_object('id',gen_random_uuid(),'updated_at',now());end if;
 if p_table='companies' then defaults:=defaults||jsonb_build_object('is_verified',false,'data_source','manual','enrichment_status','pending','is_placeholder',false);end if;
 execute format('select to_jsonb(jsonb_populate_record(null::public.%I,$1))',p_table) into e using defaults||p_values;
 if required then
  insert into person_private.lookup_mutation_frames values(pg_backend_pid(),pg_current_xact_id(),f.work_id,p_table,'INSERT',e->>'id',null,e,false,false);
 end if;
 execute format('insert into public.%I as t select (jsonb_populate_record(null::public.%I,$1)).* %s returning to_jsonb(t)',p_table,p_table,case when p_table='skills' then 'on conflict(key) do nothing' else '' end) into got using e;
 if got is not null then
  execute format('select to_jsonb(t) from public.%I t where id=$1::%s',p_table,case when p_table='skills' then 'bigint' else 'uuid' end) into actual using e->>'id';
  if got is distinct from e or actual is distinct from e then raise exception 'lookup_mutation_actual';end if;
 elsif p_table='skills' then
  select to_jsonb(s) into actual from public.skills s where s.key=e->>'key' for key share;
  if not found then raise exception 'lookup_mutation_actual';end if;
 else raise exception 'lookup_mutation_actual';end if;
 if required then
  select * into g from person_private.lookup_mutation_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
  if g.work_id is distinct from f.work_id or g.relation_name is distinct from p_table or g.operation is distinct from 'INSERT' or g.target_id is distinct from e->>'id' or g.before_row is not null or g.after_row is distinct from e or not g.before_seen or g.after_seen is distinct from (got is not null) then raise exception 'lookup_mutation_proof';end if;
  delete from person_private.lookup_mutation_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 end if;
 if got is not null then return next got;end if;return;
end$$;
create function person_private.lookup_update(p_table text,p_action text,p_id uuid,p_identity jsonb,p_candidate uuid,p_source uuid) returns void
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare f person_private.normalization_frames;b jsonb;e jsonb;patch jsonb;got jsonb;actual jsonb;g person_private.lookup_mutation_frames;required boolean;assignments text;linked uuid;
begin
 if p_table not in ('companies','schools') or p_table is null or p_action not in ('id','user','url','tier') or p_action is null then raise exception 'lookup_mutation_action';end if;
 required:=person_private.normalization_required();if required then f:=person_private.normalization_frame(p_candidate,p_source);if p_candidate is null or p_source is null then raise exception 'lookup_mutation_source';end if;end if;
 execute format('select to_jsonb(t) from public.%I t where id=$1 for no key update',p_table) into b using p_id;
 if b is null then return;end if;
 if p_table='companies' then
  -- Preserve the original conditional tier WHERE; identity branches were
  -- selected by the resolver's writer-owned/missing-identity checks.
  if p_action='tier' and (b->>'tier' is not null or coalesce((b->>'is_placeholder')::boolean,false) or b->>'created_from' is distinct from 'person_writer') then return;end if;
  if p_action='id' then patch:=jsonb_build_object('linkedin_id',p_identity->'id','identity_basis','linkedin_id');
  elsif p_action='user' then patch:=jsonb_build_object('linkedin_username',p_identity->'user','identity_basis',case when b->>'identity_basis'='linkedin_url' then 'linkedin_username' else b->>'identity_basis' end);
  elsif p_action='tier' then patch:=jsonb_build_object('tier',p_identity->'tier','tier_list_version',p_identity->'tlv');
  else raise exception 'lookup_mutation_action';end if;
 else
  if p_action='tier' and b->>'tier' is not null then return;end if;
  if p_action='id' then
   select id into linked from public.companies where linkedin_id=p_identity->>'id';
   patch:=jsonb_build_object('linkedin_org_id',p_identity->'id','identity_basis','linkedin_org_id','company_id',coalesce(nullif(b->>'company_id','')::uuid,linked));
  elsif p_action='url' then patch:=jsonb_build_object('linkedin_url_normalized',p_identity->'url');
  elsif p_action='tier' then patch:=jsonb_build_object('tier',p_identity->'tier','tier_list_version',p_identity->'tlv');
  else raise exception 'lookup_mutation_action';end if;
 end if;
 patch:=patch||jsonb_build_object('updated_at',now());
 execute format('select to_jsonb(jsonb_populate_record(null::public.%I,$1))',p_table) into e using b||patch;
 if required then insert into person_private.lookup_mutation_frames values(pg_backend_pid(),pg_current_xact_id(),f.work_id,p_table,'UPDATE',p_id::text,b,e,false,false);end if;
 select string_agg(format('%I=(jsonb_populate_record(null::public.%I,$2)).%I',k,p_table,k),',' order by k) into assignments from jsonb_object_keys(patch) k;
 execute format('update public.%I as t set %s where id=$1 returning to_jsonb(t)',p_table,assignments) into got using p_id,e;
 execute format('select to_jsonb(t) from public.%I t where id=$1',p_table) into actual using p_id;
 if got is distinct from e or actual is distinct from e then raise exception 'lookup_mutation_actual';end if;
 if required then
  select * into g from person_private.lookup_mutation_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
  if g.work_id is distinct from f.work_id or g.relation_name is distinct from p_table or g.operation is distinct from 'UPDATE' or g.target_id is distinct from p_id::text or g.before_row is distinct from b or g.after_row is distinct from e or not g.before_seen or not g.after_seen then raise exception 'lookup_mutation_proof';end if;
  delete from person_private.lookup_mutation_frames where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id();
 end if;
end$$;

create function person_private.lookup_company(i jsonb,p_candidate uuid,p_source uuid,out company_id uuid,out created boolean,out conflicts integer)
language plpgsql security definer set search_path='' as $$begin
 if person_private.normalization_required() then perform person_private.normalization_frame(p_candidate,p_source);if p_candidate is null or p_source is null then raise exception 'lookup_mutation_source';end if;end if;
 select * into company_id,created,conflicts from person_private.person_company_core(i,p_candidate,p_source);
end$$;
create function person_private.lookup_school(i jsonb,p_candidate uuid,p_source uuid,out school_id uuid,out created boolean,out conflicts integer)
language plpgsql security definer set search_path='' as $$begin
 if person_private.normalization_required() then perform person_private.normalization_frame(p_candidate,p_source);if p_candidate is null or p_source is null then raise exception 'lookup_mutation_source';end if;end if;
 select * into school_id,created,conflicts from person_private.person_school_core(i,p_candidate,p_source);
end$$;
create or replace function public.person_company(i jsonb,p_candidate uuid,p_source uuid,out company_id uuid,out created boolean,out conflicts integer)
language plpgsql security definer set search_path='' as $$begin
 if person_private.normalization_gate() then raise exception 'lookup_mutation_public_resolver';end if;
 select * into company_id,created,conflicts from person_private.person_company_core(i,p_candidate,p_source);
end$$;
create or replace function public.person_school(i jsonb,p_candidate uuid,p_source uuid,out school_id uuid,out created boolean,out conflicts integer)
language plpgsql security definer set search_path='' as $$begin
 if person_private.normalization_gate() then raise exception 'lookup_mutation_public_resolver';end if;
 select * into school_id,created,conflicts from person_private.person_school_core(i,p_candidate,p_source);
end$$;
revoke all on function person_private.lookup_mutation_guard(),person_private.lookup_insert(text,jsonb,uuid,uuid),person_private.lookup_update(text,text,uuid,jsonb,uuid,uuid),person_private.lookup_company(jsonb,uuid,uuid),person_private.lookup_school(jsonb,uuid,uuid) from public,anon,authenticated,service_role;

-- Assert every original DML/call site before replacing it; keep resolver logic.
do $patch$
declare r record;body text;
begin
 for r in select * from(values
  ('person_private.person_company_core(jsonb,uuid,uuid)',$old$update public.companies c set linkedin_id = i->>'id', identity_basis = 'linkedin_id'
          where c.id = company_id;$old$,$new$perform person_private.lookup_update('companies','id',company_id,i,p_candidate,p_source);$new$),
  ('person_private.person_company_core(jsonb,uuid,uuid)',$old$update public.companies c set linkedin_username = i->>'user',
            identity_basis = case when c.identity_basis = 'linkedin_url' then 'linkedin_username' else c.identity_basis end
          where c.id = company_id;$old$,$new$perform person_private.lookup_update('companies','user',company_id,i,p_candidate,p_source);$new$),
  ('person_private.person_company_core(jsonb,uuid,uuid)',$old$update public.companies c set tier = (i->>'tier')::smallint, tier_list_version = i->>'tlv'
      where c.id = company_id and c.tier is null and not coalesce(c.is_placeholder, false)
        and c.created_from = 'person_writer';$old$,$new$perform person_private.lookup_update('companies','tier',company_id,i,p_candidate,p_source);$new$),
  ('person_private.person_company_core(jsonb,uuid,uuid)',$old$insert into public.companies (name, linkedin_id, linkedin_username, linkedin_url, logo_url,
    normalized_name, linkedin_url_normalized, identity_basis, is_placeholder, tier, tier_list_version,
    created_from, first_seen_at, data_source, enrichment_status)
  values (
    coalesce(v_display, i->>'name', i->>'user', 'LinkedIn company ' || (i->>'id'), i->>'url'),
    i->>'id',
    case when v_user_clash is null then i->>'user' end,
    -- Only a company page URL: a search URL (no identity) is not stored in
    -- companies.linkedin_url, which is unique on the live table.
    case when v_url_clash is null and i->>'url' is not null then coalesce(i->>'raw', i->>'url') end,
    case when i->>'ph' is null then i->>'logo' end,
    coalesce(i->>'ph', i->>'norm'),
    case when v_url_clash is null then i->>'url' end,
    case when i->>'ph' is not null then 'placeholder'
         when i->>'id' is not null then 'linkedin_id'
         when i->>'user' is not null then 'linkedin_username'
         when i->>'url' is not null then 'linkedin_url'
         else 'name' end,
    i->>'ph' is not null,
    case when i->>'ph' is null then (i->>'tier')::smallint end,
    case when i->>'ph' is null and i->>'tier' is not null then i->>'tlv' end,
    'person_writer', now(), 'person_writer', null)
  returning id into company_id;$old$,$new$select (x->>'id')::uuid into company_id from person_private.lookup_insert('companies',jsonb_build_object('name',coalesce(v_display, i->>'name', i->>'user', 'LinkedIn company ' || (i->>'id'), i->>'url'),'linkedin_id',i->>'id','linkedin_username',case when v_user_clash is null then i->>'user' end,'linkedin_url',case when v_url_clash is null and i->>'url' is not null then coalesce(i->>'raw', i->>'url') end,'logo_url',case when i->>'ph' is null then i->>'logo' end,'normalized_name',coalesce(i->>'ph', i->>'norm'),'linkedin_url_normalized',case when v_url_clash is null then i->>'url' end,'identity_basis',case when i->>'ph' is not null then 'placeholder'
         when i->>'id' is not null then 'linkedin_id'
         when i->>'user' is not null then 'linkedin_username'
         when i->>'url' is not null then 'linkedin_url'
         else 'name' end,'is_placeholder',i->>'ph' is not null,'tier',case when i->>'ph' is null then (i->>'tier')::smallint end,'tier_list_version',case when i->>'ph' is null and i->>'tier' is not null then i->>'tlv' end,'created_from','person_writer','first_seen_at',now(),'data_source','person_writer','enrichment_status',null),p_candidate,p_source) x;$new$),
  ('person_private.person_school_core(jsonb,uuid,uuid)',$old$update public.schools s set linkedin_org_id = i->>'id', identity_basis = 'linkedin_org_id',
          company_id = coalesce(s.company_id, (select c.id from public.companies c where c.linkedin_id = i->>'id')),
          updated_at = now()
        where s.id = school_id;$old$,$new$perform person_private.lookup_update('schools','id',school_id,i,p_candidate,p_source);$new$),
  ('person_private.person_school_core(jsonb,uuid,uuid)',$old$update public.schools s set linkedin_url_normalized = i->>'url', updated_at = now()
        where s.id = school_id;$old$,$new$perform person_private.lookup_update('schools','url',school_id,i,p_candidate,p_source);$new$),
  ('person_private.person_school_core(jsonb,uuid,uuid)',$old$update public.schools s set tier = (i->>'tier')::smallint, tier_list_version = i->>'tlv', updated_at = now()
      where s.id = school_id and s.tier is null;$old$,$new$perform person_private.lookup_update('schools','tier',school_id,i,p_candidate,p_source);$new$),
  ('person_private.person_school_core(jsonb,uuid,uuid)',$old$insert into public.schools (name, normalized_name, linkedin_org_id, linkedin_url_normalized, identity_basis,
    company_id, logo_url, tier, tier_list_version, created_from)
  values (
    coalesce(i->>'name', substring(i->>'url' from '/([^/]+)$'), 'LinkedIn school ' || (i->>'id')),
    coalesce(i->>'norm', substring(i->>'url' from '/([^/]+)$'), i->>'id'),
    i->>'id',
    case when v_url_clash is null then i->>'url' end,
    case when i->>'id' is not null then 'linkedin_org_id' when i->>'url' is not null then 'linkedin_url' else 'name' end,
    case when i->>'id' is not null then (select c.id from public.companies c where c.linkedin_id = i->>'id') end,
    i->>'logo',
    (i->>'tier')::smallint,
    case when i->>'tier' is not null then i->>'tlv' end,
    'person_writer')
  returning id into school_id;$old$,$new$select (x->>'id')::uuid into school_id from person_private.lookup_insert('schools',jsonb_build_object('name',coalesce(i->>'name', substring(i->>'url' from '/([^/]+)$'), 'LinkedIn school ' || (i->>'id')),'normalized_name',coalesce(i->>'norm', substring(i->>'url' from '/([^/]+)$'), i->>'id'),'linkedin_org_id',i->>'id','linkedin_url_normalized',case when v_url_clash is null then i->>'url' end,'identity_basis',case when i->>'id' is not null then 'linkedin_org_id' when i->>'url' is not null then 'linkedin_url' else 'name' end,'company_id',case when i->>'id' is not null then (select c.id from public.companies c where c.linkedin_id = i->>'id') end,'logo_url',i->>'logo','tier',(i->>'tier')::smallint,'tier_list_version',case when i->>'tier' is not null then i->>'tlv' end,'created_from','person_writer'),p_candidate,p_source) x;$new$),
  ('person_private.save_person_core(jsonb)',$old$public.person_company(v_i, v_cid, v_source_id)$old$,$new$person_private.lookup_company(v_i, v_cid, v_source_id)$new$),
  ('person_private.save_person_core(jsonb)',$old$public.person_school(v_i, v_cid, v_source_id)$old$,$new$person_private.lookup_school(v_i, v_cid, v_source_id)$new$),
  ('person_private.save_person_core(jsonb)',$old$insert into public.skills (name, key) values (v_row.name, v_row.key) on conflict (key) do nothing
      returning id into v_skill_id;$old$,$new$select (x->>'id')::bigint into v_skill_id from person_private.lookup_insert('skills',jsonb_build_object('name',v_row.name,'key',v_row.key),v_cid,v_source_id) x;$new$)
 ) x(signature,old_text,new_text) loop
  body:=pg_get_functiondef(r.signature::regprocedure);
  if (length(body)-length(replace(body,r.old_text,'')))/length(r.old_text)<>1 then raise exception 'lookup_mutation_definition';end if;
  execute replace(body,r.old_text,r.new_text);
 end loop;
end$patch$;
