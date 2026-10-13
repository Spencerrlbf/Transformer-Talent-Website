#!/bin/bash
# Pre-release protection of Storage objects. Database backups (daily physical, PITR) do
# not include bucket objects, so before the production sitting every object of every
# bucket is listed and downloaded, with its path and size, into a private directory
# outside the repository. Read-only against the project; nothing is modified. The
# selected project must be named explicitly and must match the REST URL and key.
#
#   PERSON_TARGET_PROJECT_REF=<ref> SUPABASE_URL=https://<ref>.supabase.co \
#   SUPABASE_SERVICE_ROLE_KEY=… bash scripts/person-release/export-storage-objects.sh <private output dir>
set -euo pipefail
node scripts/check-node.mjs >/dev/null
OUT="${1:?private output directory required}"
node --input-type=module -e '
import fs from "node:fs"; import path from "node:path";
import {checkTargetEnvironment} from "./scripts/person-target.mjs";
const env=process.env; const t=checkTargetEnvironment(env,{restUrl:env.SUPABASE_URL,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY});
if(t.local)throw Error("hosted project required");
const out=process.argv[1]; fs.mkdirSync(out,{recursive:true,mode:0o700});
const H={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,"Content-Type":"application/json"};
const buckets=await (await fetch(`${env.SUPABASE_URL}/storage/v1/bucket`,{headers:H})).json();
const manifest=[]; let bytes=0;
for(const b of buckets){
  let offset=0;
  for(;;){
    const page=await (await fetch(`${env.SUPABASE_URL}/storage/v1/object/list/${b.id}`,{method:"POST",headers:H,body:JSON.stringify({prefix:"",limit:1000,offset,sortBy:{column:"name",order:"asc"}})})).json();
    if(!Array.isArray(page)||!page.length)break;
    for(const o of page){
      if(!o.id)continue; // folders
      const r=await fetch(`${env.SUPABASE_URL}/storage/v1/object/${b.id}/${encodeURI(o.name)}`,{headers:H});
      if(!r.ok)throw Error(`download ${b.id} ${r.status}`);
      const buf=Buffer.from(await r.arrayBuffer()); const dest=path.join(out,b.id,o.name); fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700}); fs.writeFileSync(dest,buf,{mode:0o600});
      manifest.push({bucket:b.id,name:o.name,bytes:buf.length,updated_at:o.updated_at}); bytes+=buf.length;
    }
    offset+=page.length; if(page.length<1000)break;
  }
}
fs.writeFileSync(path.join(out,"manifest.json"),JSON.stringify({project:t.ref,exported_at:new Date().toISOString(),objects:manifest.length,bytes,manifest},null,1),{mode:0o600});
console.log(JSON.stringify({project:t.ref,buckets:buckets.map(b=>b.id),objects:manifest.length,bytes}));
' "$OUT"
