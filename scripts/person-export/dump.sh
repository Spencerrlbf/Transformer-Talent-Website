#!/usr/bin/env bash
# Full dump, custom format, zstd, streamed straight into the bucket.
# Nothing is written to disk on the runner except the hash and the manifest.
source "$(dirname "$0")/common.sh"
OUT="$DEST/full.dump"
# Fail fast on an unsupported rclone flag or a refused upload before the long dump.
echo "preflight $(date -u +%FT%TZ)" | rclone rcat --retries 3 --b2-chunk-size 200M "$DEST/preflight.txt"
rclone deletefile "$DEST/preflight.txt"
echo "rclone preflight ok ($(rclone version | head -1))"
started=$(date -u +%FT%TZ)
fifo="$WORK/sha.fifo"; rm -f "$fifo"; mkfifo "$fifo"
sha256sum < "$fifo" | cut -d' ' -f1 > "$WORK/full.dump.sha256" & shapid=$!

set +e
pg_dump "$PGURL" --format=custom --compress=zstd:6 "${PG_EXCLUDES[@]}" 2> "$WORK/dump.err" \
  | tee "$fifo" \
  | rclone rcat --retries 3 --b2-chunk-size 200M "$OUT"
rcs=("${PIPESTATUS[@]}")
set -e
wait "$shapid"
finished=$(date -u +%FT%TZ)
echo "pg_dump exit=${rcs[0]} tee exit=${rcs[1]} rclone exit=${rcs[2]}"
if [ -s "$WORK/dump.err" ]; then echo "-- pg_dump messages (sanitized)"; sanitize < "$WORK/dump.err" | head -20; fi
[ "${rcs[0]}" -eq 0 ] && [ "${rcs[2]}" -eq 0 ] || exit 1

bytes=$(rclone lsjson "$OUT" | jq '.[0].Size')
sha=$(cat "$WORK/full.dump.sha256")
echo "stored bytes=$bytes sha256=$sha started=$started finished=$finished"
jq -n --arg t "$EXPORT_TARGET" --arg s "$started" --arg f "$finished" --arg sha "$sha" --argjson b "$bytes" \
  --arg cli "$(pg_dump --version)" --arg srv "$(q 'select left(version(), 40)')" \
  --arg ex "${PG_EXCLUDES[*]}" \
  '{target:$t,object:"full.dump",format:"custom",compression:"zstd:6",bytes:$b,sha256:$sha,started:$s,finished:$f,pg_dump:$cli,server:$srv,excludes:$ex}' \
  > "$WORK/full.dump.manifest.json"
upload_file "$WORK/full.dump.sha256" "full.dump.sha256"
upload_file "$WORK/full.dump.manifest.json" "full.dump.manifest.json"
rclone lsl "$DEST"
