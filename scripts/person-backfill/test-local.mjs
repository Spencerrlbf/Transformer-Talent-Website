import assert from 'node:assert/strict';
import pg from 'pg';
import { pgSite } from '../person-trial.mjs';
import { processPage, options } from '../person-backfill.mjs';
const url=process.env.LOCAL_DATABASE_URL;
if(!url||!['127.0.0.1','localhost'].includes(new URL(url).hostname))throw Error('Local database required');
const db=new pg.Client({connectionString:url});await db.connect();const site=await pgSite(url);
const lib=await import('../dist/worker-lib.mjs');
const run='synthetic-restart';
const config={run,dry:false,concurrency:1,bulk:process.env.BACKFILL_BULK_TEST==='true'};
try{
 await db.query(`insert into candidates(id,linkedin_username,full_name,current_title,current_company,created_at,linkedin_enrichment_date,work_experience,email)
 select ('b0000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,'synthetic-'||g,'Synthetic Person '||g,'Engineer','Synthetic Co','2025-01-01','2025-01-01',
 '[{"title":"Engineer","company":"Synthetic Co","is_current":true,"start_date":{"year":2020,"month":"Jan"}}]'::jsonb,'synthetic'||g||'@example.com' from generate_series(1,3)g`);
 await site.rpc('person_backfill_start',{p_run:run,p_commit:'synthetic-commit',p_parser:'person-v3',p_limit:3,p_batch:2,p_resume:false});
 const page=await site.rpc('person_backfill_page',{p_run:run,p_size:2});
 let crashed=false;
 await assert.rejects(processPage({site,lib,config,page,afterSave:async()=>{if(!crashed){crashed=true;throw Error('injected termination after committed RPC');}}}));
 assert.equal((await db.query('select processed from backfill_runs where run_id=$1',[run])).rows[0].processed,0);
 assert.equal((await db.query('select count(*)::int n from candidate_profile_state')).rows[0].n,config.bulk?2:1);
 const state=await processPage({site,lib,config,page});assert.equal(state.processed,2);
 const last=await site.rpc('person_backfill_page',{p_run:run,p_size:2});
 assert.equal(last.length,1);assert.equal((await processPage({site,lib,config,page:last})).processed,3);
 assert.equal((await db.query('select count(*)::int n from candidate_profile_state')).rows[0].n,3);
 const before=(await db.query('select md5(jsonb_agg(to_jsonb(c) order by c.id)::text) h from candidates c')).rows[0].h;
 await processPage({site,lib,config,page});
 const after=(await db.query('select md5(jsonb_agg(to_jsonb(c) order by c.id)::text) h from candidates c')).rows[0].h;
 assert.equal(before,after);
 assert.equal((await db.query('select processed from backfill_runs where run_id=$1',[run])).rows[0].processed,3);
 const revisions=(await db.query('select candidate_id,rev from candidate_profile_state order by candidate_id')).rows;
 let lost=false,replayed=0;
 const unreliable={...site,async rpc(fn,args){
  const result=await site.rpc(fn,args);
  if(fn===(config.bulk?'person_backfill_save_many':'person_backfill_save')){
   replayed++;if(!lost){lost=true;throw Object.assign(Error('synthetic lost committed response'),{code:'ECONNRESET'});}
  }
  return result;
 }};
 await processPage({site:unreliable,lib,config,page});
 assert.ok(lost&&replayed>=2,'a committed RPC with a lost response was retried');
 assert.deepEqual((await db.query('select candidate_id,rev from candidate_profile_state order by candidate_id')).rows,revisions);
 assert.equal((await db.query('select processed from backfill_runs where run_id=$1',[run])).rows[0].processed,3);
 assert.throws(()=>options(['--run-id=test','--limit=1','--batch-size=501']),/batch/);
 assert.throws(()=>options(['--run-id=test','--limit=1','--batch-size=1','--mode=project']),/shadow/);
 console.log('PASS actual local runner: interruption after commit, lost-response retry, restart, full coverage, idempotency, live candidate equality, bounds');
}finally{await site.end();await db.end();}
