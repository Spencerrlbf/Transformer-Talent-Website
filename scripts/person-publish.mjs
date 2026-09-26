#!/usr/bin/env node
// Cutover runbook step: publish already-migrated people's compatibility
// columns from the normalized tables, in bounded resumable batches.
//
//   node scripts/build-worker-lib.mjs
//   PERSON_DATABASE_URL=... node scripts/person-publish.mjs --run-id=<id> [options]
//
//   --mode=dry|publish   dry (default) computes every person's change and writes
//                        NOTHING to the database (each transaction rolls back).
//                        publish writes, one audited transaction per person.
//   --limit=N            people to consider in this invocation (default 1000)
//   --batch-size=N       people read per page, 1..500 (default 100)
//   --resume             continue the run from its saved cursor
//   --after=<uuid>       start after this id (new runs only)
//   --ids=a,b,c          a bounded explicit list (max 500) instead of a scan
//   --review=skip|publish  people with an open identity/contact review record:
//                        skip (default) or publish. Spencer's decision B5.
//   --max-seconds=N      pause with a checkpoint after this long (default 3600)
//   --max-db-bytes=N     stop when the database reaches this size
//   --out=<path>         dry-run detail: per person id, status and the NAMES of
//                        changed columns, never values. Keep private.
//
// Every person is its own transaction (publishPersonProjectionOnConnection):
// candidate lock, hold check, drift check against the last projection,
// before-image with this run's id, audited profile update. The checkpoint is
// written after the page; a crash between a commit and its checkpoint is safe
// because re-running the same person finds nothing to change and the
// before-image already carries the run id for undo. Held people, people
// without normalized state and rows that drifted are counted, not written.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {openDatabase,parseOptions,capacityGate,pinnedCommit,safeReason,log} from './person-publish/lib.mjs';

export const SPEC={
 'run-id':{type:'run',name:'runId',required:true},
 mode:{type:'enum',values:['dry','publish'],default:'dry'},
 limit:{type:'int',min:1,max:1000000,default:1000},
 'batch-size':{type:'int',name:'batch',min:1,max:500,default:100},
 resume:{type:'flag',default:false},
 after:{type:'uuid',default:null},
 ids:{type:'uuids',max:500,default:null},
 review:{type:'enum',values:['skip','publish'],default:'skip'},
 'max-seconds':{type:'int',name:'maxSeconds',min:1,max:18000,default:3600},
 'max-db-bytes':{type:'int',name:'maxBytes',min:1000000,max:1000000000000,default:34000000000},
 out:{type:'text',max:1000,default:null},
};
const COUNTS=['projected','unchanged','held','unmigrated','drift','audit_blocked','review_skipped','dry_changed','dry_unchanged','email_collision'];

