import assert from 'node:assert/strict';
import pg from 'pg';
import {pgSite} from '../person-trial.mjs';
import {reconcilePage} from '../person-reconcile.mjs';
const url=process.env.LOCAL_DATABASE_URL;
if(!url||!['127.0.0.1','localhost'].includes(new URL(url).hostname))throw Error('Local database required');
const db=new pg.Client({connectionString:url});await db.connect();const site=await pgSite(url);
const ids=['d0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002'];
const tt='801865a7-6533-41d2-9c45-e4a90e6ad51a';
const ledger='d1000000-0000-4000-8000-000000000001';
const lib=await import('../dist/worker-lib.mjs');
try{
 await db.query(`insert into candidates(id,full_name,linkedin_username,created_at,current_title) select x,'Synthetic cache hold',x::text,'2025-01-01','Engineer' from unnest($1::uuid[])x`,[ids]);
 await db.query(`insert into candidate_enrichments(id,candidate_id,organization_id,provider,status,cache_status,created_at,raw_payload) values($1,$2,$3,'harvest','ok','hit','2026-09-25','{"headline":"Stale evidence"}')`,[ledger,ids[0],tt]);
 await site.rpc('person_backfill_start',{p_run:'held-baseline',p_commit:'synthetic',p_parser:'person-v3',p_limit:100,p_batch:100,p_resume:false,p_cohort:'all'});
 const page=await site.rpc('person_backfill_page',{p_run:'held-baseline',p_size:100});
 assert.equal(page.some(p=>p.id===ids[0]),false,'ambiguous cached person must be excluded from baseline');
 assert.equal(page.some(p=>p.id===ids[1]),true,'unaffected people still migrate');
 console.log('PASS baseline excludes ambiguous person, keeps unaffected people');
 const doc=await lib.fromLegacyImport((await db.query('select * from candidates where id=$1',[ids[0]])).rows[0],[],[],[]);
 await assert.rejects(db.query('select save_person($1::jsonb)',[doc]),/source_date_unresolved/);
 assert.equal((await db.query('select count(*)::int n from candidate_sources where candidate_id=$1',[ids[0]])).rows[0].n,0);
 console.log('PASS normalized writer fails closed before publishing held evidence');
 await db.query('delete from candidate_enrichments where id=$1',[ledger]);
 assert.equal((await db.query('select count(*)::int n from person_source_holds where candidate_id=$1 and resolved_at is null',[ids[0]])).rows[0].n,1);
 await assert.rejects(db.query('select save_person($1::jsonb)',[doc]),/source_date_unresolved/);
 console.log('PASS deleting original ledger does not erase unresolved evidence or hold');
 await db.query(`insert into candidate_enrichments(candidate_id,organization_id,provider,status,cache_status,created_at,raw_payload) values($1,'22222222-2222-4222-8222-222222222222','harvest','ok','hit',now(),'{}'),($1,$2,'harvest','ok','miss',now(),'{}')`,[ids[1],tt]);
 assert.equal((await db.query('select count(*)::int n from person_source_holds where candidate_id=$1',[ids[1]])).rows[0].n,0);
 console.log('PASS tenant cache and actual fresh fetch do not hold TT person');
 const config={run:'held-reconcile',dry:false};
 await site.rpc('person_reconcile_start',{p_run:config.run,p_commit:'synthetic',p_limit:100,p_batch:100,p_resume:false,p_scope:'all',p_external_hash:'1'.repeat(32)});
 const rp=await site.rpc('person_reconcile_page',{p_run:config.run,p_size:100});
 await reconcilePage({site,lib,config,page:rp});
 assert.equal((await db.query('select status from person_reconcile_people where run_id=$1 and candidate_id=$2',[config.run,ids[0]])).rows[0].status,'review');
 await db.query("set statement_timeout='8s'");
 const final=(await db.query('select person_reconcile_finish($1,true) result',[config.run])).rows[0].result;
 assert.equal(final.status,'review_required');assert.equal(final.notes.source_date_holds,1);
 console.log('PASS reconciliation retains hold as review and cannot report complete');
 assert.equal((await db.query("select has_table_privilege('anon','person_source_holds','select') ok")).rows[0].ok,false);
 assert.equal((await db.query("select has_table_privilege('authenticated','person_source_holds','select') ok")).rows[0].ok,false);
 console.log('PASS source evidence remains service-only');
 await db.query(`update person_source_holds set resolved_at=now(),resolution='{"proof":"synthetic reviewed original fetch"}' where candidate_id=$1`,[ids[0]]);
 await db.query(`insert into candidate_enrichments(id,candidate_id,organization_id,provider,status,cache_status,created_at,raw_payload) values($1,$2,$3,'harvest','ok','hit','2026-09-25','{"headline":"Changed stale evidence"}')`,[ledger,ids[0],tt]);
 assert.equal((await db.query('select count(*)::int n from person_source_holds where candidate_id=$1 and resolved_at is null',[ids[0]])).rows[0].n,1,'a changed cached payload reopens review even after earlier evidence was resolved');
 assert.equal((await db.query('select count(*)::int n from person_source_holds where candidate_id=$1 and resolved_at is not null',[ids[0]])).rows[0].n,1,'prior evidence and resolution remain intact');
 console.log('PASS changed cached evidence cannot inherit an earlier resolution');
 const orphan='d0000000-0000-4000-8000-000000000099';
 await db.query(`insert into candidate_enrichments(candidate_id,organization_id,provider,status,cache_status,created_at,raw_payload) values($1,$2,'harvest','ok','hit',now(),'{}')`,[orphan,tt]);
 assert.equal((await db.query('select count(*)::int n from person_source_holds where candidate_id=$1',[orphan])).rows[0].n,0);
 await db.query("insert into candidates(id,full_name,linkedin_username) values($1::uuid,'Synthetic later arrival',$1::text)",[orphan]);
 assert.equal((await db.query('select count(*)::int n from person_source_holds where candidate_id=$1',[orphan])).rows[0].n,1);
 console.log('PASS orphan ledger remains accepted and later pool arrival is held');
 const simultaneous='d0000000-0000-4000-8000-000000000098';
 const other=new pg.Client({connectionString:url});await other.connect();
 try{
  await db.query('begin');
  await db.query("insert into candidates(id,full_name,linkedin_username) values($1::uuid,'Synthetic concurrent arrival',$1::text)",[simultaneous]);
  let done=false;
  const pending=other.query(`insert into candidate_enrichments(candidate_id,organization_id,provider,status,cache_status,created_at,raw_payload) values($1,$2,'harvest','ok','hit',now(),'{}')`,[simultaneous,tt]).then(()=>{done=true;});
  let blocked=false;
  for(let i=0;i<100;i++){
   blocked=(await db.query("select exists(select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock') blocked",[other.processID])).rows[0].blocked;
   if(done||blocked)break;await new Promise(r=>setTimeout(r,5));
  }
  await db.query('commit');await pending;
  assert.equal(blocked,true,'cache-hit arrival must wait for concurrent candidate creation');
  assert.equal((await db.query('select count(*)::int n from person_source_holds where candidate_id=$1',[simultaneous])).rows[0].n,1);
  console.log('PASS concurrent candidate and cached ledger arrivals cannot escape hold');
 }finally{await db.query('rollback');await other.end();}



}finally{await site.end();await db.end();}
