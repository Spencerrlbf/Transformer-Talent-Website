#!/usr/bin/env node
// Bounded legacy-witness preparation only. Historical migration accounting,
// source facts, external stores and live candidate fields are never changed.
import {pathToFileURL} from 'node:url';
import {openAnchorDatabase} from './person-audit/database.mjs';
import {retryTransient,safeErrorCode} from './person-backfill/engine.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function anchorOptions(argv=process.argv.slice(2)){
 const out={save:false,limit:1000,batch:20,after:null,maxSeconds:900,maxBytes:34000000000};
 const limits={limit:[1,1000000],batch:[1,100],'max-seconds':[1,18000],'max-bytes':[1000000,1000000000000]};
 for(const arg of argv){
  if(arg==='--save'){out.save=true;continue;}
  const m=/^--([a-z-]+)=(.+)$/.exec(arg);if(!m)throw Error('audit_option');
  if(m[1]==='after'){if(!uuid.test(m[2]))throw Error('audit_cursor');out.after=m[2].toLowerCase();continue;}
  const range=limits[m[1]],n=Number(m[2]);if(!range||!/^\d+$/.test(m[2])||!Number.isSafeInteger(n)||n<range[0]||n>range[1])throw Error('audit_option');
  out[{'max-seconds':'maxSeconds','max-bytes':'maxBytes'}[m[1]]??m[1]]=n;
 }
 return out;
}
export async function prepareAnchors({site,prepare,options,onProgress=()=>{},now=Date.now}){
 const started=now(),rpc=(fn,args)=>retryTransient(()=>site.rpc(fn,args));
 const state={phase:'anchor_checkpoint',dry_run:!options.save,after:options.after,scanned:0,ready:0,created:0,unchanged:0,review:0,pending:0};
 const samples=[];let normal=0,slow=0;
 const capacity=async()=>{const start=now(),m=await rpc('person_backfill_metrics',{}),elapsed=now()-start;
  if(!Number.isFinite(Number(m.database_bytes))||!Number.isFinite(Number(m.blocked_sessions))||Number(m.database_bytes)>=options.maxBytes||Number(m.blocked_sessions)>5)throw Error('audit_capacity');
  if(samples.length<3){samples.push(elapsed);if(samples.length===3)normal=[...samples].sort((a,b)=>a-b)[1];}
  else{slow=elapsed>Math.max(250,normal*2)?slow+1:0;if(slow>=3)throw Error('audit_latency');}
 };
 const finish=status=>{const result={...state,phase:'anchor_finished',status};onProgress(result);return result;};
 for(let i=0;i<3;i++)await capacity();
 while(state.scanned<options.limit){
  if(now()-started>=options.maxSeconds*1000)return finish('paused');
  const ids=await rpc('person_audit_anchor_page',{p_after:state.after,p_limit:Math.min(options.batch,options.limit-state.scanned)});
  if(!Array.isArray(ids)||ids.length>options.batch||ids.some((x,i)=>!uuid.test(x)||(i?x<=ids[i-1]:state.after&&x<=state.after)))throw Error('audit_page_coverage');
  if(!ids.length)return finish('scan_complete');
  const snapshots=await rpc('person_audit_anchor_inputs',{p_ids:ids});
  if(!Array.isArray(snapshots)||snapshots.length!==ids.length||snapshots.some((s,i)=>s.candidate_id!==ids[i]))throw Error('audit_input_coverage');
  const prepared=snapshots.map(prepare);
  if(prepared.some((s,i)=>s.candidate_id!==ids[i]||!['ready','review','anchored'].includes(s.status)))throw Error('audit_input_coverage');
  const ready=prepared.filter(x=>x.status==='ready'),delta={ready:ready.length,created:0,unchanged:prepared.filter(x=>x.status==='anchored').length,review:prepared.filter(x=>x.status==='review').length,pending:0};
  if(options.save)for(let i=0;i<ready.length;i+=10){
   const chunk=ready.slice(i,i+10),results=await rpc('person_audit_anchor_commit',{p_items:chunk});
   if(!Array.isArray(results)||results.length!==chunk.length||results.some((r,j)=>r.candidate_id!==chunk[j].candidate_id||!['created','unchanged','pending'].includes(r.status)))throw Error('audit_commit_coverage');
   for(const r of results)delta[r.status]++;
  }
  for(const [key,n] of Object.entries(delta))state[key]+=n;
  state.scanned+=ids.length;state.after=ids.at(-1);onProgress({...state});
  await capacity();
 }
 return finish('limit_reached');
}
export async function main(){
 const options=anchorOptions(),site=await openAnchorDatabase();
 try{
  const {prepareLegacyAuditAnchor}=await import('./dist/worker-lib.mjs');
  return await prepareAnchors({site,prepare:prepareLegacyAuditAnchor,options,onProgress:r=>console.log(JSON.stringify(r))});
 }finally{await site.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(error=>{const reason=/^audit_[a-z_]+$/.test(error.message??'')?error.message:`operation_failed:${safeErrorCode(error)}`;console.error(JSON.stringify({phase:'anchor_stopped',reason}));process.exitCode=1;});
