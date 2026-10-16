# Production upgrade package (`scripts/person-release`)

Tools for installing the release migrations on the one selected hosted database and for
protecting Storage objects before the sitting. Everything here reads the selection from
`PERSON_TARGET_PROJECT_REF` and checks every URL and key with the hardened validator
(`scripts/person-target.mjs`); nothing defaults to a project.

| File | Purpose |
|---|---|
| `production-upgrade-manifest.json` | Ordered list of the versions to install (file, SHA256, MD5, trimmed MD5), the three window versions production already recorded (`recorded_in_window`, with the digests observed there) and the rule the installer follows. Regenerate when a migration file changes. |
| `production-history-digests.json` | Per-row digests of production's 96-row `supabase_migrations.schema_migrations` (read-only, 2026-10-14) and the digest of the whole table; the resume proof checks an exported history against it. |
| `apply-upgrade.sh` | The installer. Per version one transaction holds the migration file and its history row (`statements` = the exact file bytes); an error or a lost connection before the commit leaves neither. Recorded versions are verified (trimmed-digest comparison) and skipped, never replayed; a body that differs stops the run (`history_mismatch`). The identity index `candidates_person_username_idx` is built `CONCURRENTLY` (autocommit) before `20260927170000` when absent. Destination: offline validator (selection, 5432 session endpoint, no option overrides) then the database-held label at run time. `--dry-run` prints the plan. Never `supabase db push`, never the label statement. |
| `test-apply-upgrade-resume.sh <port> <history csv>` | Isolated proof on a loopback database carrying production's history: fault before commit (error, lost connection) leaves nothing of that version; resume installs the rest; recorded bodies equal the files; tampered rows refuse; foreign selection refused; index built concurrently. |
| `export-storage-objects.mjs` / `.sh` | Recursive bucket listing (folders walked), independent `storage.objects` inventory over the 5432 endpoint, size and plain-eTag MD5 verification, SHA256/MD5 manifest, `--verify <dir>` re-hash. Any listing failure or difference stops the export. |
| `test-storage-export.mjs` | Offline tests of the export (nested folders, pagination, failures, inventory and hash mismatches, verify). |
| `hosted-runtime-check.sh` | Read-only check of the deployment's and the workers' Node runtime. |

```sh
# dry run, then install (production: both require the written approval in RELEASE_APPROVAL_PACKAGE.md)
PERSON_TARGET_PROJECT_REF=<ref> UPGRADE_DATABASE_URL='<5432 session url>' bash scripts/person-release/apply-upgrade.sh --dry-run
PERSON_TARGET_PROJECT_REF=<ref> UPGRADE_DATABASE_URL='<5432 session url>' bash scripts/person-release/apply-upgrade.sh
# the label is the operator's separate statement afterwards (runbook "Project label")
# Storage export before the sitting (read-only), then verification of the export
PERSON_TARGET_PROJECT_REF=<ref> SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=… STORAGE_DATABASE_URL='<5432 session url>' \
  bash scripts/person-release/export-storage-objects.sh <private dir>
bash scripts/person-release/export-storage-objects.sh --verify <private dir>
# proofs
node --test scripts/person-release/test-storage-export.mjs
PSQL=/opt/homebrew/opt/postgresql@15/bin/psql bash scripts/person-release/test-apply-upgrade-resume.sh <loopback port> <history-96.csv>
```

Exit codes of the installer: 2 usage/destination refused, 3 label mismatch, 4 file checksum
mismatch, 5 history mismatch or missing record, 6 identity index invalid. A row recorded
without a body (the copy's September 28 rehearsal recorded 52 versions that way) is counted
as `unverifiable_bodies` in the summary and verified by name only; production has none.
