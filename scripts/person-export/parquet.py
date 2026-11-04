"""Parquet export of whole tables: each table is written to the runner's disk,
uploaded with rclone (B2 native API) and removed before the next one.

Env: PGURL, B2_BUCKET, EXPORT_PREFIX, EXPORT_TARGET, EXPORT_SCHEMAS (comma
list, default "public"), EXPORT_TABLES (optional comma list of schema.table).
Logs print table names, counts, bytes and seconds only; never a row.
"""
import json, os, shutil, subprocess, sys, time
import duckdb

pgurl = os.environ["PGURL"]
bucket = os.environ["B2_BUCKET"]; prefix = os.environ["EXPORT_PREFIX"]; target = os.environ["EXPORT_TARGET"]
schemas = [s for s in os.environ.get("EXPORT_SCHEMAS", "public").split(",") if s]
only = {t for t in os.environ.get("EXPORT_TABLES", "").split(",") if t}
dest = f"b2:{bucket}/{prefix}/{target}/parquet"
work = os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"), "person-export", "parquet")
os.makedirs(work, exist_ok=True)

con = duckdb.connect()
con.execute("INSTALL postgres; LOAD postgres;")
con.execute("SET pg_connection_limit=4")
con.execute("ATTACH $u AS pg (TYPE postgres, READ_ONLY)", {"u": pgurl})

rows = con.execute(
    "SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name='pg' AND schema_name IN (SELECT unnest($s)) ORDER BY 1,2",
    {"s": schemas},
).fetchall()
rows = [(s, t) for s, t in rows if not only or f"{s}.{t}" in only]
print(f"tables to export: {len(rows)} from schemas {','.join(schemas)}; free disk {shutil.disk_usage(work).free // 2**30} GiB")

manifest = {"target": target, "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "tables": {}}
failed = []
for schema, table in rows:
    key = f"{schema}.{table}"
    local = os.path.join(work, f"{schema}.{table}.parquet")
    t0 = time.time()
    try:
        n = con.execute(f'COPY (SELECT * FROM pg."{schema}"."{table}") TO \'{local}\' (FORMAT parquet, COMPRESSION zstd)').fetchone()[0]
        size = os.path.getsize(local)
        subprocess.run(["rclone", "copyto", "--retries", "5", local, f"{dest}/{schema}/{table}.parquet"], check=True)
        manifest["tables"][key] = {"rows": int(n), "bytes": size, "object": f"{schema}/{table}.parquet", "seconds": round(time.time() - t0, 1)}
        print(f"{key} rows={n} bytes={size} seconds={time.time() - t0:.0f}")
    except Exception as e:
        msg = str(e).splitlines()[0][:200]
        failed.append(key); manifest["tables"][key] = {"error": msg}
        print(f"{key} FAILED: {msg}")
    finally:
        if os.path.exists(local):
            os.remove(local)

manifest["finished"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
manifest["failed"] = failed
manifest["total_bytes"] = sum(v.get("bytes", 0) for v in manifest["tables"].values())
with open(os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"), "parquet-manifest.json"), "w") as f:
    json.dump(manifest, f, indent=1)
print(f"done: {len(rows) - len(failed)} ok, {len(failed)} failed, {manifest['total_bytes']} bytes stored")
sys.exit(1 if failed else 0)
