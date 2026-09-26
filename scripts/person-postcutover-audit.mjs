#!/usr/bin/env node
// The post-cutover audit runner (plan task 9, cutover step 17). Read-mostly:
// it reads each person's evidence snapshot, plans verified / pending / review
// with scripts/person-audit/postcutover.mjs, and with --record stores that
// outcome after the database rechecks the person's compact boundary under the
// writer and capture gates. It never writes candidates, sources, receipts,
// capture rows or epoch markers.
//
//   node scripts/build-worker-lib.mjs
//   PERSON_PUBLISH_DATABASE_URL=... node scripts/person-postcutover-audit.mjs --run-id=<id> [options]
//
//   --record             store outcomes (default: dry, prints counts only)
//   --scope=all|pending  all candidates by id (default), or only people without
//                        a verified result in this run
//   --limit=N            people to consider (default 1000)
//   --batch-size=N       people per snapshot call, 1..20 (default 10)
//   --after=<uuid>       start after this id (new runs only)
//   --resume             continue from the run's saved cursor
//   --max-seconds=N      pause with a checkpoint after this long (default 3600)
//   --max-db-bytes=N     stop when the database reaches this size
//   --out=<path>         private per-person detail: id, status, reason, check
//                        names and counts. Never documents or values.
//
// Uses the website's direct or session-pooler connection (port 5432), like the
// publish CLIs. Logs carry ids, statuses, reasons and counts only.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {openDatabase,parseOptions,capacityGate,pinnedCommit,safeReason,log} from './person-publish/lib.mjs';
import {planAudit} from './person-audit/postcutover.mjs';

export const SPEC={
 'run-id':{type:'run',name:'runId',required:true},
 record:{type:'flag',default:false},
 scope:{type:'enum',values:['all','pending'],default:'all'},
 limit:{type:'int',min:1,max:1000000,default:1000},
 'batch-size':{type:'int',name:'batch',min:1,max:20,default:10},
 after:{type:'uuid',default:null},
 resume:{type:'flag',default:false},
 'max-seconds':{type:'int',name:'maxSeconds',min:1,max:18000,default:3600},
 'max-db-bytes':{type:'int',name:'maxBytes',min:1000000,max:1000000000000,default:34000000000},
 out:{type:'text',max:1000,default:null},
};
const STATUSES=['verified','pending','review'];

