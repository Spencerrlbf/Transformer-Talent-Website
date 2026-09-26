import test from 'node:test';import assert from 'node:assert/strict';import net from 'node:net';import pg from 'pg';
import * as lib from '../dist/worker-lib.mjs';
import {rehearse,newManifest,localConfig,options,snapshot,footprint} from './rehearse.mjs';import {denyOutboundExceptDatabase} from './network.mjs';
const url=process.env.LOCAL_DATABASE_URL,config=localConfig(url),pool=new pg.Pool(config);
const school='ef000000-0000-4000-8000-000000000099';
test.before(async()=>{
 await pool.query("insert into schools(id,name,normalized_name,identity_basis,tier) values($1,'Synthetic sentinel school','synthetic sentinel school','name',3)",[school]);
 await pool.query("select person_write_guard_set(true,'local canary fixture')");
});
test.after(()=>pool.end());
for(const mode of ['shadow','live'])test(`${mode} real admission verifies and leaves all fixture rows unchanged`,async()=>{
 const before=await snapshot(pool),r=await rehearse({url,mode});assert.equal(r.status,'rolled_back');assert.equal(r.precommit_planner,'verified');assert.equal(r.derivative_jobs,mode==='live'?1:0);assert.deepEqual(await snapshot(pool),before);
});
for(const mutation of ['incumbent','school','failure'])test(`${mutation} before verification rolls the entire admission back`,async()=>{
 const before=await snapshot(pool);
 await assert.rejects(rehearse({url,beforeVerify:async c=>{
  if(mutation==='incumbent')await c.query("update candidates set status='Synthetic mutation' where linkedin_username='zzcanary-3'");
  else if(mutation==='school')await c.query('update schools set tier=1 where id=$1',[school]);
  else throw Error('injected failure');
 }}),mutation==='failure'?/injected failure/:/canary_scope_(baseline|added)/);
 assert.deepEqual(await snapshot(pool),before);
});
test('existing application and username are rejected without adopting an incumbent',async()=>{
 for(const kind of ['application','username','identity']){
  const m=newManifest();
  if(kind==='application')await pool.query("insert into website_applications(id,organization_id,name,email,linkedin_username) values($1,$2,'Synthetic collision','synthetic@example.test','different')",[m.applicationId,m.organizationId]);
  else if(kind==='username'){
   const c=await pool.connect();try{await lib.saveApplicationPersonOnConnection(c,{organizationId:m.organizationId,applicationId:m.applicationId,linkedinUsername:m.username,name:'Synthetic occupied identity',parsed:null,resumeText:null,mode:'shadow'},{afterBegin:async tx=>{await tx.query("insert into website_applications(id,organization_id,name,email,linkedin_username) values($1,$2,'Synthetic occupied identity',$3,$4)",[m.applicationId,m.organizationId,`${m.username}@example.test`,m.username]);}});}finally{c.release();}
   m.applicationId=crypto.randomUUID();
  }
  else {const cid=(await pool.query("select id from candidates limit 1")).rows[0].id;await pool.query("insert into candidate_identities(candidate_id,kind,value) values($1,'linkedin_username',$2)",[cid,m.username]);}
  const before=await snapshot(pool);await assert.rejects(rehearse({url,manifest:m}),/canary_identity_occupied/);assert.deepEqual(await snapshot(pool),before);
 }
});
test('foreign organization, apply mode, and production or query-overridden connection are rejected',async()=>{
 assert.throws(()=>options(['--apply']),/canary_option/);assert.throws(()=>options(['--mode=live','--mode=shadow']),/canary_option/);
 for(const value of ['postgresql://postgres@website.invalid:5432/person_canary_test',url+'?host=website.invalid',url.replace('person_canary_test','postgres')])assert.throws(()=>localConfig(value),/canary_local_database/);
 await assert.rejects(rehearse({url,manifest:{...newManifest(),organizationId:school}}),/canary_manifest/);
});
test('new shared rows, schema changes and removed baseline rows cannot enter the footprint',()=>{
 const m=newManifest(),cid=school;
 assert.throws(()=>footprint({'public.schools':[]},{'public.schools':[{id:school}]},m,cid),/canary_scope_added/);
 assert.throws(()=>footprint({'public.schools':[{id:school}]},{'public.schools':[]},m,cid),/canary_scope_baseline/);
 assert.throws(()=>footprint({}, {'public.schools':[]},m,cid),/canary_scope_schema/);
});
test('an attribution cannot claim an incumbent event as the canary event',async()=>{
 await pool.query("update candidates set status='Synthetic sentinel workflow' where linkedin_username='zzcanary-3'");
 const foreign=(await pool.query("select e.id from person_change_events e join candidates c on c.id=e.candidate_id where c.linkedin_username='zzcanary-3' and not exists(select 1 from person_change_attributions a where a.event_id=e.id) order by e.id desc limit 1")).rows[0].id;
 const before=await snapshot(pool);
 await assert.rejects(rehearse({url,beforeVerify:async(c,r)=>{
  await c.query("insert into person_change_attributions(event_id,candidate_id,operation_id,scope,changed_fields,event_hash) select $1,$2,id,'creation','{}'::text[],repeat('0',32) from person_audit_operations where candidate_id=$2 limit 1",[foreign,r.candidateId]);
 }}),/canary_scope_(reference|added)/); // Referenced-owner epoch may expose the extra row first.
 assert.deepEqual(await snapshot(pool),before);
});
test('new contacts cannot borrow another candidate source',async()=>{
 const foreign=(await pool.query('select id from candidate_sources limit 1')).rows[0].id,before=await snapshot(pool);
 await assert.rejects(rehearse({url,beforeVerify:async(c,r)=>{await c.query('update candidate_contacts set source_id=$1 where candidate_id=$2',[foreign,r.candidateId]);}}),/canary_scope_reference/);
 assert.deepEqual(await snapshot(pool),before);
});
test('missing deferred attribution fails even though the successful rehearsal would roll back',async()=>{
 const before=await snapshot(pool);
 await assert.rejects(rehearse({url,beforeVerify:async(c,r)=>{
  await c.query(`insert into person_change_events(candidate_id,source_table,source_row_id,operation,payload)
   select id,'candidates',id::text,'INSERT',to_jsonb(c) from candidates c where id=$1`,[r.candidateId]);
 }}),/person_profile_write_guard/);
 assert.deepEqual(await snapshot(pool),before);
});
test('provider fetch and non-database sockets are refused',async()=>{
 const restore=denyOutboundExceptDatabase(config.port);
 try{await assert.rejects(fetch('https://api.openai.com/v1/embeddings'),/canary_outbound_denied/);assert.throws(()=>net.connect({host:'example.com',port:443}),/canary_outbound_denied/);assert.throws(()=>net.connect({path:'/tmp/unapproved.sock'}),/canary_outbound_denied/);}finally{restore();}
});
