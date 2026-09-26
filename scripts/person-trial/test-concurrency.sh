#!/bin/bash
# Parallel writers on a LOCAL Postgres (never production).
#   scripts/person-trial/test-concurrency.sh <port> [host]
# 8 sessions save 200 synthetic people at once. Their docs share the same new
# companies, schools and skills in shuffled orders, and one address, which is
# what would deadlock or create duplicates without the sorted advisory locks.
# Checks: every save succeeds, no duplicate company/school/skill rows, every
# job linked, one conflict row per address and arriving person.
set -euo pipefail
PORT="${1:?usage: test-concurrency.sh <port> [host]}"
HOST="${2:-127.0.0.1}"
PSQL="${PSQL:-psql}"
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export LC_ALL=C
q() { "$PSQL" -h "$HOST" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
DB=person_trial_conc
q -d postgres -c "drop database if exists $DB" -c "create database $DB" 2>/dev/null
q -d $DB -f "$DIR/local-schema.sql"
q -d $DB -1 -f "$ROOT/supabase/migrations/072_person_tables.sql"
q -d $DB -1 -f "$ROOT/supabase/migrations/20260926025355_person_writer_corrections.sql"
q -d $DB <<'EOF'
insert into public.candidates (id, full_name, linkedin_username)
select ('a0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'Conc Person ' || g, 'conc-person-' || g
from generate_series(1, 200) g;
create function public.conc_doc(n int) returns jsonb language sql as $$
  with picked as (
    select g, pos from (
      select g, row_number() over (order by md5(n::text || g::text)) as pos from generate_series(1, 30) g) x
    where pos <= 25)
  select jsonb_build_object(
    'candidate_id', ('a0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'mode', 'replace_lists',
    'source', jsonb_build_object('source', 'harvest', 'fetched_at', '2025-01-01T00:00:00Z', 'payload_hash', 'conc-' || n,
      'raw_in', 'candidate_enrichments', 'parser_version', 't'),
    'jobs', (select jsonb_agg(jsonb_build_object('row_key', 'rk-' || g, 'sort_order', pos, 'title', 'T' || g,
        'company', case g % 5
          when 0 then jsonb_build_object('name', 'Conc Name ' || g)
          when 1 then jsonb_build_object('name', 'Conc Li ' || g, 'linkedin_id', (700000 + g)::text, 'linkedin_username', 'conc-li-' || g)
          when 2 then jsonb_build_object('name', 'Conc Slug ' || g, 'linkedin_username', 'conc-slug-' || g)
          when 3 then jsonb_build_object('name', 'Conc Url ' || g, 'linkedin_url', 'https://www.linkedin.com/company/conc-url-' || g)
          else jsonb_build_object('name', case when g % 2 = 0 then 'Stealth' else 'Self-employed' end) end) order by pos) from picked),
    'educations', (select jsonb_agg(jsonb_build_object('row_key', 'e-' || g, 'sort_order', g,
        'school', case when g % 2 = 0 then jsonb_build_object('name', 'Conc School ' || g, 'linkedin_org_id', (710000 + g)::text)
                       else jsonb_build_object('name', 'Conc Name School ' || g) end) order by md5(n::text || g::text)) from generate_series(1, 6) g),
    'skills', (select jsonb_agg(jsonb_build_object('name', 'CS ' || g, 'key', 'cs ' || g) order by md5(n::text || 's' || g::text)) from generate_series(1, 60) g),
    'contacts', jsonb_build_array(jsonb_build_object('kind', 'email', 'value_raw', 'shared@example.com', 'value_normalized', 'shared@example.com')))
$$;
EOF
for w in 1 2 3 4 5 6 7 8; do
  for i in $(seq 1 25); do
    echo "select public.save_person(public.conc_doc($(( (w - 1) * 25 + i ))))->>'status';"
  done > "$WORK/w$w.sql"
done
start=$(date +%s)
for w in 1 2 3 4 5 6 7 8; do
  ( q -d $DB -t -A -f "$WORK/w$w.sql" > "$WORK/w$w.out" 2> "$WORK/w$w.err" || true ) &
done
wait
echo "8 writers, 200 saves: $(( $(date +%s) - start )) s"
if [ -s "$WORK/w1.err" ] || cat "$WORK"/w*.err | grep -q .; then cat "$WORK"/w*.err; echo "FAIL: errors"; exit 1; fi
created=$(cat "$WORK"/w*.out | grep -c '^created$' || true)
[ "$created" = "200" ] || { echo "FAIL: $created of 200 created"; exit 1; }
q -d $DB -t -A <<'EOF'
do $$
declare n int;
begin
  select count(*) into n from (select linkedin_id from public.companies where linkedin_id is not null group by 1 having count(*) > 1) d;
  assert n = 0, 'duplicate linkedin_id';
  select count(*) into n from (select lower(linkedin_username) from public.companies where linkedin_username is not null group by 1 having count(*) > 1) d;
  assert n = 0, 'duplicate username';
  select count(*) into n from (select linkedin_url_normalized from public.companies where linkedin_url_normalized is not null group by 1 having count(*) > 1) d;
  assert n = 0, 'duplicate url';
  select count(*) into n from (select normalized_name, identity_basis from public.companies where identity_basis in ('name', 'placeholder') group by 1, 2 having count(*) > 1) d;
  assert n = 0, 'duplicate name-only or placeholder';
  -- 30 employers: 6 of them map to 2 shared placeholders.
  assert (select count(*) from public.companies where created_from = 'person_writer') = 26, 'companies created once';
  assert (select count(*) from public.schools) = 6, 'schools created once';
  assert (select count(*) from public.skills) = 60, 'skills created once';
  assert (select count(*) from public.candidate_experiences where source = 'person' and company_id is null) = 0, 'every job linked';
  assert (select count(*) from public.identity_conflicts where kind = 'email_owned_by_other') = 199, 'one conflict row per arriving person';
  raise notice 'PASS concurrency: no errors, no deadlocks, no duplicates, every job linked';
end $$;
EOF
# Two people who share an address, saved at the same time: the second must
# wait for the first (the per-address lock) and log the shared address. The
# first session holds its transaction open for 3 s; the second starts 1 s in.
race_doc() {
  echo "jsonb_build_object('candidate_id', '$1'::uuid, 'mode', 'contacts_only', 'source', jsonb_build_object('source', 'directory', 'fetched_at', '2025-01-01T00:00:00Z', 'payload_hash', 'race-$2', 'raw_in', 'directory', 'parser_version', 't'), 'contacts', jsonb_build_array(jsonb_build_object('kind', 'email', 'value_normalized', 'race@example.com')))"
}
RA=a0000000-0000-4000-8000-000000000901
RB=a0000000-0000-4000-8000-000000000902
q -d $DB -c "insert into public.candidates (id, full_name, linkedin_username) values ('$RA', 'Race A', 'race-a'), ('$RB', 'Race B', 'race-b')"
( q -d $DB -c "begin" -c "select public.save_person($(race_doc $RA a))" -c "select pg_sleep(3)" -c "commit" > /dev/null ) &
sleep 1
conflicts=$(q -d $DB -t -A -c "select public.save_person($(race_doc $RB b))->'counts'->>'conflicts'")
wait
rows=$(q -d $DB -t -A -c "select count(*) from public.identity_conflicts where kind = 'email_owned_by_other' and incoming->>'value_normalized' = 'race@example.com'")
[ "$conflicts" = "1" ] && [ "$rows" = "1" ] || { echo "FAIL: concurrent shared address: conflicts=$conflicts rows=$rows"; exit 1; }
echo "PASS concurrent shared address: the second writer waited and logged the conflict"
q -d postgres -c "drop database $DB"
