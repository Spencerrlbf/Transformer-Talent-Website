#!/bin/bash
# Only the root-owned synthetic loopback database is reset.
set -euo pipefail
PORT="${1:?loopback port required}"
PSQL="${PSQL:-psql}"
[[ "$PORT" =~ ^[0-9]+$ ]] || exit 2
DB=person_application_queue_test
q(){ "$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
q -d postgres -c "drop database if exists $DB" -c "create database $DB"
q -d $DB -f scripts/person-trial/local-schema.sql
q -d $DB -f scripts/person-trial/local-site-extras.sql
q -d $DB -c "alter table organizations add column daily_review_limit integer not null default 300;create table rate_limit_events(id bigint generated always as identity primary key,bucket text not null,created_at timestamptz not null default now());create index on rate_limit_events(bucket,created_at);insert into organizations(id,slug) values('cf000000-0000-4000-8000-000000000001','synthetic-queue-tenant')"
# Minimal receipt relation for lifecycle-only SQL; full writer/receipt integration
# is separately exercised on the complete prepared migration chain.
q -d $DB -c "create table person_application_receipts(application_id uuid primary key,candidate_id uuid not null)"
q -d $DB -1 -f supabase/migrations/20260926235140_person_transition_foundation.sql
q -d $DB -1 -f supabase/migrations/20260927001258_person_application_work.sql
q -d $DB -1 -f supabase/migrations/20260927004931_person_application_queue.sql
LOCAL_DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/$DB" node --test --test-concurrency=1 scripts/person-application-queue/test-lifecycle.mjs
node scripts/build-worker-lib.mjs
npx --yes esbuild@0.28.2 scripts/person-application-queue/routes-entry.ts --bundle --platform=node --external:pg --format=esm --alias:@="$PWD" --alias:next/server=./scripts/person-application-queue/next-fixture.ts --outfile=scripts/person-application-queue/dist/routes.mjs --log-level=warning
node --test scripts/person-application-queue/test-pipeline-admission.mjs scripts/person-application-queue/test-acceptance.mjs
