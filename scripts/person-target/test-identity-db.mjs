// Database-backed: three databases in ONE PostgreSQL cluster, so pg_control_system()
// returns the same identifier for all of them (exactly the production/copy situation,
// where the copy is a physical clone). A is labelled `local`, B is labelled for a
// fictional other project, C was never labelled. The label, not the identifier, must
// decide; nothing here or in the code under test relabels a database. Run through
// scripts/person-target/run-identity-tests.sh <port>.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {verifyRuntimeIdentity,verifyDatabaseIdentity,identityKey,IDENTITY_SQL,isTargetError} from '../person-target.mjs';
import {openDatabase} from '../person-publish/lib.mjs';

const urls={A:process.env.IDENTITY_DATABASE_A,B:process.env.IDENTITY_DATABASE_B,C:process.env.IDENTITY_DATABASE_C};
for(const [k,u] of Object.entries(urls))if(!new RegExp(`^postgresql://postgres@127\\.0\\.0\\.1:\\d+/person_identity_${k.toLowerCase()}_test$`).test(u||''))throw Error('local fixtures required');
const OTHER='abcdefghijklmnopqrst';
const pools=Object.fromEntries(Object.entries(urls).map(([k,u])=>{const p=new pg.Pool({connectionString:u,max:2});p.on('error',()=>{});return [k,p];}));
const {A:a,B:b,C:c}=pools;
test.after(async()=>{for(const p of Object.values(pools))await p.end();});
const identity=async(pool)=>(await pool.query(IDENTITY_SQL)).rows[0].identity;
const rejects=(p,code)=>assert.rejects(p,e=>isTargetError(e)&&e.message===`person_target:${code}`,code);

test('one cluster: the identifier is identical for every database; only the label differs',async()=>{
 const [ia,ib,ic]=await Promise.all([identity(a),identity(b),identity(c)]);
 assert.equal(ia.system_identifier,ib.system_identifier);assert.equal(ia.system_identifier,ic.system_identifier);
 assert.equal(ia.project_ref,'local');assert.equal(ib.project_ref,OTHER);assert.equal(ic.project_ref,null);
 assert.notEqual(identityKey(ia),identityKey(ib));
 assert.ok(ia.labelled_at&&ib.labelled_at&&ic.labelled_at===null);
});
test('REST on one database, PostgreSQL on the other: refused although the cluster identifier agrees',async()=>{
 await rejects(verifyRuntimeIdentity({readRest:()=>identity(a),readDatabase:()=>identity(b),ref:'local'}),'identity_label_mismatch');
 await rejects(verifyRuntimeIdentity({readRest:()=>identity(b),readDatabase:()=>identity(a),ref:OTHER}),'identity_label_mismatch');
 await rejects(verifyRuntimeIdentity({readRest:()=>identity(a),readDatabase:()=>identity(c),ref:'local'}),'identity_unlabelled');
 const ok=await verifyRuntimeIdentity({readRest:()=>identity(a),readDatabase:()=>identity(a),ref:'local'});
 assert.equal(ok.project_ref,'local');assert.equal(ok.key,`local:${ok.system_identifier}`);
 await rejects(verifyDatabaseIdentity(b,'local'),'identity_label_mismatch');
 await rejects(verifyDatabaseIdentity(a,OTHER),'identity_label_mismatch');
 await rejects(verifyDatabaseIdentity(c,'local'),'identity_unlabelled');
 assert.equal((await verifyDatabaseIdentity(b,OTHER)).project_ref,OTHER);
});
test('the operator pool opener refuses the other clone and the unlabelled database before handing out a handle',async()=>{
 await rejects(openDatabase({LOCAL_DATABASE_URL:urls.B,PERSON_TARGET_PROJECT_REF:'local'},'tt-identity-test'),'identity_label_mismatch');
 await rejects(openDatabase({LOCAL_DATABASE_URL:urls.C,PERSON_TARGET_PROJECT_REF:'local'},'tt-identity-test'),'identity_unlabelled');
 const db=await openDatabase({LOCAL_DATABASE_URL:urls.A,PERSON_TARGET_PROJECT_REF:'local'},'tt-identity-test');
 assert.equal((await db.query('select 1 v')).rows[0].v,1);await db.end();
 // A loopback fixture without any selection is not label-checked (the server gate's rule).
 const plain=await openDatabase({LOCAL_DATABASE_URL:urls.B},'tt-identity-test');await plain.end();
 // The refusal happened before any label was written anywhere.
 assert.equal((await identity(c)).project_ref,null);
});
test('the label is written once and never changed: relabel, update, delete and truncate are refused',async()=>{
 await assert.rejects(a.query('select person_private.target_label($1)',[OTHER]),/target_label_exists/);
 const same=(await a.query("select person_private.target_label('local') r")).rows[0].r;
 assert.equal(same.project_ref,'local');assert.equal(same.created,false);
 await assert.rejects(a.query('update person_private.target_identity set project_ref=$1',[OTHER]),/target_identity_immutable/);
 await assert.rejects(a.query('delete from person_private.target_identity'),/target_identity_immutable/);
 await assert.rejects(a.query('truncate person_private.target_identity'),/target_identity_immutable/);
 await assert.rejects(a.query("insert into person_private.target_identity(project_ref) values($1)",[OTHER]),/duplicate key|target_identity_pkey/);
 await assert.rejects(c.query("select person_private.target_label('Prod')"),/target_label_invalid/);
 await assert.rejects(c.query('select person_private.target_label(null)'),/target_label_invalid/);
 await assert.rejects(c.query("select person_private.target_label('abcdefghijklmnopqrst.supabase.co')"),/target_label_invalid/);
 assert.equal((await identity(a)).project_ref,'local');assert.equal((await identity(c)).project_ref,null);
});
test('labelling is an explicit operator statement with an explicit value; afterwards the proof passes for that project only',async()=>{
 const made=(await c.query("select person_private.target_label('local') r")).rows[0].r;
 assert.equal(made.created,true);assert.equal(made.project_ref,'local');
 assert.equal((await verifyDatabaseIdentity(c,'local')).project_ref,'local');
 await rejects(verifyDatabaseIdentity(c,OTHER),'identity_label_mismatch');
 const db=await openDatabase({LOCAL_DATABASE_URL:urls.C,PERSON_TARGET_PROJECT_REF:'local'},'tt-identity-test');await db.end();
});
test('API roles cannot read or write the label; only service_role reads the identity, through the function',async()=>{
 const client=await a.connect();
 // each statement in its own transaction as that role
 const as=async(role,sql)=>{await client.query('begin');try{await client.query(`set local role ${role}`);return await client.query(sql);}finally{await client.query('rollback');}};
 try{
  for(const role of ['anon','authenticated','service_role']){
   await assert.rejects(as(role,'select * from person_private.target_identity'),/permission denied/);
   await assert.rejects(as(role,"select person_private.target_label('local')"),/permission denied/);
   await assert.rejects(as(role,"select person_private.target_label('tsrqponmlkjihgfedcba')"),/permission denied/);
   if(role==='service_role')assert.equal((await as(role,IDENTITY_SQL)).rows[0].identity.project_ref,'local');
   else await assert.rejects(as(role,IDENTITY_SQL),/permission denied/);
  }
 }finally{client.release();}
 assert.equal((await identity(a)).project_ref,'local');
});
