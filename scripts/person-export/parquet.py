"""Parquet export of whole tables: each table is written to the runner's disk,
uploaded with rclone (B2 native API) and removed before the next one.
Tables above CHUNK_BYTES are exported in primary-key ranges (uuid: 16 parts by
first hex digit; integer keys: ranges of about CHUNK_BYTES) as part files, so
no single statement runs long enough for the pooled connection to be cut.
Every statement is retried up to three times.

Env: PGURL, B2_BUCKET, EXPORT_PREFIX, EXPORT_TARGET, EXPORT_SCHEMAS (comma
list, default "public"), EXPORT_TABLES (optional comma list of schema.table;
when set, the existing manifest in the bucket is kept and updated).
Logs print table names, counts, bytes and seconds only; never a row.
"""
import json, math, os, shutil, subprocess, sys, time
import duckdb

pgurl = os.environ["PGURL"]
bucket = os.environ["B2_BUCKET"]; prefix = os.environ["EXPORT_PREFIX"]; target = os.environ["EXPORT_TARGET"]
schemas = [s for s in os.environ.get("EXPORT_SCHEMAS", "public").split(",") if s]
only = {t for t in os.environ.get("EXPORT_TABLES", "").split(",") if t}
CHUNK_BYTES = int(os.environ.get("EXPORT_CHUNK_BYTES", str(3 * 2**30)))
dest = f"b2:{bucket}/{prefix}/{target}"
work = os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"), "person-export", "parquet")
os.makedirs(work, exist_ok=True)

con = duckdb.connect()
con.execute("INSTALL postgres; LOAD postgres;")
con.execute("SET pg_connection_limit=4")
con.execute("ATTACH $u AS pg (TYPE postgres, READ_ONLY)", {"u": pgurl})

def pgq(sql):
    return con.execute("SELECT * FROM postgres_query('pg', $q)", {"q": sql}).fetchall()

def lit(s):
    return s.replace("'", "''")

def pk_of(schema, table):
    r = pgq(f"""select a.attname, format_type(a.atttypid, a.atttypmod)
                from pg_index i join pg_class c on c.oid=i.indrelid
                join pg_namespace n on n.oid=c.relnamespace
                join pg_attribute a on a.attrelid=c.oid and a.attnum=any(i.indkey)
                where i.indisprimary and n.nspname='{lit(schema)}' and c.relname='{lit(table)}'
                and array_length(i.indkey,1)=1""")
    return r[0] if r else (None, None)

def ranges_for(schema, table, nbytes):
    """List of (label, where-clause) covering the whole table, or None."""
    col, typ = pk_of(schema, table)
    if not col:
        return None
    q = f'"{col}"'
    if typ == "uuid":
        hexd = "0123456789abcdef"
        out = []
        for i, h in enumerate(hexd):
            lo = f"'{h}0000000-0000-0000-0000-000000000000'::uuid"
            if i == 15:
                out.append((f"{h}", f"{q} >= {lo}"))
            else:
                hi = f"'{hexd[i+1]}0000000-0000-0000-0000-000000000000'::uuid"
                out.append((f"{h}", f"{q} >= {lo} and {q} < {hi}"))
        return out
    if typ in ("bigint", "integer", "smallint"):
        (lo, hi), = pgq(f'select min({q}), max({q}) from "{lit(schema)}"."{lit(table)}"')
        if lo is None:
            return None
        n = max(8, math.ceil(nbytes / CHUNK_BYTES * 4))
        step = max(1, math.ceil((hi - lo + 1) / n))
        out = []
        for i in range(n):
            a = lo + i * step
            if a > hi:
                break
            b = a + step
            out.append((f"{i:03d}", f"{q} >= {a} and {q} < {b}" if i < n - 1 else f"{q} >= {a}"))
        return out
    return None

