// Local, rollback-only application-admission rehearsal. This intentionally has
// no website target or apply mode. It never runs enrichment or the whole worker.
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {denyOutboundExceptDatabase} from './network.mjs';
const TT='801865a7-6533-41d2-9c45-e4a90e6ad51a';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function localConfig(raw=process.env.LOCAL_DATABASE_URL){
 let u;try{u=new URL(raw);}catch{throw Error('canary_local_database');}
 if(!['postgres:','postgresql:'].includes(u.protocol)||!['localhost','127.0.0.1'].includes(u.hostname)||u.pathname!=='/person_canary_test'||u.search||u.hash||!/^\d+$/.test(u.port)||+u.port<1||+u.port>65535)throw Error('canary_local_database');
 return {connectionString:u.href,max:2,statement_timeout:8000,query_timeout:9000,connectionTimeoutMillis:5000,options:'-c timezone=UTC',port:Number(u.port)};
}
export function options(argv=process.argv.slice(2)){
 let mode='shadow';if(argv.length>1)throw Error('canary_option');
 if(argv.length){if(!/^--mode=(shadow|live)$/.test(argv[0]))throw Error('canary_option');mode=argv[0].split('=')[1];}
 return {mode};
}
export function newManifest(){return {organizationId:TT,applicationId:randomUUID(),username:`zzcanary-${randomUUID().replaceAll('-','')}`};}
function checkManifest(m){
 if(Object.keys(m).sort().join(',')!=='applicationId,organizationId,username'||m.organizationId!==TT||!uuid.test(m.applicationId)||!/^zzcanary-[a-f0-9]{32}$/.test(m.username))throw Error('canary_manifest');
}
const canonical=value=>value&&typeof value==='object'?Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')}}`:JSON.stringify(value);
// Whole-table reads are bounded and allowed ONLY in the disposable local DB.
// They are explicitly not a production footprint or concurrency fence.
export async function snapshot(client){
 const tables=(await client.query("select schemaname,tablename from pg_tables where schemaname in('public','person_private') order by schemaname,tablename")).rows;
 const out={};let bytes=0,total=0;
 for(const {schemaname,tablename} of tables){
  if(!/^[a-z_][a-z0-9_]*$/.test(tablename))throw Error('canary_table');
  const rows=(await client.query(`select to_jsonb(t) r from "${schemaname}"."${tablename}" t limit 1001`)).rows.map(r=>r.r);
  total+=rows.length;bytes+=Buffer.byteLength(JSON.stringify(rows));
  if(rows.length>1000||total>10000||bytes>8000000)throw Error('canary_fixture_limit');
  out[`${schemaname}.${tablename}`]=rows.sort((a,b)=>canonical(a).localeCompare(canonical(b)));
 }
 return out;
}
const candidateTables=new Set(['candidate_profile_state','candidate_sources','candidate_identities','candidate_contacts','person_projection_state','person_projection_history','person_audit_anchors','person_audit_operations','person_change_attributions','person_change_queue','person_derivative_jobs']);
export function footprint(before,after,manifest,candidateId){
 if(Object.keys(before).join('|')!==Object.keys(after).join('|'))throw Error('canary_scope_schema');
 const owned=(table)=>new Set((after[`public.${table}`]??[]).filter(r=>r.candidate_id===candidateId).map(r=>String(r.id)));
 const sources=owned('candidate_sources'),events=owned('person_change_events'),operations=owned('person_audit_operations');
 const references=(table,row)=>{
  for(const [key,value] of Object.entries(row)){
   if(key.endsWith('source_id')&&value!=null&&!sources.has(String(value)))return false;
   if(key==='event_id'&&(value==null||!events.has(String(value))))return false;
   if(key==='operation_id'&&(value==null||!operations.has(String(value))))return false;
   if(key==='application_id'&&value!==manifest.applicationId)return false;
   if(['enrichment_id','harvest_ledger_id','ledger_id'].includes(key)&&value!=null)return false;
   if(['receipt_ref','creator_ref'].includes(key)&&value!=null&&value!==`application:${manifest.applicationId}`)return false;
  }
  if(['candidate_contacts','candidate_identities'].includes(table)&&!sources.has(String(row.source_id)))return false;
  return true;
 };
 let changed=0;
 for(const [key,rows] of Object.entries(after)){
  const old=new Map();for(const row of before[key]){const s=canonical(row);old.set(s,(old.get(s)??0)+1);}
  const added=[];
  for(const row of rows){const s=canonical(row);if(old.get(s)>0)old.set(s,old.get(s)-1);else added.push(row);}
  if([...old.values()].some(n=>n!==0))throw Error('canary_scope_baseline');
  if(!added.length)continue;changed++;
  const [schema,table]=key.split('.');
  for(const row of added){
   let allowed=false;
   if(schema==='public'){
    if(candidateTables.has(table))allowed=row.candidate_id===candidateId;
    else if(table==='candidates')allowed=row.id===candidateId&&row.linkedin_username===manifest.username;
    else if(table==='website_applications')allowed=row.id===manifest.applicationId&&row.organization_id===TT&&row.candidate_id===candidateId;
    else if(table==='person_application_receipts')allowed=row.application_id===manifest.applicationId&&row.candidate_id===candidateId&&row.created_person===true;
    else if(table==='person_change_events')allowed=row.candidate_id===candidateId&&((row.source_table==='candidates'&&row.source_row_id===candidateId)||(row.source_table==='website_applications'&&row.source_row_id===manifest.applicationId));
    else if(table==='person_audit_epochs')allowed=row.scope_kind==='candidate'&&row.scope_key===candidateId;
   }
   if(!allowed)throw Error('canary_scope_added');
   if(!references(table,row))throw Error('canary_scope_reference');
  }
 }
 return changed;
}
export async function rehearse({url,mode='shadow',manifest=newManifest(),beforeVerify}={}){
 const config=localConfig(url);checkManifest(manifest);if(!['shadow','live'].includes(mode))throw Error('canary_mode');
 const restore=denyOutboundExceptDatabase(config.port),pool=new pg.Pool(config);
 let client,baseline,result,backend,stopped=false;
 const stop=Error('canary_verified_rollback');
 try{
  // No CLI/environment file loader is imported. Provider credentials cannot be
  // used: fetch and non-database sockets are denied throughout this invocation.
  const lib=await import('../dist/worker-lib.mjs');
  const {planAudit}=await import('../person-audit/postcutover.mjs');
  client=await pool.connect();
  const target=(await client.query('select current_database() n,pg_backend_pid() pid')).rows[0];
  if(target.n!=='person_canary_test')throw Error('canary_local_database');backend=target.pid;
  if(!(await client.query('select person_write_guard_status() s')).rows[0].s.enabled)throw Error('canary_guard_required');
  baseline=await snapshot(client);
  try{
   await lib.saveApplicationPersonOnConnection(client,{
    organizationId:TT,applicationId:manifest.applicationId,linkedinUsername:manifest.username,
    name:'Synthetic admission canary',parsed:{current_title:'Synthetic candidate'},resumeText:'Synthetic resume for rollback-only admission.',mode,
   },{
    afterBegin:async tx=>{
     await tx.query("set local statement_timeout='8s';set local lock_timeout='2s'");
     await tx.query('select pg_advisory_xact_lock(72007,hashtext($1))',[manifest.username]);
     const occupied=(await tx.query(`select exists(select 1 from website_applications where id=$1)
      or exists(select 1 from candidates where lower(linkedin_username)=$2)
      or exists(select 1 from candidate_identities where (kind='linkedin_username' and lower(value)=$2) or (kind='tt_application_id' and value=$1::text)) occupied`,[manifest.applicationId,manifest.username])).rows[0].occupied;
     if(occupied)throw Error('canary_identity_occupied');
     await tx.query("insert into website_applications(id,organization_id,name,email,linkedin_username,status) values($1,$2,'Synthetic admission canary',$3,$4,'queued')",[manifest.applicationId,TT,`${manifest.username}@example.test`,manifest.username]);
    },
    beforeCommit:async(tx,admitted)=>{
     if(!admitted.created||baseline['public.candidates'].some(r=>r.id===admitted.candidateId))throw Error('canary_incumbent');
     await beforeVerify?.(tx,admitted);
     // A plain rollback would skip deferred commit-time attribution checks.
     await tx.query("set local statement_timeout='8s';set constraints all immediate");
     const after=await snapshot(tx),changedTables=footprint(baseline,after,manifest,admitted.candidateId);
     const witness=(await tx.query('select person_postcutover_audit_inputs_with_witness($1::jsonb) r',[JSON.stringify([admitted.candidateId])])).rows[0].r[0];
     const plan=planAudit(witness,lib);
     if(plan.status!=='verified'||!plan.checks.creation_event)throw Error('canary_receipt_proof');
     const receipts=after['public.person_application_receipts'].filter(r=>r.application_id===manifest.applicationId);
     const projections=after['public.person_projection_state'].filter(r=>r.candidate_id===admitted.candidateId);
     const derivatives=after['public.person_derivative_jobs'].filter(r=>r.candidate_id===admitted.candidateId);
     if(receipts.length!==1||projections.length!==1||derivatives.length!==(mode==='live'?1:0)||derivatives.some(r=>r.status!=='pending'||r.attempts!==0))throw Error('canary_outcome');
     result={scope:'local_application_admission',mode,status:'rolled_back',precommit_planner:'verified',receipts:1,initial_projection:true,derivative_jobs:derivatives.length,changed_tables:changedTables,production_ready:false};
     throw stop;
    },
   });
  }catch(error){if(error===stop)stopped=true;else throw error;}
  if(!stopped)throw Error('canary_did_not_rollback');
  client.release(true);client=null;
  const check=await pool.connect();try{if((await check.query('select pg_backend_pid() pid')).rows[0].pid===backend)throw Error('canary_independent_connection');if(canonical(await snapshot(check))!==canonical(baseline))throw Error('canary_rollback_incomplete');}finally{check.release();}
  return result;
 }finally{if(client){await client.query('rollback').catch(()=>{});client.release();}await pool.end();restore();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify(await rehearse({url:process.env.LOCAL_DATABASE_URL,...options()})));}
 catch(error){console.error(JSON.stringify({status:'failed',reason:/^canary_[a-z_]+$/.test(error.message??'')?error.message:'canary_operation_failed'}));process.exitCode=1;}
}
