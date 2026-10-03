// Phase 1 of the upgrade path: the OLD Send definition (one argument, historical
// membership check, three-field witness) creates two witnesses. One is left intact
// for recovery; the other's row hash is altered to stand for a witness whose
// captured INSERT event cannot reproduce it (no proof can be recovered). Ids go to
// UPGRADE_STATE for phase 3. Synthetic fixture data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pool,TT,app,processApp,plan} from '../person-application-enrichment/test-tt-enrichment.mjs';

const state=process.env.UPGRADE_STATE;if(!state)throw Error('UPGRADE_STATE required');
const row=async(table,id)=>(await pool.query(`select * from ${table} where id=$1`,[id])).rows[0];
async function processed(){const id=await app();const out=await processApp(id);assert.equal(out.status,'processed',out.error?.message);const a=await row('website_applications',id);return {id,cid:a.candidate_id};}
async function sendRow(cid,job){
 const c=await row('candidates',cid);const t=v=>typeof v==='string'&&v.trim()?v.trim():null;
 const canonical=(await (await import('../person-application-edits/dist/contact.mjs')).publishedPoolContactsOnConnection(pool,[cid])).get(cid);
 const email=canonical?canonical.contact.email:t(c.contact?.email)??t(c.email),phone=canonical?canonical.contact.phone:t(c.contact?.phone)??t(c.phone);
 return {organization_id:TT,name:c.full_name||'Candidate',email:email??'',linkedin_url:c.linkedin_url??null,linkedin_username:c.linkedin_username??null,role_ids:[job],role_titles:[`Synthetic Role (#${job})`],status:'processed',source:'transformer_talent',candidate_id:cid,parsed_profile:{current_title:t(c.current_title),current_company:t(c.current_company),location:t(c.location)},harvest_profile:null,screening:null,contact:canonical||email||phone?{email:email??null,phone:phone??null}:null};
}
test('the older schema is installed: one-argument Send, three-field witness, old snapshot export',async()=>{
 const fns=(await pool.query("select pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='person_network_send'")).rows.map(r=>r.args);
 assert.deepEqual(fns,['p_row jsonb']);
 const cols=(await pool.query("select column_name from information_schema.columns where table_schema='person_private' and table_name='application_send_witnesses' order by ordinal_position")).rows.map(r=>r.column_name);
 assert.deepEqual(cols,['application_id','candidate_id','transaction_id','row_hash','created_at']);
 const snap=(await pool.query("select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='person_private' and p.proname='postcutover_snapshot'")).rows[0].prosrc;
 assert.ok(snap.includes('application_sends'));assert.ok(!snap.includes('inserted_row'));assert.ok(!snap.includes('insert_event'));
 assert.equal((await pool.query("select count(*)::int n from pg_proc where proname='person_target_identity'")).rows[0].n,0);
 assert.equal((await pool.query("select count(*)::int n from pg_proc where proname='resume_fill_begin'")).rows[0].n,0);
});
test('old Sends: one recoverable witness, one whose proof cannot be recovered',async()=>{
 const a=await processed(),b=await processed();
 const r1=(await pool.query('select person_network_send($1::jsonb) r',[JSON.stringify(await sendRow(a.cid,'7101'))])).rows[0].r;
 const r2=(await pool.query('select person_network_send($1::jsonb) r',[JSON.stringify(await sendRow(b.cid,'7102'))])).rows[0].r;
 assert.equal(r1.status,'sent');assert.equal(r2.status,'sent');
 const w1=(await pool.query('select * from person_private.application_send_witnesses where application_id=$1',[r1.applicationId])).rows[0];
 assert.ok(w1);assert.equal(w1.candidate_id,a.cid);
 // The release verifier (already the current code) cannot recognize an old witness:
 // the Send row is an unproved raw application until the upgrade completes its proof.
 const before=await plan(a.cid);
 assert.equal(before.status,'pending',JSON.stringify(before));assert.equal(before.checks.raw_facts.pending_applications,1,'the Send row is an unadmitted application');
 // Simulate an unrecoverable witness: alter its recorded hash as a superuser with the
 // immutability trigger off. (A real one would be a witness whose INSERT event is
 // missing or does not reproduce the row.)
 await pool.query('alter table person_private.application_send_witnesses disable trigger application_send_immutable');
 await pool.query("update person_private.application_send_witnesses set row_hash=md5('altered') where application_id=$1",[r2.applicationId]);
 await pool.query('alter table person_private.application_send_witnesses enable trigger application_send_immutable');
 fs.writeFileSync(state,JSON.stringify({recoverable:{application:r1.applicationId,candidate:a.cid,row_hash:w1.row_hash,transaction_id:w1.transaction_id},unresolved:{application:r2.applicationId,candidate:b.cid}}));
});
