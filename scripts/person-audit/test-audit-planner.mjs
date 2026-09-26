// Real PostgreSQL writer snapshots; mutations below are only in-memory evidence
// counterexamples. No production connections or malformed database writes.
import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';
import * as lib from '../dist/worker-lib.mjs';import {prepareAuditFixture} from './local-fixture.mjs';import {planAudit} from './postcutover.mjs';
const url=process.env.LOCAL_DATABASE_URL;if(!url||new URL(url).pathname!=='/person_postcutover_test'||!['localhost','127.0.0.1'].includes(new URL(url).hostname))throw Error('audit_test_database');
const pool=new pg.Pool({connectionString:url,options:'-c timezone=UTC',statement_timeout:15000});
const cid='ed000000-0000-4000-8000-000000000001',app='ed000000-0000-4000-8000-000000000002';
const observed={complete:true,rows:new Map()};const plan=s=>planAudit(s,lib,observed);let original,published,application;
async function snapshot(){const c=await pool.connect();try{await c.query('begin');await c.query("set local statement_timeout='15s'");return (await c.query('select person_postcutover_audit_inputs_with_witness($1::jsonb) r',[JSON.stringify([cid])])).rows[0].r[0];}finally{await c.query('rollback');c.release();}}
test.before(async()=>{
 await pool.query(`insert into candidates(id,full_name,linkedin_username,email,current_title,created_at,work_experience) values($1,'Synthetic planner','audit-planner','planner@example.test','Engineer','2025-01-01',$2)`,[cid,JSON.stringify([{title:'Engineer',company:'Planner Company',start_date:{year:2020},is_current:true}])]);
 await prepareAuditFixture(cid);original=await snapshot();
 const c=await pool.connect();try{await lib.publishPersonProjectionOnConnection(c,cid,{runId:'audit-planner-publish',dryRun:false});}finally{c.release();}published=await snapshot();
 await pool.query(`insert into website_applications(id,organization_id,name,email,linkedin_username,contact) values($1,$2,'Synthetic planner','claimed-extra@example.test','audit-planner','{}')`,[app,lib.TT_ORG_ID]);
 const c2=await pool.connect();try{await lib.saveApplicationPersonOnConnection(c2,{organizationId:lib.TT_ORG_ID,applicationId:app,linkedinUsername:'audit-planner',name:'Synthetic planner',parsed:{current_title:'Resume title'},resumeText:null,mode:'shadow'});}finally{c2.release();}application=await snapshot();
});
test.after(()=>pool.end());
test('real original/published snapshots verify; later shadow admission is explicitly pending publication',()=>{
 assert.equal(plan(original).status,'verified');assert.equal(plan(published).status,'verified');
 const p=plan(application);assert.equal(p.status,'pending');assert.equal(p.reason,'publication_pending');
});
test('a receipt envelope cannot be altered while retaining its source hash',()=>{
 const s=structuredClone(published);s.anchor.legacy_doc.header.full_name='Tampered';assert.equal(plan(s).status,'review');
});
test('catalog provenance must agree with its exact witnessed document',()=>{
 const s=structuredClone(published);s.normalized.sources[0].provider='unproved-provider';assert.equal(plan(s).status,'review');
});
test('raw Harvest payload rewrites and transient bounced communication facts remain review',()=>{
 for(const source_table of ['candidate_enrichments','candidate_communications']){
  const s=structuredClone(published);const old={id:app,candidate_id:cid,organization_id:lib.TT_ORG_ID,provider:'harvest',status:source_table==='candidate_communications'?'bounced':'ok',communication_type:'email',email_used:'planner@example.test',raw_payload:{name:'Before'}};
  const first=(BigInt(s.boundary.capture)+1n).toString();
  s.events.push({id:first,candidate_id:cid,source_table,source_row_id:app,operation:source_table==='candidate_enrichments'?'UPDATE':'INSERT',previous_payload:source_table==='candidate_enrichments'?old:null,payload:{...old,raw_payload:{name:'Changed'}}});
  if(source_table==='candidate_communications')s.events.push({...s.events.at(-1),id:(BigInt(first)+1n).toString(),operation:'DELETE',previous_payload:old,payload:old});
  assert.equal(plan(s).status,'review',source_table);
 }
});
test('a same-key stored job or header cannot contain unwitnessed facts',()=>{
 const job=structuredClone(published);job.normalized.jobs[0].title='Forged CEO';assert.equal(plan(job).status,'review');
 const header=structuredClone(published);header.normalized.state.header.full_name.value='Forged name';assert.equal(plan(header).status,'review');
});
test('receipt-only contact and identity evidence must remain in normalized storage',()=>{
 const s=structuredClone(application);s.projection=null;s.normalized.contacts=s.normalized.contacts.filter(c=>c.value_normalized!=='claimed-extra@example.test');assert.equal(plan(s).status,'review');
 const t=structuredClone(application);t.projection=null;t.normalized.identities=t.normalized.identities.filter(i=>i.kind!=='tt_application_id');assert.equal(plan(t).status,'review');
});
test('wrong tenant and rehashed wrong candidate receipts do not verify',()=>{
 const s=structuredClone(application);s.projection=null;s.application_receipts[0].application_snapshot.organization_id=cid;assert.equal(plan(s).status,'review');
});
test('bad-quality active email is never a valid primary',()=>{
 const s=structuredClone(published);const c=s.normalized.contacts.find(c=>c.kind==='email'&&Number(c.rank)===1);c.quality='bad';c.result='undeliverable';assert.equal(plan(s).status,'review');
});
test('undo attribution needs the exact retained restoration history',()=>{
 const s=structuredClone(published);const e=s.events.find(e=>e.attribution?.scope==='profile');assert.ok(e);const op=s.operations.find(o=>o.id===e.attribution.operation_id);op.writer='undo';op.receipt_ref='undo:9999';op.evidence={...op.evidence,history_id:'9999',revision:s.normalized.state.rev};s.history=[];assert.equal(plan(s).status,'review');
});
test('ordinary application status completion remains accounted without source finalization attribution',async()=>{
 await pool.query("update website_applications set status='complete' where id=$1",[app]);const s=await snapshot();s.projection=null;assert.equal(plan(s).status,'verified');
});
test('a linked directory contact cannot verify without complete external access or admission',()=>{
 const s=structuredClone(published);s.boundary.directory_epochs=[{contact_id:app,epoch:'0'}];
 const missing=planAudit(s,lib,{complete:false,rows:new Map()});assert.equal(missing.status,'pending');assert.equal(missing.reason,'external_unavailable');
 const d={board:{contact_id:app},harvest:null,exps:[],edus:[],emails:[],phones:[],facts:[],identifiers:[]};
 const unseen=planAudit(s,lib,{complete:true,rows:new Map([[app,d]])});assert.equal(unseen.status,'pending');assert.equal(unseen.reason,'directory_snapshot_not_admitted');
});

test('missing normalized header fields cannot verify',()=>{const s=structuredClone(published);s.normalized.state.header={};assert.equal(plan(s).status,'review');});
test('contact evidence cannot gain manual or primary eligibility flags',()=>{
 for(const mutate of [c=>c.is_manual=true,c=>c.never_primary=true,c=>{c.quality='good';c.result='valid';}]){const s=structuredClone(published);mutate(s.normalized.contacts[0]);assert.equal(plan(s).status,'review');}
});
