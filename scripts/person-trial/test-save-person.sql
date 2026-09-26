-- Tests for migration 072 (save_person and the person tables).
--
-- Run on a LOCAL Postgres only, on a fresh database where
-- scripts/person-trial/local-schema.sql and then
-- supabase/migrations/072_person_tables.sql have been applied:
--   scripts/person-trial/run-local-tests.sh <port>
-- Every fixture is synthetic (example.com addresses, 555 numbers, made-up
-- names and ids). Each check raises an exception on failure, so psql with
-- ON_ERROR_STOP=1 stops at the first failure; every pass prints "PASS".

\set ON_ERROR_STOP 1
set client_min_messages = notice;

create schema t;
alter default privileges in schema t grant all on tables to service_role;

-- Synthetic people: t.p(n) is person n's id.
create function t.p(n int) returns uuid language sql immutable as
$$ select ('a0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;

insert into public.candidates (id, full_name, linkedin_username, email, current_title, current_company)
select t.p(n), 'Test Person ' || n, 'test-person-' || n, 'test' || n || '@example.com', 'Engineer', 'Acme Robotics'
from generate_series(1, 5) n;

-- Pre-writer companies, shaped like the live rows (numeric ids, lowercase
-- usernames, URLs stored with a trailing slash).
insert into public.companies (name, linkedin_id, linkedin_username, linkedin_url) values
  ('Acme Robotics', '1001', 'acme-robotics', 'https://www.linkedin.com/company/acme-robotics/'),
  ('Globex', '2002', 'globex', 'https://www.linkedin.com/company/globex/'),
  ('Initech', '3003', 'initech', 'https://www.linkedin.com/company/initech/'),
  ('Umbrella', '4004', null, 'https://www.linkedin.com/company/umbrella-co/');

-- A live-style Harvest job row the writer must leave alone.
insert into public.candidate_experiences (organization_id, candidate_id, source, provider_experience_key, title, company_name, sort_order)
values ('801865a7-6533-41d2-9c45-e4a90e6ad51a', t.p(1), 'harvest', 'harvest-key-1', 'Engineer', 'Acme Robotics', 0);

create table t.docs (name text primary key, doc jsonb not null);
create table t.results (name text primary key, res jsonb not null);

-- Save a named fixture doc (as service_role, like the REST RPC) and keep the result.
create function t.save(p_name text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r := public.save_person((select d.doc from t.docs d where d.name = p_name));
  insert into t.results (name, res) values (p_name, r) on conflict (name) do update set res = excluded.res;
  return r;
end $$;
grant usage, create on schema t to service_role;
grant all on all tables in schema t to service_role;
grant execute on all functions in schema t to service_role;

-- A fingerprint of every table the writer can touch.
create function t.fp_all() returns text language sql as $$
  select md5(concat_ws('|',
    (select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.candidate_sources x),
    (select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.candidate_profile_state x),
    (select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.candidate_identities x),
    (select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.schools x),
    (select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.candidate_educations x),
    (select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.skills x),
    (select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.candidate_skills x),
    (select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.candidate_contacts x),
    (select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.identity_conflicts x),
    (select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.companies x),
    (select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.candidate_experiences x)))
$$;

-- A fingerprint of one person's lists (jobs, schools, skills).
create function t.fp_lists(p uuid) returns text language sql as $$
  select md5(concat_ws('|',
    (select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.candidate_experiences x where x.candidate_id = p),
    (select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.candidate_educations x where x.candidate_id = p),
    (select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.candidate_skills x where x.candidate_id = p)))
$$;

create table t.snap (name text primary key, v text);
insert into t.snap values
  ('candidates', (select md5(string_agg(x::text, ',' order by x.id)) from public.candidates x)),
  ('harvest_rows', (select md5(string_agg(x::text, ',' order by x.id)) from public.candidate_experiences x where x.source = 'harvest'));

-- ---------------------------------------------------------------------------
-- Fixture docs
-- ---------------------------------------------------------------------------
insert into t.docs (name, doc) values
('A', jsonb_build_object(
  'candidate_id', t.p(1), 'mode', 'replace_lists',
  'source', jsonb_build_object('source', 'legacy_import', 'provider', 'rapidapi_v1', 'source_ref', 'legacy',
    'fetched_at', '2024-01-01T00:00:00Z', 'payload_hash', 'hash-A', 'raw_in', 'candidates.linkedin_data',
    'enrichment_id', null, 'parser_version', 'test-1'),
  'identities', jsonb_build_array(
    jsonb_build_object('kind', 'linkedin_username', 'value', 'Test-Person-1'),
    jsonb_build_object('kind', 'airtable_id', 'value', 'recSYNTH1')),
  'header', jsonb_build_object('full_name', 'Test Person 1', 'headline', 'Engineer at Acme', 'summary', '',
    'location', 'Springfield', 'location_country', null, 'photo', null, 'open_to_work', null),
  'jobs', jsonb_build_array(
    jsonb_build_object('row_key', 'rk-acme-eng', 'sort_order', 0, 'title', 'Engineer', 'is_current', true, 'start_year', 2020, 'start_month', 3,
      'employment_type', 'full_time', 'skills', jsonb_build_array('Python', 'SQL'),
      'company', jsonb_build_object('name', 'Acme Robotics', 'linkedin_id', '1001')),
    jsonb_build_object('row_key', 'rk-globex', 'sort_order', 1, 'title', 'Analyst', 'start_year', 2018, 'end_year', 2020,
      'company', jsonb_build_object('name', 'Globex Corp', 'linkedin_username', '2002')),
    jsonb_build_object('row_key', 'rk-umbrella', 'sort_order', 2, 'title', 'Intern', 'start_year', 2017, 'end_year', 2017,
      'company', jsonb_build_object('name', 'Umbrella', 'linkedin_url', 'https://linkedin.com/company/umbrella-co?trk=x')),
    jsonb_build_object('row_key', 'rk-tiny', 'sort_order', 3, 'title', 'Helper', 'start_year', 2016,
      'company', jsonb_build_object('name', 'Tiny Shop LLC')),
    jsonb_build_object('row_key', 'rk-self', 'sort_order', 4, 'title', 'Consultant', 'start_year', 2015,
      'company', jsonb_build_object('name', 'Self-employed')),
    jsonb_build_object('row_key', 'rk-new', 'sort_order', 5, 'title', 'Founder', 'start_year', 2014,
      'company', jsonb_build_object('name', 'New Startup', 'linkedin_id', '5005', 'linkedin_url', 'https://www.linkedin.com/company/new-startup/', 'tier', 1)),
    jsonb_build_object('row_key', 'rk-tiny2', 'sort_order', 6, 'title', 'Clerk', 'start_year', 2013,
      'company', jsonb_build_object('name', 'Tiny Shop, Inc.')),
    jsonb_build_object('row_key', 'rk-stealth', 'sort_order', 7, 'title', 'Engineer', 'start_year', 2012,
      'company', jsonb_build_object('name', 'Stealth Startup')),
    jsonb_build_object('row_key', 'rk-acme-eng', 'sort_order', 8, 'title', 'Engineer (listed twice)', 'start_year', 2020,
      'company', jsonb_build_object('name', 'Acme Robotics', 'linkedin_id', '1001')),
    jsonb_build_object('row_key', 'rk-acme-name', 'sort_order', 9, 'title', 'Volunteer', 'start_year', 2011, 'is_side_role', true,
      'company', jsonb_build_object('name', 'Acme Robotics'))),
  'educations', jsonb_build_array(
    jsonb_build_object('row_key', 'rk-e1', 'sort_order', 0, 'degree', 'BS', 'degree_level', 'bachelor', 'field_of_study', 'Physics',
      'start_year', 2006, 'end_year', 2010,
      'school', jsonb_build_object('name', 'Test University', 'linkedin_org_id', '9001', 'tier', 1)),
    jsonb_build_object('row_key', 'rk-e2', 'sort_order', 1, 'degree', 'AA', 'start_year', 2004, 'end_year', 2006,
      'school', jsonb_build_object('name', 'Community College')),
    jsonb_build_object('row_key', 'rk-e3', 'sort_order', 2, 'degree', 'Certificate', 'start_year', 2011,
      'school', jsonb_build_object('name', 'Test University', 'linkedin_url', 'https://www.linkedin.com/school/9001/'))),
  'skills', jsonb_build_array(
    jsonb_build_object('name', 'Python', 'key', 'python', 'is_top', true, 'endorsements', 12, 'sort_order', 0),
    jsonb_build_object('name', 'Python (Programming Language)', 'key', 'python', 'endorsements', 3, 'job_count', 1, 'sort_order', 1),
    jsonb_build_object('name', 'SQL', 'key', 'sql', 'sort_order', 2)),
  'contacts', jsonb_build_array(
    jsonb_build_object('kind', 'email', 'value_raw', 'One.Personal@Example.com', 'value_normalized', 'one.personal@example.com',
      'label', 'personal', 'quality', 'good', 'result', 'ok', 'resultcode', 1, 'verifier', 'test', 'verified_at', '2024-02-01T00:00:00Z',
      'legacy_email_id', 'b0000000-0000-4000-8000-000000000001'),
    jsonb_build_object('kind', 'email', 'value_raw', 'one@acme.example.com', 'value_normalized', 'one@acme.example.com',
      'label', 'business', 'quality', 'risky', 'result', 'catch_all', 'verified_at', '2024-02-01T00:00:00Z'),
    jsonb_build_object('kind', 'email', 'value_raw', 'old@example.com', 'value_normalized', 'old@example.com',
      'quality', 'bad', 'result', 'invalid', 'verified_at', '2024-02-01T00:00:00Z'),
    jsonb_build_object('kind', 'email', 'value_raw', 'raw.only@example.com', 'value_normalized', 'raw.only@example.com',
      'never_primary', true, 'source_detail', 'raw_import'),
    jsonb_build_object('kind', 'email', 'value_raw', 'claimed@example.com', 'value_normalized', 'claimed@example.com', 'status', 'claimed'),
    jsonb_build_object('kind', 'phone', 'value_raw', '(555) 000-0001', 'value_normalized', '+15550000001', 'label', 'mobile'),
    jsonb_build_object('kind', 'phone', 'value_raw', '555 000 0002', 'value_normalized', '+15550000002', 'label', 'office'))
)),
-- A newer LinkedIn pull: keeps two jobs (one retitled), adds one at a
-- company whose username another LinkedIn id holds, drops the rest.
('B', jsonb_build_object(
  'candidate_id', t.p(1), 'mode', 'replace_lists',
  'source', jsonb_build_object('source', 'harvest', 'provider', 'harvest_full_profile', 'source_ref', 'enrichment-B',
    'fetched_at', '2025-06-01T00:00:00Z', 'payload_hash', 'hash-B', 'raw_in', 'candidate_enrichments',
    'enrichment_id', 'c0000000-0000-4000-8000-000000000001', 'parser_version', 'test-1'),
  'identities', jsonb_build_array(
    jsonb_build_object('kind', 'linkedin_username', 'value', 'test-person-1'),
    jsonb_build_object('kind', 'linkedin_urn', 'value', 'ACoSYNTH1')),
  'header', jsonb_build_object('headline', 'Senior Engineer at Acme', 'summary', 'Builds robots', 'location', '',
    'photo', 'https://example.com/p1.jpg'),
  'jobs', jsonb_build_array(
    jsonb_build_object('row_key', 'rk-acme-eng', 'sort_order', 0, 'title', 'Senior Engineer', 'is_current', true, 'start_year', 2020, 'start_month', 3,
      'company', jsonb_build_object('name', 'Acme Robotics', 'linkedin_id', '1001')),
    jsonb_build_object('row_key', 'rk-new', 'sort_order', 1, 'title', 'Founder', 'start_year', 2014,
      'company', jsonb_build_object('name', 'New Startup', 'linkedin_id', '5005')),
    jsonb_build_object('row_key', 'rk-initech', 'sort_order', 2, 'title', 'Engineer', 'start_year', 2010,
      'company', jsonb_build_object('name', 'Initech Labs', 'linkedin_id', '7007', 'linkedin_username', 'initech'))),
  'educations', jsonb_build_array(
    jsonb_build_object('row_key', 'rk-e1', 'sort_order', 0, 'degree', 'BSc', 'start_year', 2006, 'end_year', 2010,
      'school', jsonb_build_object('name', 'Test University', 'linkedin_org_id', '9001'))),
  'skills', jsonb_build_array(
    jsonb_build_object('name', 'Python', 'key', 'python', 'is_top', true, 'endorsements', 20, 'sort_order', 0),
    jsonb_build_object('name', 'Rust', 'key', 'rust', 'sort_order', 1)),
  'contacts', jsonb_build_array(
    jsonb_build_object('kind', 'email', 'value_raw', 'one@acme.example.com', 'value_normalized', 'one@acme.example.com',
      'label', 'business', 'quality', 'good', 'result', 'ok', 'verified_at', '2025-06-01T00:00:00Z'),
    jsonb_build_object('kind', 'email', 'value_raw', 'OLD@example.com', 'value_normalized', 'old@example.com',
      'label', 'unknown', 'quality', 'good', 'result', 'ok', 'verified_at', '2025-06-01T00:00:00Z',
      'legacy_email_id', 'b0000000-0000-4000-8000-000000000002'))
)),
-- The directory's copy, older than B: recorded, changes no list.
('C', jsonb_build_object(
  'candidate_id', t.p(1), 'mode', 'replace_lists',
  'source', jsonb_build_object('source', 'directory', 'provider', 'reply_ops_directory', 'source_ref', 'dir-1',
    'fetched_at', '2025-01-01T00:00:00Z', 'payload_hash', 'hash-C', 'raw_in', 'directory', 'parser_version', 'test-1'),
  'identities', jsonb_build_array(jsonb_build_object('kind', 'directory_contact_id', 'value', 'dir-contact-1')),
  'header', jsonb_build_object('headline', 'Old directory headline', 'open_to_work', true, 'location_country', 'US'),
  'jobs', jsonb_build_array(
    jsonb_build_object('row_key', 'rk-tiny', 'sort_order', 0, 'title', 'Helper', 'start_year', 2016,
      'company', jsonb_build_object('name', 'Tiny Shop LLC'))),
  'educations', jsonb_build_array(),
  'skills', jsonb_build_array(jsonb_build_object('name', 'COBOL', 'key', 'cobol')),
  'contacts', jsonb_build_array(
    jsonb_build_object('kind', 'email', 'value_raw', 'dir.primary@example.com', 'value_normalized', 'dir.primary@example.com',
      'label', 'personal', 'source_detail', 'directory_primary'),
    jsonb_build_object('kind', 'phone', 'value_raw', '555-000-0003', 'value_normalized', '+15550000003', 'label', 'unknown'))
)),
-- A recruiter's choice: an address an old check marked bad becomes primary.
('D', jsonb_build_object(
  'candidate_id', t.p(1), 'mode', 'contacts_only',
  'source', jsonb_build_object('source', 'recruiter', 'provider', 'dashboard', 'fetched_at', '2025-07-01T00:00:00Z',
    'payload_hash', 'hash-D', 'raw_in', 'inline', 'parser_version', 'test-1'),
  'header', jsonb_build_object('headline', 'ignored in contacts_only'),
  'contacts', jsonb_build_array(
    jsonb_build_object('kind', 'email', 'value_raw', 'old@example.com', 'value_normalized', 'old@example.com',
      'is_manual', true, 'quality', 'bad', 'result', 'invalid'))
)),
-- A later pull lists a job B dropped again: the old row comes back, same id.
('E', jsonb_build_object(
  'candidate_id', t.p(1), 'mode', 'replace_lists',
  'source', jsonb_build_object('source', 'harvest', 'provider', 'harvest_full_profile', 'fetched_at', '2025-08-01T00:00:00Z',
    'payload_hash', 'hash-E', 'raw_in', 'candidate_enrichments', 'parser_version', 'test-1'),
  'jobs', jsonb_build_array(
    jsonb_build_object('row_key', 'rk-acme-eng', 'sort_order', 0, 'title', 'Senior Engineer', 'is_current', true, 'start_year', 2020, 'start_month', 3,
      'company', jsonb_build_object('name', 'Acme Robotics', 'linkedin_id', '1001')),
    jsonb_build_object('row_key', 'rk-globex', 'sort_order', 1, 'title', 'Analyst', 'start_year', 2018, 'end_year', 2020,
      'company', jsonb_build_object('name', 'Globex Corp', 'linkedin_username', '2002')))
)),
-- Person 2: only unusable emails (bad, claimed, never-primary), and an
-- identity that belongs to person 1.
('P2a', jsonb_build_object(
  'candidate_id', t.p(2), 'mode', 'replace_lists',
  'source', jsonb_build_object('source', 'legacy_import', 'fetched_at', '2024-01-01T00:00:00Z', 'payload_hash', 'hash-P2a',
    'raw_in', 'candidates.linkedin_data', 'parser_version', 'test-1'),
  'identities', jsonb_build_array(
    jsonb_build_object('kind', 'linkedin_username', 'value', 'test-person-1'),
    jsonb_build_object('kind', 'linkedin_username', 'value', 'test-person-2')),
  'jobs', jsonb_build_array(),
  'contacts', jsonb_build_array(
    jsonb_build_object('kind', 'email', 'value_raw', 'bad2@example.com', 'value_normalized', 'bad2@example.com',
      'label', 'personal', 'quality', 'bad', 'result', 'invalid', 'verified_at', '2024-06-01T00:00:00Z',
      'legacy_email_id', 'b0000000-0000-4000-8000-000000000021'),
    jsonb_build_object('kind', 'email', 'value_raw', 'typed2@example.com', 'value_normalized', 'typed2@example.com', 'status', 'claimed'),
    jsonb_build_object('kind', 'email', 'value_raw', 'raw2@example.com', 'value_normalized', 'raw2@example.com', 'never_primary', true))
)),
-- Same address, different case, an OLDER good check: the newer bad check stays.
('P2b', jsonb_build_object(
  'candidate_id', t.p(2), 'mode', 'contacts_only',
  'source', jsonb_build_object('source', 'directory', 'fetched_at', '2025-01-01T00:00:00Z', 'payload_hash', 'hash-P2b',
    'raw_in', 'directory', 'parser_version', 'test-1'),
  'identities', jsonb_build_array(jsonb_build_object('kind', 'linkedin_username', 'value', 'TEST-PERSON-1')),
  'contacts', jsonb_build_array(
    jsonb_build_object('kind', 'email', 'value_raw', 'BAD2@EXAMPLE.COM', 'value_normalized', 'bad2@example.com',
      'quality', 'good', 'result', 'ok', 'verified_at', '2024-01-01T00:00:00Z',
      'legacy_email_id', 'b0000000-0000-4000-8000-000000000022'))
)),
-- A NEWER good check: the address becomes usable and primary.
('P2c', jsonb_build_object(
  'candidate_id', t.p(2), 'mode', 'contacts_only',
  'source', jsonb_build_object('source', 'directory', 'fetched_at', '2025-02-01T00:00:00Z', 'payload_hash', 'hash-P2c',
    'raw_in', 'directory', 'parser_version', 'test-1'),
  'contacts', jsonb_build_array(
    jsonb_build_object('kind', 'email', 'value_raw', 'bad2@example.com', 'value_normalized', 'bad2@example.com',
      'quality', 'good', 'result', 'ok', 'verified_at', '2025-02-01T00:00:00Z'))
)),
-- Person 3 works at the same employers: no new companies. An application
-- (fill_gaps) types a headline and an email; person 1's address shows up.
('P3app', jsonb_build_object(
  'candidate_id', t.p(3), 'mode', 'fill_gaps',
  'source', jsonb_build_object('source', 'application', 'provider', 'web_form', 'source_ref', 'app-1',
    'fetched_at', '2025-09-01T00:00:00Z', 'payload_hash', 'hash-P3app', 'raw_in', 'inline', 'parser_version', 'test-1'),
  'identities', jsonb_build_array(jsonb_build_object('kind', 'tt_application_id', 'value', 'app-1')),
  'header', jsonb_build_object('headline', 'Typed headline', 'location', 'Typed town'),
  'contacts', jsonb_build_array(
    jsonb_build_object('kind', 'email', 'value_raw', 'three.typed@example.com', 'value_normalized', 'three.typed@example.com', 'status', 'claimed'),
    jsonb_build_object('kind', 'phone', 'value_raw', '555-000-0031', 'value_normalized', '+15550000031', 'status', 'claimed'))
)),
('P3li', jsonb_build_object(
  'candidate_id', t.p(3), 'mode', 'replace_lists',
  'source', jsonb_build_object('source', 'legacy_import', 'fetched_at', '2023-01-01T00:00:00Z', 'payload_hash', 'hash-P3li',
    'raw_in', 'candidates.linkedin_data', 'parser_version', 'test-1'),
  'header', jsonb_build_object('headline', 'LinkedIn headline', 'location', ''),
  'jobs', jsonb_build_array(
    jsonb_build_object('row_key', 'rk3-acme', 'sort_order', 0, 'title', 'Engineer', 'start_year', 2019,
      'company', jsonb_build_object('name', 'Acme Robotics', 'linkedin_username', 'Acme-Robotics')),
    jsonb_build_object('row_key', 'rk3-tiny', 'sort_order', 1, 'title', 'Clerk', 'start_year', 2015,
      'company', jsonb_build_object('name', 'TINY SHOP')),
    jsonb_build_object('row_key', 'rk3-self', 'sort_order', 2, 'title', 'Freelancer', 'start_year', 2014,
      'company', jsonb_build_object('name', 'Self Employed')),
    jsonb_build_object('row_key', 'rk3-new', 'sort_order', 3, 'title', 'Engineer', 'start_year', 2013,
      'company', jsonb_build_object('name', 'New Startup Inc', 'linkedin_url', 'https://www.linkedin.com/company/5005'))),
  'educations', jsonb_build_array(
    jsonb_build_object('row_key', 'rk3-e1', 'sort_order', 0, 'degree', 'MS', 'start_year', 2011,
      'school', jsonb_build_object('name', 'Test University', 'linkedin_org_id', '9001')),
    jsonb_build_object('row_key', 'rk3-e2', 'sort_order', 1, 'degree', 'AA',
      'school', jsonb_build_object('name', 'Community College.'))),
  'skills', jsonb_build_array(jsonb_build_object('name', 'python', 'key', 'python')),
  'contacts', jsonb_build_array(
    jsonb_build_object('kind', 'email', 'value_raw', 'one.personal@example.com', 'value_normalized', 'one.personal@example.com', 'label', 'personal'))
)),
-- The directory backs up the typed email: it stops being 'claimed'.
('P3dir', jsonb_build_object(
  'candidate_id', t.p(3), 'mode', 'contacts_only',
  'source', jsonb_build_object('source', 'directory', 'fetched_at', '2025-09-02T00:00:00Z', 'payload_hash', 'hash-P3dir',
    'raw_in', 'directory', 'parser_version', 'test-1'),
  'contacts', jsonb_build_array(
    jsonb_build_object('kind', 'email', 'value_raw', 'three.typed@example.com', 'value_normalized', 'three.typed@example.com',
      'label', 'personal', 'quality', 'good', 'result', 'ok', 'verified_at', '2025-09-02T00:00:00Z'))
));

-- Person 5: an application with a job (fill_gaps), a second application, then
-- an older LinkedIn import. Also one address listed twice in one doc.
insert into t.docs (name, doc) values
('P5app1', jsonb_build_object(
  'candidate_id', t.p(5), 'mode', 'fill_gaps',
  'source', jsonb_build_object('source', 'application', 'fetched_at', '2025-09-01T00:00:00Z', 'payload_hash', 'hash-P5app1',
    'raw_in', 'inline', 'parser_version', 'test-1'),
  'jobs', jsonb_build_array(jsonb_build_object('row_key', 'rk5-a', 'title', 'Typed job', 'company', jsonb_build_object('name', 'Typed Co'))),
  'contacts', jsonb_build_array(
    jsonb_build_object('kind', 'email', 'value_raw', 'Five@Example.com', 'value_normalized', 'five@example.com'),
    jsonb_build_object('kind', 'email', 'value_raw', 'five@example.com', 'value_normalized', 'five@example.com',
      'label', 'personal', 'quality', 'good', 'result', 'ok', 'verified_at', '2025-09-01T00:00:00Z'),
    jsonb_build_object('kind', 'github', 'value_raw', 'https://github.com/test-five', 'value_normalized', 'github.com/test-five'))
)),
('P5app2', jsonb_build_object(
  'candidate_id', t.p(5), 'mode', 'fill_gaps',
  'source', jsonb_build_object('source', 'application', 'fetched_at', '2025-09-05T00:00:00Z', 'payload_hash', 'hash-P5app2',
    'raw_in', 'inline', 'parser_version', 'test-1'),
  'jobs', jsonb_build_array(jsonb_build_object('row_key', 'rk5-b', 'title', 'Another typed job', 'company', jsonb_build_object('name', 'Other Co')))
)),
('P5li', jsonb_build_object(
  'candidate_id', t.p(5), 'mode', 'replace_lists',
  'source', jsonb_build_object('source', 'legacy_import', 'fetched_at', '2023-01-01T00:00:00Z', 'payload_hash', 'hash-P5li',
    'raw_in', 'candidates.linkedin_data', 'parser_version', 'test-1'),
  'jobs', jsonb_build_array(jsonb_build_object('row_key', 'rk5-c', 'title', 'LinkedIn job', 'company', jsonb_build_object('name', 'LinkedIn Job Co', 'linkedin_id', '6006'))),
  'educations', jsonb_build_array(jsonb_build_object('row_key', 'rk5-e', 'school', jsonb_build_object('name', ''), 'degree', 'Unknown school'))
));

-- The rest of the suite runs as service_role, the role the REST RPC uses.
set role service_role;

-- ---------------------------------------------------------------------------
-- 1. First save: created, every job linked, lookups in the right order
-- ---------------------------------------------------------------------------
do $$
declare r jsonb; c jsonb; v uuid; n int;
begin
  r := t.save('A');
  c := r->'counts';
  assert r->>'status' = 'created', format('A status %s', r->>'status');
  assert (r->>'applied_lists')::boolean, 'A applied lists';
  assert (c->>'jobs_inserted')::int = 9 and (c->>'jobs_duplicate')::int = 1, format('A jobs %s', c);
  assert (c->>'educations_inserted')::int = 3 and (c->>'schools_created')::int = 2, format('A educations %s', c);
  assert (c->>'skills_inserted')::int = 2 and (c->>'skill_keys_created')::int = 2, format('A skills %s', c);
  assert (c->>'contacts_inserted')::int = 7, format('A contacts %s', c);
  assert (c->>'identities')::int = 2 and (c->>'conflicts')::int = 0, format('A identities %s', c);
  -- Tiny Shop (name-only, shared by two jobs), Self-employed and Stealth
  -- placeholders, New Startup (LinkedIn id), Acme by name (not the LinkedIn Acme).
  assert (c->>'companies_created')::int = 5, format('A companies %s', c);
  raise notice 'PASS 1a first save is "created" with the expected counts %', c;

  select count(*) into n from public.candidate_experiences e
  where e.candidate_id = t.p(1) and e.source = 'person' and e.removed_at is null and e.company_id is null;
  assert n = 0, 'every job links to a company';
  select count(*) into n from public.candidate_experiences e
  where e.candidate_id = t.p(1) and e.source = 'person'
    and (e.organization_id <> '801865a7-6533-41d2-9c45-e4a90e6ad51a' or e.provider_experience_key is distinct from e.row_key);
  assert n = 0, 'writer rows carry the TT org and provider_experience_key = row_key';
  raise notice 'PASS 1b every job linked; rows use source person, TT org, provider_experience_key = row_key';

  -- id, then numeric username (an id), then URL (stored raw with a slash).
  assert (select c2.linkedin_id from public.candidate_experiences e join public.companies c2 on c2.id = e.company_id
          where e.candidate_id = t.p(1) and e.row_key = 'rk-acme-eng') = '1001', 'job by LinkedIn id';
  assert (select c2.linkedin_id from public.candidate_experiences e join public.companies c2 on c2.id = e.company_id
          where e.candidate_id = t.p(1) and e.row_key = 'rk-globex') = '2002', 'numeric username counts as an id';
  assert (select c2.linkedin_id from public.candidate_experiences e join public.companies c2 on c2.id = e.company_id
          where e.candidate_id = t.p(1) and e.row_key = 'rk-umbrella') = '4004', 'job by URL';
  -- name-only: both Tiny Shop spellings share one row; Acme by name is NOT the LinkedIn Acme.
  select count(distinct e.company_id) into n from public.candidate_experiences e
  where e.candidate_id = t.p(1) and e.row_key in ('rk-tiny', 'rk-tiny2');
  assert n = 1, 'one name-only row per normalized name';
  assert (select c2.identity_basis || '/' || c2.normalized_name || '/' || coalesce(c2.created_from, '')
          from public.candidate_experiences e join public.companies c2 on c2.id = e.company_id
          where e.candidate_id = t.p(1) and e.row_key = 'rk-tiny') = 'name/tiny shop/person_writer', 'name-only row shape';
  assert (select c2.linkedin_id is null and c2.identity_basis = 'name'
          from public.candidate_experiences e join public.companies c2 on c2.id = e.company_id
          where e.candidate_id = t.p(1) and e.row_key = 'rk-acme-name'), 'a name never matches a LinkedIn company';
  assert (select c2.is_placeholder and c2.name = 'Self-employed' and c2.tier is null
          from public.candidate_experiences e join public.companies c2 on c2.id = e.company_id
          where e.candidate_id = t.p(1) and e.row_key = 'rk-self'), 'Self-employed -> placeholder';
  assert (select c2.is_placeholder and c2.name = 'Stealth'
          from public.candidate_experiences e join public.companies c2 on c2.id = e.company_id
          where e.candidate_id = t.p(1) and e.row_key = 'rk-stealth'), 'Stealth Startup -> placeholder';
  assert (select c2.tier = 1 and c2.identity_basis = 'linkedin_id' and c2.created_from = 'person_writer'
                 and c2.linkedin_url_normalized = 'https://www.linkedin.com/company/new-startup'
                 and c2.enrichment_status is null
          from public.companies c2 where c2.linkedin_id = '5005'), 'new LinkedIn company: tier from the doc, created_from person_writer';
  assert (select e.is_side_role from public.candidate_experiences e where e.candidate_id = t.p(1) and e.row_key = 'rk-acme-name'), 'is_side_role kept';
  assert (select e.skills = array['Python', 'SQL'] from public.candidate_experiences e where e.candidate_id = t.p(1) and e.row_key = 'rk-acme-eng'), 'per-job skills kept';
  assert (select e.title = 'Engineer' from public.candidate_experiences e where e.candidate_id = t.p(1) and e.row_key = 'rk-acme-eng'),
    'the first of two jobs with one row_key wins';
  raise notice 'PASS 1c company lookup order: id, numeric username, URL, name-only, placeholders; tier set on create';

  -- Schools: id, numeric URL slug = the same id, name-only.
  select count(distinct ce.school_id) into n from public.candidate_educations ce where ce.candidate_id = t.p(1) and ce.row_key in ('rk-e1', 'rk-e3');
  assert n = 1, 'school by id and by numeric URL slug is one school';
  assert (select s.tier = 1 and s.identity_basis = 'linkedin_org_id' from public.schools s where s.linkedin_org_id = '9001'), 'school tier and basis';
  assert (select s.identity_basis = 'name' and s.normalized_name = 'community college' from public.schools s
          join public.candidate_educations ce on ce.school_id = s.id where ce.candidate_id = t.p(1) and ce.row_key = 'rk-e2'), 'name-only school';
  assert (select ce.start_year = 2006 and ce.end_year = 2010 and ce.degree = 'BS' and ce.field_of_study = 'Physics'
          from public.candidate_educations ce where ce.candidate_id = t.p(1) and ce.row_key = 'rk-e1'), 'school years and degree kept';
  raise notice 'PASS 1d schools: id, URL, name-only; years and degree kept';

  -- Skills: duplicate keys merge (top if any, most endorsements, first name).
  assert (select cs.is_top and cs.endorsements = 12 and cs.job_count = 1 and s.name = 'Python'
          from public.candidate_skills cs join public.skills s on s.id = cs.skill_id
          where cs.candidate_id = t.p(1) and s.key = 'python'), 'skill merge by key';
  raise notice 'PASS 1e skills find-or-create by key, duplicates merged';

  -- Identities: username normalised to lowercase.
  assert exists (select 1 from public.candidate_identities i where i.candidate_id = t.p(1) and i.kind = 'linkedin_username' and i.value = 'test-person-1'),
    'username identity normalised';
  raise notice 'PASS 1f identities recorded';

  -- Header: the empty summary is not stored.
  assert (select s.header->'headline'->>'value' = 'Engineer at Acme' and not (s.header ? 'summary')
          from public.candidate_profile_state s where s.candidate_id = t.p(1)), 'header';
  raise notice 'PASS 1g header: non-empty values only';
end $$;

-- ---------------------------------------------------------------------------
-- 2. Contact ranking after the first save
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  assert (select cc.rank = 1 from public.candidate_contacts cc where cc.candidate_id = t.p(1) and cc.value_normalized = 'one.personal@example.com'),
    'verified personal is primary';
  assert (select cc.rank = 2 from public.candidate_contacts cc where cc.candidate_id = t.p(1) and cc.value_normalized = 'one@acme.example.com'),
    'risky business is second';
  assert (select cc.status = 'invalid' and cc.rank is null from public.candidate_contacts cc
          where cc.candidate_id = t.p(1) and cc.value_normalized = 'old@example.com'), 'a bad address is invalid and never ranked';
  assert (select cc.never_primary and cc.rank is null from public.candidate_contacts cc
          where cc.candidate_id = t.p(1) and cc.value_normalized = 'raw.only@example.com'), 'never_primary is never ranked';
  assert (select cc.status = 'claimed' and cc.rank is null from public.candidate_contacts cc
          where cc.candidate_id = t.p(1) and cc.value_normalized = 'claimed@example.com'), 'claimed is never ranked';
  assert (select cc.rank = 1 from public.candidate_contacts cc where cc.candidate_id = t.p(1) and cc.value_normalized = '+15550000001'),
    'mobile phone is primary';
  assert (select cc.rank = 2 from public.candidate_contacts cc where cc.candidate_id = t.p(1) and cc.value_normalized = '+15550000002'),
    'office phone second';
  assert (select cc.legacy_email_ids = array['b0000000-0000-4000-8000-000000000001'::uuid] from public.candidate_contacts cc
          where cc.candidate_id = t.p(1) and cc.value_normalized = 'one.personal@example.com'), 'legacy_email_id kept';
  assert (select s.primary_email = 'one.personal@example.com' and s.secondary_email = 'one@acme.example.com'
                 and s.personal_email = 'one.personal@example.com' and s.business_email = 'one@acme.example.com'
                 and s.primary_phone = '+15550000001' and s.mobile_phone = '+15550000001'
                 and s.usable_emails = array['one.personal@example.com', 'one@acme.example.com', 'raw.only@example.com']
          from public.candidate_contact_summary s where s.candidate_id = t.p(1)), 'summary view';
  raise notice 'PASS 2 ranking: verified personal > risky; invalid, never_primary, claimed unranked; mobile phone first; summary view agrees';
end $$;

-- ---------------------------------------------------------------------------
-- 3. The same doc twice: "unchanged" and not one row changes
-- ---------------------------------------------------------------------------
do $$
declare before text; r jsonb;
begin
  before := t.fp_all();
  r := public.save_person((select d.doc from t.docs d where d.name = 'A'));
  assert r->>'status' = 'unchanged', format('repeat status %s', r);
  assert r->>'source_id' = (select res->>'source_id' from t.results where name = 'A'), 'repeat returns the first source id';
  assert t.fp_all() = before, 'no row changed on repeat';
  raise notice 'PASS 3 same doc twice -> unchanged, no row changes (fingerprint of every table identical)';
end $$;

-- ---------------------------------------------------------------------------
-- 4. A newer doc replaces the lists
-- ---------------------------------------------------------------------------
create table t.ids as
select e.row_key, e.id from public.candidate_experiences e where e.candidate_id = t.p(1) and e.source = 'person';
grant all on t.ids to service_role;

do $$
declare r jsonb; c jsonb; n int;
begin
  r := t.save('B');
  c := r->'counts';
  assert r->>'status' = 'updated' and (r->>'applied_lists')::boolean, format('B %s', r);
  assert (c->>'jobs_updated')::int = 2 and (c->>'jobs_inserted')::int = 1 and (c->>'jobs_removed')::int = 7, format('B jobs %s', c);
  assert (c->>'educations_updated')::int = 1 and (c->>'educations_removed')::int = 2, format('B educations %s', c);
  assert (c->>'skills_updated')::int = 1 and (c->>'skills_inserted')::int = 1 and (c->>'skills_removed')::int = 1, format('B skills %s', c);
  assert (c->>'companies_created')::int = 1 and (c->>'conflicts')::int = 1, format('B companies/conflicts %s', c);

  assert (select e.id = i.id and e.title = 'Senior Engineer' and e.removed_at is null and e.last_seen_at = '2025-06-01T00:00:00Z'
          from public.candidate_experiences e join t.ids i on i.row_key = e.row_key
          where e.candidate_id = t.p(1) and e.row_key = 'rk-acme-eng'), 'kept job keeps its id, is updated';
  assert (select e.removed_at = '2025-06-01T00:00:00Z' from public.candidate_experiences e
          where e.candidate_id = t.p(1) and e.row_key = 'rk-globex'), 'dropped job gets removed_at';
  select count(*) into n from public.candidate_experiences e where e.candidate_id = t.p(1) and e.source = 'person' and e.removed_at is null;
  assert n = 3, 'three current jobs';
  select count(*) into n from public.candidate_experiences e where e.candidate_id = t.p(1) and e.source = 'person';
  assert n = 10, 'nothing deleted';
  assert (select s.lists_fetched_at = '2025-06-01T00:00:00Z' and s.lists_source_id = (r->>'source_id')::uuid
          from public.candidate_profile_state s where s.candidate_id = t.p(1)), 'state owns the new lists';
  raise notice 'PASS 4a newer doc replaces lists: kept job keeps id, dropped jobs get removed_at, nothing deleted';

  -- LinkedIn id 7007 is new, but its username "initech" is held by id 3003:
  -- a new row for 7007 without the username, and a company_identity conflict.
  assert (select c2.linkedin_username is null and c2.identity_basis = 'linkedin_id' from public.companies c2 where c2.linkedin_id = '7007'),
    'clashing username not copied';
  assert (select e.company_id = (select c2.id from public.companies c2 where c2.linkedin_id = '7007')
          from public.candidate_experiences e where e.candidate_id = t.p(1) and e.row_key = 'rk-initech'), 'job links to the id row';
  assert exists (select 1 from public.identity_conflicts ic where ic.kind = 'company_identity' and t.p(1) = any (ic.candidate_ids)),
    'company conflict logged';
  raise notice 'PASS 4b username held by another LinkedIn id -> new company by id + company_identity conflict';

  assert (select s.header->'headline'->>'value' = 'Senior Engineer at Acme'
                 and s.header->'location'->>'value' = 'Springfield'
                 and s.header->'summary'->>'value' = 'Builds robots'
                 and s.header->'photo'->>'value' = 'https://example.com/p1.jpg'
                 and s.header->'headline'->>'source' = 'harvest'
          from public.candidate_profile_state s where s.candidate_id = t.p(1)), 'header newest non-empty';
  raise notice 'PASS 4c header: newer value wins; empty location never blanks';

  assert (select cc.rank = 2 and cc.quality = 'good' and cc.verified_at = '2025-06-01T00:00:00Z'
          from public.candidate_contacts cc where cc.candidate_id = t.p(1) and cc.value_normalized = 'one@acme.example.com'),
    'newer check replaces the older one';
  assert (select cc.status = 'active' and cc.rank = 3 and cc.label = 'unknown'
                 and cc.legacy_email_ids = array['b0000000-0000-4000-8000-000000000002'::uuid]
          from public.candidate_contacts cc where cc.candidate_id = t.p(1) and cc.value_normalized = 'old@example.com'),
    'a newer good check revives an invalid address (verified, unknown label: after business); legacy ids unioned';
  raise notice 'PASS 4d contacts: newest check wins (invalid -> active), legacy ids unioned';
end $$;

-- ---------------------------------------------------------------------------
-- 5. An older doc arriving later: recorded, changes no list
-- ---------------------------------------------------------------------------
create table t.before_c as select t.fp_lists(t.p(1)) as v, (select count(*) from public.companies) as companies;
grant all on t.before_c to service_role;

do $$
declare r jsonb;
begin
  r := t.save('C');
  assert r->>'status' = 'updated' and not (r->>'applied_lists')::boolean, format('C %s', r);
  assert (select cs.applied_lists = false and cs.fetched_at = '2025-01-01T00:00:00Z' from public.candidate_sources cs
          where cs.id = (r->>'source_id')::uuid), 'older doc recorded with applied_lists = false';
  assert t.fp_lists(t.p(1)) = (select v from t.before_c), 'older doc changed no list';
  assert (select count(*) from public.companies) = (select companies from t.before_c), 'older doc created no company';
  assert (select s.lists_fetched_at = '2025-06-01T00:00:00Z' from public.candidate_profile_state s where s.candidate_id = t.p(1)), 'lists owner unchanged';
  assert (select s.header->'headline'->>'value' = 'Senior Engineer at Acme'
                 and (s.header->'open_to_work'->>'value')::boolean
                 and s.header->'location_country'->>'value' = 'US'
          from public.candidate_profile_state s where s.candidate_id = t.p(1)), 'older header value loses; a missing field is filled';
  raise notice 'PASS 5a older doc: recorded (applied_lists=false), no list or company change; header fills only empty fields';

  assert (select cc.rank = 1 from public.candidate_contacts cc where cc.candidate_id = t.p(1) and cc.value_normalized = 'dir.primary@example.com'),
    'directory primary outranks verified personal';
  assert (select cc.rank = 2 from public.candidate_contacts cc where cc.candidate_id = t.p(1) and cc.value_normalized = 'one.personal@example.com'),
    'verified personal second';
  assert (select cc.rank = 1 from public.candidate_contacts cc where cc.candidate_id = t.p(1) and cc.value_normalized = '+15550000003'),
    'directory phone outranks mobile';
  assert (select cc.rank = 2 from public.candidate_contacts cc where cc.candidate_id = t.p(1) and cc.value_normalized = '+15550000001'),
    'mobile phone second';
  raise notice 'PASS 5b contacts still merge from an older doc; directory primary > verified personal; directory phone > mobile';
end $$;

-- ---------------------------------------------------------------------------
-- 6. A recruiter's choice wins, even over a bad check
-- ---------------------------------------------------------------------------
do $$
declare r jsonb;
begin
  r := t.save('D');
  assert r->>'status' = 'updated' and not (r->>'applied_lists')::boolean, format('D %s', r);
  assert (select cc.rank = 1 and cc.status = 'active' and cc.is_manual from public.candidate_contacts cc
          where cc.candidate_id = t.p(1) and cc.value_normalized = 'old@example.com'), 'manual address is primary';
  assert (select cc.rank = 2 from public.candidate_contacts cc where cc.candidate_id = t.p(1) and cc.value_normalized = 'dir.primary@example.com'),
    'directory primary second';
  assert (select s.header->'headline'->>'value' = 'Senior Engineer at Acme' from public.candidate_profile_state s where s.candidate_id = t.p(1)),
    'contacts_only leaves the header';
  raise notice 'PASS 6 manual wins (even over a bad check); contacts_only leaves header and lists';
end $$;

-- ---------------------------------------------------------------------------
-- 7. A dropped job listed again comes back with its old id
-- ---------------------------------------------------------------------------
do $$
declare r jsonb; c jsonb;
begin
  r := t.save('E');
  c := r->'counts';
  assert (c->>'jobs_inserted')::int = 1 and (c->>'jobs_updated')::int = 1 and (c->>'jobs_removed')::int = 2, format('E %s', c);
  assert (select e.id = i.id and e.removed_at is null from public.candidate_experiences e join t.ids i on i.row_key = e.row_key
          where e.candidate_id = t.p(1) and e.row_key = 'rk-globex'), 'revived job keeps its id';
  -- E carries no educations or skills key: those lists are left as they were.
  assert (select count(*) from public.candidate_educations ce where ce.candidate_id = t.p(1) and ce.removed_at is null) = 1, 'educations untouched';
  assert (select count(*) from public.candidate_skills cs where cs.candidate_id = t.p(1) and cs.removed_at is null) = 2, 'skills untouched';
  raise notice 'PASS 7 a job dropped and listed again returns with its id; absent list keys are left alone';
end $$;

-- ---------------------------------------------------------------------------
-- 8. Person 2: unusable emails, merge by normalized value, identity conflict
-- ---------------------------------------------------------------------------
do $$
declare r jsonb; n int;
begin
  r := t.save('P2a');
  assert (r->'counts'->>'identities')::int = 1 and (r->'counts'->>'conflicts')::int = 1, format('P2a %s', r);
  assert not exists (select 1 from public.candidate_identities i where i.candidate_id = t.p(2) and i.value = 'test-person-1'),
    'a value owned by another person is not attached';
  assert (select i.candidate_id = t.p(1) from public.candidate_identities i where i.kind = 'linkedin_username' and i.value = 'test-person-1'),
    'owner unchanged';
  assert exists (select 1 from public.identity_conflicts ic where ic.kind = 'identity_taken'
                 and ic.candidate_ids = array[t.p(1), t.p(2)] and ic.incoming->>'value' = 'test-person-1'), 'identity conflict row';
  raise notice 'PASS 8a identity owned by another person -> identity_conflicts row, not attached';

  select count(*) into n from public.candidate_contacts cc where cc.candidate_id = t.p(2) and cc.rank is not null;
  assert n = 0, 'no usable email -> no rank at all';
  assert (select s.primary_email is null and s.usable_emails = array['raw2@example.com'] from public.candidate_contact_summary s
          where s.candidate_id = t.p(2)), 'summary: no primary, only the never-primary address usable';
  raise notice 'PASS 8b invalid, claimed and never_primary never become rank 1 even when nothing else exists';

  r := t.save('P2b');
  assert (r->'counts'->>'conflicts')::int = 0, format('P2b: the same open conflict is not logged twice %s', r);
  assert (select count(*) from public.identity_conflicts ic where ic.kind = 'identity_taken' and ic.incoming->>'value' = 'test-person-1') = 1,
    'one open conflict per identity and person';
  assert (select cc.status = 'invalid' and cc.quality = 'bad' and cc.verified_at = '2024-06-01T00:00:00Z' and cc.rank is null
                 and cc.value_raw = 'bad2@example.com'
                 and cc.legacy_email_ids = array['b0000000-0000-4000-8000-000000000021'::uuid, 'b0000000-0000-4000-8000-000000000022'::uuid]
          from public.candidate_contacts cc where cc.candidate_id = t.p(2) and cc.value_normalized = 'bad2@example.com'),
    'older good check loses to the newer bad one; legacy ids unioned; one row';
  select count(*) into n from public.candidate_contacts cc where cc.candidate_id = t.p(2) and lower(cc.value_normalized) = 'bad2@example.com';
  assert n = 1, 'merged by normalized value';
  raise notice 'PASS 8c merge by normalized value keeps the best (newest) verification';

  r := t.save('P2c');
  assert (select cc.status = 'active' and cc.rank = 1 and cc.verified_at = '2025-02-01T00:00:00Z' from public.candidate_contacts cc
          where cc.candidate_id = t.p(2) and cc.value_normalized = 'bad2@example.com'), 'newer good check makes it primary';
  raise notice 'PASS 8d a newer good check makes the address usable and primary';
end $$;

-- ---------------------------------------------------------------------------
-- 9. Person 3: no duplicate companies/schools on repeat, fill_gaps, shared
--    address, claimed contacts
-- ---------------------------------------------------------------------------
do $$
declare r jsonb; n int; companies_before int; schools_before int;
begin
  r := t.save('P3app');
  assert r->>'status' = 'created' and not (r->>'applied_lists')::boolean, format('P3app %s', r);
  assert (select s.header->'headline'->>'value' = 'Typed headline' and s.lists_fetched_at is null
          from public.candidate_profile_state s where s.candidate_id = t.p(3)), 'application fills an empty header, owns no lists';
  assert (select count(*) from public.candidate_contacts cc where cc.candidate_id = t.p(3) and cc.status = 'claimed' and cc.rank is null) = 2,
    'typed contacts are claimed and unranked';

  select count(*) into companies_before from public.companies;
  select count(*) into schools_before from public.schools;
  r := t.save('P3li');
  assert (r->'counts'->>'companies_created')::int = 0 and (r->'counts'->>'schools_created')::int = 0, format('P3li %s', r);
  assert (select count(*) from public.companies) = companies_before and (select count(*) from public.schools) = schools_before,
    'no new company or school rows';
  assert (select c2.linkedin_id = '1001' from public.candidate_experiences e join public.companies c2 on c2.id = e.company_id
          where e.candidate_id = t.p(3) and e.row_key = 'rk3-acme'), 'mixed-case username finds the LinkedIn company';
  assert (select e.company_id = (select e1.company_id from public.candidate_experiences e1 where e1.candidate_id = t.p(1) and e1.row_key = 'rk-tiny')
          from public.candidate_experiences e where e.candidate_id = t.p(3) and e.row_key = 'rk3-tiny'), 'same name-only row across people';
  assert (select c2.is_placeholder from public.candidate_experiences e join public.companies c2 on c2.id = e.company_id
          where e.candidate_id = t.p(3) and e.row_key = 'rk3-self'), 'same placeholder across people';
  assert (select c2.linkedin_id = '5005' from public.candidate_experiences e join public.companies c2 on c2.id = e.company_id
          where e.candidate_id = t.p(3) and e.row_key = 'rk3-new'), 'numeric URL slug counts as the id';
  select count(*) into n from (select c2.normalized_name from public.companies c2 where c2.created_from = 'person_writer'
    and c2.identity_basis in ('name', 'placeholder') group by c2.normalized_name, c2.identity_basis having count(*) > 1) d;
  assert n = 0, 'no duplicate name-only or placeholder rows';
  select count(*) into n from (select c2.linkedin_id from public.companies c2 where c2.linkedin_id is not null group by 1 having count(*) > 1) d;
  assert n = 0, 'no duplicate LinkedIn ids';
  raise notice 'PASS 9a company/school lookup across people: no duplicates on repeat';

  -- The older LinkedIn doc still replaces the application's headline (an
  -- application only fills gaps), but its empty location does not blank.
  assert (select s.header->'headline'->>'value' = 'LinkedIn headline' and s.header->'location'->>'value' = 'Typed town'
          from public.candidate_profile_state s where s.candidate_id = t.p(3)), 'LinkedIn data outranks typed data';
  raise notice 'PASS 9b fill_gaps: an application fills gaps; LinkedIn-grade data replaces them';

  assert exists (select 1 from public.identity_conflicts ic where ic.kind = 'email_owned_by_other'
                 and ic.candidate_ids = array[t.p(1), t.p(3)]), 'shared address logged';
  assert (select count(*) from public.candidate_contacts cc where cc.value_normalized = 'one.personal@example.com') = 2, 'kept on both people';
  raise notice 'PASS 9c an address on two people is kept on both and logged';

  r := t.save('P3dir');
  assert (select cc.status = 'active' and cc.rank = 1 and cc.label = 'personal' from public.candidate_contacts cc
          where cc.candidate_id = t.p(3) and cc.value_normalized = 'three.typed@example.com'), 'backed-up claimed email becomes active; unknown label filled';
  assert (select cc.status = 'claimed' and cc.rank is null from public.candidate_contacts cc
          where cc.candidate_id = t.p(3) and cc.value_normalized = '+15550000031'), 'unbacked claimed phone stays claimed';
  raise notice 'PASS 9d claimed contacts unranked until a trusted source backs them';
end $$;

-- ---------------------------------------------------------------------------
-- 9e. fill_gaps lists; a duplicate address inside one doc; GitHub
-- ---------------------------------------------------------------------------
do $$
declare r jsonb;
begin
  r := t.save('P5app1');
  assert (r->>'applied_lists')::boolean and (r->'counts'->>'jobs_inserted')::int = 1, format('P5app1 %s', r);
  assert (r->'counts'->>'contacts_inserted')::int = 2 and (r->'counts'->>'contacts_updated')::int = 1, format('P5app1 contacts %s', r);
  assert (select s.lists_fetched_at is null and s.lists_source_id is null from public.candidate_profile_state s where s.candidate_id = t.p(5)),
    'an application never owns the lists';
  assert (select count(*) from public.candidate_contacts cc where cc.candidate_id = t.p(5) and cc.kind = 'email') = 1, 'one row per address';
  assert (select cc.rank = 1 and cc.value_raw = 'Five@Example.com' and cc.quality = 'good' and cc.label = 'personal'
          from public.candidate_contacts cc where cc.candidate_id = t.p(5) and cc.kind = 'email'), 'second mention merged into the first';
  assert (select s.github = 'github.com/test-five' from public.candidate_contact_summary s where s.candidate_id = t.p(5)), 'github primary';

  r := t.save('P5app2');
  assert not (r->>'applied_lists')::boolean and (r->'counts'->>'jobs_inserted')::int = 0, format('P5app2 %s', r);

  r := t.save('P5li');
  assert (r->>'applied_lists')::boolean and (r->'counts'->>'jobs_inserted')::int = 1 and (r->'counts'->>'jobs_removed')::int = 1,
    format('P5li %s', r);
  assert (r->'counts'->>'educations_skipped')::int = 1, format('an education naming no school is skipped and counted %s', r);
  assert (select e.row_key = 'rk5-c' from public.candidate_experiences e where e.candidate_id = t.p(5) and e.removed_at is null),
    'LinkedIn data replaces typed jobs even when older';
  raise notice 'PASS 9e fill_gaps writes lists only when there are none and never owns them; LinkedIn replaces them; duplicate address merges; github ranked';
end $$;

-- ---------------------------------------------------------------------------
-- 10. Invariants over everything written so far
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n from (select cc.candidate_id, cc.kind from public.candidate_contacts cc where cc.rank = 1
    group by 1, 2 having count(*) > 1) d;
  assert n = 0, 'at most one rank 1 per person and kind';
  select count(*) into n from (
    select cc.candidate_id, cc.kind from public.candidate_contacts cc
    group by 1, 2
    having count(*) filter (where cc.status = 'active' and not cc.never_primary) > 0
       and count(*) filter (where cc.rank = 1) <> 1) d;
  assert n = 0, 'exactly one rank 1 wherever an eligible row exists';
  select count(*) into n from public.candidate_contacts cc where cc.rank is not null and (cc.status <> 'active' or cc.never_primary);
  assert n = 0, 'only eligible rows are ranked';
  select count(*) into n from (select cc.candidate_id, cc.kind, cc.rank from public.candidate_contacts cc where cc.rank is not null
    group by 1, 2, 3 having count(*) > 1) d;
  assert n = 0, 'ranks are distinct';
  assert (select v from t.snap where name = 'candidates') = (select md5(string_agg(x::text, ',' order by x.id)) from public.candidates x),
    'candidates rows untouched';
  assert (select v from t.snap where name = 'harvest_rows')
         = (select md5(string_agg(x::text, ',' order by x.id)) from public.candidate_experiences x where x.source = 'harvest'),
    'syncExperiences harvest rows untouched';
  raise notice 'PASS 10 exactly one rank 1 per kind; ranks only on eligible rows; candidates and harvest rows untouched';
end $$;

-- ---------------------------------------------------------------------------
-- 11. The contract: bad docs fail loudly
-- ---------------------------------------------------------------------------
do $$
declare ok boolean;
begin
  begin perform public.save_person('{"mode":"replace_lists"}'); ok := false;
  exception when invalid_parameter_value then ok := true; end;
  assert ok, 'missing candidate_id refused';
  begin perform public.save_person(jsonb_build_object('candidate_id', t.p(99), 'mode', 'replace_lists',
    'source', jsonb_build_object('source', 'harvest', 'fetched_at', '2025-01-01', 'payload_hash', 'x', 'raw_in', 'inline', 'parser_version', '1')));
    ok := false;
  exception when foreign_key_violation then ok := true; end;
  assert ok, 'unknown person refused (the writer never creates people)';
  begin perform public.save_person(jsonb_build_object('candidate_id', t.p(4), 'mode', 'merge',
    'source', jsonb_build_object('source', 'harvest', 'fetched_at', '2025-01-01', 'payload_hash', 'x', 'raw_in', 'inline', 'parser_version', '1')));
    ok := false;
  exception when invalid_parameter_value then ok := true; end;
  assert ok, 'unknown mode refused';
  begin perform public.save_person(jsonb_build_object('candidate_id', t.p(4), 'mode', 'replace_lists',
    'source', jsonb_build_object('source', 'harvest', 'fetched_at', '2025-01-01', 'payload_hash', 'x', 'raw_in', 'inline', 'parser_version', '1'),
    'jobs', jsonb_build_array(jsonb_build_object('title', 'no key'))));
    ok := false;
  exception when invalid_parameter_value then ok := true; end;
  assert ok, 'job without row_key refused';
  assert not exists (select 1 from public.candidate_sources cs where cs.candidate_id = t.p(4)), 'a refused doc leaves nothing behind';
  raise notice 'PASS 11 contract: missing id, unknown person, unknown mode, job without row_key are refused and roll back';
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 12. Access: RLS on, no policies, nothing for anon/authenticated
-- ---------------------------------------------------------------------------
do $$
declare tb text; r text; n int;
begin
  foreach tb in array array['candidate_sources', 'candidate_profile_state', 'candidate_identities', 'schools', 'candidate_educations',
    'skills', 'candidate_skills', 'candidate_contacts', 'identity_conflicts', 'backfill_runs'] loop
    assert (select c.relrowsecurity from pg_class c where c.oid = ('public.' || tb)::regclass), format('RLS on %s', tb);
    assert not exists (select 1 from pg_policy p where p.polrelid = ('public.' || tb)::regclass), format('no policies on %s', tb);
    foreach r in array array['anon', 'authenticated'] loop
      assert not has_table_privilege(r, 'public.' || tb, 'select, insert, update, delete, truncate, references, trigger'),
        format('%s has a privilege on %s', r, tb);
    end loop;
    assert has_table_privilege('service_role', 'public.' || tb, 'select, insert, update'), format('service_role on %s', tb);
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    assert not has_table_privilege(r, 'public.candidate_contact_summary', 'select'), format('%s reads the summary view', r);
    assert not has_sequence_privilege(r, 'public.skills_id_seq', 'usage, select, update'), format('%s on skills_id_seq', r);
  end loop;
  assert (select c.reloptions @> array['security_invoker=on'] from pg_class c where c.oid = 'public.candidate_contact_summary'::regclass),
    'view is security_invoker';
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and (p.proname in ('save_person', 'person_org_ident', 'person_org_lock_keys', 'person_company', 'person_school',
      'person_rerank_contacts', 'person_contact_ranks', 'person_doc_beats') or p.proname like 'tt\_%')
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
         or coalesce(array_to_string(p.proacl, ','), '') like '%=X/%' and array_to_string(p.proacl, ',') ~ '(^|,)=X/');
  assert n = 0, format('%s new functions executable by public/anon/authenticated', n);
  assert has_function_privilege('service_role', 'public.save_person(jsonb)', 'execute'), 'service_role can call save_person';
  raise notice 'PASS 12a RLS on, no policies, no table/view/sequence/function privileges for anon or authenticated';
