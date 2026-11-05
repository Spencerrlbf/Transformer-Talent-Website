# Pause export

Exports a production database into the owner's private Backblaze B2 bucket so
the project can be paused without keeping a paid database running. Runs on
GitHub Actions (`.github/workflows/person-export.yml`), never on a laptop, and
reads only. Two shapes are produced under `<prefix>/<target>/`:

- `full.dump`: one custom-format `pg_dump` archive (zstd), for an exact restore
  into a fresh PostgreSQL 17 / Supabase project. Platform-owned schemas are
  excluded (see `common.sh`); `pg_restore --list` shows the contents and
  `--schema`/`--data-only` select what to restore. `full.dump.sha256` and
  `full.dump.manifest.json` sit beside it.
- `parquet/<schema>/<table>.parquet`: every table of the chosen schemas as a
  Parquet file, for querying with DuckDB without a database server
  (`SELECT ... FROM read_parquet('s3://.../table.parquet')`).
  `parquet-manifest.json` records row counts.

Order: `probe` (sizes, exact counts, schema-only dump, bucket round trip),
`dump`, `verify`, `parquet`, `parquet_verify`. Secrets: `B2_KEY_ID`,
`B2_APPLICATION_KEY` (bucket-scoped key), and the existing database URLs.
Logs are public: names of schemas and tables, counts, bytes and hashes only.

## files

`mode=files` copies the Supabase Storage buckets (resumes, photos, assets) to
`<prefix>/<target>/storage/<bucket>/<path>` and writes `storage-manifest.json`
(bucket, name, bytes, sha256 per file). The database dump holds only the file
list, not the bytes. Needs the project's Storage URL and service key; for a
target without those secrets the step lists count and size and exits 2.
