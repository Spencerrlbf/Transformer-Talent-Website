#!/usr/bin/env node
// A source reread with durable evidence accounting. Unattributed same-date
// mutations remain review items; never manufacture a newer fact timestamp.
import {pathToFileURL} from 'node:url';
import {options} from './person-backfill.mjs';
import {retryTransient,safeErrorCode} from './person-backfill/engine.mjs';
import {openSite,openComms,commsColumns,readAll,readDirectory,readNew,buildDocs,
 selectIn,groupBy,hashOf,Tally,checkDocs,checkStored,knownEmails,knownPhones,phoneKey,
 sourceNeedsReview,TT_ORG} from './person-trial.mjs';

export function directoryEvidenceHash(lib,row,id){
 if(!row)return null;
 return lib.fromDirectory(row.board,row.harvest,row.exps,row.edus,row.emails,row.phones,id).source.payload_hash;
}

function evidenceInputs(input,events,id){
 const all=[input];
 for(const event of events){
  for(const row of [event.previous_payload,event.payload]){
   if(!row)continue;
   const next={...input};
   if(event.source_table==='candidates'){
    if(row.id!==id)throw Error('source_event_identity');
    next.row={...input.row,...row};
   }else{
    if(row.candidate_id!==id)continue;
    const mapping={candidate_emails:'legacy',candidate_enrichments:'ledger',website_applications:'apps',candidate_communications:'comms'};
    const key=mapping[event.source_table];if(!key)throw Error('source_event_table');
    if(['ledger','apps'].includes(key)&&row.organization_id!==TT_ORG)throw Error('source_event_tenancy');
    if(key==='ledger'&&(row.provider!=='harvest'||row.status!=='ok'))continue;
    if(key==='comms'&&(row.communication_type!=='email'||!['bounced','replied'].includes(row.status)))continue;
    next[key]=[...input[key].filter(x=>x.id!==row.id),row];
    // Match readSources exactly: an unchanged event must not perturb a
    // translator's deterministic equal-date contact tie-break.
    next[key].sort((a,b)=>(['ledger','apps'].includes(key)?Date.parse(a.created_at)-Date.parse(b.created_at):0)||String(a.id).localeCompare(String(b.id)));
   }
   all.push(next);
  }
 }
 return all;
}

export async function prepareEvidence(lib,id,input,events,storedSources){
 if(events.length>200) return {review:'event_limit',hash:hashOf(events.map(e=>e.id))};
 const inputs=evidenceInputs(input,events,id),byHash=new Map(),snapshots=new Map();const tally=new Tally();
 const reused=inputs.flatMap(inp=>inp.ledger).filter(row=>row.cache_status==='hit'&&row.raw_payload);
 if(reused.length)return {review:'harvest_cache_date_unknown',hash:hashOf(reused)};
 for(const inp of inputs){
  const built=await buildDocs(lib,id,inp);if(built.errors.length)throw Error('source_translation');
  checkDocs(tally,id,inp,built.docs);
  for(const doc of built.docs){
   byHash.set(`${doc.source.source}:${doc.source.payload_hash}`,doc);
   const key=JSON.stringify([doc.source.source,doc.source.source_ref,doc.source.fetched_at]);
   if(!snapshots.has(key))snapshots.set(key,new Set());snapshots.get(key).add(doc.source.payload_hash);
  }
 }
 if(tally.fail.size)throw Error(`pre_save_integrity:${[...tally.fail.keys()].join(',')}`);
 const docs=[...byHash.values()].sort((a,b)=>Date.parse(a.source.fetched_at)-Date.parse(b.source.fetched_at)||a.source.payload_hash.localeCompare(b.source.payload_hash));
 const hash=hashOf(docs.map(d=>[d.source.source,d.source.source_ref,d.source.fetched_at,d.source.payload_hash]).sort());
 if([...snapshots.values()].some(x=>x.size>1)||docs.some(d=>sourceNeedsReview(storedSources,d,false)))return {review:'same_snapshot_mutation',hash};
 const needsSave=docs.some(d=>!storedSources.some(s=>s.source===d.source.source&&s.payload_hash===d.source.payload_hash&&s.parser_version===d.source.parser_version));
 return {docs,inputs,hash,needsSave};
}

