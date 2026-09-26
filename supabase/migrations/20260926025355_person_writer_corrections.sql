-- Correct the existing shadow writer. Migration 072 is already live and stays immutable.
-- No candidate profile columns are rewritten by this migration or writer.
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create or replace function public.person_source_beats(doc jsonb, p_owner uuid)
returns boolean language plpgsql stable set search_path = '' as $$
declare old public.candidate_sources%rowtype; src jsonb := doc->'source';
begin
  if p_owner is null then return true; end if;
  select * into old from public.candidate_sources where id=p_owner;
  if not found then return true; end if;
  if old.source=src->>'source' and old.source_ref is not distinct from src->>'source_ref'
     and old.fetched_at=(src->>'fetched_at')::timestamptz then
    if old.parser_version='person-v2' and src->>'parser_version'='person-v3' then return true; end if;
    if old.parser_version='person-v3' and src->>'parser_version'='person-v2' then return false; end if;
  end if;
  return public.person_doc_beats((src->>'fetched_at')::timestamptz,src->>'source',src->>'payload_hash',p_owner);
end $$;

create or replace function public.person_header_beats(p_at timestamptz,p_source text,p_hash text,p_parser text,p_old jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare old_at timestamptz := (p_old->>'at')::timestamptz; old_source text := p_old->>'source';
begin
  if p_old is null then return true; end if;
  if old_source='recruiter' and p_source<>'recruiter' then return false; end if;
  if p_source='recruiter' and old_source<>'recruiter' then return true; end if;
  if old_source='application' and p_source<>'application' then return true; end if;
  if p_source='application' and old_source<>'application' then return false; end if;
  if p_at is distinct from old_at then return p_at > old_at; end if;
  if p_source=old_source then
    if p_parser='person-v3' and coalesce(p_old->>'parser_version','person-v2')='person-v2' then return true; end if;
    if p_parser='person-v2' and p_old->>'parser_version'='person-v3' then return false; end if;
  end if;
  return public.tt_source_rank(p_source)>public.tt_source_rank(old_source)
    or (public.tt_source_rank(p_source)=public.tt_source_rank(old_source)
        and p_hash collate "C">coalesce(p_old->>'payload_hash','') collate "C");
end $$;

create or replace function public.person_contact_ranks(p_candidate uuid)
returns table (id uuid, new_rank bigint) language sql stable set search_path = '' as $$
  select x.id, case when x.eligible then row_number() over (partition by x.kind, x.eligible order by
      x.tier, x.manual_at desc nulls last, x.personal desc, x.legacy_primary desc, x.verified_at desc nulls last,
      x.first_seen_at nulls last, x.value_normalized) end as new_rank
  from (
    select cc.id, cc.kind, cc.value_normalized, cc.verified_at, cc.first_seen_at, cc.legacy_primary,
      (cc.status = 'active' and not cc.never_primary and (cc.kind <> 'email' or public.tt_email_check_class(cc.quality,cc.result)<>'bad')) as eligible,
      case when cc.is_manual then coalesce(cc.manual_at, cc.first_seen_at) end as manual_at,
      cc.label = 'personal' as personal,
      case
        when cc.is_manual then 0
        when cc.kind = 'email' then case
          when cc.source_detail = 'directory_primary' then 1
          when public.tt_email_check_class(cc.quality, cc.result) = 'good' and cc.label = 'personal' then 2
          when public.tt_email_check_class(cc.quality, cc.result) = 'good' and cc.label = 'business' then 3
          when public.tt_email_check_class(cc.quality, cc.result) = 'good' then 4
          when public.tt_email_check_class(cc.quality, cc.result) = 'risky' then 5
          else 6 end
        when cc.kind = 'phone' then case
          when cc.source = 'directory' or cc.source_detail like 'directory%' then 1
          when cc.label = 'mobile' then 2
          else 3 end
        else 1
      end as tier
    from public.candidate_contacts cc where cc.candidate_id = p_candidate
  ) x
$$;

create or replace function public.save_person(doc jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_cid uuid;
  v_mode text;
  v_src jsonb;
  v_source text;
  v_hash text;
  v_fetched timestamptz;
  v_tlv text;
  v_source_id uuid;
  v_existing record;
  v_state record;
  v_state_existed boolean;
  v_lists text;            -- replace | fill | none
  v_applied boolean := false;
  v_has_jobs boolean;
  v_has_edus boolean;
  v_has_skills boolean;
  v_do_jobs boolean := false;
  v_do_edus boolean := false;
  v_do_skills boolean := false;
  v_header jsonb;
  v_f text;
  v_val jsonb;
  v_cur jsonb;
  v_header_at timestamptz;
  v_el jsonb;
  v_ord bigint;
  v_i jsonb;
  v_rk text;
  v_seen text[] := '{}';
  v_kept uuid[] := '{}';
  v_matches uuid[];
  v_kept_skills bigint[] := '{}';
  v_row record;
  v_sk record;
  v_co record;
  c_material boolean;
  v_id uuid;
  v_skill_id bigint;
  v_owner uuid;
  v_holders uuid[];
  v_kind text;
  v_value text;
  v_n int;
  v_lock record;
  -- contacts
  c_kind text; c_vn text; c_vr text; c_label text; c_status text; c_manual boolean; c_never boolean;
  c_detail text; c_q text; c_r text; c_rc text; c_sr text; c_ver text; c_vat timestamptz; c_raw jsonb;
  c_legacy uuid; c_class text; c_newer boolean; c_new jsonb; n_status text; n_class text;
  c_lp boolean; c_manual_at timestamptz;
  v_dir_primary text[] := '{}';
  v_dir_newest boolean := false;
  v_beats_jobs boolean;
  v_beats_edus boolean;
  v_beats_skills boolean;
  -- counts
  k_jobs_ins int := 0; k_jobs_upd int := 0; k_jobs_rem int := 0; k_jobs_dup int := 0;
  k_edu_ins int := 0; k_edu_upd int := 0; k_edu_rem int := 0; k_edu_dup int := 0; k_edu_skip int := 0;
  k_sk_ins int := 0; k_sk_upd int := 0; k_sk_rem int := 0; k_sk_keys int := 0;
  k_ct_ins int := 0; k_ct_upd int := 0; k_ct_skip int := 0;
  k_ident int := 0; k_conf int := 0; k_co int := 0; k_sch int := 0;
  header_fields constant text[] := array['full_name', 'headline', 'summary', 'location', 'location_country', 'photo', 'open_to_work', 'current_title', 'current_company'];
  single_kinds constant text[] := array['linkedin_urn', 'linkedin_username', 'directory_contact_id'];
begin
  -- ---- the contract ------------------------------------------------------
  if doc is null or jsonb_typeof(doc) <> 'object' then
    raise exception 'save_person: doc must be a JSON object' using errcode = '22023';
  end if;
  begin
    v_cid := nullif(btrim(doc->>'candidate_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'save_person: doc.candidate_id is not a uuid' using errcode = '22023';
  end;
  if v_cid is null then
    raise exception 'save_person: doc.candidate_id is required (the writer never creates people)' using errcode = '22023';
  end if;
  v_mode := doc->>'mode';
  if v_mode is null or v_mode not in ('replace_lists', 'fill_gaps', 'contacts_only') then
    raise exception 'save_person: doc.mode must be replace_lists, fill_gaps or contacts_only' using errcode = '22023';
  end if;
  v_src := doc->'source';
  if v_src is null or jsonb_typeof(v_src) <> 'object' then
    raise exception 'save_person: doc.source is required' using errcode = '22023';
  end if;
  v_source := v_src->>'source';
  v_hash := public.tt_jtext(v_src->'payload_hash');
  v_fetched := (v_src->>'fetched_at')::timestamptz;
  if v_source is null or v_hash is null or v_fetched is null
     or public.tt_jtext(v_src->'raw_in') is null or public.tt_jtext(v_src->'parser_version') is null then
    raise exception 'save_person: doc.source needs source, fetched_at, payload_hash, raw_in and parser_version' using errcode = '22023';
  end if;
  v_tlv := coalesce(public.tt_jtext(doc->'tier_list_version'), public.tt_jtext(v_src->'tier_list_version'));

  -- One writer per person at a time (the directory sync and the refresh cannot collide).
  perform pg_advisory_xact_lock(hashtext(v_cid::text));

  if not exists (select 1 from public.candidates c where c.id = v_cid) then
    raise exception 'save_person: candidate % does not exist', v_cid using errcode = '23503';
  end if;

  select s.* into v_state from public.candidate_profile_state s where s.candidate_id = v_cid;
  v_state_existed := found;

  -- ---- which lists this doc carries, and which it outranks --------------------
  -- A list key that is absent (or null) is not asserted and is left alone; an
  -- array, even an empty one, is the whole list. The translators leave a key
  -- out when the source has nothing for that list, so an empty pull never
  -- empties a list. Each list has its own owner: a replace_lists doc takes a
  -- list it carries when it outranks that list's owner (newer fetched_at;
  -- ties by source rank, then payload hash). So the same docs end the same
  -- way whatever order they arrive in.
  v_has_jobs := coalesce(jsonb_typeof(doc->'jobs') = 'array', false);
  v_has_edus := coalesce(jsonb_typeof(doc->'educations') = 'array', false);
  v_has_skills := coalesce(jsonb_typeof(doc->'skills') = 'array', false);
  v_beats_jobs := v_mode = 'replace_lists' and v_has_jobs
    and public.person_source_beats(doc, case when v_state_existed then v_state.jobs_source_id end);
  v_beats_edus := v_mode = 'replace_lists' and v_has_edus
    and public.person_source_beats(doc, case when v_state_existed then v_state.educations_source_id end);
  v_beats_skills := v_mode = 'replace_lists' and v_has_skills
    and public.person_source_beats(doc, case when v_state_existed then v_state.skills_source_id end);

  -- ---- source record and idempotency --------------------------------------
  select cs.id, cs.applied_lists into v_existing
  from public.candidate_sources cs
  where cs.candidate_id = v_cid and cs.source = v_source and cs.payload_hash = v_hash;
  if found then
    -- Seen before. Its contacts and identities were merged then, and its lists
    -- either applied or were outranked. Only a list-owning doc that was never
    -- applied and now outranks the owner of a list it carries (its rival is
    -- gone) is re-applied. A doc that carries no list is never re-applied.
    if not (v_mode = 'replace_lists' and not v_existing.applied_lists
            and (v_beats_jobs or v_beats_edus or v_beats_skills)) then
      return jsonb_build_object('status', 'unchanged', 'candidate_id', v_cid, 'source_id', v_existing.id,
        'applied_lists', false, 'rev', coalesce(v_state.rev, 0),
        'counts', jsonb_build_object(
          'jobs_inserted', 0, 'jobs_updated', 0, 'jobs_removed', 0, 'jobs_duplicate', 0,
          'educations_inserted', 0, 'educations_updated', 0, 'educations_removed', 0, 'educations_duplicate', 0, 'educations_skipped', 0,
          'skills_inserted', 0, 'skills_updated', 0, 'skills_removed', 0, 'skill_keys_created', 0,
          'contacts_inserted', 0, 'contacts_updated', 0, 'contacts_skipped', 0,
          'identities', 0, 'conflicts', 0, 'companies_created', 0, 'schools_created', 0));
    end if;
    v_source_id := v_existing.id;
  else
    insert into public.candidate_sources (candidate_id, source, provider, source_ref, fetched_at, payload_hash,
      raw_in, enrichment_id, applied_lists, parser_version)
    values (v_cid, v_source, public.tt_jtext(v_src->'provider'), public.tt_jtext(v_src->'source_ref'), v_fetched, v_hash,
      v_src->>'raw_in', nullif(v_src->>'enrichment_id', '')::uuid, false, v_src->>'parser_version')
    returning id into v_source_id;
  end if;

  -- ---- identities (every mode) ----------------------------------------------
  if jsonb_typeof(doc->'identities') = 'array' then
    for v_el in select value from jsonb_array_elements(doc->'identities') loop
      v_kind := v_el->>'kind';
      v_value := case when v_kind = 'linkedin_username' then public.tt_normalize_linkedin_slug(v_el->>'value')
                      else public.tt_jtext(v_el->'value') end;
      if v_kind is null or v_value is null then continue; end if;
      insert into public.candidate_identities (candidate_id, kind, value, is_current, source_id, first_seen_at, last_seen_at)
      values (v_cid, v_kind, v_value, true, v_source_id, v_fetched, v_fetched)
      on conflict (kind, value) do nothing
      returning candidate_id into v_owner;
      if found then
        k_ident := k_ident + 1;
        continue;
      end if;
      select ci.candidate_id into v_owner from public.candidate_identities ci where ci.kind = v_kind and ci.value = v_value;
      if v_owner = v_cid then
        update public.candidate_identities ci
        set last_seen_at = greatest(ci.last_seen_at, v_fetched), first_seen_at = least(ci.first_seen_at, v_fetched)
        where ci.kind = v_kind and ci.value = v_value
          and (ci.last_seen_at is distinct from greatest(ci.last_seen_at, v_fetched)
               or ci.first_seen_at is distinct from least(ci.first_seen_at, v_fetched));
      else
        insert into public.identity_conflicts (kind, candidate_ids, incoming, evidence_hash, source_id)
        values ('identity_taken', array[v_owner, v_cid],
          jsonb_build_object('identity_kind', v_kind, 'value', v_value, 'owner', v_owner, 'incoming_candidate', v_cid),
          md5('identity|' || v_kind || '|' || v_value || '|' || v_cid::text), v_source_id)
        on conflict (kind, evidence_hash) where status = 'open' do nothing;
        if found then k_conf := k_conf + 1; end if;
      end if;
    end loop;
    -- One current value per single-valued kind: the one seen most recently.
    update public.candidate_identities ci set is_current = (ci.id = t.top_id)
    from (
      select distinct on (x.kind) x.kind, x.id as top_id
      from public.candidate_identities x
      where x.candidate_id = v_cid and x.kind = any (single_kinds)
      order by x.kind, x.last_seen_at desc nulls last, x.first_seen_at desc nulls last, x.id
    ) t
    where ci.candidate_id = v_cid and ci.kind = t.kind and ci.is_current is distinct from (ci.id = t.top_id);
  end if;

  -- ---- header: newest non-empty value wins; empty never blanks --------------
  v_header := coalesce(v_state.header, '{}'::jsonb);
  if v_mode <> 'contacts_only' and jsonb_typeof(doc->'header') = 'object' then
    foreach v_f in array header_fields loop
      v_val := doc->'header'->v_f;
      if v_val is null or jsonb_typeof(v_val) = 'null'
         or (jsonb_typeof(v_val) = 'string' and btrim(v_val #>> '{}') = '')
         or (jsonb_typeof(v_val) = 'array' and jsonb_array_length(v_val) = 0)
         or (jsonb_typeof(v_val) = 'object' and v_val = '{}'::jsonb) then
        continue;
      end if;
      v_cur := v_header->v_f;
      v_header_at := coalesce((doc->'header_dates'->>v_f)::timestamptz, v_fetched);
      if v_cur is null or (v_mode <> 'fill_gaps' and public.person_header_beats(
        v_header_at, v_source, v_hash, v_src->>'parser_version', v_cur)) then
        v_header := jsonb_set(v_header, array[v_f], jsonb_build_object('value', v_val,
          'source', v_source, 'at', v_header_at, 'source_id', v_source_id,
          'payload_hash', v_hash, 'parser_version', v_src->>'parser_version'));
      end if;
    end loop;
  end if;

  -- ---- which lists this doc writes ----------------------------------------------
  -- replace_lists: every list it carries and outranks the owner of. fill_gaps
  -- writes a list only when the person has none, never removes anything and
  -- never owns a list (any LinkedIn-grade doc replaces what it wrote).
  if v_mode = 'replace_lists' then
    v_do_jobs := v_beats_jobs;
    v_do_edus := v_beats_edus;
    v_do_skills := v_beats_skills;
    v_lists := case when v_do_jobs or v_do_edus or v_do_skills then 'replace' else 'none' end;
  elsif v_mode = 'fill_gaps' then
    v_lists := 'fill';
    if v_has_jobs and jsonb_array_length(doc->'jobs') > 0 then
      v_do_jobs := not exists (select 1 from public.candidate_experiences e
                               where e.candidate_id = v_cid and e.source = 'person' and e.removed_at is null);
    end if;
    if v_has_edus and jsonb_array_length(doc->'educations') > 0 then
      v_do_edus := not exists (select 1 from public.candidate_educations e where e.candidate_id = v_cid and e.removed_at is null);
    end if;
    if v_has_skills and jsonb_array_length(doc->'skills') > 0 then
      v_do_skills := not exists (select 1 from public.candidate_skills s where s.candidate_id = v_cid and s.removed_at is null);
    end if;
  else
    v_lists := 'none';
  end if;
  v_applied := v_do_jobs or v_do_edus or v_do_skills;

  -- Lock every company/school identity key this doc may create, in one global
  -- order, so two writers never deadlock or create the same row twice.
  if v_do_jobs or v_do_edus then
    for v_lock in
      select distinct k.cls, hashtext(k.key) as h from (
        select 72001 as cls, unnest(public.person_org_lock_keys(public.person_org_ident(j.value->'company', false, v_tlv), false)) as key
        from jsonb_array_elements(case when v_do_jobs then doc->'jobs' else '[]'::jsonb end) j
        union all
        select 72002, unnest(public.person_org_lock_keys(public.person_org_ident(e.value->'school', true, v_tlv), true))
        from jsonb_array_elements(case when v_do_edus then doc->'educations' else '[]'::jsonb end) e
      ) k
      order by 1, 2
    loop
      perform pg_advisory_xact_lock(v_lock.cls, v_lock.h);
    end loop;
  end if;

  -- ---- jobs -> candidate_experiences (source 'person') ----------------------
  if v_do_jobs then
    for v_el, v_ord in
      select j.value, j.ordinality from jsonb_array_elements(doc->'jobs') with ordinality j
      order by coalesce(public.tt_jint(j.value->'sort_order'), j.ordinality::int), j.ordinality
    loop
      v_rk := public.tt_jtext(v_el->'row_key');
      if v_rk is null then
        raise exception 'save_person: every job needs a row_key (candidate %)', v_cid using errcode = '22023';
      end if;
      if v_rk = any (v_seen) then k_jobs_dup := k_jobs_dup + 1; continue; end if;
      v_seen := v_seen || v_rk;

      v_i := public.person_org_ident(v_el->'company', false, v_tlv);
      select * into v_co from public.person_company(v_i, v_cid, v_source_id);
      if v_co.created then k_co := k_co + 1; end if;
      k_conf := k_conf + coalesce(v_co.conflicts, 0);

      select e.id, e.removed_at into v_row from public.candidate_experiences e
      where e.candidate_id = v_cid and e.source = 'person' and e.provider_experience_key = v_rk;
      -- A company gaining a numeric identity is still the same unambiguous job.
      -- Match only active rows with the resolved company, title and start date;
      -- never guess among multiple positions or reuse a row already in this doc.
      if not found then
        select count(*), (array_agg(e.id order by e.id))[1], array_agg(e.id order by e.id) into v_n, v_id, v_matches
        from public.candidate_experiences e
        where e.candidate_id = v_cid and e.source = 'person' and e.removed_at is null
          and e.company_id = v_co.company_id and not (e.id = any(v_kept))
          and lower(btrim(e.title)) is not distinct from lower(btrim(public.tt_jtext(v_el->'title')))
          and e.start_year is not distinct from public.tt_jint(v_el->'start_year')
          and e.start_month is not distinct from public.tt_jint(v_el->'start_month');
        if v_n = 1 then
          select e.id, e.removed_at into v_row from public.candidate_experiences e where e.id=v_id;
        else
          if v_n > 1 then
            insert into public.identity_conflicts(kind,candidate_ids,incoming,evidence_hash,source_id)
            values('job_identity',array[v_cid],jsonb_build_object('job_ids',v_matches,'incoming_row_key',v_rk),
              md5('job|'||v_cid::text||'|'||v_rk||'|'||v_matches::text),v_source_id)
            on conflict(kind,evidence_hash) where status='open' do nothing;
            if found then k_conf:=k_conf+1; end if;
          end if;
          select e.id, e.removed_at into v_row from public.candidate_experiences e where false;
        end if;
      end if;
      if v_row.id is not null then
        update public.candidate_experiences e set
          title = public.tt_jtext(v_el->'title'),
          company_name = v_i->>'name',
          company_linkedin_url = v_i->>'raw',
          company_linkedin_id = v_i->>'id',
          company_id = v_co.company_id,
          employment_type = public.tt_jtext(v_el->'employment_type'),
          location = public.tt_jtext(v_el->'location'),
          description = public.tt_jtext(v_el->'description'),
          duration_text = public.tt_jtext(v_el->'duration_text'),
          start_year = public.tt_jint(v_el->'start_year'),
          start_month = public.tt_jint(v_el->'start_month'),
          end_year = public.tt_jint(v_el->'end_year'),
          end_month = public.tt_jint(v_el->'end_month'),
          is_current = coalesce((v_el->>'is_current')::boolean, false),
          is_side_role = coalesce((v_el->>'is_side_role')::boolean, false),
          skills = coalesce(array(select coalesce(s.value->>'name', s.value #>> '{}') from jsonb_array_elements(
                     case when jsonb_typeof(v_el->'skills') = 'array' then v_el->'skills' else '[]'::jsonb end) s), '{}'),
          sort_order = coalesce(public.tt_jint(v_el->'sort_order'), v_ord::int),
          row_key = v_rk,
          provider_experience_key = v_rk,
          source_id = v_source_id,
          last_seen_at = greatest(e.last_seen_at, v_fetched),
          removed_at = null,
          updated_at = now()
        where e.id = v_row.id;
        if v_row.removed_at is null then k_jobs_upd := k_jobs_upd + 1; else k_jobs_ins := k_jobs_ins + 1; end if;
        v_kept := v_kept || v_row.id;
      else
        insert into public.candidate_experiences (organization_id, candidate_id, source, provider_experience_key,
          title, company_name, company_linkedin_url, company_linkedin_id, company_id, employment_type, location,
          description, duration_text, start_year, start_month, end_year, end_month, is_current, is_side_role,
          skills, sort_order, row_key, source_id, first_seen_at, last_seen_at)
        values ('801865a7-6533-41d2-9c45-e4a90e6ad51a', v_cid, 'person', v_rk,
          public.tt_jtext(v_el->'title'), v_i->>'name', v_i->>'raw', v_i->>'id', v_co.company_id,
          public.tt_jtext(v_el->'employment_type'), public.tt_jtext(v_el->'location'),
          public.tt_jtext(v_el->'description'), public.tt_jtext(v_el->'duration_text'),
          public.tt_jint(v_el->'start_year'), public.tt_jint(v_el->'start_month'),
          public.tt_jint(v_el->'end_year'), public.tt_jint(v_el->'end_month'),
          coalesce((v_el->>'is_current')::boolean, false), coalesce((v_el->>'is_side_role')::boolean, false),
          coalesce(array(select coalesce(s.value->>'name', s.value #>> '{}') from jsonb_array_elements(
            case when jsonb_typeof(v_el->'skills') = 'array' then v_el->'skills' else '[]'::jsonb end) s), '{}'),
          coalesce(public.tt_jint(v_el->'sort_order'), v_ord::int), v_rk, v_source_id, v_fetched, v_fetched)
        returning id into v_id;
        k_jobs_ins := k_jobs_ins + 1;
        v_kept := v_kept || v_id;
      end if;
    end loop;
    if v_lists = 'replace' then
      update public.candidate_experiences e set removed_at = v_fetched, updated_at = now()
      where e.candidate_id = v_cid and e.source = 'person' and e.removed_at is null and not (e.id = any (v_kept));
      get diagnostics v_n = row_count;
      k_jobs_rem := v_n;
    end if;
  end if;

  -- ---- educations -> candidate_educations --------------------------------------
  if v_do_edus then
    v_seen := '{}'; v_kept := '{}';
    for v_el, v_ord in
      select e.value, e.ordinality from jsonb_array_elements(doc->'educations') with ordinality e
      order by coalesce(public.tt_jint(e.value->'sort_order'), e.ordinality::int), e.ordinality
    loop
      v_rk := public.tt_jtext(v_el->'row_key');
      if v_rk is null then
        raise exception 'save_person: every education needs a row_key (candidate %)', v_cid using errcode = '22023';
      end if;
      if v_rk = any (v_seen) then k_edu_dup := k_edu_dup + 1; continue; end if;
      v_seen := v_seen || v_rk;

      v_i := public.person_org_ident(v_el->'school', true, v_tlv);
      select * into v_co from public.person_school(v_i, v_cid, v_source_id);
      if v_co.school_id is null then k_edu_skip := k_edu_skip + 1; continue; end if;
      if v_co.created then k_sch := k_sch + 1; end if;
      k_conf := k_conf + coalesce(v_co.conflicts, 0);

      select e.id, e.removed_at into v_row from public.candidate_educations e
      where e.candidate_id = v_cid and e.row_key = v_rk
      order by (e.removed_at is null) desc, e.removed_at desc limit 1;
      if found then
        update public.candidate_educations e set
          school_id = v_co.school_id,
          school_name = coalesce(v_i->>'name', (select s.name from public.schools s where s.id = v_co.school_id)),
          degree = public.tt_jtext(v_el->'degree'),
          degree_level = public.tt_jtext(v_el->'degree_level'),
          field_of_study = public.tt_jtext(v_el->'field_of_study'),
          start_year = public.tt_jint(v_el->'start_year'),
          start_month = public.tt_jint(v_el->'start_month'),
          end_year = public.tt_jint(v_el->'end_year'),
          end_month = public.tt_jint(v_el->'end_month'),
          description = public.tt_jtext(v_el->'description'),
          activities = public.tt_jtext(v_el->'activities'),
          sort_order = coalesce(public.tt_jint(v_el->'sort_order'), v_ord::int),
          source_id = v_source_id,
          last_seen_at = greatest(e.last_seen_at, v_fetched),
          removed_at = null
        where e.id = v_row.id;
        if v_row.removed_at is null then k_edu_upd := k_edu_upd + 1; else k_edu_ins := k_edu_ins + 1; end if;
        v_kept := v_kept || v_row.id;
      else
        insert into public.candidate_educations (candidate_id, school_id, school_name, degree, degree_level,
          field_of_study, start_year, start_month, end_year, end_month, description, activities, sort_order,
          row_key, source_id, first_seen_at, last_seen_at)
        values (v_cid, v_co.school_id,
          coalesce(v_i->>'name', (select s.name from public.schools s where s.id = v_co.school_id)),
          public.tt_jtext(v_el->'degree'), public.tt_jtext(v_el->'degree_level'), public.tt_jtext(v_el->'field_of_study'),
          public.tt_jint(v_el->'start_year'), public.tt_jint(v_el->'start_month'),
          public.tt_jint(v_el->'end_year'), public.tt_jint(v_el->'end_month'),
          public.tt_jtext(v_el->'description'), public.tt_jtext(v_el->'activities'),
          coalesce(public.tt_jint(v_el->'sort_order'), v_ord::int), v_rk, v_source_id, v_fetched, v_fetched)
        returning id into v_id;
        k_edu_ins := k_edu_ins + 1;
        v_kept := v_kept || v_id;
      end if;
    end loop;
    if v_lists = 'replace' then
      update public.candidate_educations e set removed_at = v_fetched
      where e.candidate_id = v_cid and e.removed_at is null and not (e.id = any (v_kept));
      get diagnostics v_n = row_count;
      k_edu_rem := v_n;
    end if;
  end if;

  -- ---- skills -> skills + candidate_skills ---------------------------------------
  if v_do_skills then
    -- One row per key (duplicates merge: top if any says so, the most
    -- endorsements and jobs, the first position). Keys in sorted order, so
    -- concurrent writers insert new skills in the same order.
    for v_row in
      select d.key, (array_agg(d.name order by d.ord))[1] as name, bool_or(d.is_top) as is_top,
             max(d.endorsements) as endorsements, max(d.job_count) as job_count, min(d.ord) as ord
      from (
        select coalesce(public.tt_jtext(s.value->'key'), lower(public.tt_jtext(s.value->'name'))) as key,
               coalesce(public.tt_jtext(s.value->'name'), public.tt_jtext(s.value->'key')) as name,
               coalesce((s.value->>'is_top')::boolean, false) as is_top,
               public.tt_jint(s.value->'endorsements') as endorsements,
               nullif(least(coalesce(public.tt_jint(s.value->'job_count'), -1), 32767), -1) as job_count,
               coalesce(public.tt_jint(s.value->'sort_order'), s.ordinality::int) as ord
        from jsonb_array_elements(doc->'skills') with ordinality s
      ) d
      where d.key is not null
      group by d.key
      order by d.key
    loop
      insert into public.skills (name, key) values (v_row.name, v_row.key) on conflict (key) do nothing
      returning id into v_skill_id;
      if found then
        k_sk_keys := k_sk_keys + 1;
      else
        select s.id into v_skill_id from public.skills s where s.key = v_row.key;
      end if;
      select cs.removed_at into v_sk from public.candidate_skills cs
      where cs.candidate_id = v_cid and cs.skill_id = v_skill_id;
      if found then
        update public.candidate_skills cs set
          is_top = v_row.is_top, endorsements = v_row.endorsements, job_count = v_row.job_count,
          sort_order = least(v_row.ord, 32767), source_id = v_source_id,
          last_seen_at = greatest(cs.last_seen_at, v_fetched), removed_at = null
        where cs.candidate_id = v_cid and cs.skill_id = v_skill_id;
        if v_sk.removed_at is null then k_sk_upd := k_sk_upd + 1; else k_sk_ins := k_sk_ins + 1; end if;
      else
        insert into public.candidate_skills (candidate_id, skill_id, is_top, endorsements, job_count, sort_order,
          source_id, first_seen_at, last_seen_at)
        values (v_cid, v_skill_id, v_row.is_top, v_row.endorsements, v_row.job_count, least(v_row.ord, 32767),
          v_source_id, v_fetched, v_fetched);
        k_sk_ins := k_sk_ins + 1;
      end if;
      v_kept_skills := v_kept_skills || v_skill_id;
    end loop;
    if v_lists = 'replace' then
      update public.candidate_skills cs set removed_at = v_fetched
      where cs.candidate_id = v_cid and cs.removed_at is null and not (cs.skill_id = any (v_kept_skills));
      get diagnostics v_n = row_count;
      k_sk_rem := v_n;
    end if;
  end if;

  -- ---- contacts: merge, never delete, newest check wins, then re-rank -----------
  if jsonb_typeof(doc->'contacts') = 'array' then
    -- One writer per address at a time, across people: the check below for
    -- other holders of the same address must see a concurrent writer's row,
    -- or two people saved at once would both miss each other and log no
    -- email_owned_by_other. Class 72003, after the person lock and the
    -- 72001/72002 org locks, keys sorted: the global lock order holds.
    for v_lock in
      select distinct hashtext(x.vn) as h from (
        select coalesce(public.tt_jtext(c.value->'value_normalized'),
                 nullif(btrim(regexp_replace(lower(btrim(coalesce(c.value->>'value_raw', ''))), '^mailto:', '')), '')) as vn
        from jsonb_array_elements(doc->'contacts') c
        where lower(c.value->>'kind') = 'email') x
      where x.vn is not null
      order by 1
    loop
      perform pg_advisory_xact_lock(72003, v_lock.h);
    end loop;
    -- The directory names the primary; only its newest version may (an
    -- older directory doc arriving late does not take the primary back).
    if v_source = 'directory' then
      v_dir_newest := not exists (
        select 1 from public.candidate_sources cs
        where cs.candidate_id = v_cid and cs.source = 'directory' and cs.id <> v_source_id
          and not public.person_source_beats(doc,cs.id));
    end if;
    for v_el in select value from jsonb_array_elements(doc->'contacts') loop
      c_kind := lower(v_el->>'kind');
      if c_kind is null or c_kind not in ('email', 'phone', 'github', 'website') then
        raise exception 'save_person: contact kind must be email, phone, github or website (candidate %)', v_cid using errcode = '22023';
      end if;
      c_vn := public.tt_jtext(v_el->'value_normalized');
      if c_vn is null then
        c_vn := case c_kind
          when 'email' then nullif(btrim(regexp_replace(lower(btrim(coalesce(v_el->>'value_raw', ''))), '^mailto:', '')), '')
          when 'phone' then nullif(regexp_replace(coalesce(v_el->>'value_raw', ''), '[^0-9+]', '', 'g'), '')
          else nullif(lower(btrim(coalesce(v_el->>'value_raw', ''))), '') end;
      end if;
      if c_vn is null then k_ct_skip := k_ct_skip + 1; continue; end if;
      c_vr := coalesce(public.tt_jtext(v_el->'value_raw'), c_vn);
      c_label := lower(coalesce(public.tt_jtext(v_el->'label'), 'unknown'));
      c_label := case
        when c_label in ('personal', 'business', 'academic', 'mobile', 'home', 'office', 'unknown') then c_label
        when c_label in ('work', 'professional') then 'business'
        when c_label in ('cell', 'cellphone', 'mobile_phone') then 'mobile'
        when c_label in ('education', 'school') then 'academic'
        else 'unknown' end;
      c_status := lower(coalesce(public.tt_jtext(v_el->'status'), 'active'));
      if c_status not in ('active', 'invalid', 'bounced', 'do_not_use', 'removed', 'claimed', 'shared') then
        raise exception 'save_person: unknown contact status % (candidate %)', c_status, v_cid using errcode = '22023';
      end if;
      c_manual := coalesce((v_el->>'is_manual')::boolean, false);
      c_never := coalesce((v_el->>'never_primary')::boolean, false);
      c_detail := public.tt_jtext(v_el->'source_detail');
      c_q := public.tt_jtext(v_el->'quality');
      c_r := public.tt_jtext(v_el->'result');
      c_rc := public.tt_jtext(v_el->'resultcode');
      c_sr := public.tt_jtext(v_el->'subresult');
      c_ver := public.tt_jtext(v_el->'verifier');
      c_vat := (public.tt_jtext(v_el->'verified_at'))::timestamptz;
      c_raw := case when jsonb_typeof(v_el->'verification_raw') in ('object', 'array') then v_el->'verification_raw' end;
      c_legacy := nullif(v_el->>'legacy_email_id', '')::uuid;
      c_lp := coalesce((v_el->>'legacy_primary')::boolean, false);
      c_manual_at := case when c_manual then v_fetched end;
      -- An incoming 'invalid' with no check of its own counts as a bad check.
      c_class := case when c_kind <> 'email' then 'none'
                      when c_q is null and c_r is null and c_status = 'invalid' then 'bad'
                      else public.tt_email_check_class(c_q, c_r) end;
      if c_detail = 'directory_primary' then
        if v_source = 'directory' and not v_dir_newest then
          c_detail := 'directory';
        else
          v_dir_primary := v_dir_primary || (c_kind || '|' || c_vn);
        end if;
      end if;

      select cc.* into v_row from public.candidate_contacts cc
      where cc.candidate_id = v_cid and cc.kind = c_kind and cc.value_normalized = c_vn;
      if not found then
        n_status := case
          when c_class = 'bad' and c_status in ('active','shared') then 'invalid'
          when c_manual then c_status
          when c_class = 'bad' and c_status in ('active', 'shared') then 'invalid'
          else c_status end;
        insert into public.candidate_contacts (candidate_id, kind, value_raw, value_normalized, label, rank, status,
          quality, result, resultcode, subresult, verifier, verified_at, verification_raw, source, source_detail,
          source_id, is_manual, manual_at, never_primary, legacy_primary, legacy_email_ids, first_seen_at, last_seen_at)
        values (v_cid, c_kind, c_vr, c_vn, c_label, null, n_status,
          c_q, c_r, c_rc, c_sr, c_ver, c_vat, c_raw, v_source, c_detail,
          v_source_id, c_manual, c_manual_at, c_never, c_lp, case when c_legacy is null then null else array[c_legacy] end, v_fetched, v_fetched);
        k_ct_ins := k_ct_ins + 1;
        -- The same address on other people: kept on all of them; one review
        -- row per address and arriving person, listing every holder.
        if c_kind = 'email' then
          select array_agg(distinct cc.candidate_id order by cc.candidate_id) into v_holders
          from public.candidate_contacts cc
          where cc.kind = 'email' and cc.value_normalized = c_vn and cc.candidate_id <> v_cid and cc.status <> 'removed';
          if v_holders is not null then
            insert into public.identity_conflicts (kind, candidate_ids, incoming, evidence_hash, source_id)
            values ('email_owned_by_other',
              (select array_agg(x order by x) from unnest(v_holders || v_cid) x),
              jsonb_build_object('kind', 'email', 'value_normalized', c_vn, 'holders', to_jsonb(v_holders), 'incoming_candidate', v_cid),
              md5('email|' || c_vn || '|' || v_cid::text), v_source_id)
            on conflict (kind, evidence_hash) where status = 'open' do nothing;
            if found then k_conf := k_conf + 1; end if;
          end if;
        end if;
      else
        -- Newest verification wins. Equal timestamps use a conservative,
        -- deterministic check class and metadata order, never arrival order.
        c_newer := (c_q is not null or c_r is not null or c_vat is not null)
          and ((c_vat is not null and (v_row.verified_at is null or c_vat > v_row.verified_at))
            or (c_vat is not distinct from v_row.verified_at and
              row(case c_class when 'bad' then 3 when 'risky' then 2 when 'good' then 1 else 0 end,
                  jsonb_build_array(c_q,c_r,c_rc,c_sr,c_ver,c_raw)::text collate "C") >
              row(case public.tt_email_check_class(v_row.quality,v_row.result) when 'bad' then 3 when 'risky' then 2 when 'good' then 1 else 0 end,
                  jsonb_build_array(v_row.quality,v_row.result,v_row.resultcode,v_row.subresult,v_row.verifier,v_row.verification_raw)::text collate "C")));
        if c_vat is not distinct from v_row.verified_at
           and c_class <> 'none' and public.tt_email_check_class(v_row.quality,v_row.result) <> 'none'
           and c_class <> public.tt_email_check_class(v_row.quality,v_row.result) then
          insert into public.identity_conflicts(kind,candidate_ids,incoming,evidence_hash,source_id)
          values('contact_verification',array[v_cid],jsonb_build_object('contact_id',v_row.id,
            'stored_class',public.tt_email_check_class(v_row.quality,v_row.result),'incoming_class',c_class,'verified_at',c_vat),
            md5('verification|'||v_cid::text||'|'||c_kind||'|'||c_vn||'|'||coalesce(c_vat::text,'')),v_source_id)
          on conflict(kind,evidence_hash) where status='open' do nothing;
          if found then k_conf:=k_conf+1; end if;
        end if;
        n_class := case when c_kind <> 'email' then 'none'
                        when c_newer then c_class
                        when v_row.status='invalid' and v_row.quality is null and v_row.result is null then 'bad'
                        when c_class = 'bad' and c_q is null and c_r is null and c_vat is null
                             and v_row.quality is null and v_row.result is null then 'bad'
                        else public.tt_email_check_class(v_row.quality, v_row.result) end;
        -- Negative delivery/consent statuses stay ineligible in either arrival
        -- order. Manual preference only chooses among usable addresses.
        n_status := v_row.status;
        if 'removed' in (c_status,v_row.status) then n_status:='removed';
        elsif 'do_not_use' in (c_status,v_row.status) then n_status:='do_not_use';
        elsif 'bounced' in (c_status,v_row.status) then n_status:='bounced';
        elsif c_manual then
          n_status := c_status;
        elsif v_row.is_manual and v_row.status in ('active', 'shared') then
          n_status := case when c_status in ('bounced', 'do_not_use') then c_status else v_row.status end;
        elsif c_status in ('removed', 'do_not_use', 'bounced') then
          n_status := c_status;
        elsif v_row.status = 'bounced' then
          n_status := 'bounced';
        else
          if n_status = 'claimed' and c_status <> 'claimed' and v_source <> 'application' then n_status := 'active'; end if;
          if n_status = 'active' and c_status = 'shared' then n_status := 'shared'; end if;
          if n_class = 'bad' and n_status in ('active', 'shared') then n_status := 'invalid';
          elsif n_class in ('good', 'risky') and n_status = 'invalid' and c_status <> 'invalid' then n_status := 'active';
          end if;
        end if;
        if n_class = 'bad' and n_status in ('active','shared') then n_status := 'invalid'; end if;
        if (c_manual or v_row.is_manual) and n_status in ('invalid','bounced','removed','do_not_use')
           and (c_status in ('active','shared') or v_row.status in ('active','shared')) then
          insert into public.identity_conflicts(kind,candidate_ids,incoming,evidence_hash,source_id)
          values('contact_status',array[v_cid],jsonb_build_object('contact_id',v_row.id,
            'stored_status',v_row.status,'incoming_status',c_status,'chosen_status',n_status),
            md5('contact|'||v_cid::text||'|'||c_kind||'|'||c_vn),v_source_id)
          on conflict(kind,evidence_hash) where status='open' do nothing;
          if found then k_conf:=k_conf+1; end if;
        end if;
        c_new := jsonb_build_object(
          'label', case when v_row.label = 'unknown' and c_label <> 'unknown' then c_label else v_row.label end,
          'status', n_status,
          'is_manual', v_row.is_manual or c_manual,
          'manual_at', case when c_manual then greatest(coalesce(v_row.manual_at, c_manual_at), c_manual_at) else v_row.manual_at end,
          'never_primary', v_row.never_primary and c_never,
          'legacy_primary', v_row.legacy_primary or c_lp,
          'source_detail', case when c_detail = 'directory_primary' then c_detail else coalesce(v_row.source_detail, c_detail) end,
          'legacy', (select coalesce(array_agg(distinct u order by u), '{}') from unnest(
                      coalesce(v_row.legacy_email_ids, '{}'::uuid[]) || case when c_legacy is null then '{}'::uuid[] else array[c_legacy] end) u));
        -- A material change counts as an update; a newer sighting only moves
        -- last_seen_at (and a newer recruiter choice moves manual_at).
        c_material := c_newer
           or c_new->>'label' is distinct from v_row.label
           or c_new->>'status' is distinct from v_row.status
           or (c_new->>'is_manual')::boolean is distinct from v_row.is_manual
           or (c_new->>'never_primary')::boolean is distinct from v_row.never_primary
           or (c_new->>'legacy_primary')::boolean is distinct from v_row.legacy_primary
           or c_new->>'source_detail' is distinct from v_row.source_detail
           or (select array_agg(x::uuid) from jsonb_array_elements_text(c_new->'legacy') x) is distinct from
              (select array_agg(u order by u) from unnest(v_row.legacy_email_ids) u);
        if c_material
           or v_row.last_seen_at is distinct from greatest(v_row.last_seen_at, v_fetched)
           or v_row.first_seen_at is distinct from least(v_row.first_seen_at, v_fetched)
           or (c_new->>'manual_at')::timestamptz is distinct from v_row.manual_at then
          update public.candidate_contacts cc set
            label = c_new->>'label',
            status = c_new->>'status',
            is_manual = (c_new->>'is_manual')::boolean,
            manual_at = (c_new->>'manual_at')::timestamptz,
            never_primary = (c_new->>'never_primary')::boolean,
            legacy_primary = (c_new->>'legacy_primary')::boolean,
            source_detail = c_new->>'source_detail',
            legacy_email_ids = nullif((select array_agg(x::uuid) from jsonb_array_elements_text(c_new->'legacy') x), '{}'),
            quality = case when c_newer then c_q else cc.quality end,
            result = case when c_newer then c_r else cc.result end,
            resultcode = case when c_newer then c_rc else cc.resultcode end,
            subresult = case when c_newer then c_sr else cc.subresult end,
            verifier = case when c_newer then c_ver else cc.verifier end,
            verified_at = case when c_newer then c_vat else cc.verified_at end,
            verification_raw = case when c_newer then c_raw else cc.verification_raw end,
            -- Leave the rank for the re-rank below, unless the row can no longer hold one.
            rank = case when c_new->>'status' = 'active' and not (c_new->>'never_primary')::boolean then cc.rank end,
            first_seen_at = least(cc.first_seen_at, v_fetched),
            last_seen_at = greatest(cc.last_seen_at, v_fetched),
            updated_at = now()
          where cc.id = v_row.id;
          if c_material then k_ct_upd := k_ct_upd + 1; end if;
        end if;
      end if;
    end loop;

    -- The directory names one primary per kind; an older directory primary
    -- for the same kind becomes a plain directory row (only the newest
    -- directory version decides).
    if v_source = 'directory' and v_dir_newest and cardinality(v_dir_primary) > 0 then
      update public.candidate_contacts cc set source_detail = 'directory', updated_at = now()
      where cc.candidate_id = v_cid and cc.source_detail = 'directory_primary'
        and not ((cc.kind || '|' || cc.value_normalized) = any (v_dir_primary))
        and cc.kind in (select split_part(x, '|', 1) from unnest(v_dir_primary) x);
    end if;

    perform public.person_rerank_contacts(v_cid);
  end if;

  -- ---- state ------------------------------------------------------------------
  if v_applied then
    update public.candidate_sources cs set applied_lists = true where cs.id = v_source_id and not cs.applied_lists;
  end if;
  -- lists_source_id: the newest source that replaced any list (it outranks the
  -- one recorded); each list's own owner is whoever replaced it last.
  v_lists := case when v_lists = 'replace'
    and public.person_source_beats(doc, case when v_state_existed then v_state.lists_source_id end)
    then 'replace_newest' else v_lists end;
  insert into public.candidate_profile_state as st (candidate_id, lists_source_id, lists_fetched_at,
    jobs_source_id, educations_source_id, skills_source_id, header, rev, updated_at)
  values (v_cid,
    case when v_lists = 'replace_newest' then v_source_id end,
    case when v_lists = 'replace_newest' then v_fetched end,
    case when v_mode = 'replace_lists' and v_do_jobs then v_source_id end,
    case when v_mode = 'replace_lists' and v_do_edus then v_source_id end,
    case when v_mode = 'replace_lists' and v_do_skills then v_source_id end,
    v_header, 1, now())
  on conflict (candidate_id) do update set
    lists_source_id = case when v_lists = 'replace_newest' then v_source_id else st.lists_source_id end,
    lists_fetched_at = case when v_lists = 'replace_newest' then v_fetched else st.lists_fetched_at end,
    jobs_source_id = case when v_mode = 'replace_lists' and v_do_jobs then v_source_id else st.jobs_source_id end,
    educations_source_id = case when v_mode = 'replace_lists' and v_do_edus then v_source_id else st.educations_source_id end,
    skills_source_id = case when v_mode = 'replace_lists' and v_do_skills then v_source_id else st.skills_source_id end,
    header = v_header,
    rev = st.rev + 1,
    updated_at = now();

  return jsonb_build_object(
    'status', case when v_state_existed then 'updated' else 'created' end,
    'candidate_id', v_cid,
    'source_id', v_source_id,
    'applied_lists', v_applied,
    'rev', coalesce(v_state.rev, 0) + 1,
    'counts', jsonb_build_object(
      'jobs_inserted', k_jobs_ins, 'jobs_updated', k_jobs_upd, 'jobs_removed', k_jobs_rem, 'jobs_duplicate', k_jobs_dup,
      'educations_inserted', k_edu_ins, 'educations_updated', k_edu_upd, 'educations_removed', k_edu_rem,
      'educations_duplicate', k_edu_dup, 'educations_skipped', k_edu_skip,
      'skills_inserted', k_sk_ins, 'skills_updated', k_sk_upd, 'skills_removed', k_sk_rem, 'skill_keys_created', k_sk_keys,
      'contacts_inserted', k_ct_ins, 'contacts_updated', k_ct_upd, 'contacts_skipped', k_ct_skip,
      'identities', k_ident, 'conflicts', k_conf, 'companies_created', k_co, 'schools_created', k_sch));
end $$;

revoke all on function public.person_source_beats(jsonb,uuid), public.person_header_beats(timestamptz,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.person_source_beats(jsonb,uuid), public.person_header_beats(timestamptz,text,text,text,jsonb) to service_role;
