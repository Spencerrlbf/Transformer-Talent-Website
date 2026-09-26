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
import {openDatabase,parseOptions,pinnedCommit,safeReason,log} from './person-publish/lib.mjs';
import {openComms,commsColumns} from './person-trial.mjs';
import {timed,auditCapacity,withAuditRunLock} from './person-audit/runtime.mjs';
import {externalReader} from './person-audit/external.mjs';
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
function validate(options){
 if((!options.record&&(options.resume||options.scope!=='all'))||(options.resume&&options.after)||(options.record&&options.scope==='pending'&&!options.resume))throw Error('audit_option_combination');
}
async function readIds(pool,options,after,size,pass=1){
 if(options.record)return (await pool.query('select public.person_postcutover_audit_page($1,$2,$3,$4) r',[options.runId,after,size,pass])).rows[0].r;
 const ids=(await pool.query("select coalesce(jsonb_agg(id order by id),'[]') r from (select id from public.candidates where $1::uuid is null or id>$1 order by id limit $2) x",[after,size])).rows[0].r;
 return {ids,after:ids.at(-1)??after,examined:ids.length,exhausted:ids.length<size};
}
export async function runAudit(args){
 validate(args.options);
 if(args.options.record)return withAuditRunLock(args.pool,args.options.runId,pool=>scan({...args,pool}));
 return scan(args);
}
async function scan({pool,lib,options,comms=null,cols=null,now=Date.now,onProgress=log,external=null,startedAt=null}){
 const started=startedAt??now(),commit=pinnedCommit();let after=options.after,considered=0,status='limit_reached',startedRun=false,run;
 const counts=Object.fromEntries(STATUSES.map(s=>[s,0]));counts.boundary_moved=0;const reasons={},detail=[];
 const expired=()=>now()-started>=options.maxSeconds*1000;
 const gate=auditCapacity(pool,{maxBytes:options.maxBytes,now});
 const reader=external??externalReader({pool,comms,cols,lib,gate,expired});
 const finish=(state,reason)=>{
  const summary={phase:state==='stopped'?'audit_stopped':'audit_finished',status:state,run:options.runId,record:options.record,scope:options.scope,
   processed:considered,start_after:options.after,last_id:after,full_population_scan:state==='exhausted'&&options.scope==='all'&&!options.after&&!options.resume,...counts,reasons,seconds:Math.round((now()-started)/1000),...(reason?{reason}:{})};
  if(options.out){fs.mkdirSync(path.dirname(path.resolve(options.out)),{recursive:true});fs.writeFileSync(options.out,JSON.stringify({summary,people:detail},null,1),{mode:0o600});}
  onProgress(summary);return summary;
 };
 const checkpoint=async(state,complete=false,extra={})=>{if(startedRun)await pool.query('select public.person_postcutover_audit_checkpoint($1,$2,$3,$4::jsonb,$5)',[options.runId,after,state,JSON.stringify({scan_complete:complete,scan:status,...extra}),run.pass]);};
 try{
  for(let i=0;i<3;i++){if(expired())return finish('paused');await gate();}
  if(options.record){
   run=(await pool.query('select public.person_postcutover_audit_start($1,$2,$3,$4,$5) r',[options.runId,commit,options.scope,options.batch,options.resume])).rows[0].r;startedRun=true;
   if(options.resume)after=run.last_id;
   if(!run.external_start){const proof=await reader.fingerprint();await pool.query("select public.person_postcutover_audit_observe($1,'start',$2::jsonb,$3)",[options.runId,JSON.stringify(proof),run.pass]);}
  }
  onProgress({phase:'audit_start',run:options.runId,record:options.record,scope:options.scope,commit,after});
  while(considered<options.limit){
   if(expired()){status='paused';break;}const metrics=await gate();if(expired()){status='paused';break;}
   const size=Math.min(options.batch,options.limit-considered),page=await readIds(pool,options,after,size,run?.pass),ids=page?.ids;
   if(!page||!Number.isSafeInteger(page.examined)||page.examined<0||page.examined>size||typeof page.exhausted!=='boolean'||(page.examined&&(!page.after||after&&page.after<=after)))throw Error('audit_page_coverage');
   if(!Array.isArray(ids)||ids.length>size||ids.some((id,i)=>!/^([0-9a-f]{8}-)([0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)||(i?id<=ids[i-1]:after&&id<=after)))throw Error('audit_page_coverage');
   if(!ids.length){after=page.after;await checkpoint('running',page.exhausted);if(page.exhausted){status='exhausted';break;}continue;}
   const snapshots=(await timed(pool,15,'select public.person_postcutover_audit_inputs_with_witness($1::jsonb) r',[JSON.stringify(ids)])).rows[0].r;
   if(!Array.isArray(snapshots)||snapshots.length!==ids.length||snapshots.some((s,i)=>s.candidate_id!==ids[i]))throw Error('audit_snapshot_coverage');
   const observed=await reader.page(snapshots);
   const planned=snapshots.map(s=>planAudit(s,lib,observed));
   let outcomes=planned.map(p=>({candidate_id:p.candidate_id,status:p.status,reason:p.reason}));
   if(options.record)outcomes=(await timed(pool,15,'select public.person_postcutover_audit_record_many($1,$2::jsonb,$3) r',[options.runId,JSON.stringify(planned),run.pass])).rows[0].r;
   if(!Array.isArray(outcomes)||outcomes.length!==ids.length||outcomes.some((o,i)=>o.candidate_id!==ids[i]||!STATUSES.includes(o.status)))throw Error('audit_record_coverage');
   for(const [i,o] of outcomes.entries()){
    counts[o.status]++;if(o.reason==='boundary_moved')counts.boundary_moved++;if(o.reason)reasons[o.reason]=(reasons[o.reason]??0)+1;
    if(options.out)detail.push({id:o.candidate_id,status:o.status,reason:o.reason,checks:planned[i].checks});
   }
   after=page.after;considered+=ids.length;
   await checkpoint('running');
   onProgress({phase:'audit_checkpoint',run:options.runId,processed:considered,last_id:after,...counts,...metrics});
   if(page.exhausted){status='exhausted';break;}
  }
  await checkpoint('paused',status==='exhausted');
  if(options.record&&status==='exhausted'){const proof=await reader.fingerprint();await pool.query("select public.person_postcutover_audit_observe($1,'end',$2::jsonb,$3)",[options.runId,JSON.stringify(proof),run.pass]);}
  return finish(status);
 }catch(error){
  if(error.message==='audit_duration'){status='paused';await checkpoint('paused');return finish('paused');}
  const reason=safeReason(error);await checkpoint('failed',false,{error:reason}).catch(()=>{});finish('stopped',reason);throw error;
 }
}
export async function main(argv=process.argv.slice(2)){
 const startedAt=Date.now(),options=parseOptions(argv,SPEC);validate(options);
 const pool=await openDatabase(process.env,'tt-person-postcutover-audit');let comms,cols;
 try{
  if(process.env.COMMS_DATABASE_URL){try{comms=await openComms(process.env.COMMS_DATABASE_URL,{connectionTimeoutMillis:Math.min(8000,options.maxSeconds*1000),statementTimeoutMillis:8000});cols=await commsColumns(comms);}catch{await comms?.end();comms=null;cols=null;}}
  const lib=await import('./dist/worker-lib.mjs');return await runAudit({pool,lib,options,comms,cols,startedAt});
 }finally{await comms?.end();await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(error=>{console.error(JSON.stringify({phase:'audit_stopped',reason:safeReason(error)}));process.exit(1);});
