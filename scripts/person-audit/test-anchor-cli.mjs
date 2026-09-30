import assert from 'node:assert/strict';
import {test} from 'node:test';
const mod=await import('../person-audit-anchors.mjs').catch(()=>({}));
const ids=[1,2,3].map(n=>`d7000000-0000-4000-8000-${String(n).padStart(12,'0')}`);
const opts={save:false,limit:100,batch:2,after:null,maxSeconds:900,maxBytes:34000000000};
const prepare=s=>({candidate_id:s.candidate_id,status:s.status==='review'?'review':'ready',proof:'x',doc:{}});
function site({failCommit=false}={}){
 const calls=[];let commits=0;
 return {calls,rpc:async(fn,a)=>{
  calls.push({fn,a});
  if(fn==='person_backfill_metrics')return {database_bytes:1,blocked_sessions:0};
  if(fn==='person_audit_anchor_page')return ids.filter(x=>!a.p_after||x>a.p_after).slice(0,a.p_limit);
  if(fn==='person_audit_anchor_inputs')return a.p_ids.map((x,i)=>({candidate_id:x,status:x===ids[1]?'review':'ready'}));
  if(fn==='person_audit_anchor_commit'){if(failCommit&&++commits===2)throw Error('private payload must not be emitted');return a.p_items.map(x=>({candidate_id:x.candidate_id,status:'created'}));}
  throw Error('unexpected RPC');
 }};
}
test('anchor CLI has a dry default and strict bounded options',()=>{
 assert.equal(typeof mod.anchorOptions,'function');assert.equal(mod.anchorOptions([]).save,false);
 assert.equal(mod.anchorOptions(['--save','--limit=20','--batch=10']).save,true);
 for(const args of [['--batch=101'],['--limit=0'],['--after=bad'],['--unknown'],['--max-seconds=0']])assert.throws(()=>mod.anchorOptions(args));
});
test('dry run scans through review items and never commits',async()=>{
 const s=site(),logs=[];const result=await mod.prepareAnchors({site:s,prepare,options:opts,onProgress:x=>logs.push(x)});
 assert.equal(result.scanned,3);assert.equal(result.review,1);assert.equal(result.status,'scan_complete');assert.equal(s.calls.some(x=>x.fn==='person_audit_anchor_commit'),false);assert.equal(logs.at(-1).after,ids[2]);
});
test('saving and cursor resume honor caller bounds',async()=>{
 const s=site();const r=await mod.prepareAnchors({site:s,prepare,options:{...opts,save:true,after:ids[0],limit:1},onProgress:()=>{}});
 assert.equal(r.scanned,1);assert.equal(r.review,1);assert.equal(r.after,ids[1]);assert.equal(r.status,'limit_reached');
 const s2=site();const r2=await mod.prepareAnchors({site:s2,prepare,options:{...opts,save:true,after:r.after},onProgress:()=>{}});assert.equal(r2.created,1);assert.equal(r2.scanned,1);
});
test('failed page is never checkpointed past an unrecorded result',async()=>{
 const s=site({failCommit:true}),logs=[];await assert.rejects(mod.prepareAnchors({site:s,prepare,options:{...opts,save:true,batch:1},onProgress:x=>logs.push(x)}));
 assert.equal(logs.at(-1).after,ids[1]);assert.equal(logs.some(x=>x.after===ids[2]),false);
});
test('bad response identity, resource pressure and elapsed bounds fail closed',async()=>{
 const s=site(),rpc=s.rpc;s.rpc=async(fn,a)=>fn==='person_audit_anchor_inputs'?[{candidate_id:ids[2],status:'ready'}]:rpc(fn,a);
 await assert.rejects(mod.prepareAnchors({site:s,prepare,options:opts,onProgress:()=>{}}),/audit_input_coverage/);
 const s2=site();s2.rpc=async()=>({database_bytes:40000000000,blocked_sessions:0});await assert.rejects(mod.prepareAnchors({site:s2,prepare,options:opts,onProgress:()=>{}}),/audit_capacity/);
 let n=0;const r=await mod.prepareAnchors({site:site(),prepare,options:{...opts,maxSeconds:1},onProgress:()=>{},now:()=>n++*2000});assert.equal(r.status,'paused');assert.equal(r.scanned,0);
});
test('three slow metric probes stop further pages',async()=>{
 let time=0,probes=0;const s=site(),original=s.rpc;
 s.rpc=async(fn,a)=>{if(fn==='person_backfill_metrics'){time+=++probes<=3?10:300;return {database_bytes:1,blocked_sessions:0};}return original(fn,a);};
 await assert.rejects(mod.prepareAnchors({site:s,prepare,options:{...opts,batch:1},onProgress:()=>{},now:()=>time}),/audit_latency/);
});
test('connection URL cannot override the validated host or execution timeout',async()=>{
 const {anchorDatabaseConfig}=await import('./database.mjs');
 const {default:pg}=await import('pg');
 assert.equal(typeof anchorDatabaseConfig,'function');
 for(const suffix of ['?host=remote.invalid','?hostaddr=10.0.0.1','?statement_timeout=0','?options=-c%20statement_timeout%3D0'])assert.throws(()=>anchorDatabaseConfig({LOCAL_DATABASE_URL:`postgresql://localhost/local${suffix}`}),/audit_database_url/);
 const c=new pg.Client(anchorDatabaseConfig({LOCAL_DATABASE_URL:'postgresql://postgres@127.0.0.1:55487/person_audit_test'}));assert.equal(c.connectionParameters.host,'127.0.0.1');assert.equal(c.connectionParameters.statement_timeout,15000);
 const remote=new pg.Client(anchorDatabaseConfig({PERSON_DATABASE_URL:'postgresql://postgres@db.example/website?sslmode=require'}));assert.equal(remote.connectionParameters.host,'db.example');assert.equal(remote.connectionParameters.statement_timeout,15000);
});
