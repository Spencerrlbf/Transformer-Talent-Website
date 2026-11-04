"""Parquet export of whole tables, written straight to the bucket (S3 API).

Env: PGURL, B2_BUCKET, EXPORT_PREFIX, EXPORT_TARGET, B2_S3_HOST (from the probe),
RCLONE_CONFIG_B2_ACCOUNT / RCLONE_CONFIG_B2_KEY (the same key rclone uses),
EXPORT_SCHEMAS (comma list, default "public"), EXPORT_TABLES (optional comma
list of schema.table to restrict to). Logs print table names, counts and bytes
only. Nothing from a row is ever printed.
"""
import json, os, sys, time
import duckdb

pgurl = os.environ["PGURL"]
bucket = os.environ["B2_BUCKET"]
prefix = os.environ["EXPORT_PREFIX"]
target = os.environ["EXPORT_TARGET"]
host = os.environ["B2_S3_HOST"]
schemas = [s for s in os.environ.get("EXPORT_SCHEMAS", "public").split(",") if s]
only = {t for t in os.environ.get("EXPORT_TABLES", "").split(",") if t}
region = host.split(".")[1] if host.count(".") >= 2 else "us-west-004"
base = f"s3://{bucket}/{prefix}/{target}/parquet"

con = duckdb.connect()
con.execute("INSTALL postgres; LOAD postgres; INSTALL httpfs; LOAD httpfs;")
con.execute("SET pg_connection_limit=4")
con.execute(
    "CREATE SECRET b2 (TYPE s3, KEY_ID $k, SECRET $s, ENDPOINT $e, REGION $r, URL_STYLE 'path')",
    {"k": os.environ["RCLONE_CONFIG_B2_ACCOUNT"], "s": os.environ["RCLONE_CONFIG_B2_KEY"], "e": host, "r": region},
)
con.execute("ATTACH $u AS pg (TYPE postgres, READ_ONLY)", {"u": pgurl})

rows = con.execute(
    "SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name='pg' AND schema_name IN (SELECT unnest($s)) ORDER BY 1,2",
    {"s": schemas},
).fetchall()
rows = [(s, t) for s, t in rows if not only or f"{s}.{t}" in only]
print(f"tables to export: {len(rows)} from schemas {','.join(schemas)}")

manifest = {"target": target, "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "tables": {}}
failed = []
for schema, table in rows:
    key = f"{schema}.{table}"
    out = f"{base}/{schema}/{table}.parquet"
    t0 = time.time()
    try:
        n = con.execute(f'COPY (SELECT * FROM pg."{schema}"."{table}") TO \'{out}\' (FORMAT parquet, COMPRESSION zstd)').fetchone()[0]
        manifest["tables"][key] = {"rows": int(n), "object": f"{schema}/{table}.parquet", "seconds": round(time.time() - t0, 1)}
        print(f"{key} rows={n} seconds={time.time() - t0:.0f}")
    except Exception as e:  # keep going; report at the end
        msg = str(e).splitlines()[0][:200]
        failed.append(key)
        manifest["tables"][key] = {"error": msg}
        print(f"{key} FAILED: {msg}")

manifest["finished"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
manifest["failed"] = failed
with open(os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"), "parquet-manifest.json"), "w") as f:
    json.dump(manifest, f, indent=1)
print(f"done: {len(rows) - len(failed)} ok, {len(failed)} failed")
sys.exit(1 if failed else 0)
