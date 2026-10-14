#!/bin/bash
# Ordered, checksummed, resumable and ATOMIC installation of the release migrations on ONE
# selected database: production at the sitting, the copy for rehearsal, a loopback database
# for the interruption/resume proof (scripts/person-release/test-apply-upgrade-resume.sh).
# Reads scripts/person-release/production-upgrade-manifest.json.
#
# Per version, ONE transaction holds the migration file and its history row
# (version, name, statements = [the exact file bytes]). An error or a lost connection before
# the commit leaves neither the schema change nor the row; a recorded version is never
# replayed. Before any file is applied, every window version already recorded is checked
# against the digest the manifest knows (installer-recorded rows carry the file bytes; the
# three versions `supabase db push` recorded on production carry the digest observed there,
# read-only, 2026-10-13); a different body stops the run. The destination is checked offline
# by the hardened validator (scripts/person-target.mjs: the URL must name the selection on
# the 5432 session endpoint, no connection-option overrides), then at run time by the
# database-held label when the identity function exists: unlabelled (production before the
# install) or the selection's own label passes, any other label refuses. The case-folded
# identity index that 20260927170000 validates is built CONCURRENTLY (autocommit) before that
# file when absent; an invalid leftover build stops the run for the operator. Never
# `supabase db push`, never the label statement (runbook "Project label").
#
#   PERSON_TARGET_PROJECT_REF=<ref|local> UPGRADE_DATABASE_URL='<5432 session url>' \
#     bash scripts/person-release/apply-upgrade.sh [--dry-run]
#   PSQL=<psql binary or wrapper> overrides the client (the resume proof injects faults there).
set -euo pipefail
[ -f scripts/person-release/production-upgrade-manifest.json ] || { echo "run from the repository root" >&2; exit 2; }
node scripts/check-node.mjs >/dev/null
MANIFEST=scripts/person-release/production-upgrade-manifest.json
DRY=0; case "${1:-}" in "") ;; --dry-run) DRY=1;; *) echo "usage: apply-upgrade.sh [--dry-run]" >&2; exit 2;; esac
: "${PERSON_TARGET_PROJECT_REF:?selected project ref required}"
: "${UPGRADE_DATABASE_URL:?5432 session url required}"
# 1. Destination, offline: the selection and the URL must agree (hardened validator; the URL
#    itself is never printed).
DEST=$(node --input-type=module -e '
import {selectedTarget,checkDatabaseUrl} from "./scripts/person-target.mjs";
const t=selectedTarget(process.env);const id=checkDatabaseUrl(process.env.UPGRADE_DATABASE_URL,t,{ports:["5432"]});
console.log(`${t.ref} ${id.kind} ${id.host}:${id.port}`);' 2>&1) || { echo "upgrade_destination_refused: $(grep -o 'person_target:[a-z_]\+' <<<"$DEST" | head -1)" >&2; exit 2; }
PSQL="${PSQL:-psql}"; export PGCONNECT_TIMEOUT=20
q(){ "$PSQL" "$UPGRADE_DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1 "$@"; }
# 2. Destination, at run time: cluster identifier and the database-held label.
sysid=$(q -c "select system_identifier from pg_control_system()")
if [ "$(q -c "select to_regprocedure('public.person_target_identity()') is not null")" = t ]; then
  label=$(q -c "select coalesce(public.person_target_identity()->>'project_ref','<unlabelled>')")
else label='<no identity function yet>'; fi
case "$label" in '<unlabelled>'|'<no identity function yet>'|"$PERSON_TARGET_PROJECT_REF") ;;
  *) echo "label_mismatch: the database is labelled $label; the selection is $PERSON_TARGET_PROJECT_REF" >&2; exit 3;; esac