end $$;

-- The same, by trying it under each role.
begin;
set local role anon;
do $$
declare ok boolean;
begin
  begin perform 1 from public.candidate_contacts limit 1; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'anon read candidate_contacts';
  begin perform 1 from public.candidate_contact_summary limit 1; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'anon read the summary view';
  begin perform public.save_person('{}'::jsonb); ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'anon called save_person';
  begin insert into public.skills (name, key) values ('x', 'x'); ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'anon wrote skills';
  raise notice 'PASS 12b anon: reads, writes and the RPC are refused';
end $$;
rollback;
begin;
set local role authenticated;
do $$
declare ok boolean;
begin
  begin perform 1 from public.candidate_identities limit 1; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'authenticated read candidate_identities';
  begin perform public.save_person('{}'::jsonb); ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'authenticated called save_person';
  begin perform public.tt_normalize_org_name('x'); ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'authenticated called a helper';
  raise notice 'PASS 12c authenticated: reads and the RPCs are refused';
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- 13. Timing: 25 jobs / 5 schools / 40 skills / 10 contacts
-- ---------------------------------------------------------------------------
create function t.big_doc(p uuid, p_hash text, p_fetched text, p_variant int) returns jsonb language sql as $$
  select jsonb_build_object(
    'candidate_id', p, 'mode', 'replace_lists',
    'source', jsonb_build_object('source', 'harvest', 'provider', 'harvest_full_profile', 'fetched_at', p_fetched,
      'payload_hash', p_hash, 'raw_in', 'candidate_enrichments', 'parser_version', 'test-1'),
    'identities', jsonb_build_array(jsonb_build_object('kind', 'linkedin_urn', 'value', 'urn-' || p::text)),
    'header', jsonb_build_object('full_name', 'Timing Person', 'headline', 'Headline ' || p_variant, 'summary', repeat('About. ', 200)),
    'jobs', (select jsonb_agg(jsonb_build_object(
        'row_key', 'rk-big-' || g, 'sort_order', g, 'title', 'Title ' || g || case when g <= p_variant then ' v2' else '' end,
        'start_year', 2000 + g, 'end_year', case when g > 1 then 2001 + g end, 'is_current', g = 1,
        'description', repeat('Did things. ', 80), 'skills', jsonb_build_array('Skill ' || g, 'Skill ' || (g + 1)),
        'company', case
          when g % 5 = 0 then jsonb_build_object('name', 'Name Only Co ' || g)
          when g % 5 = 1 then jsonb_build_object('name', 'LinkedIn Co ' || g, 'linkedin_id', (800000 + g)::text, 'tier', 2)
          when g % 5 = 2 then jsonb_build_object('name', 'Slug Co ' || g, 'linkedin_username', 'slug-co-' || g)
          when g % 5 = 3 then jsonb_build_object('name', 'Url Co ' || g, 'linkedin_url', 'https://www.linkedin.com/company/url-co-' || g || '/')
          else jsonb_build_object('name', 'Freelance') end)) from generate_series(1, 25) g),
    'educations', (select jsonb_agg(jsonb_build_object('row_key', 'rk-big-e' || g, 'sort_order', g, 'degree', 'Degree ' || g,
        'start_year', 1990 + g, 'end_year', 1994 + g,
        'school', case when g % 2 = 0 then jsonb_build_object('name', 'School ' || g, 'linkedin_org_id', (900000 + g)::text)
                       else jsonb_build_object('name', 'Name School ' || g) end)) from generate_series(1, 5) g),
    'skills', (select jsonb_agg(jsonb_build_object('name', 'Skill ' || g, 'key', 'skill ' || g, 'is_top', g <= 5,
        'endorsements', g, 'sort_order', g)) from generate_series(1, 40) g),
    'contacts', (select jsonb_agg(jsonb_build_object('kind', case when g <= 7 then 'email' else 'phone' end,
        'value_raw', case when g <= 7 then 'big' || g || '@example.com' else '+1555000' || lpad(g::text, 4, '0') end,
        'value_normalized', case when g <= 7 then 'big' || g || '@example.com' else '+1555000' || lpad(g::text, 4, '0') end,
        'label', case when g % 2 = 0 then 'personal' else 'business' end,
        'quality', case when g % 3 = 0 then 'good' when g % 3 = 1 then 'risky' else null end,
        'result', case when g % 3 = 0 then 'ok' when g % 3 = 1 then 'catch_all' else null end,
        'verified_at', case when g % 3 <> 2 then '2025-01-01T00:00:00Z' end)) from generate_series(1, 10) g))