export async function reconcilePage({site,lib,comms,cols,config,page,afterSave,beforeRecord,afterRecord}){
 const rpc=(fn,args)=>retryTransient(()=>site.rpc(fn,args));
 const ids=page.map(x=>x.id),versions=new Map(page.map(x=>[x.id,Number(x.captured_version)]));
 const before=await readAll(site,ids,comms,cols,false);
 if(before.rows.size!==ids.length||before.dirMissing||before.dirSkipped)throw Error('source_coverage');
 const events=groupBy(await selectIn(site,'person_change_events','candidate_id',ids,{order:'candidate_id.asc,id.asc'}),'candidate_id');
 const sources=groupBy(await selectIn(site,'candidate_sources','candidate_id',ids,{order:'candidate_id.asc,id.asc'}),'candidate_id');
 const holds=groupBy(await selectIn(site,'person_source_holds','candidate_id',ids,{filters:[['resolved_at','is_null',null]],columns:'candidate_id,ledger_id,evidence_hash,reason',order:'candidate_id.asc,ledger_id.asc,evidence_hash.asc'}),'candidate_id');
 const prepared=new Map();
 for(const id of ids)prepared.set(id,holds.has(id)?{review:'harvest_cache_date_unknown',hash:hashOf(holds.get(id))}:await prepareEvidence(lib,id,before.inputs.get(id),events.get(id)??[],sources.get(id)??[]));
 const ready=ids.filter(id=>!prepared.get(id).review);
 const toSave=ready.filter(id=>prepared.get(id).needsSave);
 if(config.dry)return {processed:ids.length,review:ids.length-ready.length};
 const saved=new Map();
 for(let i=0;i<toSave.length;i+=10){
  const chunk=toSave.slice(i,i+10);
  const rows=await rpc('person_backfill_save_many',{p_run:config.run,p_items:chunk.map(id=>({candidate_id:id,docs:prepared.get(id).docs,version:versions.get(id)}))});
  if(rows.length!==chunk.length||rows.some((r,n)=>r.candidate_id!==chunk[n]))throw Error('source_bulk_result_mismatch');
  for(const row of rows)saved.set(row.candidate_id,row);
 }
 if(afterSave)await afterSave();
 const stored=ready.length?await readNew(site,ready,{globalCounts:false}):null;
 const v2=groupBy(await selectIn(site,'candidate_emails_v2','candidate_id',ready,{order:'id.asc'}),'candidate_id');
 const dirIds=ready.map(id=>before.inputs.get(id).row.directory_contact_id).filter(Boolean);
 const directory=dirIds.length?await readDirectory(comms,dirIds,cols):new Map();
 const records=[];const tally=new Tally();
 for(const id of ids){
  const data=prepared.get(id),common={candidate_id:id,version:versions.get(id),source_hash:data.hash};
  if(data.review){records.push({...common,status:'review',revision:null,checks:{reason:data.review}});continue;}
  const inp=before.inputs.get(id);
  const result=checkStored(tally,id,inp,data.docs,stored,lib);
  const contacts=stored.contacts.get(id)??[];
  const emails=new Set(contacts.filter(c=>c.kind==='email').map(c=>c.value_normalized));
  const phones=new Set(contacts.filter(c=>c.kind==='phone').map(c=>phoneKey(c.value_normalized)));
  for(const old of data.inputs){
   for(const email of knownEmails(old).keys())if(!emails.has(email))throw Error('post_save_event_email_missing');
   for(const phone of knownPhones(old))if(!phones.has(phone))throw Error('post_save_event_phone_missing');
  }
  const {_projection,...checks}=result;
  const externalStable=hashOf(inp.v2)===hashOf(v2.get(id)??[])&&(!inp.row.directory_contact_id||directoryEvidenceHash(lib,inp.dir,id)===directoryEvidenceHash(lib,directory.get(inp.row.directory_contact_id),id));
  records.push({...common,status:externalStable?'verified':'pending',revision:saved.get(id)?.revision??stored.state.get(id)?.rev,checks:{...checks,integrity_ok:true,external_stable:externalStable}});
 }
 if(tally.fail.size)throw Error(`post_save_integrity:${[...tally.fail.keys()].join(',')}`);
 if(beforeRecord)await beforeRecord();
 for(let i=0;i<records.length;i+=100)await rpc('person_reconcile_record_many',{p_run:config.run,p_items:records.slice(i,i+100)});
 if(afterRecord)await afterRecord();
 return rpc('person_reconcile_checkpoint',{p_run:config.run,p_ids:ids});
}

