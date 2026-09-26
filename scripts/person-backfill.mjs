#!/usr/bin/env node
// Bounded, pinned, resumable shadow-only migration. No enrichment or application writes.
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { executePage, retryTransient, safeErrorCode } from './person-backfill/engine.mjs';
import { openSite, openComms, commsColumns, readAll, buildDocs, readNew, candidatesRows,
 selectIn, groupBy, hashOf, Tally, checkDocs, checkStored, sourceNeedsReview, truthy } from './person-trial.mjs';

function positive(v, name, max) {
 const n=Number(v); if(!Number.isInteger(n)||n<1||n>max)throw Error(`Invalid ${name}`); return n;
}
export function options(argv=process.argv.slice(2), env=process.env) {
 const args=new Map(argv.filter(x=>x.startsWith('--')).map(x=>{const i=x.indexOf('=');return i<0?[x.slice(2),'true']:[x.slice(2,i),x.slice(i+1)];}));
 const config=JSON.parse(env.BACKFILL_CONFIG??'{}');
 const get=(key,variable)=>args.get(key)??env[variable]??config[key];
 const run=get('run-id','BACKFILL_RUN_ID');if(!/^[a-zA-Z0-9_-]{1,100}$/.test(run??''))throw Error('Explicit run-id required');
 if((get('mode','BACKFILL_MODE')??'shadow')!=='shadow')throw Error('Only shadow mode is authorized');
 const cohort=get('cohort','BACKFILL_COHORT')??'all';if(!['all','pilot'].includes(cohort))throw Error('Invalid cohort');
 return {run,cohort,bulk:truthy(get('bulk','BACKFILL_BULK')??'true'),limit:positive(get('limit','BACKFILL_LIMIT'),'limit',1000000),batch:positive(get('batch-size','BACKFILL_BATCH_SIZE'),'batch-size',500),
  concurrency:positive(get('concurrency','BACKFILL_CONCURRENCY')??1,'concurrency',4),
  dry:truthy(get('dry-run','BACKFILL_DRY_RUN')??'true'),resume:truthy(get('resume','BACKFILL_RESUME')),
  commit:get('commit','GITHUB_SHA')??execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  maxBytes:positive(get('max-db-bytes','BACKFILL_MAX_DB_BYTES')??34000000000,'max-db-bytes',1000000000000),
  maxSeconds:positive(get('max-seconds','BACKFILL_MAX_SECONDS')??18000,'max-seconds',20000)};
}
export async function processPage({site,lib,comms,cols,config,page,afterSave}) {
 const rpc=(fn,args)=>retryTransient(()=>site.rpc(fn,args));
 const ids=page.map(x=>x.id);const versions=new Map(page.map(x=>[x.id,Number(x.captured_version)]));
 let before;
 const hooks={
  async read(){before=await readAll(site,ids,comms,cols,false);return before;},
  async prepare(input){
   if(input.rows.size!==ids.length||input.dirMissing||input.dirSkipped)throw Error('source_coverage');
   const by=new Map();const tally=new Tally();
   const existing=groupBy(await selectIn(site,'candidate_sources','candidate_id',ids,{columns:'candidate_id,source,source_ref,fetched_at,payload_hash,parser_version',order:'candidate_id.asc'}),'candidate_id');
   for(const id of ids){
    const inp=input.inputs.get(id);const built=await buildDocs(lib,id,inp);
    if(built.errors.length)throw Error('source_translation');
    checkDocs(tally,id,inp,built.docs);
    if(built.docs.some(d=>sourceNeedsReview(existing.get(id)??[],d,false)))throw Error('source_snapshot_requires_review');
    by.set(id,built.docs);
   }
   if(tally.fail.size)throw Error(`pre_save_integrity:${JSON.stringify(Object.fromEntries([...tally.fail].map(([key,values])=>[key,[...values]])))}`);
   return by;
  },
  async save(id,docs){
   if(config.dry)return null;
   const result=await rpc('person_backfill_save',{p_run:config.run,p_candidate:id,p_docs:docs.get(id),p_version:versions.get(id)});
   if(afterSave)await afterSave(id,result);
   return result;
  },
  async verify(_page,docs,saved){
   if(config.dry)return null;
   const stored=await readNew(site,ids,{globalCounts:false});
   const tally=new Tally();const checked=new Map();
   for(const id of ids)checked.set(id,checkStored(tally,id,before.inputs.get(id),docs.get(id),stored,lib));
   if(tally.fail.size)throw Error(`post_save_integrity:${[...tally.fail.keys()].join(',')}`);
   const after=await candidatesRows(site,ids);
   const changed=ids.filter(id=>hashOf(before.rows.get(id))!==hashOf(after.get(id)));
   if(changed.length){
    const queue=new Map((await selectIn(site,'person_change_queue','candidate_id',changed,{order:'candidate_id.asc'})).map(x=>[x.candidate_id,x]));
    if(changed.some(id=>Number(queue.get(id)?.version??0)<=versions.get(id)))throw Error('uncaptured_candidate_change');
   }
   for(let i=0;i<ids.length;i++)if(Number(stored.state.get(ids[i])?.rev)!==Number(saved[i].revision))throw Error('concurrent_normalized_change');
   return {checked,changed};
  },
  async audit(id,_docs,saved,verified){
   if(config.dry)return;
   const {_projection,...checks}=verified.checked.get(id);
   if(_docs.get(id).some(d=>(d.jobs??[]).some(j=>j.company.is_placeholder&&j.company.normalized_name==='unknown employer')))
    await rpc('person_backfill_flag_missing_employers',{p_candidate:id});
   await rpc('person_backfill_audit',{p_run:config.run,p_candidate:id,p_revision:saved.revision,p_version:versions.get(id),p_checks:{...checks,concurrent_legacy_change:verified.changed.includes(id)}});
  },
  async checkpoint(){
   if(config.dry)return null;
   return site.rpc('person_backfill_checkpoint',{p_run:config.run,p_ids:ids});
  }
 };
 if(config.bulk){
  hooks.saveMany=async (_ids,docs)=>{
   if(config.dry)return _ids.map(()=>null);
   const saved=[];
   // Only one mini-batch is in flight; its database gate precedes all row locks.
   for(let i=0;i<_ids.length;i+=10){
    const chunk=_ids.slice(i,i+10);
    const results=await rpc('person_backfill_save_many',{p_run:config.run,p_items:chunk.map(id=>({candidate_id:id,docs:docs.get(id),version:versions.get(id)}))});
    if(results.length!==chunk.length||results.some((r,n)=>r.candidate_id!==chunk[n]))throw Error('source_bulk_result_mismatch');
    saved.push(...results);
    if(afterSave)for(let n=0;n<chunk.length;n++)await afterSave(chunk[n],results[n]);
   }
   return saved;
  };
  hooks.auditMany=async (_ids,_docs,saved,verified)=>{
   if(config.dry)return;
   for(let i=0;i<_ids.length;i+=100)await rpc('person_backfill_audit_many',{p_run:config.run,p_items:_ids.slice(i,i+100).map((id,n)=>{
    const {_projection,...checks}=verified.checked.get(id);
    return {candidate_id:id,revision:saved[i+n].revision,version:versions.get(id),checks:{...checks,concurrent_legacy_change:verified.changed.includes(id)}};
   })});
  };
 }
 return executePage(ids,hooks,config.concurrency);
}
export async function main(){
 const config=options();const site=await openSite();let comms;
 const start=Date.now();let started=false;let processed=0;let after=null;let exitStatus='paused';
 try{
  const lib=await import('./dist/worker-lib.mjs');
  if(process.env.COMMS_DATABASE_URL)comms=await openComms(process.env.COMMS_DATABASE_URL);
  const cols=comms?await commsColumns(comms):null;
  let metrics=await site.rpc('person_backfill_metrics',{});
  const baselineLatency=[];for(let i=0;i<3;i++){const t=Date.now();await site.rpc('person_backfill_metrics',{});baselineLatency.push(Date.now()-t);}
  const normalLatency=baselineLatency.sort((a,b)=>a-b)[1];let slow=0;
  if(metrics.database_bytes>=config.maxBytes)throw Error('capacity_limit');
  if(!config.dry){
   const state=await site.rpc('person_backfill_start',{p_run:config.run,p_commit:config.commit,p_parser:'person-v3',p_limit:config.limit,p_batch:config.batch,p_resume:config.resume,p_cohort:config.cohort});
   started=true;processed=state.processed??0;
  }
  console.log(JSON.stringify({phase:'start',run:config.run,dry_run:config.dry,bulk:config.bulk,commit:config.commit,limit:config.limit,batch:config.batch,concurrency:config.concurrency,baseline_query_ms:normalLatency,...metrics}));
  while(processed<config.limit){
   if((Date.now()-start)/1000>config.maxSeconds){exitStatus='paused';break;}
   const page=config.dry?await site.rpc('person_backfill_preview_page',{p_after:after,p_size:Math.min(config.batch,config.limit-processed),p_directory_only:false,p_cohort:config.cohort,p_limit:config.limit})
    :await site.rpc('person_backfill_page',{p_run:config.run,p_size:Math.min(config.batch,config.limit-processed)});
   if(!page.length){exitStatus='baseline_complete';break;}
   const batchStart=Date.now();
   const state=await processPage({site,lib,comms,cols,config,page});
   processed=config.dry?processed+page.length:state.processed;after=page.at(-1).id;
   const measureStart=Date.now();metrics=await site.rpc('person_backfill_metrics',{});const latency=Date.now()-measureStart;
   slow=latency>Math.max(normalLatency*2,250)?slow+1:0;
   console.log(JSON.stringify({phase:'checkpoint',run:config.run,processed,last_id:after,seconds:Number(((Date.now()-batchStart)/1000).toFixed(2)),query_ms:latency,conflicts:state?.conflicts??0,...metrics}));
   if(metrics.database_bytes>=config.maxBytes||metrics.blocked_sessions>5||slow>=3)throw Error('capacity_or_latency_gate');
  }
  if(processed>=config.limit)exitStatus='baseline_complete';
  if(started)await site.rpc('person_backfill_status',{p_run:config.run,p_status:exitStatus,p_notes:{elapsed_seconds:Math.round((Date.now()-start)/1000),metrics,baseline_query_ms:normalLatency,catchup_pending:true}});
  console.log(JSON.stringify({phase:config.dry?'dry_run_complete':exitStatus,processed,seconds:Math.round((Date.now()-start)/1000),catchup_pending:!config.dry}));
 }catch(error){
  // Never emit database error bodies or source payloads into public Actions logs.
  const reason=/^(source_|pre_save_|post_save_|uncaptured_|concurrent_|capacity_)/.test(error.message)?error.message:`operation_failed:${safeErrorCode(error)}`;
  if(started)await site.rpc('person_backfill_status',{p_run:config.run,p_status:'failed',p_notes:{error_code:reason,processed}}).catch(()=>{});
  console.error(JSON.stringify({phase:'stopped',run:config.run,reason,processed}));throw Error(reason);
 }finally{await comms?.end();await site.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{process.exitCode=1;});