$$;

insert into public.candidates (id, full_name, linkedin_username)
select t.p(1000 + n), 'Timing Person ' || n, 'timing-person-' || n from generate_series(1, 30) n;

set role service_role;
do $$
declare
  t0 timestamptz; r jsonb; n int;
  first_ms numeric[] := '{}'; again_ms numeric[] := '{}'; newer_ms numeric[] := '{}';
begin
  for n in 1..30 loop
    t0 := clock_timestamp();
    r := public.save_person(t.big_doc(t.p(1000 + n), 'big-1', '2025-01-01T00:00:00Z', 0));
    first_ms := first_ms || round(extract(epoch from clock_timestamp() - t0) * 1000, 2);
    assert r->>'status' = 'created' and (r->'counts'->>'jobs_inserted')::int = 25 and (r->'counts'->>'educations_inserted')::int = 5
      and (r->'counts'->>'skills_inserted')::int = 40 and (r->'counts'->>'contacts_inserted')::int = 10, format('big first %s', r);

    t0 := clock_timestamp();
    r := public.save_person(t.big_doc(t.p(1000 + n), 'big-1', '2025-01-01T00:00:00Z', 0));
    again_ms := again_ms || round(extract(epoch from clock_timestamp() - t0) * 1000, 2);
    assert r->>'status' = 'unchanged', 'big repeat';

    t0 := clock_timestamp();
    r := public.save_person(t.big_doc(t.p(1000 + n), 'big-2', '2025-06-01T00:00:00Z', 10));
    newer_ms := newer_ms || round(extract(epoch from clock_timestamp() - t0) * 1000, 2);
    assert r->>'status' = 'updated' and (r->'counts'->>'jobs_updated')::int = 25, format('big newer %s', r);
  end loop;
  -- 25 jobs at 25 employers: after the first person every company exists.
  assert (select count(*) from public.companies where created_from = 'person_writer' and (name like '% Co %' or name = 'Freelance')) = 20 + 1,
    'timing companies created once';
  raise notice 'TIMING save_person 25 jobs/5 schools/40 skills/10 contacts, 30 people (ms): first save (person 1 creates the companies) %; first save median %, max %; same doc again median %; newer doc median %, max %',
    first_ms[1],
    (select percentile_cont(0.5) within group (order by x) from unnest(first_ms[2:]) x),
    (select max(x) from unnest(first_ms[2:]) x),
    (select percentile_cont(0.5) within group (order by x) from unnest(again_ms) x),
    (select percentile_cont(0.5) within group (order by x) from unnest(newer_ms) x),
    (select max(x) from unnest(newer_ms) x);
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 14. A writer-made company learns the rest of its LinkedIn identity, so the
-- order docs arrive in does not split one LinkedIn page into two rows
-- ---------------------------------------------------------------------------
insert into public.candidates (id, full_name, linkedin_username)
select t.p(2000 + n), 'Order Person ' || n, 'order-person-' || n from generate_series(1, 4) n;

