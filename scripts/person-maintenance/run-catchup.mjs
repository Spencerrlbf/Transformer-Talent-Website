#!/usr/bin/env node
// Runs the PINNED catch-up (the historical translator at c4d0e4e, exactly as the
// runbook's "actual pinned CLI with the identical configuration plus resume:true")
// from the release checkout, with the one thing the pinned runner lacks: explicit
// handling of the directory connection's transport failures.
//
//   PINNED_RUNNER_DIR=<clean c4d0e4e checkout> PERSON_TARGET_PROJECT_REF=<ref> \
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… COMMS_DATABASE_URL=… \
//   BACKFILL_CONFIG='{"run-id":"…","reconcile":true,"scope":"queue","dry-run":false,"resume":true,…}' \
//   node scripts/person-maintenance/run-catchup.mjs
//
// What stays pinned: scripts/person-reconcile.mjs (the loop, the external
// fingerprint, the page translator reconcilePage), scripts/person-trial.mjs (restSite
// for the website over REST, openComms for the directory), dist/worker-lib.mjs (the
// translator bundle, rebuilt from the clean pinned tree and hashed), and every SQL
// checkpoint (person_reconcile_start/page/record_many: last_id advances only inside
// record_many's transaction, so a client failure can never advance it).
//
// What this helper adds, outside the pinned tree:
//   - the same Git/clean-tree/bundle verification the start helper performs;
//   - the configuration contract (reconcile, queue scope, not dry, resume) and the
//     explicit website selection (PERSON_TARGET_PROJECT_REF: REST URL and key claim);
//   - an 'error' listener on every pg.Client the pinned code creates, attached when
//     it connects. Without it an idle directory connection dropped by the server is
//     an uncaught exception: the process dies, the run stays `running` and the
//     pinned loop's own failure path (status `failed`, `reconcile_stopped`) never
//     runs. With it the loss is recorded (`catchup_comms_connection_lost:<code>`),
//     the client stays unusable (pg refuses further queries on it) and the pinned
//     loop fails the run in a controlled way at its next directory read; the run is
//     then resumed with the same configuration. A failure inside a directory query
//     already rejects that query; it is logged the same way.
// The pinned code itself is not modified or replaced.
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {PIN,verifyPinnedRuntime,reasonOf as startReason} from './start-catchup.mjs';
import {selectedTarget,checkRestUrl,checkServiceKey,databaseIdentity,isTargetError} from '../person-target.mjs';

const CODES=new Set(['config','credentials','target','pin','runner_exit']);
export function reasonOf(error){
 if(isTargetError(error))return error.message;
 const code=error?.message?.replace(/^catchup_run:/,'');
 if(CODES.has(code))return `catchup_run:${code}`;
 return startReason(error);
}
const sqlState=(e)=>/^[0-9A-Z]{5}$/.test(e?.code??'')?e.code:'transport';

/** Attach the transport listener to every pg.Client the PINNED tree creates. The
 * pinned modules import `pg` from their own node_modules; patching that module's
 * Client.prototype.connect reaches each instance as it connects. Idempotent. */
export function installTransportListener(pinnedRoot,{log=(line)=>console.error(line)}={}){
 const require=createRequire(path.join(pinnedRoot,'scripts','person-trial.mjs'));
 const pg=require('pg');
 const {Client}=pg;
 if(Client.prototype.__ttCatchupListener)return {installed:false,pg};
 const original=Client.prototype.connect;
 const losses=[];
 Client.prototype.connect=function connect(...args){
  if(!this.__ttCatchupListening){
   this.__ttCatchupListening=true;
   this.on('error',(error)=>{
    // The client is now unusable (pg marks it); the next query rejects, the pinned
    // loop records `failed` and stops. Only the SQLSTATE/transport class is logged.
    losses.push(sqlState(error));
    log(JSON.stringify({phase:'catchup_comms_connection_lost',code:sqlState(error),application_name:this.connectionParameters?.application_name??null}));
   });
  }
  return original.apply(this,args);
 };
 Client.prototype.__ttCatchupListener=true;
 return {installed:true,pg,losses};
}

export function checkConfig(env){
 let raw;try{raw=JSON.parse(env.BACKFILL_CONFIG??'{}');}catch{throw Error('catchup_run:config');}
 if(raw.reconcile!==true||raw.scope!=='queue'||raw['dry-run']!==false||raw.resume!==true||!/^[a-zA-Z0-9_-]{1,100}$/.test(raw['run-id']??''))throw Error('catchup_run:config');
 if(raw.commit!==undefined&&raw.commit!==PIN)throw Error('catchup_run:pin');
 if(!env.COMMS_DATABASE_URL||!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY||env.LOCAL_DATABASE_URL)throw Error('catchup_run:credentials');
 const target=selectedTarget(env);
 if(target.local){
  // Disposable local stack only: loopback REST and a loopback directory.
  checkRestUrl(env.SUPABASE_URL,target);
 }else{
  checkRestUrl(env.SUPABASE_URL,target);
  checkServiceKey(env.SUPABASE_SERVICE_ROLE_KEY,target);
 }
 let source;try{source=databaseIdentity(env.COMMS_DATABASE_URL);}catch{throw Error('catchup_run:credentials');}
 if(!target.local&&source.ref===target.ref)throw Error('catchup_run:credentials');
 return {run:raw['run-id'],target:target.ref};
}

export async function main({env=process.env,verify=verifyPinnedRuntime,out=(x)=>console.log(JSON.stringify(x))}={}){
 const {run,target}=checkConfig(env);
 const runtime=verify(env.PINNED_RUNNER_DIR);
 const listener=installTransportListener(runtime.root);
 out({phase:'catchup_runner',run,target,commit:PIN,bundle_sha256:runtime.bundleHash,runner:'pinned',website_adapter:'restSite (REST, fetch)',directory_adapter:'openComms (pg.Client) + transport listener',listener_installed:listener.installed});
 const previous=process.cwd();
 process.chdir(runtime.root);
 try{
  // Exactly what `node scripts/person-backfill.mjs` does in the pinned tree with
  // BACKFILL_CONFIG.reconcile=true: the pinned reconcile main, with the same env.
  // The pinned options() reads BACKFILL_CONFIG and GITHUB_SHA; the commit it records
  // must be the pin, so GITHUB_SHA is set to it for the duration.
  const saved=process.env.GITHUB_SHA;process.env.GITHUB_SHA=PIN;
  try{
   const {main:pinnedMain}=await import(pathToFileURL(path.join(runtime.root,'scripts','person-reconcile.mjs')).href);
   await pinnedMain();
  }finally{if(saved===undefined)delete process.env.GITHUB_SHA;else process.env.GITHUB_SHA=saved;}
  out({phase:'catchup_runner_finished',run,connection_losses:listener.losses?.length??0});
 }catch(error){
  // The pinned loop already recorded `failed` and printed reconcile_stopped; keep the
  // sanitized reason and exit non-zero so the operator resumes deliberately.
  out({phase:'catchup_runner_stopped',run,reason:/^(source_|pre_save_|post_save_|capacity_|operation_failed:)/.test(error?.message??'')?error.message:reasonOf(error),connection_losses:listener.losses?.length??0});
  throw Error('catchup_run:runner_exit');
 }finally{process.chdir(previous);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(error=>{console.error(JSON.stringify({phase:'catchup_run_stopped',reason:reasonOf(error)}));process.exitCode=1;});
