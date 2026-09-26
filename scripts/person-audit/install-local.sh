#!/bin/bash
# Add missing audit prerequisites to a caller-owned local test database only.
set -euo pipefail
PORT="${1:?local port required}"
DB="${2:?local test database required}"
case "$DB" in person_publish_test|person_atomic_test|person_intake_test|person_refresh_test|person_directory_test|person_recruiter_test|person_published_test|person_derivative_test|person_audit_test) ;; *) exit 2;; esac
PSQL="${PSQL:-psql}"
q(){ "$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q "$@"; }
while read -r relation migration;do
 if test "$(q -Atc "select to_regclass('public.$relation') is null")" = t;then
  q -1 -f "supabase/migrations/$migration.sql"
 fi
done <<'LIST'
person_reconcile_people 20260926042200_person_reconcile
person_source_holds 20260926050355_person_source_date_holds
person_application_receipts 20260926044800_person_application_intake
person_directory_receipts 20260926061600_person_directory_intake
person_recruiter_receipts 20260926065300_person_recruiter_contacts
person_refresh_attempts 20260926054500_person_refresh_intake
person_audit_operations 20260926074407_person_audit_evidence
person_publish_runs 20260926183000_person_publish_runbook
LIST
if test "$(q -Atc "select to_regprocedure('public.person_audit_anchor_inputs(jsonb)') is null")" = t;then
 q -1 -f supabase/migrations/20260926080238_person_audit_anchor_preparation.sql
fi
if test "$(q -Atc "select to_regprocedure('person_private.audit_candidate_hash(jsonb)') is null")" = t;then
 q -1 -f supabase/migrations/20260926082012_person_audit_writer_guards.sql
fi
