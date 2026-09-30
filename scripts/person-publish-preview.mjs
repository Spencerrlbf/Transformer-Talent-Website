#!/usr/bin/env node
// READ-ONLY. A projection comparison over the pool: for every migrated
// person, changes to today's candidate columns, computed
// with the same compatibilityProjection the live publish uses, over the same
// REST reader the trial and reconciliation runs use. Nothing is written.
//
//   node scripts/build-worker-lib.mjs
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/person-publish-preview.mjs [options]
//   (or LOCAL_DATABASE_URL=... for a local test database)
//
//   --limit=N          people to consider (default 1000000)
//   --batch-size=N     people per page, 1..500 (default 500)
//   --after=<uuid>     start after this id
//   --ids=a,b,c        an explicit bounded list (max 500)
//   --out=<path>       private per-person detail: id, status, changed column
//                      NAMES, collision flags. Never values. Keep it local.
//   --collision-ids=N  how many collision candidate ids to print (default 2000)
//   --max-seconds=N    pause after the current bounded page (default 600)
//   --max-db-bytes=N   database size ceiling (default 34000000000)
//
// Requires the prepared person_projection_state schema; missing read access
// fails closed. This is not an anchor/audit/transactional eligibility check.
// Output states whether traversal exhausted, hit its limit, paused or stopped;
// resume with --after=<last_id>. Each invocation reports only its own counts.
//
// From GitHub Actions: dispatch person-trial.yml with dry_run TICKED and
// backfill = {"reconcile":true,"preview":true,...}. "reconcile" only selects
// the read-only concurrency group; "preview" routes here before any
// reconciliation code runs. Logs carry ids, counts and column names only.
//
// Reported per person: unchanged | changed | held | missing | drift, with a
// separate review flag for open identity/contact conflicts. For email: whether the
// projected address differs from today's, whether another candidates row
// already holds it (the legacy unique constraint: publish would keep today's
// address and record a review item), and whether candidate_emails_v2 lists it
// under a different candidate (historical, informational).
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {openSite,selectIn,readNew,projectionInput,candidatesRows} from './person-trial.mjs';
import {mapBounded} from './person-backfill/engine.mjs';
import {parseOptions,safeReason,log,capacityGate} from './person-publish/lib.mjs';

export const SPEC={
 limit:{type:'int',min:1,max:1000000,default:1000000},
 'batch-size':{type:'int',name:'batch',min:1,max:500,default:500},
 after:{type:'uuid',default:null},
 ids:{type:'uuids',max:500,default:null},
 out:{type:'text',max:1000,default:null},
 'collision-ids':{type:'int',name:'collisionIds',min:0,max:100000,default:2000},
 'max-seconds':{type:'int',name:'maxSeconds',min:1,max:18000,default:600},
 'max-db-bytes':{type:'int',name:'maxBytes',min:1000000,max:1000000000000,default:34000000000},
};
const PROFILE=['full_name','current_title','current_company','current_company_id','work_experience','education','education_schools','education_degrees','education_fields','top_skills','all_skills_text','previous_companies','headline','profile_summary','location','profile_picture_url','email','phone'];

