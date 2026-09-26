#!/usr/bin/env node
// Cutover runbook step: undo a publish run from its before-images.
//
//   PERSON_DATABASE_URL=... node scripts/person-publish-undo.mjs --run-id=<publish run> [options]
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
import {openDatabase,parseOptions,capacityGate,pinnedCommit,safeReason,log} from './person-publish/lib.mjs';

export const SPEC={
 'run-id':{type:'run',name:'runId',required:true},
 apply:{type:'flag',default:false},
 limit:{type:'int',min:1,max:1000000,default:1000},
 'batch-size':{type:'int',name:'batch',min:1,max:500,default:100},
 'max-seconds':{type:'int',name:'maxSeconds',min:1,max:18000,default:3600},
 'max-db-bytes':{type:'int',name:'maxBytes',min:1000000,max:1000000000000,default:34000000000},
};
export async function runUndo({pool,lib,options,now=Date.now,onProgress=log}){
 const started=now(),commit=pinnedCommit(),undoRun=`${options.runId}-undo`;
 const publish=(await pool.query(`select run_id,status from public.person_publish_runs where run_id=$1 and mode='publish'`,[options.runId])).rows[0];
 if(!publish)throw Error('publish_run_missing');
 if(publish.status==='running')throw Error('publish_run_active');
 const counts={restored:0,conflict:0,missing:0,pending:0};
 if(options.apply){
  await pool.query(`insert into public.person_publish_runs(run_id,mode,status,commit_sha,notes) values($1,'undo','running',$2,$3)
   on conflict(run_id) do update set status='running',updated_at=clock_timestamp()`,[undoRun,commit,{publish_run:options.runId}]);
 }
 const gate=capacityGate(pool,{maxBytes:options.maxBytes,now});
 let metrics=await gate(),afterId='0',considered=0,status='complete';
 onProgress({phase:'undo_start',run:undoRun,publish_run:options.runId,apply:options.apply,commit,...metrics});
 try{
  while(considered<options.limit){
   if((now()-started)/1000>options.maxSeconds){status='paused';break;}
   const page=(await pool.query(
    `select id::text,candidate_id,revision::text from public.person_projection_history where run_id=$1 and restored_at is null and id>$2::bigint order by id limit $3`,
    [options.runId,afterId,Math.min(options.batch,options.limit-considered)])).rows;
   if(!page.length)break;
   if(options.apply){
    const client=await pool.connect();
    try{
     for(const row of page){
      const result=await lib.undoPersonProjectionOnConnection(client,row.candidate_id,row.revision);
      counts[result.status]++;
      await pool.query(`insert into public.person_publish_results(run_id,candidate_id,status,revision,history_id) values($1,$2,$3,$4,$5)
       on conflict(run_id,candidate_id) do update set status=excluded.status,revision=excluded.revision,history_id=excluded.history_id,created_at=clock_timestamp()`,
       [undoRun,row.candidate_id,`undo_${result.status}`,row.revision,row.id]);
     }
    }finally{client.release();}
   }else counts.pending+=page.length;
   afterId=page.at(-1).id;considered+=page.length;
   metrics=await gate();
   if(options.apply)await pool.query(`update public.person_publish_runs set processed=$2,counts=$3,updated_at=clock_timestamp() where run_id=$1`,[undoRun,considered,counts]);
   onProgress({phase:'undo_checkpoint',run:undoRun,processed:considered,...counts,...metrics});
   if(page.length<Math.min(options.batch,options.limit-considered+page.length))break;
  }
  if(status==='complete'&&considered>=options.limit&&options.limit<1000000)status='paused';
  if(options.apply)await pool.query(`update public.person_publish_runs set status=$2,processed=$3,counts=$4,updated_at=clock_timestamp(),finished_at=case when $2='complete' then clock_timestamp() end where run_id=$1`,[undoRun,status,considered,counts]);
  const summary={phase:options.apply?`undo_${status}`:'undo_dry_run_complete',run:undoRun,processed:considered,...counts,seconds:Math.round((now()-started)/1000)};
  onProgress(summary);
  return summary;
 }catch(error){
  const reason=safeReason(error);
  if(options.apply)await pool.query(`update public.person_publish_runs set status='failed',processed=$2,counts=$3,notes=notes||$4,updated_at=clock_timestamp() where run_id=$1`,[undoRun,considered,counts,{error:reason}]).catch(()=>{});
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
