import test from 'node:test';
import assert from 'node:assert/strict';
import {runPreview,SPEC,previewDispatchArguments} from '../person-publish-preview.mjs';
import {parseOptions} from './lib.mjs';
const id=n=>`d0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const lib={compatibilityProjection:async()=>({after:{email:null},changedFields:[],invalidatedKinds:new Set()})};
function fixture({people=[id(1),id(2),id(3),id(4)],health={},latencies=[],delayPerson=null,failPerson=null}={}){
 let time=0,probes=0,dataReads=0;const logs=[];
 const site={
  async rpc(fn){assert.equal(fn,'person_backfill_metrics');time+=latencies[probes++]??10;return {database_bytes:100000,blocked_sessions:0,...health};},
  async select(table,{filters=[],limit}={}){
   dataReads++;
   let selected=people.filter(cid=>filters.every(([column,op,value])=>{
    if(!['id','candidate_id'].includes(column))return true;
    return op==='in'?value.includes(cid):op==='gt'?cid>value:true;
   })).slice(0,limit??people.length);
   if(table==='candidate_profile_state')return selected.map(candidate_id=>({candidate_id,rev:1}));
   if(table==='candidates'){
    if(selected.includes(failPerson))throw Error('private data must not be logged');
    if(selected.includes(delayPerson))time+=1500;
    return selected.map(cid=>({id:cid,email:null}));
   }
   return [];
  }
 };
 return {site,logs,now:()=>time,onProgress:x=>logs.push(x),get reads(){return dataReads},get probes(){return probes}};
}
const options=(...args)=>parseOptions(args,SPEC);
const run=(f,args=[])=>runPreview({...f,lib,options:options('--batch-size=1',...args)});
test('preview options bound duration and capacity',()=>{
 const o=options();assert.equal(o.maxSeconds,600);assert.equal(o.maxBytes,34000000000);
 assert.equal(options('--max-seconds=1').maxSeconds,1);
 for(const arg of ['--max-seconds=0','--max-seconds=18001','--max-db-bytes=0'])assert.throws(()=>options(arg));
});
test('Actions dispatch preserves explicit limits and targets',()=>{
 const config={preview:true,reconcile:true,'max-seconds':12,'max-db-bytes':30000000000,ids:`${id(1)},${id(2)}`};
 const o=options(...previewDispatchArguments(config));
 assert.equal(o.maxSeconds,12);assert.equal(o.maxBytes,30000000000);assert.deepEqual(o.ids,[id(1),id(2)]);
});
test('missing and duplicate explicit IDs cannot hide a later migrated person',async()=>{
 const f=fixture({people:[id(2)]});const r=await run(f,[`--ids=${id(1)},${id(1)},${id(2)}`]);
 assert.equal(r.people,2);assert.equal(r.missing,1);assert.equal(r.unchanged,1);
 assert.equal(r.last_id,id(2));assert.equal(r.status,'exhausted');assert.equal(r.scope,'ids');assert.equal(r.full_migrated_scan,false);
});
test('a limited sample and a suffix never claim full-pool coverage',async()=>{
 const r=await run(fixture(),['--limit=1']);assert.equal(r.status,'limit_reached');assert.equal(r.last_id,id(1));assert.equal(r.full_migrated_scan,false);assert.equal(r.comparison_only,true);
 const suffix=await run(fixture(),[`--after=${id(2)}`]);assert.equal(suffix.status,'exhausted');assert.equal(suffix.scope,'after');assert.equal(suffix.full_migrated_scan,false);
 const all=await run(fixture());assert.equal(all.status,'exhausted');assert.equal(all.full_migrated_scan,true);
});
test('capacity, blocked load and unavailable metrics refuse the first data page',async()=>{
 for(const health of [{database_bytes:34000000000},{blocked_sessions:6},{database_bytes:null},{blocked_sessions:-1}]){
  const f=fixture({health});await assert.rejects(run(f),/preview_capacity/);assert.equal(f.reads,0);
  assert.equal(f.logs.at(-1).phase,'preview_stopped');assert.equal(f.logs.at(-1).people,0);assert.equal(f.logs.at(-1).last_id,null);
 }
});
test('three slow probes stop before another page and retain its complete cursor',async()=>{
 const f=fixture({latencies:[10,10,10,600,600,600]});await assert.rejects(run(f),/preview_latency/);
 assert.equal(f.logs.at(-1).people,2);assert.equal(f.logs.at(-1).last_id,id(2));
});
test('duration pauses after the completed page without starting the next',async()=>{
 const f=fixture({delayPerson:id(1)});const r=await run(f,['--max-seconds=1']);
 assert.equal(r.status,'paused');assert.equal(r.people,1);assert.equal(r.last_id,id(1));assert.equal(r.full_migrated_scan,false);
});
test('a failed page reports only fully accounted results and sanitized metadata',async()=>{
 const f=fixture({failPerson:id(2)});await assert.rejects(run(f));
 const last=f.logs.at(-1);assert.equal(last.phase,'preview_stopped');assert.equal(last.people,1);assert.equal(last.last_id,id(1));
 assert.ok(!JSON.stringify(f.logs).includes('private data'));
});
