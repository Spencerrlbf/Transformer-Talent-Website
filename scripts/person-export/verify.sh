#!/usr/bin/env bash
# Streams the stored dump back, re-hashes it and reads its table of contents.
source "$(dirname "$0")/common.sh"
OUT="$DEST/full.dump"
expected=$(rclone cat "$DEST/full.dump.sha256")
fifo="$WORK/sha.fifo"; rm -f "$fifo"; mkfifo "$fifo"
sha256sum < "$fifo" | cut -d' ' -f1 > "$WORK/got.sha256" & shapid=$!
set +e
rclone cat "$OUT" | tee "$fifo" | pg_restore --list > "$WORK/toc.txt" 2> "$WORK/toc.err"
rcs=("${PIPESTATUS[@]}")
set -e
wait "$shapid"
got=$(cat "$WORK/got.sha256")
echo "rclone exit=${rcs[0]} pg_restore exit=${rcs[2]} toc_lines=$(wc -l < "$WORK/toc.txt")"
[ -s "$WORK/toc.err" ] && { echo "-- pg_restore messages (sanitized)"; sanitize < "$WORK/toc.err" | head -10; }
echo "sha256 expected=$expected"
echo "sha256 got=     $got"
[ "$expected" = "$got" ] && echo "HASH OK" || { echo "HASH MISMATCH"; exit 1; }
echo "table data sections: $(grep -c ' TABLE DATA ' "$WORK/toc.txt")"
echo "tables: $(grep -c ' TABLE ' "$WORK/toc.txt")  indexes: $(grep -c ' INDEX ' "$WORK/toc.txt")  functions: $(grep -c ' FUNCTION ' "$WORK/toc.txt")  policies: $(grep -c ' POLICY ' "$WORK/toc.txt")"
echo "-- table data sections by schema"
grep ' TABLE DATA ' "$WORK/toc.txt" | awk '{print $(NF-2)}' | sort | uniq -c | sort -rn | head -20
upload_file "$WORK/toc.txt" "full.dump.toc.txt"
[ "${rcs[2]}" -eq 0 ]
