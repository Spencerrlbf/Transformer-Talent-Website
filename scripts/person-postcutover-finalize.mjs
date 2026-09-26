#!/usr/bin/env node
// Final accounting of a post-cutover audit run. Takes the writer gate then the
// capture gate exclusively for one bounded statement, compares every current
// candidate with the run's recorded results, and sets the run to audited,
// catchup_pending or review_required. It changes no other row.
//
//   PERSON_PUBLISH_DATABASE_URL=... node scripts/person-postcutover-finalize.mjs --run-id=<id> --external-stable=true|false
//
// --external-stable is the operator's statement about the directory: true only
// when the most recent bounded directory reconciliation reported its start and
// end fingerprints equal. Anything else is false.
import {pathToFileURL} from 'node:url';
import {openDatabase,parseOptions,safeReason,log} from './person-publish/lib.mjs';

export const SPEC={
 'run-id':{type:'run',name:'runId',required:true},
 'external-stable':{type:'enum',name:'externalStable',values:['true','false'],required:true},
};
export async function finalizeAudit({pool,options,onProgress=log}){
 const client=await pool.connect();
 try{
  await client.query('begin');
  await client.query("set local statement_timeout='8s'");
  await client.query("set local lock_timeout='2s'");
  const run=(await client.query('select public.person_postcutover_audit_finalize($1,$2) r',[options.runId,options.externalStable==='true'])).rows[0].r;
  await client.query('commit');
  const summary={phase:'audit_finalized',run:options.runId,status:run.status,counts:run.counts,...Object.fromEntries(['eligible','unverified','unresolved_review','stale','directory_stale','lookup_stale','source_date_holds','directory_pending','open_identity_conflicts','external_stable'].map(k=>[k,run.notes?.[k]]))};
  onProgress(summary);
  return summary;
 }catch(error){await client.query('rollback').catch(()=>{});throw error;}
 finally{client.release();}
}
export async function main(argv=process.argv.slice(2)){
 const options=parseOptions(argv,SPEC);
 const pool=await openDatabase(process.env,'tt-person-postcutover-finalize');
 try{return await finalizeAudit({pool,options});}
 finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(error=>{console.error(JSON.stringify({phase:'audit_finalize_stopped',reason:safeReason(error)}));process.exit(1);});
