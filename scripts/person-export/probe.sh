#!/usr/bin/env bash
# Read-only probe: server facts, schema and table sizes, exact row counts,
# a schema-only dump (no data) and a round trip to the bucket.
source "$(dirname "$0")/common.sh"

echo "== server"
q "select left(version(), 40)"
echo "database bytes: $(q 'select pg_database_size(current_database())')"
echo "pg_dump client: $(pg_dump --version)"

echo "== schemas by size (tables, bytes incl. indexes and toast)"
q "select n.nspname||' '||count(*)||' '||sum(pg_total_relation_size(c.oid))
   from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where c.relkind in ('r','p','m') and n.nspname not in ('pg_catalog','information_schema','pg_toast')
   group by n.nspname order by sum(pg_total_relation_size(c.oid)) desc"

echo "== largest 40 tables (schema.table bytes est_rows)"
q "select n.nspname||'.'||c.relname||' '||pg_total_relation_size(c.oid)||' '||c.reltuples::bigint
   from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema','pg_toast')
   order by pg_total_relation_size(c.oid) desc limit 40"

echo "== exact row counts for ${COUNT_SCHEMAS:-public}"
COUNTS="$WORK/counts.json"; echo "{" > "$COUNTS"; first=1
while IFS='|' read -r schema table; do
  [ -n "$table" ] || continue
  n=$(q "select count(*) from \"$schema\".\"$table\"")
  [ $first -eq 1 ] || echo "," >> "$COUNTS"; first=0
  printf '  "%s.%s": %s' "$schema" "$table" "$n" >> "$COUNTS"
  echo "$schema.$table $n"
done < <(q "select n.nspname||'|'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where c.relkind in ('r','p') and n.nspname = any(string_to_array('${COUNT_SCHEMAS:-public}',','))
            order by 1")
echo "" >> "$COUNTS"; echo "}" >> "$COUNTS"
upload_file "$COUNTS" "probe/counts.json"

echo "== schema-only dump (no data) with the planned excludes"
set +e
pg_dump "$PGURL" --schema-only "${PG_EXCLUDES[@]}" -f "$WORK/schema.sql" 2> "$WORK/schema.err"; rc=$?
set -e
echo "schema dump exit=$rc lines=$(wc -l < "$WORK/schema.sql") bytes=$(wc -c < "$WORK/schema.sql")"
if [ -s "$WORK/schema.err" ]; then echo "-- pg_dump messages (sanitized)"; sanitize < "$WORK/schema.err" | head -20; fi
[ $rc -eq 0 ] && upload_file "$WORK/schema.sql" "probe/schema.sql"

echo "== bucket round trip"
rclone lsd "b2:${B2_BUCKET}" >/dev/null && echo "bucket reachable"
stamp="probe $(date -u +%FT%TZ) run ${GITHUB_RUN_ID:-local}"
echo "$stamp" | rclone rcat "$DEST/probe/probe.txt"
back=$(rclone cat "$DEST/probe/probe.txt")
[ "$back" = "$stamp" ] && echo "round trip ok" || { echo "round trip MISMATCH"; exit 1; }
echo "s3 endpoint host: $(curl -fsS -u "${RCLONE_CONFIG_B2_ACCOUNT}:${RCLONE_CONFIG_B2_KEY}" https://api.backblazeb2.com/b2api/v2/b2_authorize_account | jq -r .s3ApiUrl | sed 's#https://##')"
rclone lsl "$DEST"
echo "probe complete, exit=$rc"; exit $rc
