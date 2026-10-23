#!/bin/bash
# The production catch-up combination (pinned runner, REST website, pg directory) on
# the disposable local Supabase stack. Needs the stack running with the full chain
# (scripts/tenancy/DISPOSABLE.md), a loopback PostgreSQL port for the synthetic
# directory database, and a clean pinned checkout:
#   SUPABASE_URL=http://127.0.0.1:<api> SUPABASE_SERVICE_ROLE_KEY=… WEBSITE_DATABASE_URL=<stack pg> \
#   PINNED_RUNNER_DIR=<c4d0e4e checkout> bash scripts/person-maintenance/run-catchup-local-tests.sh <comms pg port>
set -euo pipefail
node scripts/check-node.mjs >/dev/null   # supported runtime, before any fixture DDL
PORT="${1:?local port for the synthetic directory database required}"
PSQL="${PSQL:-psql}"
[[ "$PORT" =~ ^[0-9]+$ ]] || exit 2
: "${SUPABASE_URL:?}" "${SUPABASE_SERVICE_ROLE_KEY:?}" "${WEBSITE_DATABASE_URL:?}" "${PINNED_RUNNER_DIR:?}"
DB=person_catchup_comms_test
q(){ "$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
q -d postgres -c "drop database if exists $DB" -c "create database $DB"
COMMS_DATABASE_URL="postgresql://postgres@127.0.0.1:$PORT/$DB" node --test --test-concurrency=1 scripts/person-maintenance/test-run-catchup.mjs
