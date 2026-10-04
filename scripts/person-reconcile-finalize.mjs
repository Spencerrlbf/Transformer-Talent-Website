#!/usr/bin/env node
// Finalize a paused reconciliation run whose source scan is complete. Run locally.
// The destination is the explicitly selected project (PERSON_TARGET_PROJECT_REF):
// the website database, a disposable copy, or a loopback fixture. Nothing here
// defaults to the original project (release review RR-06).
//
//   PERSON_TARGET_PROJECT_REF=<ref> PERSON_PUBLISH_DATABASE_URL=<5432 session url> \
//     node scripts/person-reconcile-finalize.mjs --run-id=<run-id>
//   PERSON_TARGET_PROJECT_REF=<ref> node scripts/person-reconcile-finalize.mjs \
//     --run-id=<run-id> --workdir=<supabase CLI workdir linked to that same ref>
//
// With SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY also set, the PostgreSQL path
// proves REST and PostgreSQL reach the same cluster (person_target_identity())
// before finishing. No password appears in logs; output is the finish result.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {checkNode} from './check-node.mjs';
import {checkLinkedWorkdir,checkDatabaseUrl,checkRestUrl,checkServiceKey,selectedTarget,verifyRuntimeIdentity,IDENTITY_SQL,isTargetError} from './person-target.mjs';

export const RUN=/^[a-zA-Z0-9_-]{1,100}$/;
export function parseArgs(argv){
 const args=new Map();
 for(const x of argv){const i=x.indexOf('=');if(!x.startsWith('--')||i<0)throw Error('finalize_option');args.set(x.slice(0,i),x.slice(i+1));}
 for(const k of args.keys())if(!['--run-id','--workdir'].includes(k))throw Error('finalize_option');
 const run=args.get('--run-id');
 if(!RUN.test(run??''))throw Error('finalize_run_id');
 return {run,workdir:args.get('--workdir')};
}
/** The guard and finish statements, as one bounded transaction. */
export function finalizeSql(run){
 if(!RUN.test(run))throw Error('finalize_run_id');
 return `begin;
set local statement_timeout='8s';
set local lock_timeout='2s';
do $guard$ begin
 if not exists(select 1 from public.backfill_runs where run_id='${run}' and status='paused' and notes->>'kind'='reconcile' and notes->>'source_scan_complete'='true') then raise exception 'Source scan is not ready for finalization';end if;
end $guard$;
select public.person_reconcile_finish('${run}',(select (notes->>'external_stable')::boolean from public.backfill_runs where run_id='${run}'));
commit;`;
}
export function safeReason(error){
 const message=error?.message??'';
 if(/^(finalize_|person_)[a-z_:0-9-]+$/.test(message)||/^node_runtime:[a-z_]+:v[0-9.]+$/.test(message))return message;
 return `operation_failed:${/^[0-9A-Z]{5}$/.test(error?.code??'')?error.code:'unknown'}`;
}
/** Dependencies are replaceable only by offline tests. */
export async function main(argv=process.argv.slice(2),{env=process.env,readFile=fs.readFileSync,exec=execFileSync,connect,fetchFn=globalThis.fetch,out=x=>process.stdout.write(x)}={}){
 checkNode();
 const {run,workdir}=parseArgs(argv);
 const target=selectedTarget(env);
 if(workdir){
  if(env.PERSON_PUBLISH_DATABASE_URL)throw Error('finalize_one_destination');
  const directory=path.resolve(workdir);
  let ref;
  try{ref=readFile(path.join(directory,'supabase/.temp/project-ref'),'utf8');}catch{throw Error('person_target:workdir_mismatch');}
  checkLinkedWorkdir(ref,target);
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'person-finalize-'));
  try{
   const file=path.join(tmp,'finish.sql');
   fs.writeFileSync(file,finalizeSql(run),{mode:0o600});
   const output=exec(env.SUPABASE_CLI??'supabase',['db','query','--linked','--workdir',directory,'-f',file],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
   out(output);return {run,target:target.ref,via:'cli'};
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
 }
 const url=env.PERSON_PUBLISH_DATABASE_URL;
 if(!url)throw Error('finalize_destination_required');
 const id=checkDatabaseUrl(url,target,{ports:['5432']});
 if(env.SUPABASE_URL!==undefined)checkRestUrl(env.SUPABASE_URL,target);
 if(env.SUPABASE_SERVICE_ROLE_KEY!==undefined)checkServiceKey(env.SUPABASE_SERVICE_ROLE_KEY,target);
 const open=connect??(async()=>{
  const {default:pg}=await import('pg');
  const client=new pg.Client({connectionString:url,ssl:id.kind==='local'?false:{rejectUnauthorized:false},application_name:'tt-person-finalize',connectionTimeoutMillis:10000,statement_timeout:8000,query_timeout:9000});
  client.on('error',()=>{});
  await client.connect();return client;
 });
 const client=await open();
 try{
  const readDatabase=async()=>(await client.query(IDENTITY_SQL)).rows[0].identity;
  const readRest=env.SUPABASE_URL&&env.SUPABASE_SERVICE_ROLE_KEY?async()=>{
   const res=await fetchFn(`${env.SUPABASE_URL.replace(/\/+$/,'')}/rest/v1/rpc/person_target_identity`,{method:'POST',headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});
   if(!res.ok)throw Error(`HTTP_${res.status}`);
   return res.json();
  }:undefined;
  const identity=await verifyRuntimeIdentity({readRest,readDatabase});
  // Multi-statement text: pg returns one result per statement. Take the finish SELECT
  // by content, never by position; anything else is a changed script, not a success.
  const results=await client.query(finalizeSql(run));
  const result=Array.isArray(results)?results.find(r=>r?.rows?.[0]&&Object.hasOwn(r.rows[0],'person_reconcile_finish')):null;
  if(!result)throw Error('finalize_result');
  const finish=result.rows[0];
  out(JSON.stringify({phase:'reconcile_finalized',run,target:target.ref,system_identifier:identity.system_identifier,result:finish})+'\n');
  return {run,target:target.ref,via:'postgres',result:finish};
 }finally{await client.end().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(error=>{console.error(JSON.stringify({phase:'reconcile_finalize_stopped',reason:isTargetError(error)?error.message:safeReason(error)}));process.exitCode=1;});
