# Prepared shared lookup mutation boundary

Migration `20260927120000_person_lookup_mutations.sql` follows the conflict
boundary and is not installed in production. Other writer families, derivatives,
maintenance and complete canaries remain prerequisites for activation.

Normalization previously admitted arbitrary company, school and skill DML while
its outer frame was open. The prepared writer now calls private resolvers only
at the existing winning-source loop sites. Public resolver calls are refused in
required mode; disabled legacy calls retain their behavior. No receipt-wide
allowlist authorizes skipped or losing source entries.

Each actual insert/update has an exact relation, operation, target, OLD/NEW row
and one-use BEFORE/AFTER proof. Helpers verify RETURNING and persisted state,
then remove the private frame. Raw inserts, updates and deletes cannot borrow a
normalization frame. Truncate is refused. This assumes trusted database function
and trigger definitions; it does not claim protection against owner DDL.

Resolver matching, conflicts, IDs, defaults and timestamps are preserved. Company
identity/tier fills remain restricted by the existing writer-owned branches;
preexisting nonwriter companies stay unchanged. Schools retain their existing
missing-tier fill even on nonwriter rows. Skill dedup retains the original name
and returns zero newly created keys. Zero insertion requires a real retained key.
Target reads use FOR NO KEY UPDATE so tier fills remain compatible with job and
education FK locks. Readback keeps typed primary-key predicates for index access.

Run only against the caller-owned loopback fixture (the script resets it):

```sh
PSQL=/opt/homebrew/opt/postgresql@15/bin/psql \
  bash scripts/person-lookup-mutations/run-local-tests.sh 55487
```

Full-chain verification: 12 conflict/controller checks, 81 TT/PDF/conflict/lookup
checks and 48 legacy writer assertions pass. Seventeen initial tests reproduced
the exposed mutation/resolver/alteration paths; separate company/school lock
regressions failed with FOR UPDATE and pass with FOR NO KEY UPDATE. Tests cover
all retained identity/tier fills, actual concurrent skill insertion, global
conflict dedup across candidates/sources, ignored losing/omitted legacy lists,
public/private suppression and alteration, late expiry, private ACLs, exact
cleanup and audit-neutral accepted facts. Local EXPLAIN verified primary-key
index conditions for UUID company/school and bigint skill readback.
