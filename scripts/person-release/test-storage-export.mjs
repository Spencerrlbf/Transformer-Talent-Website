// Offline proof of the Storage export: nested folders, pagination, listing failures,
// inventory differences, size and hash mismatches, and the on-disk verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {exportObjects,verifyExport,listBucket,compareInventories,safeObjectPath,checkStorageDatabaseLabel} from './export-storage-objects.mjs';

const REF='abcdefghijklmnopqrst';
const env={PERSON_TARGET_PROJECT_REF:REF,SUPABASE_URL:`https://${REF}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:'sb_secret_test',STORAGE_DATABASE_URL:`postgresql://postgres.${REF}:x@aws-0-us-east-2.pooler.supabase.com:5432/postgres`};
const md5=(s)=>createHash('md5').update(s).digest('hex');
const json=(body,status=200)=>({ok:status<300,status,json:async()=>body,arrayBuffer:async()=>Buffer.from(JSON.stringify(body))});
const bin=(buf,status=200)=>({ok:status<300,status,arrayBuffer:async()=>buf});
/** A fake Storage: objects keyed by bucket then full name; folders derived from names. */
function fakeStorage(objects,{pageSize=1000,etagOf=(buf)=>`"${md5(buf)}"`,failList=null,sizeOf=null}={}){
 const calls=[];
 const fetchFn=async(url,init={})=>{
  const u=new URL(url);calls.push(u.pathname);
  if(u.pathname==='/storage/v1/bucket')return json(Object.keys(objects).map(id=>({id,name:id})));
  let m=/^\/storage\/v1\/object\/list\/([^/]+)$/.exec(u.pathname);
  if(m){
   const bucket=decodeURIComponent(m[1]);const {prefix,limit,offset}=JSON.parse(init.body);
   if(failList&&failList(bucket,prefix))return json({error:'boom'},500);
   const names=Object.keys(objects[bucket]??{}).filter(n=>prefix?n.startsWith(prefix+'/'):true);
   const entries=new Map();
   for(const n of names){const rest=prefix?n.slice(prefix.length+1):n;const head=rest.split('/')[0];
    if(rest.includes('/'))entries.set(head,{name:head,id:null});
    else{const buf=objects[bucket][n];entries.set(head,{name:head,id:`id-${bucket}-${n}`,updated_at:'2026-10-14T00:00:00Z',metadata:{size:sizeOf?sizeOf(n,buf):buf.length,eTag:etagOf(buf,n)}});}}
   const all=[...entries.values()].sort((a,b)=>a.name<b.name?-1:1);
   return json(all.slice(offset,offset+Math.min(limit,pageSize)));
  }
  m=/^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(u.pathname);
  if(m){const bucket=decodeURIComponent(m[1]);const name=m[2].split('/').map(decodeURIComponent).join('/');const buf=objects[bucket]?.[name];return buf?bin(buf):bin(Buffer.alloc(0),404);}
  return json({},404);
 };
 const db={query:async(_sql,[buckets])=>({rows:buckets.flatMap(b=>Object.entries(objects[b]??{}).map(([name,buf])=>({bucket:b,name,size:String(buf.length)})))})};
 return {fetchFn,db,calls};
}
const objects={resumes:{'2026-08-14/a.pdf':Buffer.from('alpha'),'leaktest/run1/deep/er/file.txt':Buffer.from('deep file'),'top.txt':Buffer.from('top')},'company-assets':{'org/logo.png':Buffer.from('png bytes')}};
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'storage-export-'));

