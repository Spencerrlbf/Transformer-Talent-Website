#!/bin/bash
set -euo pipefail
PORT="${1:?loopback port required}"
PSQL="${PSQL:-psql}"
[[ "$PORT" =~ ^[0-9]+$ ]] || exit 2
DB=person_application_work_test
q(){ "$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
q -d postgres -c "drop database if exists $DB" -c "create database $DB"
q -d $DB -f scripts/person-trial/local-schema.sql
q -d $DB -f scripts/person-trial/local-site-extras.sql
q -d $DB -c "alter table organizations add column daily_review_limit integer not null default 300;create table rate_limit_events(id bigint generated always as identity primary key,bucket text not null,created_at timestamptz not null default now());create index on rate_limit_events(bucket,created_at);insert into organizations(id,slug) values('cf000000-0000-4000-8000-000000000001','synthetic-work-tenant')"
q -d $DB -1 -f supabase/migrations/20260926235140_person_transition_foundation.sql
q -d $DB -1 -f supabase/migrations/20260927001258_person_application_work.sql
LOCAL_DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/$DB" node --test --test-concurrency=1 scripts/person-application-work/test-application-work.mjs
