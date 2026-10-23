-- The person tables and the one writer, save_person (the 50-person trial).
--
-- Every job, school, skill, outside id and contact of a pool person gets its
-- own row, pointing at the source record it came from. save_person(doc) takes
-- the same PersonDoc every translator in lib/server/person/ produces and saves
-- it in one transaction under a per-person lock:
--   * the same doc twice changes nothing ("unchanged");
--   * the newest LinkedIn-grade source, by when the source fetched it,
--     replaces each list it carries (jobs, schools, skills) as a unit: kept
--     rows keep their ids, new rows are added, rows no longer listed get
--     removed_at (never deleted); an older doc arriving late is recorded and
--     changes no list another source newer than it owns; ties on fetched_at
--     break the same way in any order;
--   * header fields: the newest non-empty value wins, an empty value never
--     blanks one;
--   * every job links to a company (LinkedIn id, then username, then URL; else
--     a name-only row or a shared placeholder), every school to a school row;
--   * contacts add up across sources, are never deleted, keep the newest check,
--     and are re-ranked so each kind has exactly one primary.
--
-- Additive only, safe on the live database:
--   * new tables (RLS on, no policies, nothing granted to anon/authenticated);
--   * new nullable columns on companies and candidate_experiences (constant
--     defaults only, so neither table is rewritten);
--   * new indexes, one view (security_invoker) and new functions (EXECUTE
--     revoked from public, anon and authenticated).
-- candidates is not altered and save_person never writes it: the trial's
-- people keep their live rows exactly as they are. Writer rows in
-- candidate_experiences use source 'person' (syncExperiences' 'harvest' rows
-- are left alone; nothing in the site reads candidate_experiences today).

set lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- New tables
-- ---------------------------------------------------------------------------

-- Everything that ever fed a person: the old import, each LinkedIn pull, each
-- directory version, each application or recruiter edit.
create table if not exists public.candidate_sources (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete restrict,
  source text not null check (source in ('legacy_import', 'harvest', 'directory', 'application', 'recruiter')),
  provider text,
  source_ref text,
  fetched_at timestamptz not null,
  payload_hash text not null,
  raw_in text not null check (raw_in in ('candidate_enrichments', 'candidates.linkedin_data', 'directory', 'inline')),
  enrichment_id uuid,
  applied_lists boolean not null default false,
  parser_version text not null,
  created_at timestamptz default now(),
  unique (candidate_id, source, payload_hash)
);

-- Which source owns the lists and when that data was true, plus the header
-- ({field: {value, source, at}}), so the trial never alters candidates.
-- lists_source_id is the newest source that replaced any list; each list
-- also records its own owner (jobs/educations/skills_source_id), because a
-- source that lacks a list (a pull with no positions) leaves that list with
-- the older source that had one, in whatever order the sources arrive.
create table if not exists public.candidate_profile_state (
  candidate_id uuid primary key references public.candidates(id) on delete restrict,
  lists_source_id uuid references public.candidate_sources(id),
  lists_fetched_at timestamptz,
  jobs_source_id uuid references public.candidate_sources(id),
  educations_source_id uuid references public.candidate_sources(id),
  skills_source_id uuid references public.candidate_sources(id),
  header jsonb not null default '{}'::jsonb,
  rev int not null default 0,
  updated_at timestamptz
);
create index if not exists candidate_profile_state_lists_source_idx
  on public.candidate_profile_state (lists_source_id) where lists_source_id is not null;

-- Every outside id that points at a person. One value belongs to one person.
create table if not exists public.candidate_identities (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete restrict,
  kind text not null check (kind in ('linkedin_urn', 'linkedin_username', 'directory_contact_id', 'airtable_id', 'tt_application_id')),
  value text not null,
  is_current boolean not null default true,
  source_id uuid references public.candidate_sources(id),
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  unique (kind, value)
);
create index if not exists candidate_identities_candidate_idx on public.candidate_identities (candidate_id);
create index if not exists candidate_identities_source_idx on public.candidate_identities (source_id) where source_id is not null;

create table if not exists public.schools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_name text not null,
  linkedin_org_id text,
  linkedin_url_normalized text,
  identity_basis text not null check (identity_basis in ('linkedin_org_id', 'linkedin_url', 'name')),
  company_id uuid references public.companies(id),
  logo_url text,
  country text,
  tier smallint,
  tier_list_version text,
  merged_into uuid,
  created_from text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists schools_linkedin_org_id_key on public.schools (linkedin_org_id) where linkedin_org_id is not null;
create unique index if not exists schools_linkedin_url_normalized_key on public.schools (linkedin_url_normalized) where linkedin_url_normalized is not null;
create unique index if not exists schools_name_key on public.schools (normalized_name) where identity_basis = 'name';
create index if not exists schools_company_idx on public.schools (company_id) where company_id is not null;