def copy_with_retry(sql, local):
    last = None
    for attempt in range(1, 4):
        try:
            if os.path.exists(local):
                os.remove(local)
            return con.execute(f"COPY ({sql}) TO '{local}' (FORMAT parquet, COMPRESSION zstd)").fetchone()[0]
        except Exception as e:  # pooled connection cut, transient I/O
            last = e
            print(f"  attempt {attempt} failed: {str(e).splitlines()[0][:160]}")
            time.sleep(10 * attempt)
    raise last

def upload(local, name):
    subprocess.run(["rclone", "copyto", "--retries", "5", local, f"{dest}/parquet/{name}"], check=True)

rows = con.execute(
    "SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name='pg' AND schema_name IN (SELECT unnest($s)) ORDER BY 1,2",
    {"s": schemas},
).fetchall()
rows = [(s, t) for s, t in rows if not only or f"{s}.{t}" in only]
print(f"tables to export: {len(rows)} from schemas {','.join(schemas)}; free disk {shutil.disk_usage(work).free // 2**30} GiB; chunk above {CHUNK_BYTES} bytes")

manifest = {"target": target, "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "tables": {}}
if only:
    try:
        manifest = json.loads(subprocess.check_output(["rclone", "cat", f"{dest}/parquet-manifest.json"]))
        manifest["updated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        print(f"updating the existing manifest ({len(manifest['tables'])} tables)")
    except Exception:
        pass
failed = []
for schema, table in rows:
    key = f"{schema}.{table}"
    t0 = time.time()
    try:
        (nbytes,), = pgq(f"select pg_total_relation_size('\"{lit(schema)}\".\"{lit(table)}\"'::regclass)")
        parts = ranges_for(schema, table, nbytes) if nbytes > CHUNK_BYTES else None
        if parts:
            total_rows = total_bytes = 0; objects = []
            for label, where in parts:
                local = os.path.join(work, f"{schema}.{table}.{label}.parquet")
                sql = f"SELECT * FROM postgres_query('pg', 'select * from \"{lit(schema)}\".\"{lit(table)}\" where {lit(where)}')"
                n = copy_with_retry(sql, local)
                size = os.path.getsize(local)
                name = f"{schema}/{table}/part-{label}.parquet"
                upload(local, name); os.remove(local)
                objects.append(name); total_rows += int(n); total_bytes += size
                print(f"  {key} part {label} rows={n} bytes={size}")
            manifest["tables"][key] = {"rows": total_rows, "bytes": total_bytes, "object": f"{schema}/{table}/", "parts": objects, "seconds": round(time.time() - t0, 1)}
            print(f"{key} rows={total_rows} bytes={total_bytes} parts={len(objects)} seconds={time.time() - t0:.0f}")
        else:
            local = os.path.join(work, f"{schema}.{table}.parquet")
            n = copy_with_retry(f'SELECT * FROM pg."{schema}"."{table}"', local)
            size = os.path.getsize(local)
            upload(local, f"{schema}/{table}.parquet"); os.remove(local)
            manifest["tables"][key] = {"rows": int(n), "bytes": size, "object": f"{schema}/{table}.parquet", "seconds": round(time.time() - t0, 1)}
            print(f"{key} rows={n} bytes={size} seconds={time.time() - t0:.0f}")
    except Exception as e:
        msg = str(e).splitlines()[0][:200]
        failed.append(key); manifest["tables"][key] = {"error": msg}
        print(f"{key} FAILED: {msg}")
    finally:
        for f in os.listdir(work):
            os.remove(os.path.join(work, f))

manifest["finished"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
manifest["failed"] = [k for k, v in manifest["tables"].items() if "error" in v]
manifest["total_bytes"] = sum(v.get("bytes", 0) for v in manifest["tables"].values())
with open(os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"), "parquet-manifest.json"), "w") as f:
    json.dump(manifest, f, indent=1)
print(f"done: {len(rows) - len(failed)} ok, {len(failed)} failed this run; manifest {len(manifest['tables'])} tables, {len(manifest['failed'])} with errors, {manifest['total_bytes']} bytes stored")
sys.exit(1 if failed else 0)