test('nested objects are listed through every folder level and across pages',async()=>{
 const {fetchFn}=fakeStorage(objects,{pageSize:1});
 const listed=await listBucket({fetchFn,base:env.SUPABASE_URL,headers:{},bucket:'resumes'});
 assert.deepEqual(listed.map(o=>o.name),['2026-08-14/a.pdf','leaktest/run1/deep/er/file.txt','top.txt']);
 assert.equal(listed[1].size,9);
});
test('a listing failure anywhere in the tree stops the export',async()=>{
 const {fetchFn,db}=fakeStorage(objects,{failList:(b,p)=>p==='leaktest/run1'});
 await assert.rejects(exportObjects({env,fetchFn,db,out:tmp(),log:()=>{}}),/storage_list_failed:resumes:500/);
});
test('the export downloads every object, verifies sizes and plain eTags and writes a hashed manifest; --verify re-hashes it',async()=>{
 const {fetchFn,db}=fakeStorage(objects);const out=tmp();const logs=[];
 const s=await exportObjects({env,fetchFn,db,out,log:(x)=>logs.push(x)});
 assert.equal(s.objects,4);assert.equal(s.bytes,5+9+3+9);assert.equal(s.md5_verified,4);assert.equal(s.etag_unverifiable,0);assert.equal(s.inventory.same,true);
 assert.equal(fs.readFileSync(path.join(out,'resumes','leaktest','run1','deep','er','file.txt'),'utf8'),'deep file');
 const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
 assert.equal(manifest.manifest.find(o=>o.name==='top.txt').md5,md5('top'));
 assert.ok(logs.every(l=>!JSON.stringify(l).includes('a.pdf')),'object names stay out of logs');
 assert.equal(verifyExport(out,()=>{}).complete,true);
 fs.writeFileSync(path.join(out,'resumes','top.txt'),'tampered');
 const v=verifyExport(out,()=>{});assert.equal(v.mismatch,1);assert.equal(v.complete,false);
});
test('multipart eTags are counted unverifiable, a wrong plain eTag or a short body stops the export',async()=>{
 const multi=fakeStorage(objects,{etagOf:(buf)=>`"${md5(buf)}-2"`});
 const s=await exportObjects({env,fetchFn:multi.fetchFn,db:multi.db,out:tmp(),log:()=>{}});
 assert.equal(s.etag_unverifiable,4);assert.equal(s.md5_verified,0);
 const wrong=fakeStorage(objects,{etagOf:()=>`"${'0'.repeat(32)}"`});
 await assert.rejects(exportObjects({env,fetchFn:wrong.fetchFn,db:wrong.db,out:tmp(),log:()=>{}}),/storage_hash_mismatch/);
 const short=fakeStorage(objects,{sizeOf:(n,buf)=>buf.length+1});
 // the database inventory carries the true size, so this is caught as an inventory difference first
 await assert.rejects(exportObjects({env,fetchFn:short.fetchFn,db:short.db,out:tmp(),log:()=>{}}),/storage_inventory_mismatch/);
});
test('an object the database knows but the listing lacks (or the reverse) refuses the export',async()=>{
 const {fetchFn}=fakeStorage(objects);
 const extra={query:async(_s,[buckets])=>({rows:[...(await fakeStorage(objects).db.query('',[buckets])).rows,{bucket:'resumes',name:'ghost.pdf',size:'1'}]})};
 await assert.rejects(exportObjects({env,fetchFn,db:extra,out:tmp(),log:()=>{}}),/storage_inventory_mismatch:1:0:0/);
 const fewer={query:async()=>({rows:[]})};
 await assert.rejects(exportObjects({env,fetchFn,db:fewer,out:tmp(),log:()=>{}}),/storage_inventory_mismatch:0:4:0/);
 assert.deepEqual(compareInventories([{bucket:'b',name:'x',size:1}],[{bucket:'b',name:'x',size:2}]).size_differs,1);
});
test('the destination must be the selected project on the 5432 session endpoint; object names cannot escape the directory',async()=>{
 const {fetchFn,db}=fakeStorage(objects);
 await assert.rejects(exportObjects({env:{...env,STORAGE_DATABASE_URL:env.STORAGE_DATABASE_URL.replace('5432','6543')},fetchFn,db,out:tmp(),log:()=>{}}),/person_target:database_port/);
 await assert.rejects(exportObjects({env:{...env,SUPABASE_URL:'https://zyxwvutsrqponmlkjihg.supabase.co'},fetchFn,db,out:tmp(),log:()=>{}}),/person_target:rest_mismatch/);
 await assert.rejects(exportObjects({env:{...env,STORAGE_DATABASE_URL:undefined},fetchFn,db,out:tmp(),log:()=>{}}),/storage_export_database_required/);
 assert.throws(()=>safeObjectPath('../x'),/storage_object_name/);assert.throws(()=>safeObjectPath('/abs'),/storage_object_name/);assert.throws(()=>safeObjectPath('a//b'),/storage_object_name/);
});

test('the inventory connection accepts an unlabelled (pre-install) database and the selection\'s own label, and refuses another label',async()=>{
 const db=(present,label)=>({query:async(sql)=>sql.includes('to_regprocedure')?{rows:[{present}]}:{rows:[{label}]}});
 assert.deepEqual(await checkStorageDatabaseLabel(db(false,null),env),{label:null,checked:false});
 assert.deepEqual(await checkStorageDatabaseLabel(db(true,null),env),{label:null,checked:true});
 assert.deepEqual(await checkStorageDatabaseLabel(db(true,REF),env),{label:REF,checked:true});
 await assert.rejects(checkStorageDatabaseLabel(db(true,'zyxwvutsrqponmlkjihg'),env),/storage_export_label_mismatch/);
});
