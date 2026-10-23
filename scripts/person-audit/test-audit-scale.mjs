// Explicit local-only accounting/load probe. Synthetic empty candidates and
// fabricated verified markers test fence/counter scale, NOT content validity.
// Every fixture and marker is rolled back; never run on a hosted database.
import pg from 'pg';import assert from 'node:assert/strict';
const url=process.env.LOCAL_DATABASE_URL;if(!url||new URL(url).pathname!=='/person_postcutover_test'||!['localhost','127.0.0.1'].includes(new URL(url).hostname))throw Error('audit_test_database');
const db=new pg.Client({connectionString:url,statement_timeout:60000});await db.connect();
try{
 const started=performance.now();
 await db.query('begin');await db.query("set local statement_timeout='60s'");const prior=Number((await db.query('select count(*) n from candidates')).rows[0].n);
 await db.query('set local session_replication_role=replica');
 await db.query("insert into candidates(id,full_name,linkedin_username) select ('ff000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Synthetic scale','audit-scale-'||n from generate_series(1,423050)n");
 console.log(JSON.stringify({phase:'scale_seed',ms:Math.round(performance.now()-started)}));
 await db.query('set local session_replication_role=origin');
 await db.query("select person_postcutover_audit_start('audit-scale','test','all',20,false)");
 await db.query("insert into person_postcutover_audit_results(run_id,candidate_id,status,boundary) select 'audit-scale',candidate_id,'verified',boundary from person_private.postcutover_boundaries() where candidate_id>='ff000000-0000-4000-8000-000000000000'");
 console.log(JSON.stringify({phase:'scale_markers',ms:Math.round(performance.now()-started)}));
 // These are empty synthetic rows; missing external/pass proof must prevent
 // certification even when all these compact boundaries match.
 await db.query("set local statement_timeout='8s'");const began=performance.now();
 const result=(await db.query("select person_postcutover_audit_finalize('audit-scale') r")).rows[0].r,elapsed=Math.round(performance.now()-began);
 assert.equal(result.notes.eligible,423050+prior);assert.equal(result.notes.unverified,prior);assert.equal(result.notes.stale,0);assert.notEqual(result.status,'audited');
 console.log(JSON.stringify({test:'accounting_scale',synthetic_people:423050,eligible:result.notes.eligible,unverified:result.notes.unverified,finalize_ms:elapsed,status:result.status}));
}finally{await db.query('rollback');await db.end();}