before=$(q -c 'select count(*) from supabase_migrations.schema_migrations')
echo "target=$DEST system_identifier=$sysid database_label=$label versions_before=$before dry_run=$DRY"
PLAN=$(mktemp "${TMPDIR:-/tmp}/person-upgrade-plan.XXXXXX"); trap 'rm -f "$PLAN" "$PLAN.sql"' EXIT
python3 - "$MANIFEST" > "$PLAN" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
for r in m['recorded_in_window']: print('RECORDED', r['version'], r['name'], r['statements_md5_trimmed'])
for r in m['to_install']: print('INSTALL', r['version'], r['file'], r['sha256'], r['md5_trimmed'])
PY
# One recorded row per version, carrying the body the manifest knows (digest of the body with
# trailing whitespace trimmed: one rehearsal recording dropped a final newline). Returns 1 when
# the version is not recorded at all; exits when it is recorded with another body or name.
# A row recorded WITHOUT a body (statements null: the copy's September 28 rehearsal recorded
# versions that way) can only be checked by name; it is counted and reported, never silently
# trusted. Production's rows all carry bodies (CLI-recorded or installer-recorded).
unverifiable=0
check_recorded(){ # version expected_trimmed_md5 name
  local row; row=$(q -c "select coalesce(name,''),coalesce(array_length(statements,1),0),coalesce(md5(rtrim(array_to_string(statements,E'\\x01'),E' \\n\\r\\t')),''),count(*) over () from supabase_migrations.schema_migrations where version='$1'")
  [ -n "$row" ] || return 1
  local rname rn rmd5 rcount; IFS='|' read -r rname rn rmd5 rcount <<<"$row"
  if [ "$rcount" != 1 ] || [ "$rname" != "$3" ]; then
    echo "history_mismatch $1: recorded name=$rname rows=$rcount expected name=$3" >&2; exit 5; fi
  if [ "$rn" = 0 ]; then echo "warning: $1 is recorded without a body (statements null); its name matches, its body cannot be verified"; unverifiable=$((unverifiable+1)); return 0; fi
  if [ "$rmd5" != "$2" ]; then
    echo "history_mismatch $1: recorded statements=$rn digest=$rmd5 expected digest=$2" >&2; exit 5; fi
  return 0
}
# The nonunique case-folded identity index 20260927170000 validates. Built outside any
# transaction so pool writes are not blocked; a plain CREATE INDEX inside that migration's
# transaction would hold ShareLock on candidates for the whole build.
prepare_index(){
  local state; state=$(q -c "select coalesce((select case when i.indisvalid and i.indisready then 'valid' else 'invalid' end from pg_index i where i.indexrelid=to_regclass('public.candidates_person_username_idx')),'absent')")
  case "$state" in
    valid) echo "index candidates_person_username_idx: present and valid";;
    invalid) echo "index_invalid: candidates_person_username_idx exists but is not valid (an interrupted concurrent build). Operator: drop index concurrently public.candidates_person_username_idx; then rerun." >&2; exit 6;;
    absent)
      if [ $DRY = 1 ]; then echo "would build index candidates_person_username_idx concurrently (autocommit, before 20260927170000)"; return; fi
      echo "build index candidates_person_username_idx concurrently (autocommit)"
      q -c "set lock_timeout='3s'" -c "set statement_timeout='30min'" -c "create index concurrently candidates_person_username_idx on public.candidates(lower(linkedin_username))"
      [ "$(q -c "select i.indisvalid and i.indisready from pg_index i where i.indexrelid=to_regclass('public.candidates_person_username_idx')")" = t ] || { echo "index_invalid: the concurrent build did not produce a valid index" >&2; exit 6; };;
  esac
}
applied=0; skipped=0
while read -r kind a b c d; do
  if [ "$kind" = RECORDED ]; then
    # Versions production already had inside the window: present, with the observed body.
    check_recorded "$a" "$c" "$b" || { echo "history_missing $a: the manifest expects this version to be recorded already" >&2; exit 5; }
    echo "verified $a (recorded before this package)"; continue
  fi
  version=$a; file=$b; sha=$c; md5=$d
  actual=$(shasum -a 256 "supabase/migrations/$file" | cut -c1-64)
  [ "$actual" = "$sha" ] || { echo "checksum_mismatch $file" >&2; exit 4; }
  name="${file#*_}"; name="${name%.sql}"
  if check_recorded "$version" "$md5" "$name"; then echo "skip $version (recorded, digest verified)"; skipped=$((skipped+1)); continue; fi
  [ "$version" = 20260927170000 ] && prepare_index
  if [ $DRY = 1 ]; then echo "would apply $version $file"; continue; fi
  echo "apply $version $file"
  # The file and its history row in one transaction. The body arrives as a psql variable
  # (a shell substitution drops the trailing newline, so a sentinel byte is appended and
  # removed in SQL); the migration files contain no psql variables or backslash commands.
  cat > "$PLAN.sql" <<SQL
\\set ON_ERROR_STOP on
begin;
\\i supabase/migrations/$file
insert into supabase_migrations.schema_migrations(version,name,statements)
 select :'version', :'name', array[left(:'body',length(:'body')-1)]
 where not exists (select 1 from supabase_migrations.schema_migrations where version=:'version');
commit;
SQL
  q -v version="$version" -v name="$name" -v body="$(cat "supabase/migrations/$file"; printf x)" -f "$PLAN.sql"
  check_recorded "$version" "$md5" "$name" || { echo "record_missing $version: the transaction did not leave a history row" >&2; exit 5; }
  applied=$((applied+1))
done < "$PLAN"
[ $DRY = 1 ] || q -c "notify pgrst, 'reload schema'"
echo "applied=$applied skipped=$skipped unverifiable_bodies=$unverifiable versions_after=$(q -c 'select count(*) from supabase_migrations.schema_migrations') label_now=$(if [ "$(q -c "select to_regprocedure('public.person_target_identity()') is not null")" = t ]; then q -c "select coalesce(public.person_target_identity()->>'project_ref','<unlabelled>')"; else echo '<no identity function>'; fi)"
echo "next (operator, explicit): psql \"\$UPGRADE_DATABASE_URL\" -c \"select person_private.target_label('$PERSON_TARGET_PROJECT_REF')\""