// The two external stores have no website capture trigger. Read bounded source
// snapshots at both scan boundaries and require matching hashes. No DDL/writes
// run on either external store. A change requires another source scan.
export async function externalFingerprint(site,comms,cols,lib){
 const v2=await site.rpc('person_reconcile_v2_fingerprint',{});
 const links=(await site.select('candidates',{columns:'id,directory_contact_id',filters:[['directory_contact_id','not_null']],order:'id.asc'})).map(({id,directory_contact_id})=>({id,directory_contact_id}));
 const ids=[...new Set(links.map(x=>x.directory_contact_id))].sort();const hashes=[];
 if(ids.length&&!comms)throw Error('source_directory_unavailable');
 for(let i=0;i<ids.length;i+=500){
  const chunk=ids.slice(i,i+500),rows=await readDirectory(comms,chunk,cols);
  if(rows.size!==chunk.length)throw Error('source_directory_coverage');
  for(const id of chunk)hashes.push([id,directoryEvidenceHash(lib,rows.get(id),id)]);
 }
 return hashOf({v2,links,hashes});
}

export async function main(){
 const config=options();const raw=JSON.parse(process.env.BACKFILL_CONFIG??'{}');config.scope=raw.scope??'all';
 if(!['all','queue','directory'].includes(config.scope))throw Error('source_invalid_scope');
 const site=await openSite();let comms,started=false;const start=Date.now();let processed=0,after=null;
 try{
  const lib=await import('./dist/worker-lib.mjs');
  if(process.env.COMMS_DATABASE_URL)comms=await openComms(process.env.COMMS_DATABASE_URL);
  const cols=comms?await commsColumns(comms):null;
  const metrics=await site.rpc('person_backfill_metrics',{});if(metrics.database_bytes>=config.maxBytes)throw Error('capacity_limit');
  let initial=await externalFingerprint(site,comms,cols,lib);
  if(!config.dry){const state=await site.rpc('person_reconcile_start',{p_run:config.run,p_commit:config.commit,p_limit:config.limit,p_batch:config.batch,p_resume:config.resume,p_scope:config.scope,p_external_hash:initial});started=true;processed=state.processed;initial=state.notes.external_hash;}
  const samples=[];for(let i=0;i<3;i++){const t=Date.now();await site.rpc('person_backfill_metrics',{});samples.push(Date.now()-t);}
  const normal=samples.sort((a,b)=>a-b)[1];let slow=0;
  console.log(JSON.stringify({phase:'reconcile_start',run:config.run,dry_run:config.dry,scope:config.scope,commit:config.commit,external_hash:initial,processed}));
  while(processed<config.limit){
   if((Date.now()-start)/1000>config.maxSeconds){if(started)await site.rpc('person_backfill_status',{p_run:config.run,p_status:'paused',p_notes:{reconciliation_pending:true}});return;}
   const page=config.dry?await site.rpc('person_reconcile_preview_page',{p_after:after,p_size:Math.min(config.batch,config.limit-processed),p_scope:config.scope}):await site.rpc('person_reconcile_page',{p_run:config.run,p_size:config.batch});
   if(!page.length)break;
   const result=await reconcilePage({site,lib,comms,cols,config,page});processed=config.dry?processed+page.length:result.processed;after=page.at(-1).id;
   const t=Date.now(),metrics=await site.rpc('person_backfill_metrics',{}),latency=Date.now()-t;
   slow=latency>Math.max(250,normal*2)?slow+1:0;
   console.log(JSON.stringify({phase:'reconcile_checkpoint',run:config.run,processed,query_ms:latency,...metrics}));
   if(metrics.database_bytes>=config.maxBytes||metrics.blocked_sessions>5||slow>=3)throw Error('capacity_or_latency_gate');
  }
  const finalHash=await externalFingerprint(site,comms,cols,lib),externalStable=initial===finalHash;
  // Final accounting uses a separate, explicitly timed SQL statement. A
  // function-level timeout does not bound an already-running PostgREST RPC.
  if(started)await site.rpc('person_backfill_status',{p_run:config.run,p_status:'paused',p_notes:{source_scan_complete:true,external_stable:externalStable,external_end_hash:finalHash,source_scan_completed_at:new Date().toISOString()}});
  console.log(JSON.stringify({phase:started?'source_scan_complete':'reconcile_dry_complete',run:config.run,processed,external_stable:externalStable,finalization_pending:started,seconds:Math.round((Date.now()-start)/1000)}));
 }catch(error){
  const reason=/^(source_|pre_save_|post_save_|capacity_)/.test(error.message)?error.message:`operation_failed:${safeErrorCode(error)}`;
  if(started)await site.rpc('person_backfill_status',{p_run:config.run,p_status:'failed',p_notes:{error_code:reason,reconciliation_pending:true}}).catch(()=>{});
  console.error(JSON.stringify({phase:'reconcile_stopped',run:config.run,reason,processed}));throw Error(reason);
 }finally{await comms?.end();await site.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{process.exitCode=1;});
