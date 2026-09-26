#!/usr/bin/env node
// Cutover runbook step: undo a publish run from its before-images.
//
//   PERSON_PUBLISH_DATABASE_URL=... node scripts/person-publish-undo.mjs --run-id=<publish run> [options]
//
//   --apply              restore (default is a dry run that only counts)
//   --limit=N            before-images to consider (default 1000)
//   --batch-size=N       rows per page, 1..500 (default 100)
//   --max-seconds=N      pause after this long (default 3600)
//   --max-db-bytes=N     stop when the database reaches this size
//
// Restores only the profile columns in each before-image, and only when the
// person still carries the normalized revision that publish wrote AND the
// current profile hash equals what publish produced (undoPersonProjectionOnConnection).
// A newer edit, a later normalized revision or a unique-email clash is reported
// as a conflict and left alone. Restored rows are marked restored_at, so a
// re-run does nothing. Source records and normalized facts are never touched.
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {openDatabase,parseOptions,capacityGate,pinnedCommit,safeReason,log,withRunLock} from './person-publish/lib.mjs';

export const SPEC={
 'run-id':{type:'run',name:'runId',required:true},
 apply:{type:'flag',default:false},
 limit:{type:'int',min:1,max:1000000,default:1000},
 'batch-size':{type:'int',name:'batch',min:1,max:500,default:100},
 'max-seconds':{type:'int',name:'maxSeconds',min:1,max:18000,default:3600},
 'max-db-bytes':{type:'int',name:'maxBytes',min:1000000,max:1000000000000,default:34000000000},
};
export async function runUndo({pool,lib,options,now=Date.now,onProgress=log}){
 return withRunLock(pool,options.runId,client=>runUndoLocked({pool:client,lib,options,now,onProgress}));
}
async function runUndoLocked({pool,lib,options,now,onProgress}){
 const started=now(),commit=pinnedCommit(),undoRun=options.runId.length<=95?`${options.runId}-undo`:`undo-${createHash('sha256').update(options.runId).digest('hex')}`;
 const publish=(await pool.query(`select run_id,status from public.person_publish_runs where run_id=$1 and mode='publish'`,[options.runId])).rows[0];
 if(!publish)throw Error('publish_run_missing');
 if(publish.status==='running')throw Error('publish_run_active');
 const counts={restored:0,conflict:0,missing:0,pending:0};
 if(options.apply){
  await pool.query(`insert into public.person_publish_runs(run_id,mode,status,commit_sha,notes) values($1,'undo','running',$2,$3)
   on conflict(run_id) do nothing`,[undoRun,commit,{publish_run:options.runId}]);
  const existing=(await pool.query('select mode,commit_sha,notes from public.person_publish_runs where run_id=$1',[undoRun])).rows[0];
  if(existing.mode!=='undo'||existing.notes?.publish_run!==options.runId)throw Error('publish_run_config_differs');
  if(existing.commit_sha!==commit)throw Error('publish_run_commit_differs');
  await pool.query("update public.person_publish_runs set status='running',updated_at=clock_timestamp() where run_id=$1",[undoRun]);
 }
 const checkpoint=async status=>{
  if(!options.apply)return;
  const rows=(await pool.query('select status,count(*)::int n from public.person_publish_results where run_id=$1 group by status',[undoRun])).rows;
  counts.restored=0;counts.conflict=0;counts.missing=0;
  for(const row of rows)counts[row.status.replace(/^undo_/,'')]=row.n;
  await pool.query(`update public.person_publish_runs set status=$2,processed=$3,counts=$4,updated_at=clock_timestamp(),finished_at=case when $2='complete' then clock_timestamp() end where run_id=$1`,[undoRun,status,counts.restored+counts.conflict+counts.missing,counts]);
 };
 const gate=capacityGate(pool,{maxBytes:options.maxBytes,now});
 let metrics,afterId='0',considered=0,status='complete';
 try{
  metrics=await gate();
  onProgress({phase:'undo_start',run:undoRun,publish_run:options.runId,apply:options.apply,commit,...metrics});
  while(considered<options.limit){
   if((now()-started)/1000>options.maxSeconds){status='paused';break;}
   const page=(await pool.query(
    `select id::text,candidate_id,revision::text from public.person_projection_history where run_id=$1 and restored_at is null and id>$2::bigint order by id limit $3`,
    [options.runId,afterId,Math.min(options.batch,options.limit-considered)])).rows;
   if(!page.length)break;
   if(options.apply){
     for(const row of page){
      await lib.undoPersonProjectionOnConnection(pool,row.candidate_id,row.revision,{historyId:row.id,runId:options.runId,recordRunId:undoRun});
     }
   }else counts.pending+=page.length;
   afterId=page.at(-1).id;considered+=page.length;
   metrics=await gate();
   await checkpoint('running');
   onProgress({phase:'undo_checkpoint',run:undoRun,processed:considered,...counts,...metrics});
   if(page.length<Math.min(options.batch,options.limit-considered+page.length))break;
  }
  if(status==='complete'&&considered>=options.limit&&options.limit<1000000)status='paused';
  await checkpoint(status);
  const summary={phase:options.apply?`undo_${status}`:'undo_dry_run_complete',run:undoRun,processed:options.apply?counts.restored+counts.conflict+counts.missing:considered,...counts,seconds:Math.round((now()-started)/1000)};
  onProgress(summary);
  return summary;
 }catch(error){
  const reason=safeReason(error);
  await checkpoint('failed').catch(()=>{});
  onProgress({phase:'undo_stopped',run:undoRun,reason,processed:considered,...counts});
  throw error;
 }
}
export async function main(argv=process.argv.slice(2)){
 const options=parseOptions(argv,SPEC);
 const pool=await openDatabase(process.env,'tt-person-publish-undo');
 try{const lib=await import('./dist/worker-lib.mjs');return await runUndo({pool,lib,options});}
 finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(error=>{console.error(JSON.stringify({phase:'undo_stopped',reason:safeReason(error)}));process.exit(1);});
