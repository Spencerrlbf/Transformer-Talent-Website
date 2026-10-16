# Copy `qsqlgibgsxzlimoegcjx`: evidence exported before retirement (2026-10-15 16:28 UTC)

Read-only export of the rehearsal's run tables and controller history, taken immediately before
the copy's deletion (package section 6, step 1). The CSV files hold candidate ids, statuses,
reasons, counts and timestamps only (no names, contacts or payloads) and live outside version
control in `output/copy-rehearsal-evidence-2026-10-15/` on the operator machine (35 MB).

| File | Rows | Content |
|---|---|---|
| `backfill_runs.csv` | 24 | every catch-up/backfill run with status, cursor and notes (fingerprints, counts) |
| `person_reconcile_people_rehearsal_runs.csv` | 8,209 | per-person outcomes of the `rehearsal-*` catch-up runs |
| `person_publish_runs.csv` | 9 | publication and undo runs with counts |
| `person_publish_results.csv` | 170,191 | per-person publication outcomes (status, revision, history id, changed fields) |
| `person_postcutover_audit_runs.csv` | 4 | audit runs and notes |
| `person_postcutover_audit_results.csv` | 68,640 | per-person audit outcomes (status, reason) of `rehearsal-audit-20261014` |
| `transition_events.csv` | 46 | every controller change with revision, generation and reason code |
| `maintenance_events.csv` | 36 | every maintenance window opened and closed |
| `schema_migrations_digests.csv` | 160 | recorded versions with statement digests |
| `leaktest_people_state.csv` | 10 | the synthetic pool people (derived rows, pending) |
| `storage_inventory.csv` | 3 | objects and bytes per bucket |
| `summary.txt` | 1 | size 43,685,538,963 bytes; 423,062 candidates; 423,061 profile states; 160,111 projection states; 422,788 anchors; 159,115 pending; 160 versions; controller armed/open revision 47 generation 35; label `qsqlgibgsxzlimoegcjx` |

The ledger (`RELEASE_REMEDIATION.md` sections 10–15) and the package already carry every
measurement these files support; the files are the raw record.
