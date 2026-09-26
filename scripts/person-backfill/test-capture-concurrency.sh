#!/bin/bash
# Synthetic rows only; use the task-owned local backfill test database.
set -euo pipefail
PORT="${1:?local port required}"
PSQL="${PSQL:-psql}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
q(){ "$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -d person_backfill_test -v ON_ERROR_STOP=1 -q "$@"; }
CID=c0000000-0000-4000-8000-000000000099
q -c "insert into candidates(id,linkedin_username,full_name) values('$CID','capture-race','Synthetic Capture Race') on conflict(id) do nothing"
q >"$WORK/a.log" 2>&1 <<EOF_A &
\set VERBOSITY verbose
begin;
select 1 from candidates where id='$CID' for update;
select pg_sleep(1);
update candidates set current_title='Concurrent Edit' where id='$CID';
commit;
EOF_A
A=$!
sleep 0.2
q >"$WORK/b.log" 2>&1 <<EOF_B &
\set VERBOSITY verbose
begin;
insert into website_applications(candidate_id,organization_id,name,email) values('$CID','801865a7-6533-41d2-9c45-e4a90e6ad51a','Synthetic Apply Race','race@example.com');
commit;
EOF_B
B=$!
FAIL=0
wait "$A" || FAIL=1
wait "$B" || FAIL=1
if [ "$FAIL" -ne 0 ]; then
 if rg -q 40P01 "$WORK"; then echo 'FAIL capture creates a deadlock between candidate edit and application save'; else echo 'FAIL capture concurrency operation'; fi
 exit 1
fi
q -c "do \$\$ begin assert (select count(*) from person_change_events where candidate_id='$CID')>=3,'both writes captured'; end \$\$"
echo 'PASS candidate lock plus concurrent TT application save: no deadlock and both changes captured'
