#!/bin/bash
# Run the save_person tests on a LOCAL Postgres (never production).
#   scripts/person-trial/run-local-tests.sh <port> [host]
# Creates a fresh database "person_trial_test", applies the local mirror of
# the live schema, then migration 072 in one transaction (as a migration run
# does), applies it a second time to prove it is re-runnable, then runs the
# tests. Needs psql on PATH (or PSQL=/path/to/psql).
set -euo pipefail
PORT="${1:?usage: run-local-tests.sh <port> [host]}"
HOST="${2:-127.0.0.1}"
PSQL="${PSQL:-psql}"
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
export LC_ALL=C
q() { "$PSQL" -h "$HOST" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
q -d postgres -c "drop database if exists person_trial_test" -c "create database person_trial_test"
q -d person_trial_test -f "$DIR/local-schema.sql"
q -d person_trial_test -1 -f "$ROOT/supabase/migrations/072_person_tables.sql"
q -d person_trial_test -1 -f "$ROOT/supabase/migrations/072_person_tables.sql" 2>/dev/null
q -d person_trial_test -f "$DIR/test-save-person.sql"
