#!/bin/bash
set -euo pipefail
PORT="${1:?local port required}"
PSQL="${PSQL:-psql}"
q(){ "$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
q -d postgres -c 'drop database if exists person_recruiter_test' -c 'create database person_recruiter_test'
q -d person_recruiter_test -f scripts/person-trial/local-schema.sql
q -d person_recruiter_test -f scripts/person-trial/local-site-extras.sql
for migration in 072_person_tables 20260926025355_person_writer_corrections 20260926031057_person_backfill_capture 20260926032752_person_missing_employer_review 20260926033900_person_atomic_projection 20260926040300_person_backfill_bulk 20260926183000_person_publish_runbook 20260926042200_person_reconcile 20260926050355_person_source_date_holds 20260926044800_person_application_intake 20260926061600_person_directory_intake; do
 q -d person_recruiter_test -1 -f "supabase/migrations/$migration.sql"
done
if test -f supabase/migrations/20260926065300_person_recruiter_contacts.sql;then
 q -d person_recruiter_test -1 -f supabase/migrations/20260926065300_person_recruiter_contacts.sql
fi
bash scripts/person-audit/install-local.sh "$PORT" person_recruiter_test
LOCAL_DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/person_recruiter_test" node --test scripts/person-recruiter/test-recruiter.mjs
node --test scripts/person-recruiter/test-contact-view.mjs
LOCAL_DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/person_recruiter_test" node --test scripts/person-recruiter/test-server-paths.mjs
