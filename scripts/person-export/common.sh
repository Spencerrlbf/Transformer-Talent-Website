#!/usr/bin/env bash
# Shared pieces for the pause export (see README.md in this folder).
# Logs are public (public repository): print schema and table names, counts,
# byte sizes and hashes only. Never print a row, a URL or a key.
set -euo pipefail

: "${B2_BUCKET:?B2_BUCKET is required}"
: "${EXPORT_PREFIX:?EXPORT_PREFIX is required}"
: "${EXPORT_TARGET:?EXPORT_TARGET is required}"
: "${PGURL:?PGURL is required}"

DEST="b2:${B2_BUCKET}/${EXPORT_PREFIX}/${EXPORT_TARGET}"
WORK="${RUNNER_TEMP:-/tmp}/person-export"
mkdir -p "$WORK"

# Schemas the Supabase platform owns and recreates itself in a fresh project.
# Everything else (public, auth, storage metadata, cron, supabase_migrations,
# the application's private schemas) is dumped.
PG_EXCLUDES=(
  --exclude-schema=extensions
  --exclude-schema=graphql
  --exclude-schema=graphql_public
  --exclude-schema=net
  --exclude-schema=pgbouncer
  --exclude-schema='pgsodium*'
  --exclude-schema=realtime
  --exclude-schema=_realtime
  --exclude-schema=vault
  --exclude-schema=supabase_functions
  --exclude-schema=_analytics
  --exclude-schema=_supavisor
  --exclude-schema=pgtle
)

# Per-statement bound for the probe/verify reads; the dump itself runs unbounded.
export PGOPTIONS='-c statement_timeout=900000'
export PGCONNECT_TIMEOUT=30

q() { psql "$PGURL" -X -q -v ON_ERROR_STOP=1 -At -c "$1"; }

sanitize() { sed -E 's/eyJ[A-Za-z0-9._-]+/<jwt>/g; s#postgres(ql)?://[^ "]+#<pg-url>#g' | cut -c1-300; }

upload_file() { # upload_file <local path> <name under DEST>
  rclone copyto --retries 5 "$1" "$DEST/$2"
}