create function t.job_doc(p uuid, p_hash text, p_fetched text, p_company jsonb) returns jsonb language sql as $$
  select jsonb_build_object('candidate_id', p, 'mode', 'replace_lists',
    'source', jsonb_build_object('source', 'harvest', 'fetched_at', p_fetched, 'payload_hash', p_hash,
      'raw_in', 'candidate_enrichments', 'parser_version', 'test-1'),
    'jobs', jsonb_build_array(jsonb_build_object('row_key', 'rk-' || p_hash, 'title', 'Engineer', 'company', p_company)))
$$;

set role service_role;
do $$
declare r jsonb; v uuid; n int;
begin
  -- Username first, then id + username, then the id alone (another person).
  r := public.save_person(t.job_doc(t.p(2001), 'o1', '2024-01-01T00:00:00Z', '{"name": "Split Co", "linkedin_username": "split-co"}'));
  select c.id into v from public.companies c where c.linkedin_username = 'split-co';
  assert (select c.linkedin_id is null and c.identity_basis = 'linkedin_username' from public.companies c where c.id = v), 'username-only row';
  r := public.save_person(t.job_doc(t.p(2001), 'o2', '2025-01-01T00:00:00Z', '{"name": "Split Co", "linkedin_id": "97001", "linkedin_username": "split-co"}'));
  assert (r->'counts'->>'companies_created')::int = 0, format('o2 %s', r);
  assert (select c.linkedin_id = '97001' and c.identity_basis = 'linkedin_id' from public.companies c where c.id = v), 'the row learns its LinkedIn id';
  r := public.save_person(t.job_doc(t.p(2002), 'o3', '2025-01-01T00:00:00Z', '{"name": "Split Co", "linkedin_id": "97001"}'));
  assert (r->'counts'->>'companies_created')::int = 0, format('o3 %s', r);
  assert (select e.company_id = v from public.candidate_experiences e where e.candidate_id = t.p(2002) and e.removed_at is null),
    'the id alone finds the same row';

  -- Id first, then id + username, then a mixed-case username alone.
  r := public.save_person(t.job_doc(t.p(2003), 'o4', '2024-01-01T00:00:00Z', '{"name": "Other Co", "linkedin_id": "97002"}'));
  select c.id into v from public.companies c where c.linkedin_id = '97002';
  r := public.save_person(t.job_doc(t.p(2003), 'o5', '2025-01-01T00:00:00Z', '{"name": "Other Co", "linkedin_id": "97002", "linkedin_username": "other-co"}'));
  assert (select c.linkedin_username = 'other-co' and c.identity_basis = 'linkedin_id' from public.companies c where c.id = v), 'the row learns its username';
  r := public.save_person(t.job_doc(t.p(2004), 'o6', '2025-01-01T00:00:00Z', '{"name": "Other Co", "linkedin_username": "Other-Co"}'));
  assert (r->'counts'->>'companies_created')::int = 0, format('o6 %s', r);
  assert (select e.company_id = v from public.candidate_experiences e where e.candidate_id = t.p(2004) and e.removed_at is null),
    'the username alone finds the same row';

  -- A pre-existing row keeps its LinkedIn columns (Umbrella has no username).
  r := public.save_person(t.job_doc(t.p(2004), 'o7', '2025-06-01T00:00:00Z', '{"name": "Umbrella", "linkedin_id": "4004", "linkedin_username": "umbrella-inc"}'));
  assert (r->'counts'->>'companies_created')::int = 0, format('o7 %s', r);
  assert (select c.linkedin_username is null from public.companies c where c.linkedin_id = '4004'), 'pre-existing row not changed';

  -- A value another row already holds is not copied (no unique violation, no merge).
  r := public.save_person(t.job_doc(t.p(2001), 'o8', '2025-06-01T00:00:00Z', '{"name": "Dup Co", "linkedin_id": "97003"}'));
  r := public.save_person(t.job_doc(t.p(2002), 'o9', '2025-06-01T00:00:00Z', '{"name": "Dup Co", "linkedin_username": "dup-co"}'));
  r := public.save_person(t.job_doc(t.p(2003), 'o10', '2025-06-01T00:00:00Z', '{"name": "Dup Co", "linkedin_id": "97003", "linkedin_username": "dup-co"}'));
  assert (select c.linkedin_username is null from public.companies c where c.linkedin_id = '97003'), 'username held elsewhere is not copied';
  assert (select c.linkedin_id is null from public.companies c where c.linkedin_username = 'dup-co'), 'the other row is left alone';

  select count(*) into n from (select c.linkedin_id from public.companies c where c.linkedin_id is not null group by 1 having count(*) > 1) d;
  assert n = 0, 'no duplicate LinkedIn ids';
  select count(*) into n from (select lower(c.linkedin_username) from public.companies c where c.linkedin_username is not null group by 1 having count(*) > 1) d;
  assert n = 0, 'no duplicate usernames';
  raise notice 'PASS 14 a writer-made company learns its LinkedIn id or username; pre-existing rows and values held elsewhere are left alone';
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 15. Review fixes: recruiter picks, per-list owners, ties, schools that learn
-- their id, the directory's newest primary, the old primary flag, tier fill
-- only on the writer's rows, no search URL in companies.linkedin_url
-- ---------------------------------------------------------------------------
insert into public.candidates (id, full_name, linkedin_username)
select t.p(3000 + n), 'Review Person ' || n, 'review-person-' || n from generate_series(1, 12) n;

