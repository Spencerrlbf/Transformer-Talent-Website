"""Counts the rows in every stored Parquet file and compares with the manifest
and with the probe's live counts. Prints names and numbers only."""
import json, os, subprocess, sys
import duckdb

bucket = os.environ["B2_BUCKET"]; prefix = os.environ["EXPORT_PREFIX"]; target = os.environ["EXPORT_TARGET"]
host = os.environ["B2_S3_HOST"]; region = host.split(".")[1]
dest = f"b2:{bucket}/{prefix}/{target}"
manifest = json.loads(subprocess.check_output(["rclone", "cat", f"{dest}/parquet-manifest.json"]))
try:
    live = json.loads(subprocess.check_output(["rclone", "cat", f"{dest}/probe/counts.json"]))
except subprocess.CalledProcessError:
    live = {}
con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs;")
con.execute("CREATE SECRET b2 (TYPE s3, KEY_ID $k, SECRET $s, ENDPOINT $e, REGION $r, URL_STYLE 'path')",
            {"k": os.environ["RCLONE_CONFIG_B2_ACCOUNT"], "s": os.environ["RCLONE_CONFIG_B2_KEY"], "e": host, "r": region})
bad = 0
for key, info in sorted(manifest["tables"].items()):
    if "error" in info:
        print(f"{key} skipped (export failed)"); bad += 1; continue
    n = con.execute(f"SELECT count(*) FROM read_parquet('s3://{bucket}/{prefix}/{target}/parquet/{info['object']}')").fetchone()[0]
    l = live.get(key)
    ok = n == info["rows"]
    print(f"{key} parquet={n} manifest={info['rows']} live_at_probe={l if l is not None else 'n/a'} {'OK' if ok else 'MISMATCH'}")
    bad += 0 if ok else 1
print(f"files checked={len(manifest['tables'])} problems={bad}")
sys.exit(1 if bad else 0)
