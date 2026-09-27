# Prepared conflict evidence boundary

Migration `20260927110000_person_conflict_evidence.sql` follows the prepared
legacy-source boundary. It is not installed in production. Installation and
activation remain part of the approved release, after all writer families and
maintenance have admission coverage.

Required mode rejects direct conflict insertion, resolution and deletion, even
inside an otherwise valid normalization operation. The existing writer and
company/school resolvers use a private insertion helper with an exact per-row
frame. Candidate/source proof comes from the active normalized document. Checked
application projection can record only its singleton legacy-email collision.
Statement gates take the controller lock before business locks; row checks take
no new controller/work locks. The outer operation still rechecks its lease.

The helper verifies the actual inserted row. A suppressed insertion fails unless
an existing open kind/hash proves genuine dedup. SETOF preserves INSERT's FOUND
semantics: one new row, zero duplicates. Global company/school conflict keys may
already belong to another candidate/source; their retained evidence is preserved.
Disabled legacy writes and the historical missing-employer RPC remain compatible.
Missing-employer writes in required mode need later maintenance admission. Truncate
is refused after installation. No conflicts are automatically resolved or removed.

Run only against the owned loopback fixture (the script resets that database):

```sh
PSQL=/opt/homebrew/opt/postgresql@15/bin/psql \
  bash scripts/person-conflict-evidence/run-local-tests.sh 55487
```

The full prepared chain passes 12 boundary/concurrency checks, 41 TT intake,
PDF, proof and collision checks, and 48 legacy writer assertions. Tests cover
owner/service denial; private ACLs; partial credentials; both controller lock
orders; shared-email evidence; raw writes inside normalization; public/private
trigger suppression or alteration; context clearing and lease expiry; real
unique-index contention; collision profile/history hashes; source ownership;
company/school dedup re-entering the resolver with a different candidate and
source; preserved conflict counters; and disabled writer compatibility.

Shared lookup mutation provenance, other writer admission, derivatives,
maintenance and full release canaries remain separate prerequisites.
