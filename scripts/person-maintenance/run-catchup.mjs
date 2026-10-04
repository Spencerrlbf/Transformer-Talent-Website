#!/usr/bin/env node
// Runs a narrowly derived historical catch-up runtime. The clean PIN remains
// untouched; only readNew/checkStored contact evidence supports explicit clears.
// Translator bundle, external fingerprint, reconciliation loop and SQL semantics
// stay historical. The derived manifest proves every input/output SHA256.
// Hosted use requires compatibility ID and exact artifact SHA256 acknowledgement.
// Transport listeners turn idle directory loss into the historical controlled
// failure/resume path. No decision scan occurs before the bounded page snapshot.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {PIN,verifyPinnedRuntime,reasonOf as startReason} from './start-catchup.mjs';
import {selectedTarget,checkRestUrl,checkServiceKey,databaseIdentity,isTargetError} from '../person-target.mjs';
import {checkNode} from '../check-node.mjs';
import {prepareCompatibilityRuntime,checkCompatibilityApproval,checkArtifactApproval} from './contact-compat-runtime.mjs';

const CODES=new Set(['config','credentials','target','pin','runner_exit','arguments','aliases','pinned_env_file','environment_changed','options_mismatch','compatibility_source','compatibility_approval','artifact_approval']);
// Environment the pinned modules read (person-trial.mjs, person-backfill.mjs options()).
// Anything here must be exactly what was validated: the pinned tree's ignored
// `.env.scripts` fills MISSING variables at import time, and the pinned parser prefers
// CLI arguments and BACKFILL_* aliases over BACKFILL_CONFIG.
const PINNED_READS=['LOCAL_DATABASE_URL','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','COMMS_DATABASE_URL','COMMS_WORKSPACE','BACKFILL_CONFIG','GITHUB_SHA','PERSON_TARGET_PROJECT_REF','PERSON_CATCHUP_COMPATIBILITY_ID','PERSON_CATCHUP_ARTIFACT_SHA256'];
const ALIASES=/^BACKFILL_(RUN_ID|MODE|COHORT|BULK|LIMIT|BATCH_SIZE|CONCURRENCY|DRY_RUN|RESUME|MAX_DB_BYTES|MAX_SECONDS)$/;
const envSnapshot=(env)=>Object.fromEntries(PINNED_READS.map(k=>[k,env[k]]));
export function reasonOf(error){
 if(isTargetError(error))return error.message;
 if(/^node_runtime:/.test(error?.message??''))return error.message;
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

/** No late inputs: the pinned parser would let them override the checked JSON. */
export function checkInputs(env,argv=process.argv.slice(2)){
 if(argv.length)throw Error('catchup_run:arguments');
 const aliases=Object.keys(env).filter(k=>ALIASES.test(k));
 if(aliases.length)throw Error('catchup_run:aliases');
}
/** The pinned tree must not carry an env file: it would fill missing variables (for
 * example LOCAL_DATABASE_URL, which switches the website from the validated REST
 * destination to a PostgreSQL URL) after validation. */
export function checkPinnedTree(root){
 const files=fs.readdirSync(root).filter(f=>f==='.env'||f.startsWith('.env.'));
 if(files.length)throw Error('catchup_run:pinned_env_file');
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

export async function main({env=process.env,argv=process.argv.slice(2),verify=verifyPinnedRuntime,out=(x)=>console.log(JSON.stringify(x))}={}){
 checkNode();
 checkInputs(env,argv);
 const {run,target}=checkConfig(env);
 checkCompatibilityApproval(env,target);
 const before=envSnapshot(env);
 const pinned=verify(env.PINNED_RUNNER_DIR);
 checkPinnedTree(pinned.root);
 const runtime=prepareCompatibilityRuntime(pinned);
 checkArtifactApproval(env,target,runtime.manifest);
 const listener=installTransportListener(runtime.root);
 const previous=process.cwd();
 process.chdir(runtime.root);
 try{
  // Exactly what `node scripts/person-backfill.mjs` does in the pinned tree with
  // BACKFILL_CONFIG.reconcile=true: the pinned reconcile main, with the same env.
  // The pinned options() reads BACKFILL_CONFIG and GITHUB_SHA; the commit it records
  // must be the pin, so GITHUB_SHA is set to it for the duration.
  const saved=process.env.GITHUB_SHA;process.env.GITHUB_SHA=PIN;
  try{
   const [{main:pinnedMain},{options}]=await Promise.all([
    import(pathToFileURL(path.join(runtime.root,'scripts','person-reconcile.mjs')).href),
    import(pathToFileURL(path.join(runtime.root,'scripts','person-backfill.mjs')).href),
   ]);
   // Importing the pinned modules must not have changed what they will read, and the
   // options they parse must be the ones validated.
   const after=envSnapshot(process.env);
   for(const k of PINNED_READS)if(k!=='GITHUB_SHA'&&after[k]!==before[k])throw Error('catchup_run:environment_changed');
   if(process.env.LOCAL_DATABASE_URL)throw Error('catchup_run:environment_changed');
   const raw=JSON.parse(env.BACKFILL_CONFIG);
   const effective=options([],process.env);
   if(effective.run!==raw['run-id']||effective.commit!==PIN||effective.dry!==false||effective.resume!==true||effective.limit!==raw.limit||effective.batch!==raw['batch-size']||(raw['max-seconds']!==undefined&&effective.maxSeconds!==raw['max-seconds'])||(raw['max-db-bytes']!==undefined&&effective.maxBytes!==raw['max-db-bytes']))throw Error('catchup_run:options_mismatch');
   out({phase:'catchup_runner',run,target,commit:PIN,bundle_sha256:runtime.bundleHash,runner:'derived_pinned',compatibility:runtime.manifest,website_adapter:'restSite (REST, fetch)',directory_adapter:'openComms (pg.Client) + transport listener',listener_installed:listener.installed,node:process.version,
    effective:{run:effective.run,scope:raw.scope,dry:effective.dry,resume:effective.resume,limit:effective.limit,batch:effective.batch,max_seconds:effective.maxSeconds,max_db_bytes:effective.maxBytes}});
   await pinnedMain();
  }finally{if(saved===undefined)delete process.env.GITHUB_SHA;else process.env.GITHUB_SHA=saved;}
  out({phase:'catchup_runner_finished',run,connection_losses:listener.losses?.length??0});
 }catch(error){
  // The pinned loop already recorded `failed` and printed reconcile_stopped; keep the
  // sanitized reason and exit non-zero so the operator resumes deliberately.
  const reason=/^(source_|pre_save_|post_save_|capacity_|operation_failed:)/.test(error?.message??'')?error.message:reasonOf(error);
  out({phase:'catchup_runner_stopped',run,reason,connection_losses:listener.losses?.length??0});
  throw Error(reason.startsWith('catchup_run:')?reason:'catchup_run:runner_exit');
 }finally{process.chdir(previous);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(error=>{console.error(JSON.stringify({phase:'catchup_run_stopped',reason:reasonOf(error)}));process.exitCode=1;});
