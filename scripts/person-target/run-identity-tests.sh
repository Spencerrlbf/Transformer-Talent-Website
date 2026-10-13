#!/bin/bash
# Local PostgreSQL only. Three databases in ONE cluster, so pg_control_system() reports
# one identifier for all of them: A labelled `local`, B labelled for a fictional other
# project, C never labelled. Proves the label (20261013090000) separates databases the
# identifier cannot, and that cross-project operations are refused before any write.
set -euo pipefail
node scripts/check-node.mjs >/dev/null   # supported runtime first
PORT="${1:?local port required}"
PSQL="${PSQL:-psql}"
[[ "$PORT" =~ ^[0-9]+$ ]] || exit 2
q(){ "$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
prepare(){
 q -d postgres -c "drop database if exists $1" -c "create database $1"
 q -d "$1" -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
 end \$\$;"
 q -d "$1" -c "create schema person_private; revoke all on schema person_private from public,anon,authenticated;"
 q -d "$1" -1 -f supabase/migrations/20261003090000_person_target_identity.sql
 q -d "$1" -1 -f supabase/migrations/20261013090000_person_target_label.sql
}
prepare person_identity_a_test
prepare person_identity_b_test
prepare person_identity_c_test
# The operator's explicit labelling statements (never inferred by the migration).
q -d person_identity_a_test -c "select person_private.target_label('local')"
q -d person_identity_b_test -c "select person_private.target_label('abcdefghijklmnopqrst')"
IDENTITY_DATABASE_A="postgresql://postgres@127.0.0.1:$PORT/person_identity_a_test" \
IDENTITY_DATABASE_B="postgresql://postgres@127.0.0.1:$PORT/person_identity_b_test" \
IDENTITY_DATABASE_C="postgresql://postgres@127.0.0.1:$PORT/person_identity_c_test" \
node --test --test-concurrency=1 scripts/person-target/test-identity-db.mjs
# The server gate's PostgreSQL proof with the production bundle (REST sealed). C is
# re-created: the library suite above labelled it as its last step.
prepare person_identity_c_test
npx --yes esbuild@0.28.2 scripts/person-target/server-entry.ts --bundle --platform=node --format=esm --external:pg --alias:@="$PWD" --outfile=scripts/person-target/dist/server.mjs --log-level=warning
IDENTITY_DATABASE_A="postgresql://postgres@127.0.0.1:$PORT/person_identity_a_test" \
IDENTITY_DATABASE_B="postgresql://postgres@127.0.0.1:$PORT/person_identity_b_test" \
IDENTITY_DATABASE_C="postgresql://postgres@127.0.0.1:$PORT/person_identity_c_test" \
node --test --test-concurrency=1 scripts/person-target/test-server-identity-db.mjs
