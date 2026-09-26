#!/bin/bash
# Local PostgreSQL only: the post-cutover auditor (planner, record, finalize,
# runner). Resets only the disposable person_postcutover_audit_test database.
#   node scripts/build-worker-lib.mjs
#   PSQL=/opt/homebrew/opt/postgresql@15/bin/psql bash scripts/person-audit/run-postcutover-audit-tests.sh <port>
set -euo pipefail
PORT="${1:?local port required}"
PSQL="${PSQL:-psql}"
DB=person_postcutover_audit_test
q(){ "$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
q -d postgres -c "drop database if exists $DB" -c "create database $DB"
q -d $DB -f scripts/person-trial/local-schema.sql
q -d $DB -f scripts/person-trial/local-site-extras.sql
for migration in 072_person_tables 20260926025355_person_writer_corrections 20260926031057_person_backfill_capture 20260926032752_person_missing_employer_review 20260926033900_person_atomic_projection 20260926040300_person_backfill_bulk 20260926042200_person_reconcile 20260926050355_person_source_date_holds 20260926044800_person_application_intake 20260926061600_person_directory_intake 20260926065300_person_recruiter_contacts 20260926054500_person_refresh_intake 20260926074407_person_audit_evidence 20260926080238_person_audit_anchor_preparation 20260926082012_person_audit_writer_guards 20260926172608_person_postcutover_snapshots 20260926183000_person_publish_runbook 20260926201342_person_publish_review_guards 20260926213000_person_postcutover_audit; do
 q -d $DB -1 -f "supabase/migrations/$migration.sql"
done
q -d $DB -f scripts/person-derivatives/local-embeddings.sql
q -d $DB -1 -f supabase/migrations/20260926072840_person_derivative_jobs.sql
LOCAL_DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/$DB" node --test --test-concurrency=1 scripts/person-audit/test-postcutover-audit.mjs