/** One statement with an armed timeout, inside its own transaction. */
async function timed(pool,seconds,sql,values){
 const client=await pool.connect();
 try{
  await client.query('begin');
  await client.query(`set local statement_timeout='${Number(seconds)}s'`);
  const result=await client.query(sql,values);
  await client.query('commit');
  return result;
 }catch(error){await client.query('rollback').catch(()=>{});throw error;}
 finally{client.release();}
}
async function readIds(pool,options,after,size){
 if(options.record)return (await pool.query('select public.person_postcutover_audit_page($1,$2,$3) r',[options.runId,after,size])).rows[0].r;
 // A dry run has no run row: page the same way the RPC does for scope=all.
 return (await pool.query('select coalesce(jsonb_agg(id order by id),\'[]\') r from (select id from public.candidates where $1::uuid is null or id>$1 order by id limit $2) x',[after,size])).rows[0].r;
}
export async function runAudit({pool,lib,options,now=Date.now,onProgress=log}){
 const started=now(),commit=pinnedCommit();
 if(options.record&&options.scope==='pending'&&!options.resume)throw Error('audit_pending_requires_resume');
 let after=options.after,considered=0,status='complete';
 const counts=Object.fromEntries(STATUSES.map(s=>[s,0]));counts.boundary_moved=0;
 const reasons={};const detail=[];
 if(options.record){
  const run=(await pool.query('select public.person_postcutover_audit_start($1,$2,$3,$4,$5) r',[options.runId,commit,options.scope,options.batch,options.resume])).rows[0].r;
  if(options.resume&&!options.after)after=run.last_id;
  if(options.after&&options.resume)throw Error('publish_option:after_with_resume');
 }
 const gate=capacityGate(pool,{maxBytes:options.maxBytes,now});
 let metrics=await gate();
 onProgress({phase:'audit_start',run:options.runId,record:options.record,scope:options.scope,commit,after,...metrics});
 try{
  while(considered<options.limit){
   if((now()-started)/1000>options.maxSeconds){status='paused';break;}
   const ids=await readIds(pool,options,after,Math.min(options.batch,options.limit-considered));
   if(!ids.length)break;
   const snapshots=(await timed(pool,15,'select public.person_postcutover_audit_inputs_with_witness($1::jsonb) r',[JSON.stringify(ids)])).rows[0].r;
   if(!Array.isArray(snapshots)||snapshots.length!==ids.length)throw Error('audit_snapshot_coverage');
   const planned=snapshots.map(s=>planAudit(s,lib));
   let outcomes=planned.map(p=>({candidate_id:p.candidate_id,status:p.status,reason:p.reason}));
   if(options.record){
    outcomes=(await timed(pool,15,'select public.person_postcutover_audit_record_many($1,$2::jsonb) r',[options.runId,JSON.stringify(planned)])).rows[0].r;
    if(!Array.isArray(outcomes)||outcomes.length!==planned.length)throw Error('audit_record_coverage');
   }
   for(const [i,o] of outcomes.entries()){
    counts[o.status]=(counts[o.status]??0)+1;
    if(o.reason==='boundary_moved')counts.boundary_moved++;
    if(o.reason)reasons[o.reason]=(reasons[o.reason]??0)+1;
    if(options.out)detail.push({id:o.candidate_id,status:o.status,reason:o.reason??null,checks:planned[i].checks});
   }
   after=ids.at(-1);considered+=ids.length;
   metrics=await gate();
   if(options.record)await pool.query('select public.person_postcutover_audit_checkpoint($1,$2,$3,$4::jsonb) r',[options.runId,after,'running',{}]);
   onProgress({phase:'audit_checkpoint',run:options.runId,processed:considered,last_id:after,...counts,...metrics});
   if(ids.length<Math.min(options.batch,options.limit-considered+ids.length))break;
  }
  if(status==='complete'&&considered>=options.limit&&options.limit<1000000)status='paused';
  if(options.record)await pool.query('select public.person_postcutover_audit_checkpoint($1,$2,$3,$4::jsonb) r',[options.runId,after,status==='complete'?'paused':status,{scan:status,elapsed_seconds:Math.round((now()-started)/1000)}]);
  if(options.out){fs.mkdirSync(path.dirname(path.resolve(options.out)),{recursive:true});fs.writeFileSync(options.out,JSON.stringify({run:options.runId,record:options.record,commit,people:detail},null,1),{mode:0o600});}
  const summary={phase:options.record?`audit_scan_${status}`:'audit_dry_run_complete',run:options.runId,processed:considered,last_id:after,...counts,reasons,seconds:Math.round((now()-started)/1000)};
  onProgress(summary);
  return summary;
 }catch(error){
  const reason=safeReason(error);
  if(options.record)await pool.query('select public.person_postcutover_audit_checkpoint($1,$2,$3,$4::jsonb) r',[options.runId,after,'failed',{error:reason}]).catch(()=>{});
  onProgress({phase:'audit_stopped',run:options.runId,reason,processed:considered,last_id:after,...counts});
  throw error;
 }
}
export async function main(argv=process.argv.slice(2)){
 const options=parseOptions(argv,SPEC);
 const pool=await openDatabase(process.env,'tt-person-postcutover-audit');
 try{const lib=await import('./dist/worker-lib.mjs');return await runAudit({pool,lib,options});}
 finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(error=>{console.error(JSON.stringify({phase:'audit_stopped',reason:safeReason(error)}));process.exit(1);});
