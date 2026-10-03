#!/usr/bin/env node
// Prepare one new queue catch-up using the actual accepted historical code.
// Creates only the run checkpoint; the operator opens its window before resume.
import path from 'node:path';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {selectedTarget,checkRestUrl,checkServiceKey,databaseIdentity,verifyRuntimeIdentity,isTargetError} from '../person-target.mjs';
export const PIN='c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc';
const CODES=new Set(['directory','session_connection_required','deadline','not_pinned','dirty_runtime','bundle_build','config','credentials','capacity','existing_run','response','target']);
export function reasonOf(error){
 if(isTargetError(error))return error.message;
 const code=error?.message?.replace(/^catchup_start:/,'');
 return CODES.has(code)?`catchup_start:${code}`:`operation_failed:${/^[0-9A-Z]{5}$/.test(error?.code??'')?error.code:'unknown'}`;
}
/** Never trust GITHUB_SHA or the parser's --commit label as checkout evidence.
 * Rebuild the ignored bundle from a clean pinned tree, then recheck that tree. */
export function verifyPinnedRuntime(dir){
 if(!dir)throw Error('catchup_start:directory');
 let root;
 try{root=fs.realpathSync(path.resolve(dir));}catch{throw Error('catchup_start:directory');}
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')));
 const git=(...args)=>execFileSync('git',['-C',root,...args],{env,encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}).trim();
 try{if(fs.realpathSync(git('rev-parse','--show-toplevel'))!==root||git('rev-parse','HEAD')!==PIN)throw Error();}
 catch{throw Error('catchup_start:not_pinned');}
 const clean=()=>{try{git('diff','--exit-code',PIN,'--');}catch{throw Error('catchup_start:dirty_runtime');}};
 clean();
 try{execFileSync(process.execPath,['scripts/build-worker-lib.mjs'],{cwd:root,env,timeout:60000,stdio:['ignore','pipe','pipe']});}
 catch{throw Error('catchup_start:bundle_build');}
 clean();
 if(git('rev-parse','HEAD')!==PIN)throw Error('catchup_start:not_pinned');
 return {root,bundleHash:createHash('sha256').update(fs.readFileSync(path.join(root,'scripts/dist/worker-lib.mjs'))).digest('hex')};
}
/** Same read-only directory input used by the pinned translator, with bounded
 * connection/query waits. Failed acquisition closes its own client. */
export async function openReadOnlyDirectory(url,{Client=pg.Client}={}){
 const dsn=new URL(url);
 if(!['postgres:','postgresql:'].includes(dsn.protocol)||dsn.hash)throw Error('catchup_start:credentials');
 // URL options must not override the explicit bounds or connection target.
 for(const key of dsn.searchParams.keys())if(!['sslmode','sslrootcert','sslcert','sslkey'].includes(key))throw Error('catchup_start:credentials');
 dsn.search='';
 const local=['localhost','127.0.0.1','::1','[::1]'].includes(dsn.hostname);
 if(!local&&((dsn.port||'5432')!=='5432'||!(/^(db\.[a-z0-9-]+\.supabase\.co|[a-z0-9-]+\.pooler\.supabase\.com)$/.test(dsn.hostname))))throw Error('catchup_start:session_connection_required');
 const db=new Client({connectionString:dsn.toString(),ssl:local?false:{rejectUnauthorized:false},application_name:'tt-person-catchup-start',connectionTimeoutMillis:10000,statement_timeout:8000,query_timeout:9000});
 db.on('error',()=>{});
 try{await db.connect();await db.query("set statement_timeout='8s'");await db.query('set default_transaction_read_only=on');return db;}
 catch(error){await db.end().catch(()=>{});throw error;}
}
const load=(root,f)=>import(pathToFileURL(path.join(root,'scripts',f)).href);
/** Dependencies can be replaced only by offline fault-injection tests. */
export async function main(argv=process.argv.slice(2),{env=process.env,verify=verifyPinnedRuntime,importPinned=load,openDirectory=openReadOnlyDirectory,now=()=>performance.now(),out=x=>console.log(JSON.stringify(x))}={}){
 const started=now();
 if(argv.length)throw Error('catchup_start:config');
 const runtime=await verify(env.PINNED_RUNNER_DIR);
 const previous=process.cwd();let site,comms;
 try{
  process.chdir(runtime.root);
  const raw=JSON.parse(env.BACKFILL_CONFIG??'{}');
  if(raw.reconcile!==true||raw.scope!=='queue'||raw['dry-run']!==false||raw.resume===true)throw Error('catchup_start:config');
  if(!env.COMMS_DATABASE_URL||!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY||env.LOCAL_DATABASE_URL)throw Error('catchup_start:credentials');
  // The website destination is the explicitly selected project, never a built-in
  // default (RR-06). The communications source is a different project by contract.
  const target=selectedTarget(env);
  if(target.local)throw Error('catchup_start:target');
  checkRestUrl(env.SUPABASE_URL,target);
  checkServiceKey(env.SUPABASE_SERVICE_ROLE_KEY,target);
  if(databaseIdentity(env.COMMS_DATABASE_URL).ref===target.ref)throw Error('catchup_start:credentials');
  const {options}=await importPinned(runtime.root,'person-backfill.mjs');
  const {restSite,commsColumns}=await importPinned(runtime.root,'person-trial.mjs');
  const {externalFingerprint}=await importPinned(runtime.root,'person-reconcile.mjs');
  const config=options([],env);
  if(config.commit!==PIN||config.dry||config.resume||!Number.isFinite(config.maxSeconds)||config.maxSeconds<=0)throw Error('catchup_start:config');
  const checkTime=()=>{if(now()-started>=config.maxSeconds*1000)throw Error('catchup_start:deadline');};
  checkTime();
  site=restSite(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY);
  // Runtime proof that the REST destination is a real cluster that installed the
  // release chain; the identifier is recorded with the run evidence.
  const identity=await verifyRuntimeIdentity({readRest:()=>site.rpc('person_target_identity',{})});
  comms=await openDirectory(env.COMMS_DATABASE_URL);
  const existing=await site.select('backfill_runs',{columns:'run_id,status',filters:[['run_id','eq',config.run]],order:'run_id.asc'});
  if(existing.length)throw Error('catchup_start:existing_run');
  const metrics=await site.rpc('person_backfill_metrics',{});
  if(!Number.isFinite(Number(metrics.database_bytes))||Number(metrics.database_bytes)>=config.maxBytes||!Number.isFinite(Number(metrics.blocked_sessions))||Number(metrics.blocked_sessions)>5)throw Error('catchup_start:capacity');
  const lib=await importPinned(runtime.root,'dist/worker-lib.mjs');
  const hash=await externalFingerprint(site,comms,await commsColumns(comms),lib);
  checkTime();
  const state=await site.rpc('person_reconcile_start',{p_run:config.run,p_commit:PIN,p_limit:config.limit,p_batch:config.batch,p_resume:false,p_scope:'queue',p_external_hash:hash});
  if(state.run_id!==config.run||state.status!=='running')throw Error('catchup_start:response');
  const result={phase:'catchup_started',run:state.run_id,status:state.status,scope:'queue',commit:PIN,bundle_sha256:runtime.bundleHash,target:target.ref,system_identifier:identity.system_identifier,limit:config.limit,batch:config.batch};
  out(result);return result;
 }finally{
  await Promise.allSettled([Promise.resolve().then(()=>comms?.end()),Promise.resolve().then(()=>site?.end())]);
  process.chdir(previous);
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(error=>{console.error(JSON.stringify({phase:'catchup_start_stopped',reason:reasonOf(error)}));process.exitCode=1;});
