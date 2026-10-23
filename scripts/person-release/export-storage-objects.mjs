#!/usr/bin/env node
// Pre-release protection of Storage objects. Database backups (daily physical, PITR) do not
// include bucket objects, so before the production sitting every object of every bucket is
// listed (folders walked recursively), downloaded and verified into a private directory
// outside the repository. Read-only against the project.
//
// Verification: (1) the REST listing must equal the independent inventory read from
// storage.objects over the 5432 session endpoint (same bucket/name set, same sizes);
// (2) every downloaded body must have the listed size; (3) when the object's eTag is a plain
// MD5 (single-part upload) the body's MD5 must equal it, otherwise the object is counted
// `etag_unverifiable` (multipart) and still size-verified; (4) the manifest records SHA256
// and MD5 of every file so `--verify <dir>` can re-hash the export later. Any listing
// failure, inventory difference, size or hash mismatch stops the export with a non-zero exit.
// The selected project must be named explicitly and must match the REST URL, the key and
// the database URL (hardened validator). Object names never appear in logs, only counts;
// the private manifest carries them.
//
//   PERSON_TARGET_PROJECT_REF=<ref> SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=… \
//   STORAGE_DATABASE_URL='<5432 session url>' node scripts/person-release/export-storage-objects.mjs <private output dir>
//   node scripts/person-release/export-storage-objects.mjs --verify <private output dir>
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {checkTargetEnvironment} from '../person-target.mjs';

const PAGE=1000;
const md5=(buf)=>createHash('md5').update(buf).digest('hex');
const sha256=(buf)=>createHash('sha256').update(buf).digest('hex');
const fail=(code,detail)=>Object.assign(Error(detail?`${code}:${detail}`:code),{code});
/** A stored object name must stay inside the bucket directory on disk. */
export function safeObjectPath(name){
 if(typeof name!=='string'||!name||name.startsWith('/')||name.includes('\0'))throw fail('storage_object_name');
 const parts=name.split('/');
 if(parts.some(p=>p===''||p==='.'||p==='..'))throw fail('storage_object_name');
 return parts.join(path.sep);
}
/** Every object of a bucket through the REST listing, folders walked recursively, pages of
 * 1000 by name. A non-2xx listing or a non-array body stops the export. */
