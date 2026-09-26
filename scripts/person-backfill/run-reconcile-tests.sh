#!/bin/bash
set -euo pipefail
PORT="${1:?local port required}"
PSQL="${PSQL:-psql}"
q(){ "$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
q -d postgres -c 'drop database if exists person_reconcile_test' -c 'create database person_reconcile_test'
q -d person_reconcile_test -f scripts/person-trial/local-schema.sql
q -d person_reconcile_test -f scripts/person-trial/local-site-extras.sql
q -d person_reconcile_test -1 -f supabase/migrations/072_person_tables.sql
q -d person_reconcile_test -1 -f supabase/migrations/20260926025355_person_writer_corrections.sql
q -d person_reconcile_test -1 -f supabase/migrations/20260926031057_person_backfill_capture.sql
q -d person_reconcile_test -1 -f supabase/migrations/20260926032752_person_missing_employer_review.sql
q -d person_reconcile_test -1 -f supabase/migrations/20260926040300_person_backfill_bulk.sql
q -d person_reconcile_test -1 -f supabase/migrations/20260926042200_person_reconcile.sql
LOCAL_DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/person_reconcile_test" node scripts/person-backfill/test-reconcile.mjs
node --test scripts/person-backfill/test-reconcile-evidence.mjs
