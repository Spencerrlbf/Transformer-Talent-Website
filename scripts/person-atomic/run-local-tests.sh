#!/bin/bash
set -euo pipefail
PORT="${1:?local port required}"
PSQL="${PSQL:-psql}"
q(){ "$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
q -d postgres -c 'drop database if exists person_atomic_test' -c 'create database person_atomic_test'
q -d person_atomic_test -f scripts/person-trial/local-schema.sql
q -d person_atomic_test -f scripts/person-trial/local-site-extras.sql
q -d person_atomic_test -1 -f supabase/migrations/072_person_tables.sql
q -d person_atomic_test -1 -f supabase/migrations/20260926025355_person_writer_corrections.sql
q -d person_atomic_test -1 -f supabase/migrations/20260926031057_person_backfill_capture.sql
q -d person_atomic_test -1 -f supabase/migrations/20260926032752_person_missing_employer_review.sql
q -d person_atomic_test -1 -f supabase/migrations/20260926033900_person_atomic_projection.sql
q -d person_atomic_test -1 -f supabase/migrations/20260926040300_person_backfill_bulk.sql
q -d person_atomic_test -1 -f supabase/migrations/20260926183000_person_publish_runbook.sql
bash scripts/person-audit/install-local.sh "$PORT" person_atomic_test
LOCAL_DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/person_atomic_test" node scripts/person-atomic/test-atomic.mjs
LOCAL_DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/person_atomic_test" node --test scripts/person-atomic/test-review-regressions.mjs
LOCAL_DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/person_atomic_test" node scripts/person-atomic/test-pool.mjs
LOCAL_DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/person_atomic_test" node scripts/person-atomic/test-pool.mjs --idle