create table if not exists public.candidate_educations (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete restrict,
  school_id uuid not null references public.schools(id),
  school_name text not null,
  degree text,
  degree_level text,
  field_of_study text,
  start_year smallint,
  start_month smallint,
  end_year smallint,
  end_month smallint,
  description text,
  activities text,
  sort_order smallint not null,
  row_key text not null,
  source_id uuid not null references public.candidate_sources(id),
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  removed_at timestamptz
);
create unique index if not exists candidate_educations_row_key_key
  on public.candidate_educations (candidate_id, row_key) where removed_at is null;
create index if not exists candidate_educations_candidate_idx on public.candidate_educations (candidate_id);
create index if not exists candidate_educations_school_idx on public.candidate_educations (school_id);
create index if not exists candidate_educations_source_idx on public.candidate_educations (source_id);

create table if not exists public.skills (
  id bigint generated by default as identity primary key,
  name text not null,
  key text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.candidate_skills (
  candidate_id uuid not null references public.candidates(id) on delete restrict,
  skill_id bigint not null references public.skills(id),
  is_top boolean not null default false,
  endorsements int,
  job_count smallint,
  sort_order smallint,
  source_id uuid references public.candidate_sources(id),
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  removed_at timestamptz,
  primary key (candidate_id, skill_id)
);
create index if not exists candidate_skills_skill_idx on public.candidate_skills (skill_id);
create index if not exists candidate_skills_source_idx on public.candidate_skills (source_id) where source_id is not null;

-- Every email, phone, GitHub and website, one row each. rank 1 = primary per
-- kind; a row that is not active, or may never be primary, is never ranked.
create table if not exists public.candidate_contacts (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete restrict,
  kind text not null check (kind in ('email', 'phone', 'github', 'website')),
  value_raw text not null,
  value_normalized text not null,
  label text not null default 'unknown' check (label in ('personal', 'business', 'academic', 'mobile', 'home', 'office', 'unknown')),
  rank smallint check (rank >= 1),
  status text not null default 'active' check (status in ('active', 'invalid', 'bounced', 'do_not_use', 'removed', 'claimed', 'shared')),
  quality text,
  result text,
  resultcode text,
  subresult text,
  verifier text,
  verified_at timestamptz,
  verification_raw jsonb,
  source text not null,
  source_detail text,
  source_id uuid references public.candidate_sources(id),
  is_manual boolean not null default false,
  -- When a recruiter last chose it (the choosing doc's fetched_at): the
  -- order among several manual picks. Only a manual doc sets it.
  manual_at timestamptz,
  never_primary boolean not null default false,
  -- The old tables marked it the person's primary (candidate_emails or _v2
  -- is_primary, or email_source 'primary'): breaks ties within a tier, as
  -- the Network's pick does today.
  legacy_primary boolean not null default false,
  legacy_email_ids uuid[],
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (candidate_id, kind, value_normalized),
  constraint candidate_contacts_rank_eligible check (rank is null or (status = 'active' and not never_primary))
);
create unique index if not exists candidate_contacts_one_primary
  on public.candidate_contacts (candidate_id, kind) where rank = 1;
create index if not exists candidate_contacts_value_idx on public.candidate_contacts (kind, value_normalized);
create index if not exists candidate_contacts_source_idx on public.candidate_contacts (source_id) where source_id is not null;

-- The review queue for anything the writer refused to attach on its own.
create table if not exists public.identity_conflicts (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  candidate_ids uuid[],
  incoming jsonb,
  evidence_hash text,
  source_id uuid,
  status text not null default 'open',
  created_at timestamptz not null default now()
);
create unique index if not exists identity_conflicts_open_key
  on public.identity_conflicts (kind, evidence_hash) where status = 'open';
create index if not exists identity_conflicts_candidates_idx on public.identity_conflicts using gin (candidate_ids);

-- Resumable checkpoints for backfill runs.
create table if not exists public.backfill_runs (
  run_id text primary key,
  pass text,
  last_id uuid,
  processed int,
  conflicts int,
  status text,
  started_at timestamptz,
  finished_at timestamptz,
  notes jsonb
);

-- ---------------------------------------------------------------------------
-- New nullable columns on existing tables (constant defaults: no rewrite)
-- ---------------------------------------------------------------------------

alter table public.companies
  add column if not exists normalized_name text,
  add column if not exists linkedin_url_normalized text,
  add column if not exists identity_basis text,
  add column if not exists is_placeholder boolean default false,
  add column if not exists tier smallint,
  add column if not exists tier_list_version text,
  add column if not exists merged_into uuid,
  add column if not exists created_from text,
  add column if not exists first_seen_at timestamptz;

-- Not unique: existing rows may hold duplicates. The writer keeps its own rows
-- unique through its lookup order and an advisory lock per identity key.
create index if not exists companies_normalized_name_idx
  on public.companies (normalized_name) where normalized_name is not null;
create index if not exists companies_linkedin_url_normalized_idx
  on public.companies (linkedin_url_normalized) where linkedin_url_normalized is not null;
create index if not exists companies_lower_linkedin_username_idx
  on public.companies (lower(linkedin_username)) where linkedin_username is not null;
create index if not exists companies_created_from_idx
  on public.companies (created_from) where created_from is not null;

alter table public.candidate_experiences
  add column if not exists company_id uuid references public.companies(id),
  add column if not exists company_linkedin_id text,
  add column if not exists is_side_role boolean default false,
  add column if not exists row_key text,
  add column if not exists source_id uuid references public.candidate_sources(id),
  add column if not exists first_seen_at timestamptz,
  add column if not exists last_seen_at timestamptz,
  add column if not exists removed_at timestamptz;

create unique index if not exists candidate_experiences_row_key_key
  on public.candidate_experiences (candidate_id, row_key) where row_key is not null and removed_at is null;
create index if not exists candidate_experiences_company_idx
  on public.candidate_experiences (company_id) where company_id is not null;
create index if not exists candidate_experiences_source_id_idx
  on public.candidate_experiences (source_id) where source_id is not null;

-- ---------------------------------------------------------------------------
-- Small helpers (website-owned; they call no April function)
-- ---------------------------------------------------------------------------

-- Company/school names: lowercase, punctuation to spaces, legal suffixes off.
create or replace function public.tt_normalize_org_name(p text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  v text;
  suffix constant text := ' (incorporated|inc|corporation|corp|company|co|llc|limited|ltd|plc|llp|lp|gmbh|ag|sa|bv|nv|pte|pty|sarl|oy|ab)$';
begin
  if p is null then return null; end if;
  v := btrim(regexp_replace(regexp_replace(lower(btrim(p)), '[[:punct:]]+', ' ', 'g'), '\s+', ' ', 'g'));
  loop
    exit when v !~ suffix;
    v := btrim(regexp_replace(regexp_replace(v, suffix, ''), '\s+', ' ', 'g'));
  end loop;
  return nullif(v, '');
end $$;

-- LinkedIn company/school page URL -> https://www.linkedin.com/<company|school>/<slug>
create or replace function public.tt_normalize_linkedin_org_url(p text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text;
begin
  v := lower(btrim(coalesce(p, '')));
  if v = '' then return null; end if;
  if v like '//%' then v := 'https:' || v;
  elsif v !~ '^[a-z][a-z0-9+.-]*://' then v := 'https://' || regexp_replace(v, '^/+', '');
  end if;
  v := regexp_replace(v, '[#?].*$', '');
  v := regexp_replace(v, '^http://', 'https://');
  v := regexp_replace(v, '^https://([a-z]{2,3}\.|m\.)?linkedin\.com', 'https://www.linkedin.com');
  if v !~ '^https://www\.linkedin\.com/(company|school)/[^/]+' then return null; end if;
  return regexp_replace(v, '^https://www\.linkedin\.com/(company|school)/([^/]+).*$', 'https://www.linkedin.com/\1/\2');
end $$;

-- A LinkedIn username/slug: lowercase, no @, no leading in/ company/ school/,
-- no slashes; a full URL gives its slug.
create or replace function public.tt_normalize_linkedin_slug(p text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text;
begin
  v := lower(btrim(coalesce(p, '')));
  if v = '' then return null; end if;
  if v like '%linkedin.com/%' then
    v := substring(v from 'linkedin\.com/(?:in|pub|company|school)/([^/?#]+)');
    return nullif(btrim(v), '');
  end if;
  v := regexp_replace(v, '^@+', '');
  v := regexp_replace(v, '^/+', '');
  v := regexp_replace(v, '^(in|company|school)/', '');
  v := regexp_replace(v, '[/?#].*$', '');
  return nullif(btrim(v), '');
end $$;

-- The shared placeholder a no-LinkedIn employer name stands for, if any.
create or replace function public.tt_company_placeholder(p_normalized text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_normalized in ('self employed', 'selfemployed', 'self employment') then 'self employed'
    when p_normalized in ('freelance', 'freelancer', 'freelancing') then 'freelance'
    when p_normalized ~ '^stealth( (mode|ai|startup|start up|company|co|venture))*$' then 'stealth'
    when p_normalized in ('career break', 'career gap') then 'career break'
    when p_normalized in ('confidential', 'confidential company', 'undisclosed', 'undisclosed company') then 'confidential'
  end
$$;

-- An email check result: bad | good | risky | none. 'replied' (the person
-- answered from the address) is the strongest good check there is.
create or replace function public.tt_email_check_class(p_quality text, p_result text)
returns text language sql immutable set search_path = '' as $$
  select case
    when lower(p_quality) in ('bad', 'invalid') or lower(p_result) in ('invalid', 'bad', 'bounced', 'disposable') then 'bad'
    when (lower(p_quality) in ('good', 'ok', 'valid') and (p_result is null or lower(p_result) in ('ok', 'valid', 'deliverable', 'replied')))
      or (p_quality is null and lower(p_result) in ('ok', 'valid', 'deliverable', 'replied')) then 'good'
    when lower(p_quality) in ('risky', 'unknown', 'catch_all', 'accept_all')
      or lower(p_result) in ('catch_all', 'unknown', 'risky', 'accept_all') then 'risky'
    else 'none'
  end
$$;

-- A JSON number or numeric string as an integer, else null.
create or replace function public.tt_jint(p jsonb)
returns int language sql immutable set search_path = '' as $$
  select case
    when p is null then null
    when jsonb_typeof(p) = 'number' then trunc((p #>> '{}')::numeric)::int
    when jsonb_typeof(p) = 'string' and btrim(p #>> '{}') ~ '^-?[0-9]{1,9}$' then btrim(p #>> '{}')::int
  end
$$;

-- A JSON value as trimmed non-empty text, else null.
create or replace function public.tt_jtext(p jsonb)
returns text language sql immutable set search_path = '' as $$
  select case when p is null or jsonb_typeof(p) = 'null' then null else nullif(btrim(p #>> '{}'), '') end
$$;

-- Which list source wins a tie on fetched_at: the paid LinkedIn pull, then
-- the directory's copy of one, then the old import.
create or replace function public.tt_source_rank(p_source text)
returns int language sql immutable set search_path = '' as $$
  select case p_source when 'legacy_import' then 0 when 'application' then 1 when 'directory' then 2
    when 'harvest' then 3 when 'recruiter' then 4 else -1 end
$$;

-- Does a doc (fetched_at, source, payload_hash) outrank the source that owns
-- a list now? Newer fetched_at wins; a tie goes to the higher source rank,
-- then the higher payload hash, so the same docs end the same way in any
-- order. No owner: the doc wins. The owner itself does not outrank itself.
create or replace function public.person_doc_beats(p_fetched timestamptz, p_source text, p_hash text, p_owner uuid)
returns boolean language sql stable set search_path = '' as $$
  select case when p_owner is null then true else coalesce((
    select p_fetched > cs.fetched_at
        or (p_fetched = cs.fetched_at
            and (public.tt_source_rank(p_source) > public.tt_source_rank(cs.source)
                 or (public.tt_source_rank(p_source) = public.tt_source_rank(cs.source)
                     and p_hash collate "C" > cs.payload_hash collate "C")))
    from public.candidate_sources cs where cs.id = p_owner), true) end
$$;

-- A company or school object from a PersonDoc, normalised to the identity
-- the writer matches on: {id, user, url, raw, name, norm, ph, tier, tlv, logo}.
create or replace function public.person_org_ident(o jsonb, p_school boolean, p_tlv text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_id text; v_user text; v_url text; v_raw text; v_slug text; v_name text; v_norm text; v_ph text; v_tier int;
begin
  if o is null or jsonb_typeof(o) <> 'object' then return null; end if;
  v_name := public.tt_jtext(o->'name');
  v_id := public.tt_jtext(case when p_school then coalesce(o->'linkedin_org_id', o->'linkedin_id') else coalesce(o->'linkedin_id', o->'linkedin_org_id') end);
  if v_id is not null and v_id !~ '^[0-9]+$' then
    v_id := substring(v_id from ':([0-9]+)$');  -- urn:li:...:<digits>; anything else is not an id
  end if;
  v_user := public.tt_normalize_linkedin_slug(o->>'linkedin_username');
  v_raw := public.tt_jtext(o->'linkedin_url');
  v_url := coalesce(public.tt_jtext(o->'linkedin_url_normalized'), public.tt_normalize_linkedin_org_url(v_raw));
  v_slug := substring(v_url from '/(?:company|school)/([^/]+)$');
  -- A numeric username or URL slug is a LinkedIn id.
  if v_user ~ '^[0-9]+$' then v_id := coalesce(v_id, v_user); v_user := null; end if;
  if v_slug ~ '^[0-9]+$' then v_id := coalesce(v_id, v_slug);
  elsif v_user is null and v_slug is not null and not p_school then v_user := v_slug;
  end if;
  v_norm := coalesce(public.tt_jtext(o->'normalized_name'), public.tt_normalize_org_name(v_name), lower(v_name));
  if not p_school and v_id is null and v_user is null and v_url is null then
    v_ph := case when o->>'is_placeholder' = 'true' then v_norm else public.tt_company_placeholder(v_norm) end;
  end if;
  v_tier := public.tt_jint(case when jsonb_typeof(o->'tier') = 'object' then o->'tier'->'tier' else o->'tier' end);
  return jsonb_build_object(
    'id', v_id, 'user', case when p_school then null else v_user end, 'url', v_url, 'raw', v_raw,
    'name', v_name, 'norm', v_norm, 'ph', v_ph,
    'tier', case when v_tier between 1 and 9 then v_tier end,
    'tlv', coalesce(public.tt_jtext(o->'tier_list_version'), p_tlv),
    'logo', public.tt_jtext(o->'logo_url'));
end $$;

-- Advisory-lock keys for an identity (sorted by the caller before locking).
create or replace function public.person_org_lock_keys(i jsonb, p_school boolean)
returns text[] language sql immutable set search_path = '' as $$
  select case when i is null then '{}'::text[] else array_remove(array[
    case when i->>'id' is not null then 'li:' || (i->>'id') end,
    case when i->>'user' is not null then 'u:' || (i->>'user') end,
    case when i->>'url' is not null then 'url:' || (i->>'url') end,
    case when i->>'id' is null and i->>'user' is null and i->>'url' is null then
      case when i->>'ph' is not null then 'p:' || (i->>'ph') when i->>'norm' is not null then 'n:' || (i->>'norm') end
    end
  ], null) end
$$;

-- Find or create the company for an identity. Order: LinkedIn id, then
-- lower(username), then the normalised URL (or the same URL stored raw on a
-- pre-writer row). A username/URL row that carries a different LinkedIn id is
-- not a match: a new row is made for the id and a company_identity conflict
-- is logged. No LinkedIn identity: the shared placeholder row or the one
-- name-only row for the normalised name. A name never matches a LinkedIn
-- company. A matched row the writer created fills in a missing LinkedIn id
-- or username from the doc (when no other row holds it), so docs arriving
-- in any order end on one row per LinkedIn page. The caller holds the
-- advisory locks for the identity's keys.
create or replace function public.person_company(i jsonb, p_candidate uuid, p_source uuid,
  out company_id uuid, out created boolean, out conflicts int)
language plpgsql set search_path = '' as $$
declare
  v_row record;
  v_own record;
  v_user_clash uuid;
  v_url_clash uuid;
  v_has_li boolean;
  v_display text;
begin
  created := false; conflicts := 0;
  if i is null then return; end if;
  v_has_li := i->>'id' is not null or i->>'user' is not null or i->>'url' is not null;

  if i->>'id' is not null then
    select c.id, c.tier into v_row from public.companies c where c.linkedin_id = i->>'id';
    if found then company_id := v_row.id; end if;
  end if;
  if company_id is null and i->>'user' is not null then
    select c.id, c.tier, c.linkedin_id into v_row from public.companies c
    where lower(c.linkedin_username) = i->>'user' order by c.created_at nulls last, c.id limit 1;
    if found then
      if i->>'id' is null or v_row.linkedin_id is null or v_row.linkedin_id = i->>'id' then company_id := v_row.id;
      else v_user_clash := v_row.id; end if;
    end if;
  end if;
  if company_id is null and i->>'url' is not null then
    select c.id, c.tier, c.linkedin_id into v_row from public.companies c
    where c.linkedin_url_normalized = i->>'url'
    order by c.created_at nulls last, c.id limit 1;
    if not found then
      -- Pre-writer rows keep only the raw URL (usually with a trailing
      -- slash). The explicit predicate lets the live partial unique index
      -- on linkedin_url serve this under a generic plan.
      select c.id, c.tier, c.linkedin_id into v_row from public.companies c
      where c.linkedin_url is not null and c.linkedin_url <> ''
        and c.linkedin_url = any (array_remove(array[i->>'url', (i->>'url') || '/', i->>'raw'], null))
      order by c.created_at nulls last, c.id limit 1;
    end if;
    if found then
      if i->>'id' is null or v_row.linkedin_id is null or v_row.linkedin_id = i->>'id' then company_id := v_row.id;
      else v_url_clash := v_row.id; end if;
    end if;
  end if;

  if company_id is null and not v_has_li then
    if i->>'ph' is not null then
      select c.id, c.tier into v_row from public.companies c
      where c.is_placeholder and c.normalized_name = i->>'ph' order by c.created_at nulls last, c.id limit 1;
    elsif i->>'norm' is not null then
      select c.id, c.tier into v_row from public.companies c
      where c.identity_basis = 'name' and c.normalized_name = i->>'norm' and c.merged_into is null
      order by c.created_at nulls last, c.id limit 1;
    else
      return;  -- the job names no company
    end if;
    if found then company_id := v_row.id; end if;
  end if;

  if company_id is not null then
    -- A row this writer made from part of a LinkedIn identity learns the rest
    -- (a username-only row meets a doc with the id, or an id-only row meets
    -- a doc with the username), so the next doc that names only the id or
    -- only the username finds this row instead of making a second one for
    -- the same LinkedIn page. Only when no other row holds the value, and
    -- only on the writer's own rows: pre-existing companies rows keep their
    -- LinkedIn columns as they are. The caller holds the advisory locks for
    -- every key of this identity, so no other writer can take the value.
    if v_has_li then
      select c.created_from, c.linkedin_id, c.linkedin_username, c.identity_basis into v_own
      from public.companies c where c.id = company_id;
      if v_own.created_from = 'person_writer' then
        if i->>'id' is not null and v_own.linkedin_id is null
           and not exists (select 1 from public.companies x where x.linkedin_id = i->>'id') then
          update public.companies c set linkedin_id = i->>'id', identity_basis = 'linkedin_id'
          where c.id = company_id;
        end if;
        if i->>'user' is not null and v_own.linkedin_username is null
           and not exists (select 1 from public.companies x where lower(x.linkedin_username) = i->>'user') then
          update public.companies c set linkedin_username = i->>'user',
            identity_basis = case when c.identity_basis = 'linkedin_url' then 'linkedin_username' else c.identity_basis end
          where c.id = company_id;
        end if;
      end if;
    end if;
    -- Fill a missing tier, only on a row this writer made (never on a
    -- placeholder). Pre-existing companies rows are not written at all: an
    -- update there would also bump their updated_at through the live
    -- trigger, which no undo can put back. Tiering every company is
    -- migration step 10's job.
    if v_row.tier is null and (i->>'tier') is not null and i->>'ph' is null then
      update public.companies c set tier = (i->>'tier')::smallint, tier_list_version = i->>'tlv'
      where c.id = company_id and c.tier is null and not coalesce(c.is_placeholder, false)
        and c.created_from = 'person_writer';
    end if;
    return;
  end if;

  v_display := case i->>'ph'
    when 'self employed' then 'Self-employed' when 'freelance' then 'Freelance' when 'stealth' then 'Stealth'
    when 'career break' then 'Career Break' when 'confidential' then 'Confidential' end;
  insert into public.companies (name, linkedin_id, linkedin_username, linkedin_url, logo_url,
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
  returning id into company_id;
  created := true;

  if v_user_clash is not null or v_url_clash is not null then
    insert into public.identity_conflicts (kind, candidate_ids, incoming, evidence_hash, source_id)
    values ('company_identity', array[p_candidate],
      jsonb_build_object('company', i, 'created_company_id', company_id,
        'username_row', v_user_clash, 'url_row', v_url_clash),
      md5('company|' || coalesce(i->>'id', '') || '|' || coalesce(i->>'user', '') || '|' || coalesce(i->>'url', '')),
      p_source)
    on conflict (kind, evidence_hash) where status = 'open' do nothing;
    if found then conflicts := 1; end if;
  end if;
end $$;

-- Find or create the school for an identity: LinkedIn school id, then the
-- normalised URL, then the one name-only row. Same clash rule as companies.
create or replace function public.person_school(i jsonb, p_candidate uuid, p_source uuid,
  out school_id uuid, out created boolean, out conflicts int)
language plpgsql set search_path = '' as $$
declare
  v_row record;
  v_own record;
  v_url_clash uuid;
begin
  created := false; conflicts := 0;
  if i is null or (i->>'id' is null and i->>'url' is null and i->>'norm' is null) then return; end if;

  if i->>'id' is not null then
    select s.id, s.tier into v_row from public.schools s where s.linkedin_org_id = i->>'id';
    if found then school_id := v_row.id; end if;
  end if;
  if school_id is null and i->>'url' is not null then
    select s.id, s.tier, s.linkedin_org_id into v_row from public.schools s where s.linkedin_url_normalized = i->>'url';
    if found then
      if i->>'id' is null or v_row.linkedin_org_id is null or v_row.linkedin_org_id = i->>'id' then school_id := v_row.id;
      else v_url_clash := v_row.id; end if;
    end if;
  end if;
  if school_id is null and i->>'id' is null and i->>'url' is null then
    select s.id, s.tier into v_row from public.schools s where s.identity_basis = 'name' and s.normalized_name = i->>'norm';
    if found then school_id := v_row.id; end if;
  end if;

  if school_id is not null then
    -- As person_company: a row this writer made learns the LinkedIn school id
    -- (matched by URL) or the page URL (matched by id) it lacks, when no
    -- other row holds that value, so a later doc naming only one of them
    -- finds this row whatever order the docs arrive in. The caller holds the
    -- advisory locks for the li: and url: keys.
    select s.created_from, s.linkedin_org_id, s.linkedin_url_normalized into v_own from public.schools s where s.id = school_id;
    if v_own.created_from = 'person_writer' then
      if i->>'id' is not null and v_own.linkedin_org_id is null
         and not exists (select 1 from public.schools x where x.linkedin_org_id = i->>'id') then
        update public.schools s set linkedin_org_id = i->>'id', identity_basis = 'linkedin_org_id',
          company_id = coalesce(s.company_id, (select c.id from public.companies c where c.linkedin_id = i->>'id')),
          updated_at = now()
        where s.id = school_id;
      end if;
      if i->>'url' is not null and v_own.linkedin_url_normalized is null
         and not exists (select 1 from public.schools x where x.linkedin_url_normalized = i->>'url') then
        update public.schools s set linkedin_url_normalized = i->>'url', updated_at = now()
        where s.id = school_id;
      end if;
    end if;
    if v_row.tier is null and (i->>'tier') is not null then
      update public.schools s set tier = (i->>'tier')::smallint, tier_list_version = i->>'tlv', updated_at = now()
      where s.id = school_id and s.tier is null;
    end if;
    return;
  end if;

  insert into public.schools (name, normalized_name, linkedin_org_id, linkedin_url_normalized, identity_basis,
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
  returning id into school_id;
  created := true;

  if v_url_clash is not null then
    insert into public.identity_conflicts (kind, candidate_ids, incoming, evidence_hash, source_id)
    values ('school_identity', array[p_candidate],
      jsonb_build_object('school', i, 'created_school_id', school_id, 'url_row', v_url_clash),
      md5('school|' || coalesce(i->>'id', '') || '|' || coalesce(i->>'url', '')), p_source)
    on conflict (kind, evidence_hash) where status = 'open' do nothing;
    if found then conflicts := 1; end if;
  end if;
end $$;

-- The rank each of one person's contacts should hold. Eligible = active and
-- not never_primary; everything else gets null. Emails: recruiter's choice
-- (the latest pick first), the directory's primary, verified personal,
-- verified business, other verified, risky, unverified. Phones: recruiter,
-- directory, mobile, other. GitHub/website: recruiter, then oldest. Within a
-- tier: a personal address, then the one the old tables marked primary (the
-- Network's pick today), then the newest check, then the first seen. Every
-- column it orders by is one the re-rank itself never writes, so both of
-- its passes see the same order.
create or replace function public.person_contact_ranks(p_candidate uuid)
returns table (id uuid, new_rank bigint) language sql stable set search_path = '' as $$
  select x.id, case when x.eligible then row_number() over (partition by x.kind, x.eligible order by
      x.tier, x.manual_at desc nulls last, x.personal desc, x.legacy_primary desc, x.verified_at desc nulls last,
      x.first_seen_at nulls last, x.value_normalized) end as new_rank
  from (
    select cc.id, cc.kind, cc.value_normalized, cc.verified_at, cc.first_seen_at, cc.legacy_primary,
      (cc.status = 'active' and not cc.never_primary) as eligible,
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

-- Re-rank one person's contacts: exactly one rank 1 per kind among eligible
-- rows. Two passes, so the one-primary index never sees two rank-1 rows
-- mid-way: rows whose rank changes lose it first, then take the new one.
create or replace function public.person_rerank_contacts(p_candidate uuid)
returns void language plpgsql set search_path = '' as $$
begin
  update public.candidate_contacts c set rank = null, updated_at = now()
  from public.person_contact_ranks(p_candidate) r
  where c.id = r.id and c.rank is not null and c.rank is distinct from r.new_rank;

  update public.candidate_contacts c set rank = r.new_rank, updated_at = now()
  from public.person_contact_ranks(p_candidate) r
  where c.id = r.id and c.rank is null and r.new_rank is not null;
end $$;

-- ---------------------------------------------------------------------------
-- save_person
-- ---------------------------------------------------------------------------
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
  v_el jsonb;
  v_ord bigint;
  v_i jsonb;
  v_rk text;
  v_seen text[] := '{}';
  v_kept uuid[] := '{}';
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
  header_fields constant text[] := array['full_name', 'headline', 'summary', 'location', 'location_country', 'photo', 'open_to_work'];
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
    and public.person_doc_beats(v_fetched, v_source, v_hash, case when v_state_existed then v_state.jobs_source_id end);
  v_beats_edus := v_mode = 'replace_lists' and v_has_edus
    and public.person_doc_beats(v_fetched, v_source, v_hash, case when v_state_existed then v_state.educations_source_id end);
  v_beats_skills := v_mode = 'replace_lists' and v_has_skills
    and public.person_doc_beats(v_fetched, v_source, v_hash, case when v_state_existed then v_state.skills_source_id end);

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
      if v_cur is null
         or (v_mode <> 'fill_gaps'
             and (v_cur->>'source' <> 'recruiter' or v_source = 'recruiter')
             and ((v_cur->>'at')::timestamptz < v_fetched or v_cur->>'source' = 'application' or v_source = 'recruiter')) then
        v_header := jsonb_set(v_header, array[v_f], jsonb_build_object('value', v_val, 'source', v_source, 'at', v_fetched));
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
      if found then
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
          and (cs.fetched_at > v_fetched or (cs.fetched_at = v_fetched and cs.payload_hash collate "C" > v_hash collate "C")));
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
        -- Keep the best check: the newest verified_at wins; a check beats none.
        c_newer := (c_q is not null or c_r is not null or c_vat is not null)
          and ((c_vat is not null and (v_row.verified_at is null or c_vat > v_row.verified_at))
               or (c_vat is null and v_row.verified_at is null and v_row.quality is null and v_row.result is null));
        n_class := case when c_kind <> 'email' then 'none'
                        when c_newer then c_class
                        when c_class = 'bad' and c_q is null and c_r is null and c_vat is null
                             and v_row.quality is null and v_row.result is null then 'bad'
                        else public.tt_email_check_class(v_row.quality, v_row.result) end;
        -- Status: a recruiter decides; removed/do-not-use stay; a recruiter's
        -- active choice is not demoted by automation; claimed becomes active
        -- once a trusted source backs it; otherwise the newest check wins.
        n_status := v_row.status;
        if c_manual then
          n_status := c_status;
        elsif v_row.status in ('removed', 'do_not_use') then
          n_status := v_row.status;
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
    and public.person_doc_beats(v_fetched, v_source, v_hash, case when v_state_existed then v_state.lists_source_id end)
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

-- ---------------------------------------------------------------------------
-- The flat contact shape, worked out from the rows so it can never disagree
-- ---------------------------------------------------------------------------
create or replace view public.candidate_contact_summary with (security_invoker = on) as
select
  c.candidate_id,
  (array_agg(c.value_normalized) filter (where c.kind = 'email' and c.rank = 1))[1] as primary_email,
  (array_agg(c.value_normalized) filter (where c.kind = 'email' and c.rank = 2))[1] as secondary_email,
  (array_agg(c.value_normalized order by c.rank nulls last, c.value_normalized)
     filter (where c.kind = 'email' and c.status = 'active' and c.label = 'personal'))[1] as personal_email,
  (array_agg(c.value_normalized order by c.rank nulls last, c.value_normalized)
     filter (where c.kind = 'email' and c.status = 'active' and c.label = 'business'))[1] as business_email,
  (array_agg(c.value_normalized order by c.rank nulls last, c.value_normalized)
     filter (where c.kind = 'email' and c.status = 'active' and c.label = 'academic'))[1] as academic_email,
  (array_agg(c.value_normalized) filter (where c.kind = 'phone' and c.rank = 1))[1] as primary_phone,
  (array_agg(c.value_normalized) filter (where c.kind = 'phone' and c.rank = 2))[1] as secondary_phone,
  (array_agg(c.value_normalized order by c.rank nulls last, c.value_normalized)
     filter (where c.kind = 'phone' and c.status = 'active' and c.label = 'mobile'))[1] as mobile_phone,
  (array_agg(c.value_normalized order by c.rank nulls last, c.value_normalized)
     filter (where c.kind = 'github' and c.status = 'active'))[1] as github,
  coalesce(array_agg(c.value_normalized order by c.rank nulls last, c.value_normalized)
     filter (where c.kind = 'email' and c.status = 'active'), '{}'::text[]) as usable_emails
from public.candidate_contacts c
group by c.candidate_id;

-- ---------------------------------------------------------------------------
-- Access: RLS on with no policies; nothing for anon or signed-in users.
-- The server uses the service key (service_role keeps its default grants).
-- ---------------------------------------------------------------------------
alter table public.candidate_sources enable row level security;
alter table public.candidate_profile_state enable row level security;
alter table public.candidate_identities enable row level security;
alter table public.schools enable row level security;
alter table public.candidate_educations enable row level security;
alter table public.skills enable row level security;
alter table public.candidate_skills enable row level security;
alter table public.candidate_contacts enable row level security;
alter table public.identity_conflicts enable row level security;
alter table public.backfill_runs enable row level security;

revoke all on table public.candidate_sources, public.candidate_profile_state, public.candidate_identities,
  public.schools, public.candidate_educations, public.skills, public.candidate_skills, public.candidate_contacts,
  public.identity_conflicts, public.backfill_runs, public.candidate_contact_summary
  from anon, authenticated;
revoke all on sequence public.skills_id_seq from anon, authenticated;

revoke execute on function
  public.tt_normalize_org_name(text),
  public.tt_normalize_linkedin_org_url(text),
  public.tt_normalize_linkedin_slug(text),
  public.tt_company_placeholder(text),
  public.tt_email_check_class(text, text),
  public.tt_jint(jsonb),
  public.tt_jtext(jsonb),
  public.tt_source_rank(text),
  public.person_doc_beats(timestamptz, text, text, uuid),
  public.person_org_ident(jsonb, boolean, text),
  public.person_org_lock_keys(jsonb, boolean),
  public.person_company(jsonb, uuid, uuid),
  public.person_school(jsonb, uuid, uuid),
  public.person_contact_ranks(uuid),
  public.person_rerank_contacts(uuid),
  public.save_person(jsonb)
  from public, anon, authenticated;

grant execute on function
  public.tt_normalize_org_name(text),
  public.tt_normalize_linkedin_org_url(text),
  public.tt_normalize_linkedin_slug(text),
  public.tt_company_placeholder(text),
  public.tt_email_check_class(text, text),
  public.tt_jint(jsonb),
  public.tt_jtext(jsonb),
  public.tt_source_rank(text),
  public.person_doc_beats(timestamptz, text, text, uuid),
  public.person_org_ident(jsonb, boolean, text),
  public.person_org_lock_keys(jsonb, boolean),
  public.person_company(jsonb, uuid, uuid),
  public.person_school(jsonb, uuid, uuid),
  public.person_contact_ranks(uuid),
  public.person_rerank_contacts(uuid),
  public.save_person(jsonb)
  to service_role;