async function migratedPage(site,options,after,size){
 if(options.ids){
  // Page the requested set itself. Missing state must be accounted for, not
  // mistaken for exhaustion before a later requested person is visited.
  return options.ids.filter(id=>!after||id>after).slice(0,size);
 }
 const filters=after?[['candidate_id','gt',after]]:[];
 const rows=await site.select('candidate_profile_state',{columns:'candidate_id',filters,order:'candidate_id.asc',limit:size});
 return rows.map(r=>r.candidate_id);
}
export async function previewPage({site,lib,ids}){
 const [stored,rows,holds,conflicts,projections]=await mapBounded([
  ()=>readNew(site,ids,{globalCounts:false}),
  ()=>candidatesRows(site,ids),
  ()=>selectIn(site,'person_source_holds','candidate_id',ids,{columns:'candidate_id',filters:[['resolved_at','is_null']],order:'candidate_id.asc'}),
  async()=>{const parts=[];for(let i=0;i<ids.length;i+=40)parts.push(ids.slice(i,i+40));
   return (await mapBounded(parts,4,part=>site.select('identity_conflicts',{columns:'candidate_ids',filters:[['status','eq','open'],['candidate_ids','ov',part]],order:'id.asc'}))).flat();},
  ()=>selectIn(site,'person_projection_state','candidate_id',ids,{columns:'candidate_id,profile_hash',order:'candidate_id.asc'}),
 ],4,fn=>fn());
 const published=new Map(projections.map(p=>[p.candidate_id,p]));
 const held=new Set(holds.map(h=>h.candidate_id));
 const reviewed=new Set(conflicts.flatMap(c=>c.candidate_ids??[]));
 const results=[];const wantEmails=new Map();
 for(const id of ids){
  const before=rows.get(id),state=stored.state.get(id);
  if(!before||!state){results.push({id,status:'missing'});continue;}
  if(held.has(id)){results.push({id,status:'held'});continue;}
  if(published.has(id)&&published.get(id).profile_hash!==lib.projectionProfileHash(before)){
   results.push({id,status:'drift',review:reviewed.has(id)});continue;
  }
  const tables=projectionInput(id,stored);
  // Collisions are resolved after the page is computed, with one lookup per page.
  const computed=await lib.compatibilityProjection({...tables,contact_ranks_authoritative:true},state,before,async()=>false);
  const projectedEmail=computed.after.email??null;
  if(projectedEmail&&projectedEmail!==(before.email??null))wantEmails.set(id,projectedEmail);
  results.push({id,status:computed.changedFields.length?'changed':'unchanged',review:reviewed.has(id),changed:[...computed.changedFields],projectedEmail,emailChanged:projectedEmail!==(before.email??null),emailCleared:!projectedEmail&&Boolean(before.email),emailInvalidated:computed.invalidatedKinds.has('email'),hadEmail:Boolean(before.email)});
 }
 const emails=[...new Set(wantEmails.values())];
 const [owners,v2]=emails.length?await mapBounded([
  ()=>selectIn(site,'candidates','email',emails,{columns:'id,email',order:'id.asc',chunk:20}),
  ()=>selectIn(site,'candidate_emails_v2','email_normalized',emails.map(e=>e.toLowerCase()),{columns:'candidate_id,email_normalized',order:'id.asc',chunk:20}),
 ],2,fn=>fn()):[[],[]];
 const ownerByEmail=new Map();for(const o of owners)ownerByEmail.set(o.email,[...(ownerByEmail.get(o.email)??[]),o.id]);
 const v2ByEmail=new Map();for(const r of v2)v2ByEmail.set(r.email_normalized,[...(v2ByEmail.get(r.email_normalized)??[]),r.candidate_id]);
 for(const r of results){
  if(['missing','held','drift'].includes(r.status))continue;
  const others=(ownerByEmail.get(r.projectedEmail)??[]).filter(x=>x!==r.id);
  r.emailCollision=r.emailChanged&&others.length>0;
  r.emailV2OtherOwner=r.emailChanged&&(v2ByEmail.get((r.projectedEmail??'').toLowerCase())??[]).some(x=>x!==r.id);
  // What publish does on a collision: keep today's address (so the email
  // column does not change) unless the normalized facts explicitly
  // invalidated it, in which case the column is cleared.
  if(r.emailCollision){
   if(r.emailInvalidated){r.emailCleared=r.hadEmail;}
   else{r.changed=r.changed.filter(k=>k!=='email');r.emailChanged=false;if(!r.changed.length)r.status='unchanged';}
  }
  delete r.projectedEmail;delete r.emailInvalidated;delete r.hadEmail;
 }
 return results;
}
export async function runPreview({site,lib,options,onProgress=log,now=Date.now}){
 options={...options,ids:options.ids?[...new Set(options.ids)].sort():null};
 const started=now();
 const totals={people:0,changed:0,unchanged:0,held:0,missing:0,drift:0,review:0,review_changed:0,email_changed:0,email_cleared:0,email_collision:0,email_v2_other_owner:0};
 const byColumn=Object.fromEntries(PROFILE.map(k=>[k,0]));
 const collisionIds=[];const detail=[];
 let after=options.after,considered=0,status='limit_reached';
 const scope=options.ids?'ids':options.after?'after':'all';
 const finish=(state,reason)=>{
  const summary={phase:state==='stopped'?'preview_stopped':'preview_finished',status:state,comparison_only:true,
   scope,population:options.ids?'requested_ids':'normalized_profiles',start_after:options.after,last_id:after,full_migrated_scan:scope==='all'&&state==='exhausted',
   ...totals,by_column:{...byColumn},collision_ids:[...collisionIds],seconds:Math.round((now()-started)/1000),...(reason?{reason}:{})};
  if(options.out){fs.mkdirSync(path.dirname(path.resolve(options.out)),{recursive:true});fs.writeFileSync(options.out,JSON.stringify({summary,people:detail},null,1),{mode:0o600});}
  onProgress(summary);return summary;
 };
 const capacity=capacityGate({query:async()=>{
  const metrics=await site.rpc('person_backfill_metrics',{});
  for(const key of ['database_bytes','blocked_sessions']){
   const value=metrics?.[key];
   if(!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isSafeInteger(Number(value))||Number(value)<0)throw Error('preview_capacity');
  }
  return {rows:[{result:metrics}]};
 }},{maxBytes:options.maxBytes,now});
 const gate=async()=>{try{return await capacity();}catch(error){
  if(['publish_capacity','publish_latency'].includes(error.message))throw Error(error.message.replace('publish_','preview_'));throw error;
 }};
 const expired=()=>now()-started>=options.maxSeconds*1000;
 onProgress({phase:'preview_start',comparison_only:true,scope,limit:options.limit,batch:options.batch,after,max_seconds:options.maxSeconds,max_db_bytes:options.maxBytes});
 try{
  for(let i=0;i<3;i++){if(expired())return finish('paused');await gate();}
  while(considered<options.limit){
   if(expired()){status='paused';break;}
   const metrics=await gate();
   if(expired()){status='paused';break;}
   const size=Math.min(options.batch,options.limit-considered);
   const ids=await migratedPage(site,options,after,size);
   if(!ids.length){status='exhausted';break;}
   if(ids.length>size||ids.some((id,i)=>!/^([0-9a-f]{8}-)([0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)||(i?id<=ids[i-1]:after&&id<=after)))throw Error('preview_page_coverage');
   const results=await previewPage({site,lib,ids});
   if(results.length!==ids.length||results.some((r,i)=>r.id!==ids[i]||!['changed','unchanged','held','missing','drift'].includes(r.status)))throw Error('preview_page_coverage');
   for(const r of results){
    totals.people++;totals[r.status]=(totals[r.status]??0)+1;
    if(r.review){totals.review++;if(r.status==='changed')totals.review_changed++;}
    for(const k of r.changed??[])byColumn[k]=(byColumn[k]??0)+1;
    if(r.emailChanged)totals.email_changed++;
    if(r.emailCleared)totals.email_cleared++;
    if(r.emailCollision){totals.email_collision++;if(collisionIds.length<options.collisionIds)collisionIds.push(r.id);}
    if(r.emailV2OtherOwner)totals.email_v2_other_owner++;
    if(options.out)detail.push(r);
   }
   after=ids.at(-1);considered+=ids.length;
   onProgress({phase:'preview_checkpoint',processed:totals.people,last_id:after,...totals,...metrics});
   if(ids.length<size||(options.ids&&after===options.ids.at(-1))){status='exhausted';break;}
  }
 return finish(status);
 }catch(error){finish('stopped',previewReason(error));throw error;}
}
const previewReason=error=>/^preview_[a-z_]+$/.test(error?.message??'')?error.message:safeReason(error);
export function previewDispatchArguments(dispatch){
 return ['limit','batch-size','after','collision-ids','max-seconds','max-db-bytes','ids'].filter(k=>dispatch[k]!==undefined).map(k=>`--${k}=${dispatch[k]}`);
}
export async function main(argv=process.argv.slice(2)){
 const options=parseOptions(argv,SPEC);
 const site=await openSite();
 try{const lib=await import('./dist/worker-lib.mjs');return await runPreview({site,lib,options});}
 finally{await site.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(error=>{console.error(JSON.stringify({phase:'preview_error',reason:previewReason(error)}));process.exit(1);});
