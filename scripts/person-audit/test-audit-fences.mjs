// Root-owned disposable PostgreSQL only; transactions deliberately overlap.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import * as lib from '../dist/worker-lib.mjs';
import {prepareAuditFixture} from './local-fixture.mjs';
import {planAudit} from './postcutover.mjs';
const url=process.env.LOCAL_DATABASE_URL;
if(!url||new URL(url).pathname!=='/person_postcutover_test'||!['localhost','127.0.0.1'].includes(new URL(url).hostname))throw Error('audit_test_database');
const pool=new pg.Pool({connectionString:url,max:5,statement_timeout:15000,options:"-c timezone=UTC"});
const id=n=>`eb000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function timed(sql,values=[],seconds=15){const c=await pool.connect();try{await c.query('begin');await c.query(`set local statement_timeout='${seconds}s'`);const r=await c.query(sql,values);await c.query('commit');return r.rows[0]?.r;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
async function seed(n){await pool.query(`insert into candidates(id,full_name,linkedin_username,current_title,email,created_at,work_experience,education) values($1,'Synthetic audit fence',$2,'Engineer',$3,'2025-01-01', $4,$5)`,[id(n),`audit-fence-${n}`,`audit-fence-${n}@example.test`,JSON.stringify([{title:'Engineer',company:`Fence company ${n}`,is_current:true,start_date:{year:2020,month:'Jan'}}]),JSON.stringify([{school:`Fence school ${n}`,degree:'BSc',start_year:2015,end_year:2018}])]);await prepareAuditFixture(id(n));return id(n);}
const snap=async cid=>(await timed('select person_postcutover_audit_inputs_with_witness($1::jsonb) r',[JSON.stringify([cid])]))[0];
const start=run=>timed("select person_postcutover_audit_start($1,'test','all',10,false) r",[run]);
const record=(run,plan)=>timed('select person_postcutover_audit_record_many($1,$2::jsonb) r',[run,JSON.stringify([plan])]);
test.after(()=>pool.end());
test('record waits for a delayed shared lookup commit and refuses the older snapshot',async()=>{
 const cid=await seed(1);const before=await snap(cid);const company=before.normalized.companies[0].id;const writer=await pool.connect();
 await start('fence-delayed');
 try{
  await writer.query('begin');await writer.query("update companies set name=name||' changed' where id=$1",[company]);
  const plan=planAudit(await snap(cid),lib);assert.equal(plan.status,'verified');
  let settled=false;const pending=record('fence-delayed',plan).finally(()=>{settled=true;});
  await new Promise(r=>setTimeout(r,80));
  await writer.query('commit');
  const result=await pending;
  assert.equal(result[0].status,'pending');assert.equal(result[0].reason,'boundary_moved');
 }finally{await writer.query('rollback');writer.release();}
});
test('lookup witness is invariant under the recording session timezone',async()=>{
 const cid=await seed(2);const snapshot=await snap(cid);assert.ok(snapshot.normalized.schools.length);
 const plan=planAudit(snapshot,lib);assert.equal(plan.status,'verified');await start('fence-timezone');
 const c=await pool.connect();try{await c.query('begin');await c.query("set local timezone='America/New_York'");await c.query("set local statement_timeout='15s'");const out=(await c.query('select person_postcutover_audit_record_many($1,$2::jsonb) r',['fence-timezone',JSON.stringify([plan])])).rows[0].r;assert.equal(out[0].status,'verified');await c.query('commit');}finally{await c.query('rollback');c.release();}
});
test('a pending pass can reset the cursor and revisit stale verified people',async()=>{
 const cid=await seed(3);await start('fence-resume');await record('fence-resume',planAudit(await snap(cid),lib));
 await timed("select person_postcutover_audit_checkpoint('fence-resume',$1,'paused','{}') r",[cid]);
 await pool.query("update candidates set headline='Later fact' where id=$1",[cid]);
 const restarted=await timed("select person_postcutover_audit_start('fence-resume','test','pending',10,true) r");assert.equal(restarted.last_id,null);
 const page=await timed("select person_postcutover_audit_page('fence-resume',$1,10,2) r",[id(2)]);assert.ok(page.ids.includes(cid));
});
test('finalization cannot accept an operator boolean as external source proof',async()=>{
 await start('fence-external');
 await assert.rejects(timed("select person_postcutover_audit_finalize('fence-external',true) r",[],8),/audit_external_observation_required|does not exist/);
});
test('a changed external observation invalidates retained verified results on a pending pass',async()=>{
 const cid=await seed(4);await start('fence-external-pass');
 const input=await timed('select person_postcutover_audit_external_inputs() r');
 const proof=hash=>({...input,contact_ids:undefined,complete:true,hash:hash.repeat(64)});
 await timed("select person_postcutover_audit_observe('fence-external-pass','start',$1::jsonb) r",[JSON.stringify(proof('a'))]);
 await record('fence-external-pass',planAudit(await snap(cid),lib));
 await timed("select person_postcutover_audit_checkpoint('fence-external-pass',$1,'paused','{\"scan_complete\":true}') r",[cid]);
 await timed("select person_postcutover_audit_start('fence-external-pass','test','pending',10,true) r");
 await timed("select person_postcutover_audit_observe('fence-external-pass','start',$1::jsonb,2) r",[JSON.stringify(proof('b'))]);
 const page=await timed("select person_postcutover_audit_page('fence-external-pass',$1,10,2) r",[id(3)]);
 assert.ok((page.ids??page).includes(cid),'unchanged website rows must be revisited after COMMS-only drift');
});
test('old pass checkpoints and observations cannot mutate a restarted pass',async()=>{
 await start('fence-old-pass');
 await timed("select person_postcutover_audit_checkpoint('fence-old-pass',null,'paused','{\"scan_complete\":true}') r");
 const run=await timed("select person_postcutover_audit_start('fence-old-pass','test','pending',10,true) r");assert.equal(run.pass,2);
 await assert.rejects(timed("select person_postcutover_audit_checkpoint('fence-old-pass',$1,'paused','{\"scan_complete\":true}') r",[id(4)]),/audit_run_pass/);
 await assert.rejects(timed("select person_postcutover_audit_observe('fence-old-pass','start','{\"complete\":false}') r"),/audit_run_pass/);
 const current=(await pool.query("select last_id,scan_complete,external_start from person_postcutover_audit_runs where run_id='fence-old-pass'")).rows[0];
 assert.deepEqual(current,{last_id:null,scan_complete:false,external_start:null});
});
test('oversized people remain compact reviews through snapshot, recording and pending paging',async()=>{
 const cid=await seed(5);await pool.query("insert into candidate_contacts(candidate_id,kind,value_raw,value_normalized,status,source) select $1,'email','oversize-'||n||'@example.test','oversize-'||n||'@example.test','active','legacy_import' from generate_series(1,1001)n",[cid]);
 await start('fence-overflow');const c=await pool.connect();try{
  await c.query('begin');await c.query("set local statement_timeout='15s'");
  await c.query("create or replace function person_private.postcutover_boundaries(p_ids uuid[] default null) returns table(candidate_id uuid,boundary jsonb) language plpgsql stable as $$begin if cardinality(p_ids)>0 then raise exception 'overflow_boundary_must_not_run';end if;return;end$$");
  const snap=(await c.query('select person_postcutover_audit_inputs_with_witness($1::jsonb) r',[JSON.stringify([cid])])).rows[0].r[0];assert.equal(snap.reason,'contacts_limit');
  const outcome=planAudit(snap,lib);assert.equal(outcome.status,'review');const recorded=(await c.query("select person_postcutover_audit_record_many('fence-overflow',$1::jsonb) r",[JSON.stringify([outcome])])).rows[0].r;assert.equal(recorded[0].status,'review');
  await c.query("select person_postcutover_audit_start('fence-overflow','test','pending',10,true)");
  const page=(await c.query("select person_postcutover_audit_page('fence-overflow',$1,1,2) r",[id(4)])).rows[0].r;assert.deepEqual(page.ids,[cid]);
 }finally{await c.query('rollback');c.release();}
});
test('finalization sees a shared lookup commit after waiting for its capture gate',async()=>{
 const cid=await seed(6);await start('fence-final-delay');const s=await snap(cid);await record('fence-final-delay',planAudit(s,lib));
 const writer=await pool.connect();try{
  await writer.query('begin');await writer.query("update companies set name=name||' later' where id=$1",[s.normalized.companies[0].id]);
  const final=timed("select person_postcutover_audit_finalize('fence-final-delay') r",[],8);await new Promise(r=>setTimeout(r,80));await writer.query('commit');const result=await final;assert.equal(result.notes.lookup_stale,1);assert.notEqual(result.status,'audited');
 }finally{await writer.query('rollback');writer.release();}
});
test('snapshot and audit bookkeeping never alter business, capture or source evidence',async()=>{
 const cid=await seed(7);const fingerprint=async()=>{const values=[];for(const table of ['candidates','candidate_profile_state','candidate_sources','candidate_contacts','candidate_identities','candidate_experiences','candidate_educations','candidate_skills','person_change_events','person_change_queue','person_audit_operations','person_audit_epochs','person_directory_receipts','person_postcutover_lookup_epochs','candidate_emails_v2'])values.push((await pool.query(`select md5(coalesce(string_agg(j,',' order by j),'')) hash from (select to_jsonb(x)::text j from ${table} x) rows`)).rows[0].hash);return values;};
 const before=await fingerprint();await start('fence-read-only');await record('fence-read-only',planAudit(await snap(cid),lib));await timed("select person_postcutover_audit_finalize('fence-read-only') r",[],8);assert.deepEqual(await fingerprint(),before);
});
