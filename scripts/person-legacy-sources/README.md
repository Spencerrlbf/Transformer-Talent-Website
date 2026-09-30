# Legacy source boundary (prepared only)

`20260927100000_person_legacy_source_fence.sql` follows enrichment migration
`20260927090000`. It remains uninstalled; this is not a partial production release.

When normalization is required, the website's historical
`candidate_communications` rows refuse INSERT/UPDATE/DELETE regardless of status
or whether their candidate exists. These rows supply bounce/reply evidence to the
source reader and auditor. This does not touch the separate communications project.

Experience mutations require every present OLD/NEW row to remain `source=person`,
belong to TT, and match the existing private normalization frame's candidate.
BEFORE and AFTER checks prevent a later trigger changing that scope. Normalized
updates may advance a job's source ID; soft-removals retain their earlier source.
Existing raw Harvest rows remain intact. Both tables refuse TRUNCATE after the
prepared chain is installed. Row guards acquire no controller/work locks; existing
statement gates already take the controller before business locks.

Disabled, context-free legacy writes remain compatible, including the actual
`syncExperiences` upsert. Claimed TT applications use normalized jobs; tenant
applications never write pool experiences. Role/lookup reads and anonymous JD
parser telemetry continue to work.

Run the isolated synthetic fixture (resets only `person_legacy_sources_test`):

```sh
PSQL=/opt/homebrew/opt/postgresql@15/bin/psql bash scripts/person-legacy-sources/run-local-tests.sh 55487
```

Coverage includes owner/service raw mutations, orphan owners, OLD/NEW source and
ownership changes, capture rollback, real controller races in both lock orders,
stale snapshots, tenant completion while TT is held, TT populated-job creation,
update and replacement, retained provenance on removed jobs, late trigger changes,
the actual legacy upsert, and the preceding real TT intake/PDF/audit cases.

Shared lookup/conflict provenance, other writer admissions, derivative work,
maintenance compatibility and the whole release canary remain separate gates.