export async function listBucket({fetchFn,base,headers,bucket}){
 const out=[];
 async function walk(prefix){
  for(let offset=0;;){
   const res=await fetchFn(`${base}/storage/v1/object/list/${encodeURIComponent(bucket)}`,{method:'POST',headers,body:JSON.stringify({prefix,limit:PAGE,offset,sortBy:{column:'name',order:'asc'}})});
   if(!res.ok)throw fail('storage_list_failed',`${bucket}:${res.status}`);
   const page=await res.json();
   if(!Array.isArray(page))throw fail('storage_list_invalid',bucket);
   offset+=page.length;
   for(const o of page){
    if(typeof o?.name!=='string'||!o.name)throw fail('storage_list_invalid',bucket);
    const name=prefix?`${prefix}/${o.name}`:o.name;
    if(o.id)out.push({bucket,name,size:o.metadata?.size===undefined?null:Number(o.metadata.size),etag:o.metadata?.eTag??null,updated_at:o.updated_at??null});
    else await walk(name); // a folder entry (no id): descend
   }
   // Stop only on an empty page: a server that returns short pages must not truncate the walk.
   if(!page.length)break;
  }
 }
 await walk('');
 return out.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
}
/** The independent inventory: storage.objects as the database holds it. */
export async function databaseInventory(db,buckets){
 const rows=(await db.query("select bucket_id bucket,name,(metadata->>'size')::bigint size from storage.objects where bucket_id=any($1::text[]) order by 1,2",[buckets])).rows;
 return rows.map(r=>({bucket:r.bucket,name:r.name,size:r.size===null?null:Number(r.size)}));
}
/** Same set of bucket/name pairs with the same sizes; differences are counted, never named. */
export function compareInventories(listed,inventory){
 const key=(o)=>`${o.bucket}\u0000${o.name}`;
 const a=new Map(listed.map(o=>[key(o),o])),b=new Map(inventory.map(o=>[key(o),o]));
 let missing_from_listing=0,missing_from_database=0,size_differs=0;
 for(const [k,o] of b)if(!a.has(k))missing_from_listing++;else if(a.get(k).size!==null&&o.size!==null&&a.get(k).size!==o.size)size_differs++;
 for(const k of a.keys())if(!b.has(k))missing_from_database++;
 const same=!missing_from_listing&&!missing_from_database&&!size_differs;
 return {same,listed:a.size,database:b.size,missing_from_listing,missing_from_database,size_differs};
}
export async function exportObjects({env=process.env,fetchFn=globalThis.fetch,db,out,log=(x)=>console.log(JSON.stringify(x)),now=()=>new Date()}){
 const t=checkTargetEnvironment(env,{restUrl:env.SUPABASE_URL,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY,databaseUrls:[env.STORAGE_DATABASE_URL],ports:['5432']});
 if(t.local&&!env.STORAGE_EXPORT_ALLOW_LOCAL)throw fail('storage_export_hosted_required');
 if(!env.STORAGE_DATABASE_URL)throw fail('storage_export_database_required');
 const base=env.SUPABASE_URL.replace(/\/+$/,'');
 const headers={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json'};
 fs.mkdirSync(out,{recursive:true,mode:0o700});
 const bres=await fetchFn(`${base}/storage/v1/bucket`,{headers});
 if(!bres.ok)throw fail('storage_bucket_list_failed',String(bres.status));
 const buckets=await bres.json();
 if(!Array.isArray(buckets)||buckets.some(b=>typeof b?.id!=='string'))throw fail('storage_bucket_list_invalid');
 const ids=buckets.map(b=>b.id).sort();
 const listed=[];for(const bucket of ids)listed.push(...await listBucket({fetchFn,base,headers,bucket}));
 const inventory=await databaseInventory(db,ids);
 const comparison=compareInventories(listed,inventory);
 log({phase:'storage_inventory',project:t.ref,buckets:ids,...comparison});
 if(!comparison.same)throw fail('storage_inventory_mismatch',`${comparison.missing_from_listing}:${comparison.missing_from_database}:${comparison.size_differs}`);
 const manifest=[];let bytes=0,md5Verified=0,etagUnverifiable=0;
 for(const o of listed){
  const r=await fetchFn(`${base}/storage/v1/object/${encodeURIComponent(o.bucket)}/${o.name.split('/').map(encodeURIComponent).join('/')}`,{headers});
  if(!r.ok)throw fail('storage_download_failed',`${o.bucket}:${r.status}`);
  const buf=Buffer.from(await r.arrayBuffer());
  if(o.size!==null&&buf.length!==o.size)throw fail('storage_size_mismatch',o.bucket);
  const bodyMd5=md5(buf);
  const plainEtag=typeof o.etag==='string'?/^"?([0-9a-f]{32})"?$/i.exec(o.etag):null;
  let etagVerified=false;
  if(plainEtag){if(plainEtag[1].toLowerCase()!==bodyMd5)throw fail('storage_hash_mismatch',o.bucket);etagVerified=true;md5Verified++;}
  else etagUnverifiable++;
  const dest=path.join(out,o.bucket,safeObjectPath(o.name));
  if(!path.resolve(dest).startsWith(path.resolve(out)+path.sep))throw fail('storage_object_name');
  fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});
  fs.writeFileSync(dest,buf,{mode:0o600});
  manifest.push({bucket:o.bucket,name:o.name,bytes:buf.length,sha256:sha256(buf),md5:bodyMd5,etag:o.etag,etag_verified:etagVerified,updated_at:o.updated_at});
  bytes+=buf.length;
 }
 const summary={project:t.ref,exported_at:now().toISOString(),buckets:ids,objects:manifest.length,bytes,inventory:comparison,sizes_verified:manifest.length,md5_verified:md5Verified,etag_unverifiable:etagUnverifiable};
 fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({...summary,manifest},null,1),{mode:0o600});
 log({phase:'storage_export_complete',...summary});
 return summary;
}
/** Re-hash every exported file against the manifest. */
export function verifyExport(out,log=(x)=>console.log(JSON.stringify(x))){
 const m=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
 let ok=0,missing=0,mismatch=0;
 for(const o of m.manifest){
  const dest=path.join(out,o.bucket,safeObjectPath(o.name));
  if(!fs.existsSync(dest)){missing++;continue;}
  const buf=fs.readFileSync(dest);
  if(buf.length!==o.bytes||sha256(buf)!==o.sha256||md5(buf)!==o.md5)mismatch++;else ok++;
 }
 const result={phase:'storage_export_verified',project:m.project,objects:m.manifest.length,ok,missing,mismatch,complete:!missing&&!mismatch};
 log(result);return result;
}
/** The inventory connection. The export runs BEFORE the schema install (step 0 of the sitting),
 * when production has no identity function yet, so the installer's rule applies instead of
 * the operator pool's: the URL must pass the hardened validator; when the identity function
 * exists its label must equal the selection; an unlabelled database (pre-install) passes. */
export async function openStorageDatabase(env,{pgModule}={}){
 const pg=pgModule??(await import('pg')).default;
 const {databaseConfig}=await import('../person-publish/lib.mjs');
 const pool=new pg.Pool(databaseConfig({...env,PERSON_PUBLISH_DATABASE_URL:env.STORAGE_DATABASE_URL,LOCAL_DATABASE_URL:undefined},'tt-storage-export'));
 pool.on('error',()=>{});
 try{
  await checkStorageDatabaseLabel(pool,env);
  return pool;
 }catch(error){await pool.end();throw error;}
}
export async function checkStorageDatabaseLabel(db,env){
 const {selectedTarget}=await import('../person-target.mjs');
 const ref=selectedTarget(env).ref;
 const present=(await db.query("select to_regprocedure('public.person_target_identity()') is not null present")).rows[0].present;
 if(!present)return {label:null,checked:false};
 const label=(await db.query("select public.person_target_identity()->>'project_ref' label")).rows[0].label;
 if(label!==null&&label!==ref)throw fail('storage_export_label_mismatch');
 return {label,checked:true};
}
export async function main(argv=process.argv.slice(2),env=process.env){
 if(argv[0]==='--verify'){const r=verifyExport(argv[1]??fail('storage_export_dir'));if(!r.complete)process.exitCode=1;return r;}
 const out=argv[0];if(!out||argv.length!==1)throw fail('storage_export_dir');
 const db=await openStorageDatabase(env);
 try{return await exportObjects({env,db,out});}finally{await db.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(error=>{console.error(JSON.stringify({phase:'storage_export_stopped',reason:/^(storage_|person_target:)/.test(error?.message??'')?error.message:'operation_failed'}));process.exitCode=1;});