async function loadRun(pool,options,commit){
 const existing=(await pool.query('select * from public.person_publish_runs where run_id=$1',[options.runId])).rows[0];
 if(options.mode==='dry'){
  if(existing)throw Error('publish_run_exists');
  return {last_id:options.after,processed:0,counts:Object.fromEntries(COUNTS.map(k=>[k,0]))};
 }
 if(existing){
  if(!options.resume)throw Error('publish_run_exists');
  // A complete run may be resumed too: re-running its people is a no-op and
  // proves idempotency without a new run id.
  if(existing.mode!=='publish'||!['paused','failed','running','complete'].includes(existing.status))throw Error('publish_run_not_resumable');
  if(existing.commit_sha!==commit)throw Error('publish_run_commit_differs');
  if(existing.notes?.review!==options.review||Boolean(existing.notes?.ids)!==Boolean(options.ids))throw Error('publish_run_config_differs');
  await pool.query(`update public.person_publish_runs set status='running',updated_at=clock_timestamp() where run_id=$1`,[options.runId]);
  return {last_id:existing.last_id,processed:existing.processed,counts:{...Object.fromEntries(COUNTS.map(k=>[k,0])),...existing.counts}};
 }
 if(options.resume)throw Error('publish_run_missing');
 await pool.query(`insert into public.person_publish_runs(run_id,mode,status,commit_sha,last_id,notes) values($1,'publish','running',$2,$3,$4)`,
  [options.runId,commit,options.after,{review:options.review,ids:options.ids?options.ids.length:null,batch:options.batch}]);
 return {last_id:options.after,processed:0,counts:Object.fromEntries(COUNTS.map(k=>[k,0]))};
}
/** Next page of migrated people by id, with hold/review flags read in one query. */
async function readPage(pool,options,after,size){
 const reviewFilter=`exists(select 1 from public.identity_conflicts ic where ic.status='open' and c.id=any(ic.candidate_ids))`;
 if(options.ids){
  const rest=options.ids.filter(id=>!after||id>after).sort().slice(0,size);
  if(!rest.length)return [];
  return (await pool.query(`select c.id,${reviewFilter} review from public.candidates c where c.id=any($1::uuid[]) order by c.id`,[rest])).rows;
 }
 return (await pool.query(
  `select c.id,${reviewFilter} review from public.candidates c
   where ($1::uuid is null or c.id>$1) and exists(select 1 from public.candidate_profile_state s where s.candidate_id=c.id)
   order by c.id limit $2`,[after,size])).rows;
}
async function checkpoint(pool,options,state,status,extra={}){
 if(options.mode==='dry')return;
 await pool.query(`update public.person_publish_runs set status=$2,last_id=$3,processed=$4,counts=$5,notes=notes||$6,updated_at=clock_timestamp(),finished_at=case when $2 in ('complete','failed') then clock_timestamp() else finished_at end where run_id=$1`,
  [options.runId,status,state.last_id,state.processed,state.counts,extra]);
}
export async function runPublish({pool,lib,options,now=Date.now,onProgress=log,hooks={}}){
 const started=now(),commit=pinnedCommit();
 if(options.ids&&options.after)throw Error('publish_option:after_with_ids');
 const state=await loadRun(pool,options,commit);
 // An explicit id list is bounded and every person is idempotent, so a resume
 // re-checks the whole list instead of trusting a cursor into it.
 if(options.ids)state.last_id=null;
 const gate=capacityGate(pool,{maxBytes:options.maxBytes,now});
 const detail=[];
 let metrics=await gate();
 onProgress({phase:'publish_start',run:options.runId,mode:options.mode,review:options.review,commit,resume:options.resume,after:state.last_id,processed:state.processed,...metrics});
 let considered=0,status='complete';
 try{
  while(considered<options.limit){
   if((now()-started)/1000>options.maxSeconds){status='paused';break;}
   const page=await readPage(pool,options,state.last_id,Math.min(options.batch,options.limit-considered));
   if(!page.length)break;
   const client=await pool.connect();
   try{
    for(const row of page){
     let result;
     if(row.review&&options.review==='skip'){result={candidateId:row.id,status:'review_skipped',revision:null,changedFields:[],emailCollision:false,historyId:null};}
     else result=await lib.publishPersonProjectionOnConnection(client,row.id,{runId:options.runId,dryRun:options.mode==='dry'});
     state.counts[result.status]=(state.counts[result.status]??0)+1;
     if(result.emailCollision)state.counts.email_collision++;
     if(options.mode==='publish')await pool.query(
      `insert into public.person_publish_results(run_id,candidate_id,status,revision,history_id,changed_fields,email_collision) values($1,$2,$3,$4,$5,$6,$7)
       on conflict(run_id,candidate_id) do update set status=excluded.status,revision=excluded.revision,history_id=coalesce(excluded.history_id,public.person_publish_results.history_id),changed_fields=excluded.changed_fields,email_collision=excluded.email_collision,created_at=clock_timestamp()`,
      [options.runId,row.id,result.status,result.revision,result.historyId,result.changedFields,result.emailCollision]);
     if(options.out)detail.push({id:row.id,status:result.status,changed:result.changedFields,collision:result.emailCollision,...(result.reason?{reason:result.reason}:{})});
     if(hooks.afterPerson)await hooks.afterPerson(row.id,result);
    }
   }finally{client.release();}
   state.last_id=page.at(-1).id;state.processed+=page.length;considered+=page.length;
   metrics=await gate();
   await checkpoint(pool,options,state,'running');
   onProgress({phase:'publish_checkpoint',run:options.runId,processed:state.processed,last_id:state.last_id,...state.counts,...metrics});
   if(hooks.afterPage)await hooks.afterPage(state);
   if(page.length<Math.min(options.batch,options.limit-considered+page.length))break;
  }
  if(status==='complete'&&considered>=options.limit&&options.limit<1000000)status='paused';
  await checkpoint(pool,options,state,status,{elapsed_seconds:Math.round((now()-started)/1000)});
  if(options.out){fs.mkdirSync(path.dirname(path.resolve(options.out)),{recursive:true});fs.writeFileSync(options.out,JSON.stringify({run:options.runId,mode:options.mode,commit,people:detail},null,1),{mode:0o600});}
  const summary={phase:options.mode==='dry'?'dry_run_complete':`publish_${status}`,run:options.runId,processed:state.processed,last_id:state.last_id,...state.counts,seconds:Math.round((now()-started)/1000)};
  onProgress(summary);
  return summary;
 }catch(error){
  const reason=safeReason(error);
  await checkpoint(pool,options,state,'failed',{error:reason,elapsed_seconds:Math.round((now()-started)/1000)}).catch(()=>{});
  onProgress({phase:'publish_stopped',run:options.runId,reason,processed:state.processed,last_id:state.last_id,...state.counts});
  throw error;
 }
}
export async function main(argv=process.argv.slice(2)){
 const options=parseOptions(argv,SPEC);
 const pool=await openDatabase(process.env,'tt-person-publish');
 try{
  const lib=await import('./dist/worker-lib.mjs');
  return await runPublish({pool,lib,options});
 }finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(error=>{console.error(JSON.stringify({phase:'publish_stopped',reason:safeReason(error)}));process.exit(1);});
