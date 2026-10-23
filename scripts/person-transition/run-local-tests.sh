#!/bin/bash
set -euo pipefail
PORT="${1:?loopback port required}"
PSQL="${PSQL:-psql}"
[[ "$PORT" =~ ^[0-9]+$ ]] || exit 2
DB=person_transition_test
q(){ "$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
q -d postgres -c "drop database if exists $DB" -c "create database $DB"
q -d $DB -f scripts/person-trial/local-schema.sql
q -d $DB -c "insert into organizations(id,slug) values('cf000000-0000-4000-8000-000000000001','synthetic-transition-tenant')"
q -d $DB -1 -f supabase/migrations/20260926235140_person_transition_foundation.sql
LOCAL_DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/$DB" node --test --test-concurrency=1 scripts/person-transition/test-foundation.mjs
npx --yes esbuild@0.28.2 scripts/person-transition/entry.ts --bundle --platform=node --external:pg --format=esm --outfile=scripts/person-transition/dist/transport.mjs --log-level=warning
LOCAL_DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/$DB" node --test --test-concurrency=1 scripts/person-transition/test-transport.mjs
