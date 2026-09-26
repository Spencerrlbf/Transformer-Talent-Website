import test from 'node:test';
import assert from 'node:assert/strict';
import {runAudit,SPEC} from '../person-postcutover-audit.mjs';
import {parseOptions} from '../person-publish/lib.mjs';
const id=n=>`ec000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture({metrics={},latencies=[],delayPage=false}={}){
 let reads=0,probes=0,time=0;const logs=[];const query=async(sql,args=[])=>{
  if(sql.includes('person_backfill_metrics')){time+=latencies[probes++]??10;return {rows:[{result:{database_bytes:100000,blocked_sessions:0,...metrics}}]};}
  if(sql.includes('person_postcutover_audit_inputs')){if(delayPage)time+=1100;return {rows:[{r:JSON.parse(args[0]).map(candidate_id=>({candidate_id,status:'review',reason:'anchor_required'}))}]};}
  if(sql.includes('from public.candidates')){reads++;return {rows:[{r:[id(1),id(2)].filter(x=>!args[0]||x>args[0]).slice(0,args[1])}]};}
  if(/^(begin|commit|rollback|set local)/i.test(sql))return {rows:[]};
  throw Error('unexpected_test_query');
 };
 const pool={query,connect:async()=>({query,release(){}})};
 return {pool,lib:{},logs,now:()=>time,onProgress:x=>logs.push(x),get reads(){return reads},get probes(){return probes}};
}
const options=args=>parseOptions(['--run-id=cli-test','--batch-size=1',...args],SPEC);
const run=(f,args=[])=>runAudit({...f,options:options(args)});
test('invalid dry resume/scope and record after options fail before any DB calls',async()=>{
 for(const args of [['--resume'],['--scope=pending'],['--record','--resume',`--after=${id(1)}`]]){
  const f=fixture();await assert.rejects(run(f,args),/audit_option/);assert.equal(f.probes,0);assert.equal(f.reads,0);
 }
});
test('null negative or unavailable load metrics refuse any person page',async()=>{
 for(const metrics of [{database_bytes:null},{blocked_sessions:-1},{database_bytes:34000000000},{blocked_sessions:6}]){
  const f=fixture({metrics});await assert.rejects(run(f),/audit_capacity/);assert.equal(f.reads,0);assert.equal(f.logs.at(-1).status,'stopped');
 }
});
test('three baseline probes precede pages and sustained slowdown stops with exact progress',async()=>{
 const f=fixture({latencies:[10,10,10,600,600,600]});await assert.rejects(run(f),/audit_latency/);assert.equal(f.logs.at(-1).processed,2);assert.equal(f.logs.at(-1).last_id,id(2));
});
test('limits deadlines and suffix scans report partial coverage explicitly',async()=>{
 const limited=await run(fixture(),['--limit=1']);assert.equal(limited.status,'limit_reached');assert.equal(limited.full_population_scan,false);
 const timed=await run(fixture({delayPage:true}),['--max-seconds=1']);assert.equal(timed.status,'paused');assert.equal(timed.processed,1);assert.equal(timed.last_id,id(1));
 const suffix=await run(fixture(),[`--after=${id(1)}`]);assert.equal(suffix.status,'exhausted');assert.equal(suffix.full_population_scan,false);
 const all=await run(fixture());assert.equal(all.status,'exhausted');assert.equal(all.full_population_scan,true);
});
