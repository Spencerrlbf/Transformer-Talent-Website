#!/bin/bash
set -euo pipefail
PORT="${1:?local port required}"
PSQL="${PSQL:-psql}"
q(){ "$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
q -d postgres -c 'drop database if exists person_audit_test' -c 'create database person_audit_test'
q -d person_audit_test -f scripts/person-trial/local-schema.sql
q -d person_audit_test -f scripts/person-trial/local-site-extras.sql
for migration in 072_person_tables 20260926025355_person_writer_corrections 20260926031057_person_backfill_capture 20260926032752_person_missing_employer_review 20260926033900_person_atomic_projection 20260926040300_person_backfill_bulk 20260926042200_person_reconcile 20260926050355_person_source_date_holds 20260926044800_person_application_intake 20260926061600_person_directory_intake; do
 q -d person_audit_test -1 -f "supabase/migrations/$migration.sql"
done
if test -f supabase/migrations/20260926065300_person_recruiter_contacts.sql;then
 q -d person_audit_test -1 -f supabase/migrations/20260926065300_person_recruiter_contacts.sql
fi
q -d person_audit_test -f scripts/person-derivatives/local-embeddings.sql
q -d person_audit_test -1 -f supabase/migrations/20260926072840_person_derivative_jobs.sql
q -d person_audit_test -1 -f supabase/migrations/20260926054500_person_refresh_intake.sql
q -d person_audit_test -c "insert into candidates(id,full_name,linkedin_username) values('d5000000-0000-4000-8000-000000000900','Synthetic Pre-migration','audit-before-migration')"
q -d person_audit_test -1 -f supabase/migrations/20260926074407_person_audit_evidence.sql
q -d person_audit_test -1 -f supabase/migrations/20260926080238_person_audit_anchor_preparation.sql
LOCAL_DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/person_audit_test" node --test scripts/person-audit/test-evidence.mjs
q -d person_audit_test -c "create table refresh_queue(id uuid primary key default gen_random_uuid(),organization_id uuid not null,candidate_id uuid not null,linkedin_url text,linkedin_username text,priority int not null default 100,reason text,status text not null default 'queued',queued_at timestamptz not null default now(),processed_at timestamptz,unique(candidate_id,status))"
LOCAL_DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/person_audit_test" node --test --test-concurrency=1 scripts/person-intake/test-applications.mjs scripts/person-refresh/test-refresh.mjs scripts/person-directory/test-directory.mjs scripts/person-recruiter/test-recruiter.mjs

LOCAL_DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/person_audit_test" node --test --test-concurrency=1 scripts/person-audit/test-anchors.mjs scripts/person-audit/test-anchor-cli.mjs
