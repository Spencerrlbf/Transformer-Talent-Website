#!/usr/bin/env node
// Cutover runbook step: the profile write guard on public.candidates.
//
//   PERSON_DATABASE_URL=... node scripts/person-guard.mjs --status
//   PERSON_DATABASE_URL=... node scripts/person-guard.mjs --enable --note="..."
//   PERSON_DATABASE_URL=... node scripts/person-guard.mjs --disable --note="..."
//   PERSON_DATABASE_URL=... node scripts/person-guard.mjs --test-rejected=<candidate id>
//   PERSON_DATABASE_URL=... node scripts/person-guard.mjs --test-allowed=<candidate id>
//
// While enabled, a change to any compatibility profile column must happen in
// a transaction that opened an audited person operation for that candidate.
// Workflow columns are not guarded. The two tests prove the guard on a real
// row and ROLL BACK: neither leaves any change. --test-rejected performs an
// unaudited profile update and expects person_profile_write_guard.
// --test-allowed opens an audited operation (writer 'projection') and performs
// the same update through the attribution path, expecting success.
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {openDatabase,parseOptions,safeReason,log} from './person-publish/lib.mjs';

export const SPEC={
 status:{type:'flag',default:false},
 enable:{type:'flag',default:false},
 disable:{type:'flag',default:false},
 note:{type:'text',max:200,default:null},
 'test-rejected':{type:'uuid',name:'testRejected',default:null},
 'test-allowed':{type:'uuid',name:'testAllowed',default:null},
};
const PROBE=`update public.candidates set headline=coalesce(headline,'')||' ',updated_at=clock_timestamp() where id=$1 returning id`;

export async function guardStatus(pool){return (await pool.query('select public.person_write_guard_status() result')).rows[0].result;}
export async function setGuard(pool,enabled,note){return (await pool.query('select public.person_write_guard_set($1,$2) result',[enabled,note])).rows[0].result;}

/** An unaudited profile update must be rejected while the guard is enabled. Rolls back. */
export async function testRejected(client,id){
 await client.query('begin');
 try{
  await client.query("set local lock_timeout='3s'; set local statement_timeout='10s'");
  const exists=(await client.query('select 1 from public.candidates where id=$1 for update',[id])).rows.length;
  if(!exists)throw Error('person_not_found');
  let outcome='allowed';
  try{await client.query(PROBE,[id]);}
  catch(error){outcome=error.message==='person_profile_write_guard'?'rejected':`error:${safeReason(error)}`;}
  return outcome;
 }finally{await client.query('rollback').catch(()=>{});}
}
/** The same update inside an audited operation must pass. Rolls back. */
export async function testAllowed(client,id,lib){
 await client.query('begin');
 try{
  await client.query("set local lock_timeout='3s'; set local statement_timeout='10s'");
  await client.query('select pg_advisory_xact_lock_shared(72005,0)');
  await client.query('select pg_advisory_xact_lock(hashtext($1))',[id]);
  const before=(await client.query('select * from public.candidates where id=$1 for update',[id])).rows[0];
  if(!before)throw Error('person_not_found');
  const audit=await lib.beginGuardedAuditOperationLocked(client,before,{writer:'projection',receiptRef:`projection:guard-test:${randomUUID()}`,evidence:{mode:'guard_test'}});
  await lib.attributeAuditMutation(client,audit,{scope:'profile',table:'candidates',rowId:id},()=>client.query(PROBE,[id]));
  return 'allowed';
 }catch(error){
  if(error.message==='person_profile_write_guard')return 'rejected';
  throw error;
 }finally{await client.query('rollback').catch(()=>{});}
}
export async function main(argv=process.argv.slice(2)){
 const options=parseOptions(argv,SPEC);
 const actions=[options.status,options.enable,options.disable,Boolean(options.testRejected),Boolean(options.testAllowed)].filter(Boolean).length;
 if(actions!==1)throw Error('publish_option:one_action');
 if((options.enable||options.disable)&&!options.note)throw Error('publish_option_required:note');
 const pool=await openDatabase(process.env,'tt-person-guard');
 try{
  if(options.status){const result=await guardStatus(pool);log({phase:'guard_status',...result});return result;}
  if(options.enable||options.disable){const result=await setGuard(pool,options.enable,options.note);log({phase:'guard_set',...result});return result;}
  const client=await pool.connect();
  try{
   if(options.testRejected){
    const status=await guardStatus(pool),outcome=await testRejected(client,options.testRejected);
    const pass=status.enabled?outcome==='rejected':outcome==='allowed';
    log({phase:'guard_test_rejected',candidate_id:options.testRejected,guard_enabled:status.enabled,outcome,pass,rolled_back:true});
    if(!pass)process.exitCode=2;
    return {outcome,pass};
   }
   const lib=await import('./dist/worker-lib.mjs');
   const outcome=await testAllowed(client,options.testAllowed,lib),pass=outcome==='allowed';
   log({phase:'guard_test_allowed',candidate_id:options.testAllowed,outcome,pass,rolled_back:true});
   if(!pass)process.exitCode=2;
   return {outcome,pass};
  }finally{client.release();}
 }finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(error=>{console.error(JSON.stringify({phase:'guard_stopped',reason:safeReason(error)}));process.exit(1);});
