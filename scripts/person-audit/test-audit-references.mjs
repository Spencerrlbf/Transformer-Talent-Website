// Deliberately malformed evidence only in a disposable, loopback database.
import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';
import * as lib from '../dist/worker-lib.mjs';import {prepareAuditFixture} from './local-fixture.mjs';import {planAudit} from './postcutover.mjs';
const url=process.env.LOCAL_DATABASE_URL;
if(!url||new URL(url).pathname!=='/person_postcutover_test'||!['localhost','127.0.0.1'].includes(new URL(url).hostname))throw Error('audit_test_database');
const pool=new pg.Pool({connectionString:url,max:5,statement_timeout:15000,options:'-c timezone=UTC'});
const id=n=>`ef000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const plan=s=>planAudit(s,lib,{complete:true,rows:new Map()});
async function timed(sql,args=[],seconds=15){const c=await pool.connect();try{await c.query('begin');await c.query(`set local statement_timeout='${seconds}s'`);const r=await c.query(sql,args);await c.query('commit');return r.rows[0]?.r;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}
const snap=async cid=>(await timed('select person_postcutover_audit_inputs_with_witness($1::jsonb) r',[JSON.stringify([cid])]))[0];
async function seed(n){const cid=id(n);await pool.query(`insert into candidates(id,full_name,linkedin_username,email,current_title,created_at,work_experience,education,top_skills) values($1,'Synthetic reference',$2,$3,'Engineer','2025-01-01',$4,$5,$6)`,[cid,`audit-reference-${n}`,`reference-${n}@example.test`,JSON.stringify([{company:`Reference company ${n}`,title:'Engineer',start_date:{year:2020},is_current:true}]),JSON.stringify([{school:`Reference school ${n}`,degree:'BSc',start_year:2015,end_year:2018}]),['Reference skill']]);await prepareAuditFixture(cid);return cid;}
const start=run=>timed("select person_postcutover_audit_start($1,'reference-test','all',20,false) r",[run]);
const record=(run,p)=>timed('select person_postcutover_audit_record_many($1,$2::jsonb) r',[run,JSON.stringify([p])]);
async function publish(cid){const c=await pool.connect();try{await lib.publishPersonProjectionOnConnection(c,cid,{runId:'reference-publish',dryRun:false});}finally{c.release();}}
async function stray(cid,foreign){const s=await snap(cid);const eid=(await pool.query('select min(id)::text id from person_change_events where candidate_id=$1',[foreign])).rows[0].id;await pool.query("insert into person_change_attributions(event_id,candidate_id,operation_id,scope,changed_fields,event_hash) values($1,$2,$3,'creation','{}',repeat('0',32))",[eid,cid,s.operations[0].id]);return eid;}
let original,other;
test.before(async()=>{for(const n of [1,2])if(!(await pool.query('select 1 from candidates where id=$1',[id(n)])).rowCount)await seed(n);original=await snap(id(1));other=await snap(id(2));});test.after(()=>pool.end());
test('contacts cannot borrow a foreign or missing source while retaining witnessed content',()=>{
 assert.equal(plan(original).status,'verified');
 for(const source_id of [other.normalized.sources[0].id,null]){const s=structuredClone(original);s.normalized.contacts[0].source_id=source_id;assert.equal(plan(s).status,'review');}
});
test('source ownership also covers identities, state and removed list rows',()=>{
 for(const edit of [s=>s.normalized.identities[0].source_id=other.normalized.sources[0].id,s=>s.normalized.state.lists_source_id=other.normalized.sources[0].id,s=>{s.normalized.jobs[0].removed_at='2026-01-01';s.normalized.jobs[0].source_id=other.normalized.sources[0].id;}]){const s=structuredClone(original);edit(s);assert.equal(plan(s).status,'review');}
});
test('same-person source must witness the contact, but merged evidence may retain its original source',async()=>{
 const cid=await seed(3),app=id(300);await pool.query(`insert into website_applications(id,organization_id,name,email,linkedin_username,contact) values($1,$2,'Synthetic reference','new-reference@example.test','audit-reference-3','{}')`,[app,lib.TT_ORG_ID]);
 const c=await pool.connect();try{await lib.saveApplicationPersonOnConnection(c,{organizationId:lib.TT_ORG_ID,applicationId:app,linkedinUsername:'audit-reference-3',name:'Synthetic reference',parsed:{current_title:'Resume title'},resumeText:null,mode:'shadow'});}finally{c.release();}
 const s=await snap(cid);assert.equal(plan(s).status,'verified');const old=s.normalized.contacts.find(x=>x.value_normalized==='reference-3@example.test');const src=s.normalized.sources.find(x=>x.source==='application');assert.ok(old&&src);old.source_id=src.id;old.source=src.source;assert.equal(plan(s).status,'review');
});
test('independent references expose an attribution naming another candidate event',async()=>{
 const cid=await seed(4),foreign=await seed(5);await publish(cid);assert.equal(plan(await snap(cid)).status,'verified');const eid=await stray(cid,foreign);const s=await snap(cid);assert.equal(plan(s).status,'review');assert.ok(s.attribution_refs.some(x=>x.event_id===eid));assert.ok(!s.events.some(x=>x.id===eid),'no foreign event payload should be exposed');
});
test('an unchanged event cannot bypass attribution hash and transaction checks',async()=>{
 const cid=await seed(6);await publish(cid);await pool.query("update candidates set updated_at=clock_timestamp() where id=$1",[cid]);const s=await snap(cid);const e=s.events.at(-1),op=s.operations[0];assert.equal(e.before_contract_hash,e.after_contract_hash);e.attribution={event_id:e.id,candidate_id:cid,operation_id:op.id,scope:'profile',changed_fields:e.actual_changed_fields,event_hash:'0'.repeat(32)};s.attribution_refs??=[];s.attribution_refs.push({event_id:e.id,candidate_id:cid,operation_id:op.id});assert.equal(plan(s).status,'review');
});
test('a missing reference version or overflowing references fails closed',()=>{
 const old=structuredClone(original);delete old.reference_version;assert.equal(plan(old).status,'review');
 const huge=structuredClone(original);huge.attribution_refs=Array.from({length:201},(_,n)=>({event_id:String(n),candidate_id:original.candidate_id,operation_id:id(900)}));assert.equal(plan(huge).status,'review');
});
test('contact reassignment between snapshot and record invalidates the result',async()=>{
 const cid=await seed(7);await start('reference-record');const p=plan(await snap(cid));assert.equal(p.status,'verified');await pool.query('update candidate_contacts set source_id=$1 where candidate_id=$2',[other.normalized.sources[0].id,cid]);const out=await record('reference-record',p);assert.equal(out[0].reason,'boundary_moved');
});
test('source-owner reassignment invalidates its former owner after record',async()=>{
 const cid=await seed(8),foreign=await seed(9);await start('reference-owner');const s=await snap(cid);await record('reference-owner',plan(s));await pool.query('update candidate_sources set candidate_id=$1 where id=$2',[foreign,s.normalized.sources[0].id]);const fin=await timed("select person_postcutover_audit_finalize('reference-owner') r",[],8);assert.equal(fin.notes.stale,1);
});
test('reference recording waits for a delayed transaction commit',async()=>{
 const cid=await seed(10);await start('reference-delayed');const writer=await pool.connect();try{
 await writer.query('begin');await writer.query('update candidate_contacts set source_id=$1 where candidate_id=$2',[other.normalized.sources[0].id,cid]);const p=plan(await snap(cid));assert.equal(p.status,'verified');let completed=false;const pending=record('reference-delayed',p).finally(()=>completed=true);await new Promise(r=>setTimeout(r,80));const wasPending=!completed;await writer.query('commit');const out=await pending;assert.ok(wasPending);assert.equal(out[0].reason,'boundary_moved');
 }finally{await writer.query('rollback');writer.release();}
});
test('an attribution inserted after snapshot invalidates record and after record invalidates finalization',async()=>{
 for(const [n,afterRecord] of [[11,false],[13,true]]){const cid=await seed(n),foreign=await seed(n+1),run=`reference-attribute-${n}`;await publish(cid);await start(run);const p=plan(await snap(cid));assert.equal(p.status,'verified');if(afterRecord)await record(run,p);await stray(cid,foreign);if(afterRecord){const fin=await timed('select person_postcutover_audit_finalize($1) r',[run],8);assert.equal(fin.notes.stale,1);}else{const out=await record(run,p);assert.equal(out[0].reason,'boundary_moved');}}
});
test('old planners cannot record verified outcomes just by copying a new boundary',async()=>{
 const cid=await seed(15);await start('reference-old-planner');const p=plan(await snap(cid));delete p.checks.reference_version;const out=await record('reference-old-planner',p);assert.notEqual(out[0].status,'verified');assert.equal(out[0].reason,'reference_proof_required');
});
test('older verified results without proof are revisited and cannot finalize as current',async()=>{
 const cid=await seed(16),run='reference-old-result';await start(run);const p=plan(await snap(cid));await record(run,p);await pool.query("update person_postcutover_audit_results set checks=checks-'reference_version' where run_id=$1",[run]);const fin=await timed('select person_postcutover_audit_finalize($1) r',[run],8);assert.equal(fin.notes.stale,1);
 await timed("select person_postcutover_audit_start($1,'reference-test','pending',20,true) r",[run]);const page=await timed('select person_postcutover_audit_page($1,$2,1,2) r',[run,id(15)]);assert.deepEqual(page.ids,[cid]);
});

test('merged recruiter contact evidence retains a valid historical source',async()=>{
 const cid=await seed(17),before=await snap(cid),source=before.normalized.contacts[0].source_id;
 const c=await pool.connect();try{await lib.saveRecruiterContactOnConnection(c,{organizationId:lib.TT_ORG_ID,candidateId:cid,actorId:id(800),requestId:id(801),contact:{email:'reference-17@example.test'},mode:'shadow'});}finally{c.release();}
 const s=await snap(cid);assert.equal(s.normalized.contacts[0].source_id,source);assert.equal(s.normalized.contacts[0].is_manual,true);assert.equal(plan(s).status,'verified');
});
test('the SQL snapshot bounds independent attribution references without loading foreign events',async()=>{
 const cid=await seed(18);await publish(cid);const s=await snap(cid);
 await pool.query("insert into candidates(id,full_name,linkedin_username) select md5('reference-overflow-'||n)::uuid,'Synthetic overflow','reference-overflow-'||n from generate_series(1,201)n");
 await pool.query("insert into person_change_attributions(event_id,candidate_id,operation_id,scope,changed_fields,event_hash) select e.id,$1,$2,'creation','{}',repeat('0',32) from person_change_events e join candidates c on c.id=e.candidate_id where c.linkedin_username like 'reference-overflow-%' and e.operation='INSERT'",[cid,s.operations[0].id]);
 const oversized=await snap(cid);assert.equal(oversized.status,'review');assert.equal(oversized.reason,'attribution_refs_limit');assert.equal(oversized.events,undefined);
});
test('identity, list, header and historical-row reference edits move the committed boundary',async()=>{
 const statements=[
  'update candidate_identities set source_id=$2 where candidate_id=$1',
  'update candidate_educations set source_id=$2 where candidate_id=$1',
  'update candidate_skills set source_id=$2 where candidate_id=$1',
  "update candidate_experiences set source_id=$2,removed_at=clock_timestamp() where candidate_id=$1 and source='person'",
  'update candidate_profile_state set lists_source_id=$2 where candidate_id=$1',
  "update candidate_profile_state set header=jsonb_set(header,'{full_name,source_id}',to_jsonb($2::text)) where candidate_id=$1",
 ];
 for(const [i,sql]of statements.entries()){const cid=await seed(20+i),run=`reference-move-${i}`;await start(run);const p=plan(await snap(cid));assert.equal(p.status,'verified');const changed=await pool.query(sql,[cid,other.normalized.sources[0].id]);assert.ok(changed.rowCount);const result=await record(run,p);assert.equal(result[0].reason,'boundary_moved');}
});
test('person-experience scope transitions are fenced; unrelated sighting updates are not',async()=>{
 const cid=await seed(30),before=await snap(cid);await pool.query('update candidate_contacts set last_seen_at=clock_timestamp() where candidate_id=$1',[cid]);await pool.query('update candidate_profile_state set updated_at=clock_timestamp() where candidate_id=$1',[cid]);assert.equal((await snap(cid)).boundary.candidate_epoch,before.boundary.candidate_epoch);
 await pool.query("update candidate_experiences set source='legacy_import' where candidate_id=$1 and source='person'",[cid]);const after=await snap(cid);assert.ok(BigInt(after.boundary.candidate_epoch)>BigInt(before.boundary.candidate_epoch));
 await pool.query("update candidate_experiences set source='person' where candidate_id=$1 and source='legacy_import'",[cid]);assert.ok(BigInt((await snap(cid)).boundary.candidate_epoch)>BigInt(after.boundary.candidate_epoch));
});
test('finalization sees reference changes committed after it starts waiting',async()=>{
 const cid=await seed(31);await start('reference-late-final');await record('reference-late-final',plan(await snap(cid)));const c=await pool.connect();try{
 await c.query('begin');await c.query('update candidate_contacts set source_id=$1 where candidate_id=$2',[other.normalized.sources[0].id,cid]);const pending=timed("select person_postcutover_audit_finalize('reference-late-final') r",[],8);await new Promise(r=>setTimeout(r,80));await c.query('commit');const fin=await pending;assert.equal(fin.notes.stale,1);
 }finally{await c.query('rollback');c.release();}
});
test('a foreign-declared attribution invalidates the event owner before and after recording',async()=>{
 for(const [n,afterRecord]of [[40,false],[42,true]]){
  const actual=await seed(n),declared=await seed(n+1),run=`reference-event-owner-${n}`;await publish(actual);await publish(declared);await pool.query('update candidates set updated_at=clock_timestamp() where id=$1',[actual]);const s=await snap(actual),e=s.events.at(-1),op=(await snap(declared)).operations[0];assert.equal(e.before_contract_hash,e.after_contract_hash);const p=plan(s);assert.equal(p.status,'verified');await start(run);if(afterRecord)await record(run,p);
  await pool.query("insert into person_change_attributions(event_id,candidate_id,operation_id,scope,changed_fields,event_hash) values($1,$2,$3,'profile','{updated_at}',repeat('0',32))",[e.id,declared,op.id]);assert.equal(plan(await snap(actual)).status,'review');
  if(afterRecord){const f=await timed('select person_postcutover_audit_finalize($1) r',[run],8);assert.equal(f.notes.stale,1);}else assert.equal((await record(run,p))[0].reason,'boundary_moved');
 }
});
test('unchanged application events must bind the exact application receipt',async()=>{
 const cid=await seed(50);for(const n of [501,502]){await pool.query("insert into website_applications(id,organization_id,name,email,linkedin_username) values($1,$2,'Synthetic reference','reference-50@example.test','audit-reference-50')",[id(n),lib.TT_ORG_ID]);const c=await pool.connect();try{await lib.saveApplicationPersonOnConnection(c,{organizationId:lib.TT_ORG_ID,applicationId:id(n),linkedinUsername:'audit-reference-50',name:'Synthetic reference',parsed:null,resumeText:null,mode:'shadow'});}finally{c.release();}}
 const before=await snap(cid);assert.equal(plan(before).status,'verified');const guard=before.operations.find(o=>o.receipt_ref===`application:${id(502)}`).evidence.guard;
 const c=await pool.connect();try{await c.query('begin');await c.query("insert into person_audit_operations(id,candidate_id,writer,receipt_ref,evidence) values($1,$2,'application',$3,$4)",[id(503),cid,`application:${id(502)}`,{guard}]);await c.query('update website_applications set status=status where id=$1',[id(501)]);await c.query("insert into person_change_attributions(event_id,candidate_id,operation_id,scope,changed_fields,event_hash) select id,$1,$2,'application_finalize','{}',md5(jsonb_build_array(id,candidate_id,source_table,source_row_id,operation,transaction_id::text,previous_payload,payload)::text) from person_change_events where candidate_id=$1 and transaction_id=pg_current_xact_id() and source_table='website_applications'",[cid,id(503)]);await c.query('commit');}finally{await c.query('rollback');c.release();}
 const invalid=plan(await snap(cid));assert.equal(invalid.status,'review');assert.equal(invalid.reason,'attribution_invalid');
});
