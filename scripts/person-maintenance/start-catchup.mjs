#!/usr/bin/env node
// Starts the final catch-up reconcile run exactly as the pinned runner would, so the
// operator can open its `catchup` window before the runner pages. The window only
// opens for a run that is already `running` and pinned to c4d0e4e, while the pinned
// CLI starts and pages in one go. Found by the 2026-09-28 rehearsal on a copy.
//
//   PINNED_RUNNER_DIR=/path/to/c4d0e4e-checkout BACKFILL_CONFIG='{"reconcile":true,"run-id":"RUN",
//     "scope":"queue","limit":1000,"batch-size":100,"dry-run":false}' node scripts/person-maintenance/start-catchup.mjs
//
// Then open the window for RUN, and run the pinned CLI with the same BACKFILL_CONFIG
// plus "resume":true. The external fingerprint, commit, limit, batch and scope all
// come from the pinned code, so the resume matches. Needs SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY and the read-only COMMS_DATABASE_URL. Prints no values.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const PIN='c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc';
const dir=process.env.PINNED_RUNNER_DIR;
if(!dir)throw Error('catchup_start:PINNED_RUNNER_DIR');
process.chdir(dir); // the pinned options() records the commit from this checkout
const from=(f)=>import(pathToFileURL(path.join(dir,'scripts',f)).href);
const {options}=await from('person-backfill.mjs');
const {openSite,openComms,commsColumns}=await from('person-trial.mjs');
const {externalFingerprint}=await from('person-reconcile.mjs');
const config=options(),raw=JSON.parse(process.env.BACKFILL_CONFIG??'{}');
if(config.commit!==PIN)throw Error('catchup_start:not_pinned');
if(config.dry||config.resume||!raw.reconcile||raw.scope!=='queue')throw Error('catchup_start:config');
if(!process.env.COMMS_DATABASE_URL)throw Error('catchup_start:COMMS_DATABASE_URL');
const site=await openSite(),comms=await openComms(process.env.COMMS_DATABASE_URL);
try{
 const lib=await from('dist/worker-lib.mjs');
 const hash=await externalFingerprint(site,comms,await commsColumns(comms),lib);
 const state=await site.rpc('person_reconcile_start',{p_run:config.run,p_commit:config.commit,p_limit:config.limit,p_batch:config.batch,p_resume:false,p_scope:'queue',p_external_hash:hash});
 console.log(JSON.stringify({phase:'catchup_started',run:state.run_id,status:state.status,scope:'queue',commit:PIN.slice(0,7),limit:config.limit,batch:config.batch}));
}finally{await comms.end();await site.end();}
