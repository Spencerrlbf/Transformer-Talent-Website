#!/bin/bash
# Resets only the caller-owned loopback person_application_proof_test fixture database.
set -euo pipefail
PORT="${1:?local port required}"
PSQL="${PSQL:-psql}"
[[ "$PORT" =~ ^[0-9]+$ ]] || exit 2
DB=person_application_proof_test
q(){ "$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
q -d postgres -c "drop database if exists $DB" -c "create database $DB"
q -d $DB -f scripts/person-trial/local-schema.sql
q -d $DB -f scripts/person-trial/local-site-extras.sql
q -d $DB -c "alter table organizations add column daily_review_limit integer not null default 300;create table rate_limit_events(id bigint generated always as identity primary key,bucket text not null,created_at timestamptz not null default now());create index on rate_limit_events(bucket,created_at)"
q -d $DB -c "create table refresh_queue(id uuid primary key default gen_random_uuid(),organization_id uuid not null,candidate_id uuid not null,linkedin_url text,linkedin_username text,priority int not null default 100,reason text,status text not null default 'queued',queued_at timestamptz not null default now(),processed_at timestamptz,unique(candidate_id,status))"
for migration in 072_person_tables 20260926025355_person_writer_corrections 20260926031057_person_backfill_capture 20260926032752_person_missing_employer_review 20260926033900_person_atomic_projection 20260926040300_person_backfill_bulk 20260926042200_person_reconcile 20260926050355_person_source_date_holds 20260926044800_person_application_intake 20260926061600_person_directory_intake 20260926065300_person_recruiter_contacts 20260926054500_person_refresh_intake 20260926074407_person_audit_evidence 20260926080238_person_audit_anchor_preparation 20260926082012_person_audit_writer_guards 20260926172608_person_postcutover_snapshots 20260926183000_person_publish_runbook 20260926201342_person_publish_review_guards 20260926213000_person_postcutover_audit 20260926233000_person_audit_reference_ownership 20260926235140_person_transition_foundation 20260927001258_person_application_work 20260927004931_person_application_queue; do
 q -d $DB -1 -f "supabase/migrations/$migration.sql"
done
q -d $DB -f scripts/person-derivatives/local-embeddings.sql
q -d $DB -1 -f supabase/migrations/20260926072840_person_derivative_jobs.sql
q -d $DB -c "create table sourced_candidates(id uuid primary key default gen_random_uuid(),organization_id uuid not null,linkedin_username text,contact jsonb)"
if test -f supabase/migrations/20260927013100_person_application_finalization.sql; then
 q -d $DB -1 -f supabase/migrations/20260927013100_person_application_finalization.sql
fi
if test -f supabase/migrations/20260927020700_person_application_ownership.sql; then
 q -d $DB -1 -f supabase/migrations/20260927020700_person_application_ownership.sql
fi
if test -f supabase/migrations/20260927023000_person_normalization_fence.sql; then
 q -d $DB -1 -f supabase/migrations/20260927023000_person_normalization_fence.sql
fi
if test -f supabase/migrations/20260927025000_person_application_proof.sql; then
 q -d $DB -1 -f supabase/migrations/20260927025000_person_application_proof.sql
fi
if test -f supabase/migrations/20260927035000_person_application_projection.sql; then
 q -d $DB -1 -f supabase/migrations/20260927035000_person_application_projection.sql
fi
if test -f supabase/migrations/20260927052000_person_intake_mutations.sql; then
 q -d $DB -1 -f supabase/migrations/20260927052000_person_intake_mutations.sql
fi
node scripts/build-worker-lib.mjs
npx --yes esbuild@0.28.2 scripts/person-application-queue/processing-entry.ts --bundle --platform=node --external:pg --format=esm --alias:@="$PWD" --outfile=scripts/person-application-queue/dist/processing.mjs --log-level=warning
LOCAL_DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/$DB" node --test --test-concurrency=1 scripts/person-application-proof/test-proof.mjs