-- A doc with contacts only: (source, fetched_at, hash, contacts).
create function t.contact_doc(p uuid, p_source text, p_fetched text, p_hash text, p_contacts jsonb) returns jsonb language sql as $$
  select jsonb_build_object('candidate_id', p, 'mode', 'contacts_only',
    'source', jsonb_build_object('source', p_source, 'fetched_at', p_fetched, 'payload_hash', p_hash, 'raw_in', 'inline', 'parser_version', 'test-1'),
    'contacts', p_contacts)
$$;
-- A list doc: jobs/educations/skills given as jsonb (null = key absent).
create function t.list_doc(p uuid, p_source text, p_fetched text, p_hash text, p_jobs jsonb, p_edus jsonb, p_skills jsonb) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('candidate_id', p, 'mode', 'replace_lists',
    'source', jsonb_build_object('source', p_source, 'fetched_at', p_fetched, 'payload_hash', p_hash, 'raw_in', 'inline', 'parser_version', 'test-1'),
    'jobs', p_jobs, 'educations', p_edus, 'skills', p_skills))
$$;
create function t.job(p_key text, p_title text, p_company jsonb) returns jsonb language sql as $$
  select jsonb_build_object('row_key', p_key, 'title', p_title, 'company', p_company)
$$;
create function t.live_jobs(p uuid) returns text language sql as $$
  select coalesce(string_agg(e.row_key, ',' order by e.row_key), '') from public.candidate_experiences e
  where e.candidate_id = p and e.source = 'person' and e.removed_at is null
