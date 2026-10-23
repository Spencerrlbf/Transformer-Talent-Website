import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import * as lib from '../dist/worker-lib.mjs';
import {localConfig} from './rehearse.mjs';
const url=process.env.LOCAL_DATABASE_URL;
const pool=new pg.Pool(localConfig(url));
const org=lib.TT_ORG_ID,id=n=>`ef000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const args=n=>({organizationId:org,applicationId:id(n),linkedinUsername:`zzcanary-${n}`,name:'Synthetic canary',parsed:null,resumeText:'Synthetic resume only',mode:'shadow'});
async function seed(c,n){await c.query("insert into website_applications(id,organization_id,name,email,linkedin_username,status) values($1,$2,'Synthetic canary',$3,$4,'queued')",[id(n),org,`zzcanary-${n}@example.test`,`zzcanary-${n}`]);}
const use=async fn=>{const c=await pool.connect();try{return await fn(c);}finally{c.release();}};
test.after(()=>pool.end());
test('after-BEGIN fixture and successful real admission roll back together at the verifier',async()=>{
 const stop=Error('canary_verified_rollback');let verified=false;
 await assert.rejects(use(c=>lib.saveApplicationPersonOnConnection(c,args(1),{
  afterBegin:tx=>seed(tx,1),
  beforeCommit:async(tx,r)=>{
   await tx.query('set constraints all immediate');
   assert.equal(r.created,true);
   assert.equal((await tx.query('select count(*) n from person_application_receipts where application_id=$1',[id(1)])).rows[0].n,'1');
   verified=true;throw stop;
  }
 })),e=>e===stop);
 assert.equal(verified,true);
 assert.equal((await pool.query('select count(*) n from website_applications where id=$1',[id(1)])).rows[0].n,'0');
 assert.equal((await pool.query("select count(*) n from candidates where linkedin_username='zzcanary-1'")).rows[0].n,'0');
 assert.equal((await pool.query('select count(*) n from person_application_receipts')).rows[0].n,'0');
});
test('a verifier failure cannot escape the owned transaction via an early COMMIT',async()=>{
 await seed(pool,2);const stop=Error('canary_scope_escape');
 await assert.rejects(use(c=>lib.saveApplicationPersonOnConnection(c,args(2),{beforeCommit:()=>{throw stop;}})),e=>e===stop);
 assert.equal((await pool.query('select candidate_id from website_applications where id=$1',[id(2)])).rows[0].candidate_id,null);
 assert.equal((await pool.query("select count(*) n from candidates where linkedin_username='zzcanary-2'")).rows[0].n,'0');
});
test('the existing entrypoint without hooks still commits the actual writer',async()=>{
 await seed(pool,3);const result=await use(c=>lib.saveApplicationPersonOnConnection(c,args(3)));
 assert.equal(result.created,true);
 assert.equal((await pool.query('select candidate_id from person_application_receipts where application_id=$1',[id(3)])).rows[0].candidate_id,result.candidateId);
});
