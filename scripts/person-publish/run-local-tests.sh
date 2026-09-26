#!/bin/bash
# Local PostgreSQL only: the cutover runbook scripts (publish, undo, guard).
#   node scripts/build-worker-lib.mjs
#   PSQL=/opt/homebrew/opt/postgresql@15/bin/psql bash scripts/person-publish/run-local-tests.sh <port>
set -euo pipefail
PORT="${1:?local port required}"
PSQL="${PSQL:-psql}"
q(){ "$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
q -d postgres -c 'drop database if exists person_publish_test' -c 'create database person_publish_test'
q -d person_publish_test -f scripts/person-trial/local-schema.sql
q -d person_publish_test -f scripts/person-trial/local-site-extras.sql
for migration in 072_person_tables 20260926025355_person_writer_corrections 20260926031057_person_backfill_capture 20260926032752_person_missing_employer_review 20260926033900_person_atomic_projection 20260926040300_person_backfill_bulk; do
 q -d person_publish_test -1 -f "supabase/migrations/$migration.sql"
done
bash scripts/person-audit/install-local.sh "$PORT" person_publish_test
LOCAL_DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/person_publish_test" node --test --test-concurrency=1 scripts/person-publish/test-publish.mjs
