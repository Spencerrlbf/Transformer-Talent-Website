#!/bin/bash
# Local PostgreSQL only. Proves scripts/person-release/apply-upgrade.sh on an isolated database
# that carries PRODUCTION's migration history: the 96 rows of
# supabase_migrations.schema_migrations exported read-only (production, or the copy whose 96
# matching rows carry the same digests, see production-history-digests.json), over the local
# fixture schema the other harnesses use, with production's pre-window person migrations
# (072 … 20260926032752) and the three window versions production recorded.
#
#   PSQL=<psql> bash scripts/person-release/test-apply-upgrade-resume.sh <port> <history csv>
# Export (read-only): psql "$URL" -X -c "\copy (select version,name,statements from
#   supabase_migrations.schema_migrations where version<='20260926050355' and version not in
#   ('20260926033900','20260926044800') order by version) to 'history-96.csv' csv"
#
# Proved: (1) an error raised after the migration file but before the commit leaves neither
# the schema change nor the history row; (2) a connection terminated at the same point leaves
# neither; (3) the resume skips every recorded version after verifying its body and installs
# the rest, ending at 96 + 63 versions whose recorded bodies equal the files; (4) a recorded
# body that differs from the file stops a later run; (5) the hardened validator refuses a
# selection the URL does not name; (6) the identity index is built concurrently before
# 20260927170000.
set -euo pipefail
node scripts/check-node.mjs >/dev/null
PORT="${1:?local port required}"; CSV="${2:?history csv required}"
PSQL="${PSQL:-psql}"; [[ "$PORT" =~ ^[0-9]+$ ]] || exit 2; [ -f "$CSV" ] || exit 2
DB=person_release_resume_test
q(){ "$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -X -v ON_ERROR_STOP=1 -q -At "$@"; }
URL="postgresql://postgres@127.0.0.1:$PORT/$DB"
MANIFEST=scripts/person-release/production-upgrade-manifest.json
expect(){ [ "$1" = "$2" ] || { echo "FAIL $3: got '$1' expected '$2'" >&2; exit 1; }; echo "ok $3"; }

q -d postgres -c "drop database if exists $DB" -c "create database $DB"
q -d $DB -f scripts/person-trial/local-schema.sql
q -d $DB -f scripts/person-trial/local-site-extras.sql
q -d $DB -f scripts/person-intake-mutations/local-normalizer.sql
q -d $DB -f scripts/person-derivatives/local-embeddings.sql
q -d $DB -c "alter table organizations add column daily_review_limit integer not null default 300;
create table rate_limit_events(id bigint generated always as identity primary key,bucket text not null,created_at timestamptz not null default now());create index on rate_limit_events(bucket,created_at);
create table refresh_queue(id uuid primary key default gen_random_uuid(),organization_id uuid not null,candidate_id uuid not null,linkedin_url text,linkedin_username text,priority int not null default 100,reason text,status text not null default 'queued',queued_at timestamptz not null default now(),processed_at timestamptz,unique(candidate_id,status));
create table sourced_candidates(id uuid primary key default gen_random_uuid(),organization_id uuid not null,linkedin_username text,contact jsonb);
create table org_roles(id uuid primary key default gen_random_uuid(),organization_id uuid not null,external_id text not null,unique(organization_id,external_id));create table site_role_embeddings(job_id text primary key);
create table recruiter_profiles(id uuid primary key,organization_id uuid not null,published boolean not null default false);
insert into candidates(id,full_name,linkedin_username) select gen_random_uuid(),'Synthetic '||g,'synthetic-resume-'||g from generate_series(1,200) g"
# Production's person schema before the window, and the three window versions it recorded.
for m in 072_person_tables 20260926025355_person_writer_corrections 20260926031057_person_backfill_capture 20260926032752_person_missing_employer_review 20260926040300_person_backfill_bulk 20260926042200_person_reconcile 20260926050355_person_source_date_holds; do
  q -d $DB -1 -f "supabase/migrations/$m.sql"
done
q -d $DB -c "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations(version text primary key, statements text[], name text)"
q -d $DB -c "\\copy supabase_migrations.schema_migrations(version,name,statements) from '$CSV' csv"
expect "$(q -d $DB -c 'select count(*) from supabase_migrations.schema_migrations')" 96 "production history imported (96 versions)"
digest=$(q -d $DB -c "select md5(string_agg(version||'|'||coalesce(name,'')||'|'||coalesce(array_length(statements,1),0)||'|'||md5(coalesce(name,'')||'|'||array_to_string(statements,E'\\x01')), E'\\n' order by version)) from supabase_migrations.schema_migrations")
expect "$digest" "$(python3 -c "import json;print(json.load(open('scripts/person-release/production-history-digests.json'))['all_rows_digest'].split('= ')[1])")" "imported history equals production's digest"

# A psql that injects one fault into the apply script of one version.
WRAP=$(mktemp "${TMPDIR:-/tmp}/fault-psql.XXXXXX"); trap 'rm -f "$WRAP"' EXIT
cat > "$WRAP" <<'W'
#!/bin/bash
args=("$@")
for ((i=0;i<${#args[@]};i++)); do
  if [ "${args[i]}" = -f ] && grep -q "supabase/migrations/${FAULT_VERSION}_" "${args[i+1]}" 2>/dev/null; then
    case "$FAULT_MODE" in
      error) sed -i.bak $'s/^commit;$/select 1\\/0;\\\ncommit;/' "${args[i+1]}";;
      disconnect) sed -i.bak $'s/^commit;$/select pg_terminate_backend(pg_backend_pid());\\\ncommit;/' "${args[i+1]}";;
    esac
  fi
done
exec "$REAL_PSQL" "${args[@]}"
W
chmod +x "$WRAP"
run(){ PERSON_TARGET_PROJECT_REF=local UPGRADE_DATABASE_URL="$URL" PSQL="$PSQL" bash scripts/person-release/apply-upgrade.sh "$@"; }
fault(){ FAULT_VERSION="$1" FAULT_MODE="$2" REAL_PSQL="$PSQL" PERSON_TARGET_PROJECT_REF=local UPGRADE_DATABASE_URL="$URL" PSQL="$WRAP" bash scripts/person-release/apply-upgrade.sh; }
versions_before(){ python3 -c "import json;v=[r['version'] for r in json.load(open('$MANIFEST'))['to_install']];print(v.index('$1'))"; }

# (5) the validator: a hosted selection cannot be served by a loopback URL.
set +e; out=$(PERSON_TARGET_PROJECT_REF=abcdefghijklmnopqrst UPGRADE_DATABASE_URL="$URL" PSQL="$PSQL" bash scripts/person-release/apply-upgrade.sh --dry-run 2>&1); code=$?; set -e
expect "$code" 2 "foreign selection refused before any connection"; grep -q "person_target:database_mismatch" <<<"$out" || { echo "FAIL refusal code: $out" >&2; exit 1; }

# (1) error before commit: nothing of that version remains.
set +e; fault 20260926183000 error >/dev/null 2>&1; code=$?; set -e
[ $code -ne 0 ] || { echo "FAIL fault run should exit non-zero" >&2; exit 1; }
expect "$(q -d $DB -c 'select count(*) from supabase_migrations.schema_migrations')" $((96+$(versions_before 20260926183000))) "history after an error before commit: only the versions before it"
expect "$(q -d $DB -c "select to_regclass('public.person_publish_runs') is null")" t "the failed version's table does not exist"
expect "$(q -d $DB -c "select count(*) from supabase_migrations.schema_migrations where version='20260926183000'")" 0 "the failed version is not recorded"

# (2) connection terminated before commit: nothing of that version remains, earlier resume kept.
set +e; fault 20260926213000 disconnect >/dev/null 2>&1; code=$?; set -e
[ $code -ne 0 ] || { echo "FAIL disconnect run should exit non-zero" >&2; exit 1; }
expect "$(q -d $DB -c 'select count(*) from supabase_migrations.schema_migrations')" $((96+$(versions_before 20260926213000))) "history after a lost connection before commit"
expect "$(q -d $DB -c "select to_regclass('public.person_postcutover_audit_runs') is null")" t "the interrupted version's table does not exist"

# (6)+(3) resume to the end.
out=$(run)
grep -q "build index candidates_person_username_idx concurrently" <<<"$out" || { echo "FAIL index pre-build not reported" >&2; exit 1; }
echo "ok identity index built concurrently before 20260927170000"
expect "$(q -d $DB -c "select i.indisvalid and i.indisready from pg_index i where i.indexrelid=to_regclass('public.candidates_person_username_idx')")" t "identity index valid"
expect "$(q -d $DB -c 'select count(*) from supabase_migrations.schema_migrations')" 159 "resume completed: 96 + 63 versions"
mismatch=$(python3 - "$MANIFEST" <<'PY' | q -d $DB -f - 
import json,sys
m=json.load(open(sys.argv[1]))
print("select count(*) from (values "+",".join(f"('{r['version']}','{r['md5']}')" for r in m['to_install'])+") v(version,md5) left join supabase_migrations.schema_migrations s on s.version=v.version where s.version is null or md5(s.statements[1])<>v.md5 or array_length(s.statements,1)<>1")
PY
)
expect "$mismatch" 0 "every installed version is recorded once with the exact file bytes"
out=$(run --dry-run); expect "$(grep -c '^skip ' <<<"$out")" 63 "a further dry run skips all 63 after verifying their digests"
expect "$(grep -c 'would apply' <<<"$out")" 0 "nothing left to apply"
grep -q "applied=0 skipped=63 unverifiable_bodies=0" <<<"$out" || { echo "FAIL summary: $(tail -2 <<<"$out")" >&2; exit 1; }

# (4) a recorded body that differs from the file stops the run.
q -d $DB -c "update supabase_migrations.schema_migrations set statements[1]=statements[1]||'-- tampered' where version='20260927090000'"
set +e; out=$(run --dry-run 2>&1); code=$?; set -e
expect "$code" 5 "tampered history row refused"; grep -q "history_mismatch 20260927090000" <<<"$out" || { echo "FAIL: $out" >&2; exit 1; }
q -d $DB -c "update supabase_migrations.schema_migrations set statements[1]=left(statements[1],length(statements[1])-length('-- tampered')) where version='20260927090000'"
out=$(run --dry-run); grep -q "applied=0 skipped=63" <<<"$out"; echo "ok restored row verifies again"
# The label is the operator's separate statement; a labelled database with the right label passes.
q -d $DB -c "select person_private.target_label('local')" >/dev/null
out=$(run --dry-run); grep -q "database_label=local" <<<"$out" || { echo "FAIL label not read" >&2; exit 1; }; echo "ok labelled database accepted for the matching selection"
echo "apply-upgrade resume proof: all checks passed"
