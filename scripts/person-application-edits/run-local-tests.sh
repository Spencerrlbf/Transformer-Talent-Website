#!/bin/bash
# Local PostgreSQL only: checked TT application edits. Resets only person_directory_worker_test.
set -euo pipefail
PORT="${1:?local port required}"
PSQL="${PSQL:-psql}"
[[ "$PORT" =~ ^[0-9]+$ ]] || exit 2
DB=person_directory_worker_test
q(){ "$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
q -d postgres -c "drop database if exists $DB" -c "create database $DB"
q -d $DB -f scripts/person-trial/local-schema.sql
q -d $DB -f scripts/person-trial/local-site-extras.sql
q -d $DB -f scripts/person-intake-mutations/local-normalizer.sql
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
if test -f supabase/migrations/20260927060000_person_intake_ready.sql; then
 q -d $DB -1 -f supabase/migrations/20260927060000_person_intake_ready.sql
fi
if test -f supabase/migrations/20260927065000_person_tenant_binding.sql; then
 q -d $DB -1 -f supabase/migrations/20260927065000_person_tenant_binding.sql
fi
q -d $DB -c "create table org_roles(id uuid primary key default gen_random_uuid(),organization_id uuid not null,external_id text not null,unique(organization_id,external_id));create table site_role_embeddings(job_id text primary key)"
if test -f supabase/migrations/20260927070000_person_application_completion.sql; then
 q -d $DB -1 -f supabase/migrations/20260927070000_person_application_completion.sql
fi
q -d $DB -c "create table recruiter_profiles(id uuid primary key,organization_id uuid not null,published boolean not null default false)"
if test -f supabase/migrations/20260927080000_person_application_acceptance.sql; then
 q -d $DB -1 -f supabase/migrations/20260927080000_person_application_acceptance.sql
fi
if test -f supabase/migrations/20260927090000_person_application_enrichment.sql; then
 q -d $DB -1 -f supabase/migrations/20260927090000_person_application_enrichment.sql
fi
if test -f supabase/migrations/20260927100000_person_legacy_source_fence.sql; then
 q -d $DB -1 -f supabase/migrations/20260927100000_person_legacy_source_fence.sql
fi
if test -f supabase/migrations/20260927110000_person_conflict_evidence.sql; then
 q -d $DB -1 -f supabase/migrations/20260927110000_person_conflict_evidence.sql
fi
if test -f supabase/migrations/20260927120000_person_lookup_mutations.sql; then
 q -d $DB -1 -f supabase/migrations/20260927120000_person_lookup_mutations.sql
fi
if test -f supabase/migrations/20260927130000_person_directory_input.sql; then
 q -d $DB -1 -f supabase/migrations/20260927130000_person_directory_input.sql
fi
if test -f supabase/migrations/20260927140000_person_directory_execution.sql; then
 q -d $DB -1 -f supabase/migrations/20260927140000_person_directory_execution.sql
fi
if test -f supabase/migrations/20260927150000_person_directory_publication.sql; then
 q -d $DB -1 -f supabase/migrations/20260927150000_person_directory_publication.sql
fi
q -d $DB -1 -f supabase/migrations/20260927160000_person_directory_creation.sql
q -d $DB -1 -f supabase/migrations/20260927170000_person_directory_outcomes.sql
if test -f supabase/migrations/20260927180000_person_directory_suppression.sql; then
 q -d $DB -1 -f supabase/migrations/20260927180000_person_directory_suppression.sql
fi
if test -f supabase/migrations/20260927190000_person_directory_readmission.sql; then
 q -d $DB -1 -f supabase/migrations/20260927190000_person_directory_readmission.sql
fi
if test -f supabase/migrations/20260927200000_person_directory_current.sql; then
 q -d $DB -1 -f supabase/migrations/20260927200000_person_directory_current.sql
fi
q -d $DB -1 -f supabase/migrations/20260927210000_person_refresh_lifecycle.sql
if test -f supabase/migrations/20260927220000_person_refresh_save.sql; then
 q -d $DB -1 -f supabase/migrations/20260927220000_person_refresh_save.sql
fi
q -d $DB -1 -f supabase/migrations/20260927230000_person_refresh_worker.sql
q -d $DB -1 -f supabase/migrations/20260928000000_person_recruiter_admission.sql
if test -f supabase/migrations/20260928010000_person_derivative_journal.sql; then
 q -d $DB -1 -f supabase/migrations/20260928010000_person_derivative_journal.sql
fi
if test -f supabase/migrations/20260928020000_person_derivative_lifecycle.sql; then
 q -d $DB -1 -f supabase/migrations/20260928020000_person_derivative_lifecycle.sql
fi
if test -f supabase/migrations/20260928030000_person_maintenance_window.sql; then
 q -d $DB -1 -f supabase/migrations/20260928030000_person_maintenance_window.sql
fi
if test -f supabase/migrations/20260928040000_person_application_edits.sql; then
 q -d $DB -1 -f supabase/migrations/20260928040000_person_application_edits.sql
fi
if test -f supabase/migrations/20260928050000_person_publish_admission.sql; then
 q -d $DB -1 -f supabase/migrations/20260928050000_person_publish_admission.sql
fi
if test -f supabase/migrations/20260928060000_person_application_contact.sql; then
 q -d $DB -1 -f supabase/migrations/20260928060000_person_application_contact.sql
fi
q -d $DB -1 -f supabase/migrations/20260928061000_person_resume_contact_fill.sql
q -d $DB -1 -f supabase/migrations/20260928070000_person_network_send.sql
q -d $DB -1 -f supabase/migrations/20260928080000_person_derivative_publish.sql
node scripts/build-worker-lib.mjs
npx --yes esbuild@0.28.2 scripts/person-application-enrichment/entry.ts --bundle --platform=node --external:pg --format=esm --alias:@="$PWD" --outfile=scripts/person-application-enrichment/dist/processing.mjs --log-level=warning
npx --yes esbuild@0.28.2 scripts/person-application-edits/contact-entry.ts --bundle --platform=node --external:pg --format=esm --alias:@="$PWD" --alias:next/server=./scripts/person-application-queue/next-fixture.ts --alias:pdf-parse/lib/pdf-parse.js=./scripts/person-application-edits/resume-parser-fixture.ts --outfile=scripts/person-application-edits/dist/contact.mjs --log-level=warning
LOCAL_DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/$DB" node --test --test-concurrency=1 scripts/person-application-edits/test-edits.mjs
node --test scripts/person-application-edits/test-contact-recipient.mjs
