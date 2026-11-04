"""Downloads every stored Parquet file in turn, counts its rows and compares
with the export manifest and the probe's live counts. Names and numbers only."""
import json, os, subprocess, sys
import duckdb

bucket = os.environ["B2_BUCKET"]; prefix = os.environ["EXPORT_PREFIX"]; target = os.environ["EXPORT_TARGET"]
dest = f"b2:{bucket}/{prefix}/{target}"
work = os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"), "person-export", "verify"); os.makedirs(work, exist_ok=True)
manifest = json.loads(subprocess.check_output(["rclone", "cat", f"{dest}/parquet-manifest.json"]))
try:
    live = json.loads(subprocess.check_output(["rclone", "cat", f"{dest}/probe/counts.json"]))
except subprocess.CalledProcessError:
    live = {}
con = duckdb.connect()
bad = 0
for key, info in sorted(manifest["tables"].items()):
    if "error" in info:
        print(f"{key} skipped (export failed)"); bad += 1; continue
    n = 0; size = 0
    for obj in info.get("parts", [info["object"]]):
        local = os.path.join(work, "t.parquet")
        subprocess.run(["rclone", "copyto", "--retries", "5", f"{dest}/parquet/{obj}", local], check=True)
        n += con.execute("SELECT count(*) FROM read_parquet($p)", {"p": local}).fetchone()[0]
        size += os.path.getsize(local); os.remove(local)
    ok = n == info["rows"] and size == info["bytes"]
    l = live.get(key)
    print(f"{key} parquet={n} manifest={info['rows']} bytes_match={size == info['bytes']} live_at_probe={l if l is not None else 'n/a'} {'OK' if ok else 'MISMATCH'}")
    bad += 0 if ok else 1
print(f"files checked={len(manifest['tables'])} problems={bad}")
sys.exit(1 if bad else 0)
