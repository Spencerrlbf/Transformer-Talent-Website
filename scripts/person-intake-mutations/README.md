# Prepared checked application intake mutations

`20260927052000_person_intake_mutations.sql` remains uninstalled. It follows the
prepared application ownership, normalization, audit proof and projection chain.
Claimed TT intake now uses checked database operations for candidate metadata,
receipt finalization and future preferences. The disabled legacy path is retained.

The binding operation opens a private minimal seed frame. Metadata comes from the
immutable receipt and first admission transaction: nonnegative integral experience
for a new person, fill-only resume, and an optional initial vector for matching
receipt and canonical text. Incumbent metadata survives later applications.
Same-operation replays must match the privately witnessed result. Actual returned
rows are checked before witnesses are recorded; suppressed updates fail closed.

Resume truncation matches the existing JavaScript 50,000 UTF-16-unit limit and
node-postgres encoding. Vector eligibility compares exact UTF-16 units, including
split surrogate boundaries, with both receipt and current candidate matching text.
The vector uses the actual candidate field type and requires 1,536 numeric values.
No provider work occurs inside these operations.

Candidate changes require exact private seed, metadata, preference or projection
frames while admission is required. Before and after row checks reject extra
fields or late trigger changes; service callers cannot open frames. TT receipt
fields require the exact finalization frame. Candidate DELETE/TRUNCATE is denied
under the documented guard/ACL rules. All mutations, attribution and evidence
roll back together on failure or lease expiry.

This is one prepared dependency, not the full release boundary. The later pipeline
workflow finalizer still needs a private completion witness. Public acceptance,
tenant result finalization, other source/derivative/conflict writes, the other
writer families, maintenance and complete canary/drain checks remain prerequisites.
Do not install or activate this partial chain in production.

```sh
PSQL=/path/to/psql bash scripts/person-intake-mutations/run-local-tests.sh LOCAL_PORT
```

The harness owns only the loopback `person_intake_mutations_test` database and
blocks outbound provider requests. Thirty tests cover actual new/existing intake,
both modes, replay, raw write protection, Unicode boundaries, vector validation,
private helper access, late trigger changes/suppression and rollback after lease
expiry or preference failure. A fixture reproduces the live username normalizer.
The broader projection harness uses private owner-only synthetic seed frames for
email competitors so its real unique-index race remains covered with guards on.
