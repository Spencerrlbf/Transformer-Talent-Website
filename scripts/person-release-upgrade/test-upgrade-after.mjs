// Phase 3 of the upgrade path: after 20260928061000 and the forward migrations, the
// older install has the release definitions, the recoverable witness carries its exact
// insertion proof, the unrecoverable one is retained with NULL proof and its person
// is not reported as verified. Synthetic fixture data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pool,plan} from './fixture-pool.mjs';
test.after(()=>pool.end());

const state=JSON.parse(fs.readFileSync(process.env.UPGRADE_STATE,'utf8'));
test('definitions converged with the clean install',async()=>{
 const fns=(await pool.query("select pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='person_network_send'")).rows.map(r=>r.args);
 assert.deepEqual(fns,['p_row jsonb, p_mode text']);
 const cols=(await pool.query("select column_name,is_nullable from information_schema.columns where table_schema='person_private' and table_name='application_send_witnesses' order by ordinal_position")).rows;
 assert.deepEqual(cols.map(c=>c.column_name),['application_id','candidate_id','transaction_id','row_hash','created_at','inserted_row','event_id','event_hash']);
 // One witness stays unresolved, so the proof columns remain nullable under the all-or-none check.
 assert.deepEqual(cols.filter(c=>['inserted_row','event_id','event_hash'].includes(c.column_name)).map(c=>c.is_nullable),['YES','YES','YES']);
 assert.equal((await pool.query("select count(*)::int n from pg_constraint where conname='application_send_witnesses_proof_complete'")).rows[0].n,1);
 const snap=(await pool.query("select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='person_private' and p.proname='postcutover_snapshot'")).rows[0].prosrc;
 assert.ok(snap.includes('inserted_row'));assert.ok(snap.includes('insert_event'));assert.ok(snap.includes('snapshot_size_limit'));
 assert.equal((snap.match(/application_sends_limit/g)||[]).length,1,'the count guard is not duplicated');
 const fill=(await pool.query("select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='person_application_contact_fill'")).rows[0].prosrc;
 assert.ok(fill.includes('( ext [0-9]{1,6})?$'));
 const identity=(await pool.query('select public.person_target_identity() i')).rows[0].i;
 assert.match(identity.system_identifier,/^[0-9]{1,20}$/);
 assert.equal((await pool.query("select count(*)::int n from pg_proc where proname='resume_fill_begin'")).rows[0].n,1);
 const index=(await pool.query("select i.indisvalid,i.indisready,i.indisunique from pg_index i where i.indexrelid=to_regclass('public.candidates_person_username_idx')")).rows[0];
 assert.deepEqual(index,{indisvalid:true,indisready:true,indisunique:false});
});
test('the recoverable witness carries exact insertion proof and its Send is recognized again',async()=>{
 const w=(await pool.query('select * from person_private.application_send_witnesses where application_id=$1',[state.recoverable.application])).rows[0];
 assert.equal(w.row_hash,state.recoverable.row_hash,'original hash untouched');
 assert.equal(w.transaction_id,state.recoverable.transaction_id,'original transaction untouched');
 assert.ok(w.inserted_row&&w.event_id&&w.event_hash);
 const e=(await pool.query('select * from person_change_events where id=$1',[w.event_id])).rows[0];
 assert.equal(e.operation,'INSERT');assert.equal(e.source_table,'website_applications');assert.equal(e.source_row_id,state.recoverable.application);assert.equal(e.transaction_id,w.transaction_id);assert.equal(e.previous_payload,null);
 const recomputed=(await pool.query('select md5($1::jsonb::text) h',[JSON.stringify(w.inserted_row)])).rows[0].h;
 assert.equal(recomputed,w.row_hash,'inserted_row reproduces the original row hash exactly');
 const {resume_embedding,matching_embedding,resume_text,notes,...captured}=w.inserted_row;
 assert.deepEqual(captured,e.payload);
 const eventHash=(await pool.query('select md5(jsonb_build_array(e.id,e.candidate_id,e.source_table,e.source_row_id,e.operation,e.transaction_id::text,e.previous_payload,e.payload)::text) h from person_change_events e where e.id=$1',[w.event_id])).rows[0].h;
 assert.equal(eventHash,w.event_hash);
 const after=await plan(state.recoverable.candidate);
 assert.equal(after.status,'verified',JSON.stringify(after));assert.equal(after.checks.raw_facts.pending_applications,0);
});
test('the unrecoverable witness is retained without fabricated proof and its person is not verified',async()=>{
 const w=(await pool.query('select * from person_private.application_send_witnesses where application_id=$1',[state.unresolved.application])).rows[0];
 assert.ok(w,'witness retained');
 assert.equal(w.inserted_row,null);assert.equal(w.event_id,null);assert.equal(w.event_hash,null);
 const after=await plan(state.unresolved.candidate);
 assert.equal(after.status,'pending',JSON.stringify(after));assert.equal(after.checks.raw_facts.pending_applications,1,'the Send row is an unadmitted application');
 // Still immutable.
 await assert.rejects(pool.query('delete from person_private.application_send_witnesses where application_id=$1',[state.unresolved.application]),/application_send_immutable/);
});
test('a new Send on the upgraded schema writes a complete witness through the release definition',async()=>{
 const n=(await pool.query('select count(*)::int n from person_private.application_send_witnesses where inserted_row is not null')).rows[0].n;
 assert.ok(n>=1);
 // The proof check constraint refuses a half-proved row (as superuser, trigger disabled).
 await pool.query('alter table person_private.application_send_witnesses disable trigger application_send_immutable');
 try{await assert.rejects(pool.query('update person_private.application_send_witnesses set event_id=null where application_id=$1',[state.recoverable.application]),/application_send_witnesses_proof_complete/);}
 finally{await pool.query('alter table person_private.application_send_witnesses enable trigger application_send_immutable');}
});
