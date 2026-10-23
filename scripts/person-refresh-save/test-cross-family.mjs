// Existing application/directory suites also run under the new shared dispatchers.
import test from 'node:test';import assert from 'node:assert/strict';import{randomUUID}from'node:crypto';
import '../person-directory-worker/test-worker.mjs';
import {pool,org,phase,row,fixture,run,use} from '../person-directory-execution/test-execution.mjs';
import {app,processApp} from '../person-application-enrichment/test-tt-enrichment.mjs';
import * as lib from '../dist/worker-lib.mjs';import {planAudit} from '../person-audit/postcutover.mjs';
async function refresh(id,requestId=randomUUID()){
 await phase(false);const c=await row(id),queue=randomUUID();
 await pool.query('insert into refresh_queue(id,organization_id,candidate_id) values($1,$2,$3)',[queue,org,id]);
 await pool.query("insert into candidate_enrichments(candidate_id,organization_id,linkedin_username,raw_payload,created_at) values($1,$2,$3,$4,clock_timestamp()-interval '1 day')",[id,org,c.linkedin_username,{headline:'Synthetic refresh',experience:[]}]);
 await phase();process.env.PERSON_TRANSITION_SUPPORT='on';const a={organizationId:org,queueId:queue,requestId,token:randomUUID(),dailyCap:0,allowPaid:false,mode:'live'};
 assert.equal((await use(c=>lib.claimCertifiedRefreshOnConnection(c,a))).status,'claimed');return a;
}
const save=a=>use(c=>lib.saveCertifiedRefreshOnConnection(c,a));
async function audit(id,snapshot){const s=(await pool.query('select person_postcutover_audit_inputs_with_witness($1::jsonb) r',[JSON.stringify([id])])).rows[0].r[0];return planAudit(s,lib,{complete:true,rows:new Map(snapshot?[[snapshot.board.contact_id,snapshot]]:[])});}
test('directory and refresh may share a UUID without borrowing family authority',async()=>{
 const f=await fixture(s=>{s.board.name='Synthetic'});f.args.mode='live';const directory=await run(f),a=await refresh(f.id,f.args.executionId),out=await save(a);assert.equal(out.status,'done');assert.deepEqual(await run(f),directory);assert.deepEqual(await save(a),out);const proof=await audit(f.id,f.snapshot);assert.equal(proof.status,'verified',proof.reason);
});
test('refresh then directory then application preserve the audit chain and old refresh replay',async()=>{
 const f=await fixture(s=>{s.board.name='Synthetic'});f.args.mode='live';const a=await refresh(f.id),out=await save(a);assert.equal((await run(f)).status,'done');
 const application=await processApp(await app({email:randomUUID()+'@example.test'},f.before.linkedin_username));assert.equal(application.status,'processed',application.error?.message);
 assert.deepEqual(await save(a),out);const proof=await audit(f.id,f.snapshot);assert.equal(proof.status,'verified',proof.reason);
});
test('receipt-created applicant can be refreshed without creating another anchor or candidate',async()=>{
 const application=await processApp(await app({email:randomUUID()+'@example.test'}));assert.equal(application.status,'processed',application.error?.message);const id=application.result.candidateId;
 const before=(await pool.query('select to_jsonb(a) r from person_audit_anchors a where candidate_id=$1',[id])).rows[0].r;const a=await refresh(id);assert.equal((await save(a)).status,'done');assert.deepEqual((await pool.query('select to_jsonb(a) r from person_audit_anchors a where candidate_id=$1',[id])).rows[0].r,before);const proof=await audit(id);assert.equal(proof.status,'verified',proof.reason);
});
