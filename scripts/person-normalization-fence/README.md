# Prepared normalization write boundary

`20260927023000_person_normalization_fence.sql` is prepared only. Do not install
or activate this partial writer chain in production. It preserves the existing
`save_person`/resolver signatures and core bodies while requiring claimed
application work to execute the exact document in its immutable receipt.

A private backend/transaction frame exists only inside the checked save call.
Service callers cannot open one, call the private cores, or obtain authority by
supplying a candidate ID, source ID or work token. Lease validation also applies
to unchanged replays and runs again after the core returns. Successful and failed
calls clear the frame before returning.

Statement gates take the controller lock before target row locks, including while
enforcement is disabled. Row guards check both old and new candidate ownership.
The protected tables are candidate sources, profile state, identities, education,
skills and contacts; experiences when either old or new `source` is `person`;
and shared companies, schools and skills. Shared lookup changes use the unchanged
resolver semantics within the admitted save. Direct mutator calls and table
TRUNCATE privileges are denied. With enforcement off and no work context, legacy
DML/save behavior remains available. A partial or malformed work context never
falls back to legacy permission.

This does not fence candidates, external source rows, `identity_conflicts`,
projection/audit proof rows, derivatives or other writer families. Those require
their own checked boundaries before activation. In particular, the legacy email
collision record is written during projection, outside this normalization frame;
it needs projection authorization, not a conflict-kind exemption.

Run the full prepared chain on a disposable loopback PostgreSQL database:

```sh
PSQL=/path/to/psql bash scripts/person-normalization-fence/run-local-tests.sh LOCAL_PORT
```

The harness resets only `person_normalization_fence_test`. Its 24 tests exercise
the actual claimed intake service and PostgreSQL guards, including raw DML,
resolver/core ACLs, changed receipt documents, token-only contexts, both experience
discriminator transitions, controller lock contention, successful and failed
frame cleanup, and concurrent school/skill resolution. External provider calls
are synthetic. Compatibility was also checked with 32 claimed-intake/ownership,
125 legacy intake/directory/refresh/recruiter, 85 audit and 15 canary tests, plus
the production build, against the full prepared migration chain.
