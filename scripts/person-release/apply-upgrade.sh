#!/bin/bash
# Ordered, checksummed, resumable installation of the release migrations on ONE selected
# hosted database (production at the sitting; the copy for rehearsal). Reads
# scripts/person-release/production-upgrade-manifest.json, verifies each file's SHA256
# against the manifest, skips versions already recorded in
# supabase_migrations.schema_migrations, applies each remaining file in its own
# transaction (psql -1) on the 5432 SESSION endpoint, records the version with the file
# as its single statement, and stops at the first error. It never runs `supabase db push`,
# never replays a recorded version and never writes the project label: that is the
# operator's explicit statement afterwards (runbook "Project label").
#
#   PERSON_TARGET_PROJECT_REF=<ref> UPGRADE_DATABASE_URL='<5432 session url>' \
#     bash scripts/person-release/apply-upgrade.sh [--dry-run]
set -euo pipefail
node scripts/check-node.mjs >/dev/null
MANIFEST=scripts/person-release/production-upgrade-manifest.json
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
: "${PERSON_TARGET_PROJECT_REF:?selected project ref required}"
: "${UPGRADE_DATABASE_URL:?5432 session url required}"
case "$UPGRADE_DATABASE_URL" in *"postgres.${PERSON_TARGET_PROJECT_REF}"*".pooler.supabase.com:5432/"*|*"db.${PERSON_TARGET_PROJECT_REF}.supabase.co:5432/"*) ;; *) echo "upgrade_url_mismatch: the URL must name ${PERSON_TARGET_PROJECT_REF} on port 5432" >&2; exit 2;; esac
PSQL="${PSQL:-psql}"; export PGCONNECT_TIMEOUT=20
q(){ "$PSQL" "$UPGRADE_DATABASE_URL" -X -At -v ON_ERROR_STOP=1 "$@"; }
label=$(q -c "select coalesce(public.person_target_identity()->>'project_ref','<unlabelled>')" 2>/dev/null || echo '<no identity function yet>')
echo "target=$PERSON_TARGET_PROJECT_REF database_label=$label versions_before=$(q -c 'select count(*) from supabase_migrations.schema_migrations')"
if [ "$label" != '<unlabelled>' ] && [ "$label" != '<no identity function yet>' ] && [ "$label" != "$PERSON_TARGET_PROJECT_REF" ]; then echo "label_mismatch: database is labelled $label" >&2; exit 3; fi
python3 - "$MANIFEST" <<'PY' > /tmp/person-upgrade-plan.$$
import json,sys
m=json.load(open(sys.argv[1]))
for r in m['to_install']: print(r['version'], r['file'], r['sha256'])
PY
applied=0; skipped=0
while read -r version file sha; do
  actual=$(shasum -a 256 "supabase/migrations/$file" | cut -c1-64)
  [ "$actual" = "$sha" ] || { echo "checksum_mismatch $file" >&2; exit 4; }
  if [ "$(q -c "select count(*) from supabase_migrations.schema_migrations where version='$version'")" = "1" ]; then echo "skip $version (recorded)"; skipped=$((skipped+1)); continue; fi
  if [ $DRY = 1 ]; then echo "would apply $version $file"; continue; fi
  echo "apply $version $file"
  q -q -1 -f "supabase/migrations/$file"
  name="${file#*_}"; name="${name%.sql}"
  # Record the exact file bytes as the single statement (a shell substitution would drop the
  # trailing newline; a sentinel character is appended and removed inside SQL).
  printf "insert into supabase_migrations.schema_migrations(version,name,statements) select '%s','%s',array[left(:'body',length(:'body')-1)] where not exists(select 1 from supabase_migrations.schema_migrations where version='%s');\n" "$version" "$name" "$version" | q -q -v body="$(cat "supabase/migrations/$file"; printf x)"
  recorded=$(q -c "select md5(statements[1]) from supabase_migrations.schema_migrations where version='$version'")
  [ "$recorded" = "$(md5 -q "supabase/migrations/$file" 2>/dev/null || md5sum "supabase/migrations/$file" | cut -c1-32)" ] || { echo "record_mismatch $version" >&2; exit 5; }
  applied=$((applied+1))
done < /tmp/person-upgrade-plan.$$
rm -f /tmp/person-upgrade-plan.$$
[ $DRY = 1 ] || q -q -c "notify pgrst, 'reload schema'"
echo "applied=$applied skipped=$skipped versions_after=$(q -c 'select count(*) from supabase_migrations.schema_migrations') label_now=$(q -c "select coalesce(public.person_target_identity()->>'project_ref','<unlabelled>')")"
echo "next (operator, explicit): psql \"\$UPGRADE_DATABASE_URL\" -c \"select person_private.target_label('$PERSON_TARGET_PROJECT_REF')\""