$$;
create function t.live_skills(p uuid) returns text language sql as $$
  select coalesce(string_agg(k.key, ',' order by k.key), '') from public.candidate_skills cs join public.skills k on k.id = cs.skill_id
  where cs.candidate_id = p and cs.removed_at is null
$$;
create function t.rank_of(p uuid, v text) returns int language sql as $$
  select cc.rank from public.candidate_contacts cc where cc.candidate_id = p and cc.value_normalized = v
$$;
grant execute on all functions in schema t to service_role;

set role service_role;
do $$
declare r jsonb; n int; before_upd timestamptz;
begin
  -- 15a. Three recruiter picks, then an automated bounce of the middle one:
  -- the picks keep their order by when they were chosen, no duplicate rank 1.
  r := public.save_person(t.contact_doc(t.p(3001), 'recruiter', '2024-01-01T00:00:00Z', 'm1',
    '[{"kind":"email","value_normalized":"mb@example.com","is_manual":true}]'));
  r := public.save_person(t.contact_doc(t.p(3001), 'recruiter', '2024-02-01T00:00:00Z', 'm2',
    '[{"kind":"email","value_normalized":"mx@example.com","is_manual":true}]'));
  r := public.save_person(t.contact_doc(t.p(3001), 'recruiter', '2024-03-01T00:00:00Z', 'm3',
    '[{"kind":"email","value_normalized":"ma@example.com","is_manual":true}]'));
  assert t.rank_of(t.p(3001), 'ma@example.com') = 1 and t.rank_of(t.p(3001), 'mx@example.com') = 2
     and t.rank_of(t.p(3001), 'mb@example.com') = 3, 'the latest pick leads';
  r := public.save_person(t.contact_doc(t.p(3001), 'directory', '2024-04-01T00:00:00Z', 'm4',
    '[{"kind":"email","value_normalized":"mx@example.com","status":"bounced","quality":"bad","result":"bounced"}]'));
  assert r->>'status' = 'updated', format('bounce of a middle pick %s', r);
  assert t.rank_of(t.p(3001), 'ma@example.com') = 1 and t.rank_of(t.p(3001), 'mb@example.com') = 2
     and t.rank_of(t.p(3001), 'mx@example.com') is null, 'picks re-rank without a clash';
  -- An automated sighting of an older pick does not move it ahead of the latest one.
  r := public.save_person(t.contact_doc(t.p(3001), 'harvest', '2025-01-01T00:00:00Z', 'm5',
    '[{"kind":"email","value_normalized":"mb@example.com","quality":"good","result":"ok","verified_at":"2025-01-01T00:00:00Z"}]'));
  assert t.rank_of(t.p(3001), 'ma@example.com') = 1 and t.rank_of(t.p(3001), 'mb@example.com') = 2,
    'a re-sighting leaves the recruiter''s latest pick first';
  assert (select cc.manual_at = '2024-01-01T00:00:00Z' from public.candidate_contacts cc
          where cc.candidate_id = t.p(3001) and cc.value_normalized = 'mb@example.com'), 'manual_at only moves on a manual doc';
  raise notice 'PASS 15a recruiter picks ordered by manual_at; a bounce or an automated sighting re-ranks without a clash';

  -- 15b. A newer doc that carries no jobs keeps the older doc's jobs, in either order.
  r := public.save_person(t.list_doc(t.p(3002), 'legacy_import', '2024-01-01T00:00:00Z', 'l-old',
    jsonb_build_array(t.job('rk-old', 'Engineer', '{"name":"Old Co"}')), null, '[{"name":"Go","key":"go"}]'));
  r := public.save_person(t.list_doc(t.p(3002), 'harvest', '2025-01-01T00:00:00Z', 'l-new',
    null, null, '[{"name":"Rust","key":"rust"}]'));
  r := public.save_person(t.list_doc(t.p(3003), 'harvest', '2025-01-01T00:00:00Z', 'l-new',
    null, null, '[{"name":"Rust","key":"rust"}]'));
  r := public.save_person(t.list_doc(t.p(3003), 'legacy_import', '2024-01-01T00:00:00Z', 'l-old',
    jsonb_build_array(t.job('rk-old', 'Engineer', '{"name":"Old Co"}')), null, '[{"name":"Go","key":"go"}]'));
  assert (r->>'applied_lists')::boolean, format('an older doc still takes a list nobody owns %s', r);
  assert t.live_jobs(t.p(3002)) = 'rk-old' and t.live_jobs(t.p(3003)) = 'rk-old', 'jobs from the older doc in both orders';
  assert t.live_skills(t.p(3002)) = 'rust' and t.live_skills(t.p(3003)) = 'rust', 'skills from the newer doc in both orders';
  assert (select s.jobs_source_id = (select cs.id from public.candidate_sources cs where cs.candidate_id = t.p(3003) and cs.payload_hash = 'l-old')
            and s.skills_source_id = s.lists_source_id and s.lists_fetched_at = '2025-01-01T00:00:00Z'
          from public.candidate_profile_state s where s.candidate_id = t.p(3003)), 'per-list owners; lists_source_id is the newest';
  -- Repeats are unchanged.
  r := public.save_person(t.list_doc(t.p(3003), 'legacy_import', '2024-01-01T00:00:00Z', 'l-old',
    jsonb_build_array(t.job('rk-old', 'Engineer', '{"name":"Old Co"}')), null, '[{"name":"Go","key":"go"}]'));
  assert r->>'status' = 'unchanged', format('repeat of a partly applied doc %s', r);
  raise notice 'PASS 15b each list has its own owner: a newer doc without jobs leaves the older jobs, in any order';

  -- 15c. Equal fetched_at: the same winner in both orders (harvest outranks the old import).
  r := public.save_person(t.list_doc(t.p(3004), 'legacy_import', '2024-01-01T00:00:00Z', 'tie-l', jsonb_build_array(t.job('rk-a', 'A', '{"name":"A Co"}')), null, null));
  r := public.save_person(t.list_doc(t.p(3004), 'harvest', '2024-01-01T00:00:00Z', 'tie-h', jsonb_build_array(t.job('rk-b', 'B', '{"name":"B Co"}')), null, null));
  r := public.save_person(t.list_doc(t.p(3005), 'harvest', '2024-01-01T00:00:00Z', 'tie-h', jsonb_build_array(t.job('rk-b', 'B', '{"name":"B Co"}')), null, null));
  r := public.save_person(t.list_doc(t.p(3005), 'legacy_import', '2024-01-01T00:00:00Z', 'tie-l', jsonb_build_array(t.job('rk-a', 'A', '{"name":"A Co"}')), null, null));
  assert t.live_jobs(t.p(3004)) = 'rk-b' and t.live_jobs(t.p(3005)) = 'rk-b', 'a tie on fetched_at goes to the higher source in both orders';
  raise notice 'PASS 15c ties on fetched_at break the same way in any order';

  -- 15d. A replace_lists doc with no list at all: the second save is unchanged.
  r := public.save_person(t.contact_doc(t.p(3006), 'directory', '2024-01-01T00:00:00Z', 'nolist',
    '[{"kind":"email","value_normalized":"nolist@example.com"}]') || '{"mode":"replace_lists"}');
  r := public.save_person(t.contact_doc(t.p(3006), 'directory', '2024-01-01T00:00:00Z', 'nolist',
    '[{"kind":"email","value_normalized":"nolist@example.com"}]') || '{"mode":"replace_lists"}');
  assert r->>'status' = 'unchanged' and (select rev from public.candidate_profile_state where candidate_id = t.p(3006)) = 1,
    format('a list doc without lists is not re-applied %s', r);
  raise notice 'PASS 15d a replace_lists doc that carries no list is unchanged on repeat';

  -- 15e. A school made from its URL learns its LinkedIn id (and the reverse): one row.
  r := public.save_person(t.list_doc(t.p(3007), 'harvest', '2024-01-01T00:00:00Z', 's1', null,
    '[{"row_key":"e1","school":{"name":"Probe U","linkedin_url":"https://www.linkedin.com/school/probe-u/"}}]', null));
  r := public.save_person(t.list_doc(t.p(3008), 'harvest', '2024-01-01T00:00:00Z', 's2', null,
    '[{"row_key":"e1","school":{"name":"Probe U","linkedin_org_id":"55501","linkedin_url":"https://www.linkedin.com/school/probe-u/"}}]', null));
  r := public.save_person(t.list_doc(t.p(3009), 'harvest', '2024-01-01T00:00:00Z', 's3', null,
    '[{"row_key":"e1","school":{"name":"Probe U","linkedin_org_id":"55501"}}]', null));
  assert (select count(*) from public.schools where normalized_name = 'probe u') = 1, 'one school row for one LinkedIn school';
  assert (select linkedin_org_id = '55501' and identity_basis = 'linkedin_org_id' from public.schools where normalized_name = 'probe u'), 'learned its id';
  r := public.save_person(t.list_doc(t.p(3007), 'harvest', '2024-02-01T00:00:00Z', 's4', null,
    '[{"row_key":"e1","school":{"name":"Probe Two","linkedin_org_id":"55502"}}]', null));
  r := public.save_person(t.list_doc(t.p(3008), 'harvest', '2024-02-01T00:00:00Z', 's5', null,
    '[{"row_key":"e1","school":{"name":"Probe Two","linkedin_org_id":"55502","linkedin_url":"https://www.linkedin.com/school/probe-two/"}}]', null));
  r := public.save_person(t.list_doc(t.p(3009), 'harvest', '2024-02-01T00:00:00Z', 's6', null,
    '[{"row_key":"e1","school":{"name":"Probe Two","linkedin_url":"https://www.linkedin.com/school/probe-two/"}}]', null));
  assert (select count(*) from public.schools where normalized_name = 'probe two') = 1, 'id first, then URL: one row';
  raise notice 'PASS 15e a writer-made school learns its LinkedIn id or URL: one row per school in any order';

  -- 15f. An older directory version arriving late does not take the primary back.
  r := public.save_person(t.contact_doc(t.p(3010), 'directory', '2024-06-01T00:00:00Z', 'd-new',
    '[{"kind":"email","value_normalized":"new@example.com","source_detail":"directory_primary"}]'));
  r := public.save_person(t.contact_doc(t.p(3010), 'directory', '2023-06-01T00:00:00Z', 'd-old',
    '[{"kind":"email","value_normalized":"old@example.com","source_detail":"directory_primary"}]'));
  assert t.rank_of(t.p(3010), 'new@example.com') = 1, 'the newest directory primary stays first';
  assert (select source_detail = 'directory' from public.candidate_contacts where candidate_id = t.p(3010) and value_normalized = 'old@example.com'),
    'the older primary is a plain directory address';
  raise notice 'PASS 15f only the newest directory version names the primary';

  -- 15g. Ties inside a tier go to the address the old tables marked primary, then 'replied' is a good check.
  r := public.save_person(t.contact_doc(t.p(3011), 'legacy_import', '2024-01-01T00:00:00Z', 'lp',
    '[{"kind":"email","value_normalized":"aaa@example.com","label":"personal","quality":"good","result":"ok","verified_at":"2024-01-01T00:00:00Z"},
      {"kind":"email","value_normalized":"zzz@example.com","label":"personal","quality":"good","result":"ok","verified_at":"2024-01-01T00:00:00Z","legacy_primary":true},
      {"kind":"email","value_normalized":"rep@example.com","label":"business","quality":"good","result":"replied","verified_at":"2024-01-01T00:00:00Z"}]'));
  assert t.rank_of(t.p(3011), 'zzz@example.com') = 1 and t.rank_of(t.p(3011), 'aaa@example.com') = 2, 'the old primary wins a tie';
  assert t.rank_of(t.p(3011), 'rep@example.com') = 3 and public.tt_email_check_class('good', 'replied') = 'good', 'replied is a good check';
  raise notice 'PASS 15g the old tables'' primary breaks ties within a tier; replied counts as verified';

  -- 15h. Tier: filled on the writer's own rows, never on a pre-existing companies row.
  select c.updated_at into before_upd from public.companies c where c.linkedin_id = '3003';
  r := public.save_person(t.list_doc(t.p(3012), 'harvest', '2024-01-01T00:00:00Z', 'tier1',
    jsonb_build_array(t.job('rk-i', 'Engineer', '{"name":"Initech","linkedin_id":"3003","tier":1}'),
                      t.job('rk-s', 'Engineer', '{"name":"Search Co","linkedin_url":"https://www.linkedin.com/search/results/all/?keywords=search%20co"}'),
                      t.job('rk-w', 'Engineer', '{"name":"Writer Co","linkedin_id":"98001"}')), null, null));
  r := public.save_person(t.list_doc(t.p(3012), 'harvest', '2024-02-01T00:00:00Z', 'tier2',
    jsonb_build_array(t.job('rk-i', 'Engineer', '{"name":"Initech","linkedin_id":"3003","tier":1}'),
                      t.job('rk-w', 'Engineer', '{"name":"Writer Co","linkedin_id":"98001","tier":2}')), null, null));
  assert (select c.tier is null and c.tier_list_version is null and c.updated_at = before_upd from public.companies c where c.linkedin_id = '3003'),
    'a pre-existing row is not written';
  assert (select c.tier = 2 from public.companies c where c.linkedin_id = '98001'), 'a writer-made row gets its missing tier';
  assert (select c.linkedin_url is null and c.identity_basis = 'name' from public.companies c where c.created_from = 'person_writer' and c.name = 'Search Co'),
    'a search URL is not stored as the company''s LinkedIn URL';
  raise notice 'PASS 15h tier fill only on writer rows (pre-existing rows untouched); no search URL in companies.linkedin_url';
end $$;
reset role;

select 'ALL TESTS PASSED' as result;
