"""Copy the project's Supabase Storage files (resumes, photos, assets) to the
bucket. pg_dump saves only the file *list* (storage.objects); the bytes live in
object storage and must be fetched through the Storage API.

Env: PGURL (file list), B2_BUCKET, EXPORT_PREFIX, EXPORT_TARGET, and for the
download STORAGE_URL + STORAGE_KEY (the project's service key). Without a key
the script reports the count and size only, so the gap is visible for a
project whose key is not a repository secret.
Logs are public: counts, bytes and hashes only; never a file name or a key.
"""
import hashlib, json, os, subprocess, sys, time
from urllib.parse import quote
from urllib.request import Request, urlopen

bucket = os.environ["B2_BUCKET"]; prefix = os.environ["EXPORT_PREFIX"]; target = os.environ["EXPORT_TARGET"]
dest = f"b2:{bucket}/{prefix}/{target}/storage"
work = os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"), "person-export", "storage")
os.makedirs(work, exist_ok=True)
storage_url = os.environ.get("STORAGE_URL", "").rstrip("/")
storage_key = os.environ.get("STORAGE_KEY", "")

def run(args, **kw):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kw)

rows = json.loads(run(["psql", os.environ["PGURL"], "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", "-c",
    "select coalesce(json_agg(json_build_object('bucket', bucket_id, 'name', name, "
    "'size', coalesce((metadata->>'size')::bigint, 0))), '[]') from storage.objects where name is not null"]).stdout or "[]")
total = sum(r["size"] for r in rows)
per = {}
for r in rows:
    b = per.setdefault(r["bucket"], [0, 0]); b[0] += 1; b[1] += r["size"]
print(f"storage objects: {len(rows)} files, {total} bytes")
for b, (n, s) in sorted(per.items()):
    print(f"  bucket {b}: {n} files, {s} bytes")
if not rows:
    print("nothing to copy"); sys.exit(0)
if not (storage_url and storage_key):
    print("NO STORAGE KEY for this target: files listed but not copied"); sys.exit(2)

def download(r, path):
    url = f"{storage_url}/storage/v1/object/{quote(r['bucket'])}/{quote(r['name'])}"
    req = Request(url, headers={"Authorization": f"Bearer {storage_key}", "apikey": storage_key})
    for attempt in range(4):
        try:
            with urlopen(req, timeout=120) as resp, open(path, "wb") as f:
                h = hashlib.sha256(); n = 0
                while chunk := resp.read(1 << 20):
                    f.write(chunk); h.update(chunk); n += len(chunk)
            return n, h.hexdigest()
        except Exception as e:  # noqa: BLE001
            msg = type(e).__name__ + (f" {getattr(e, 'code', '')}" if hasattr(e, "code") else "")
            if attempt == 3:
                return None, msg
            time.sleep(5 * (attempt + 1))

manifest = {"target": target, "files": [], "errors": 0}
copied = 0; copied_bytes = 0
for i, r in enumerate(rows, 1):
    local = os.path.join(work, f"obj-{i}")
    n, digest = download(r, local)
    if n is None:
        print(f"  file {i}/{len(rows)} FAILED download: {digest}")
        manifest["errors"] += 1; continue
    if r["size"] and n != r["size"]:
        print(f"  file {i}/{len(rows)} size mismatch: listed {r['size']} got {n}")
        manifest["errors"] += 1; os.remove(local); continue
    try:
        run(["rclone", "copyto", "--retries", "5", local, f"{dest}/{r['bucket']}/{r['name']}"])
    except subprocess.CalledProcessError as e:
        print(f"  file {i}/{len(rows)} FAILED upload: rc={e.returncode}")
        manifest["errors"] += 1; os.remove(local); continue
    os.remove(local)
    manifest["files"].append({"bucket": r["bucket"], "name": r["name"], "bytes": n, "sha256": digest})
    copied += 1; copied_bytes += n
print(f"copied {copied}/{len(rows)} files, {copied_bytes} bytes, {manifest['errors']} errors")

# Read the bucket listing back and compare path by path.
listed = json.loads(run(["rclone", "lsjson", "-R", "--files-only", dest]).stdout or "[]")
remote = {e["Path"]: e["Size"] for e in listed}
problems = 0
for f in manifest["files"]:
    key = f"{f['bucket']}/{f['name']}"
    if remote.get(key) != f["bytes"]:
        problems += 1
extra = len(set(remote) - {f"{f['bucket']}/{f['name']}" for f in manifest["files"]})
print(f"bucket check: {len(remote)} objects stored, {sum(remote.values())} bytes; "
      f"files checked={len(manifest['files'])} problems={problems} unexpected={extra}")

mpath = os.path.join(work, "storage-manifest.json")
with open(mpath, "w") as f:
    json.dump(manifest, f)
run(["rclone", "copyto", mpath, f"b2:{bucket}/{prefix}/{target}/storage-manifest.json"])
sys.exit(1 if (manifest["errors"] or problems) else 0)
