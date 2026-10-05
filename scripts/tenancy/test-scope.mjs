// Full-schema loopback regression: a hosted-size database must not broaden a fixture run.
import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';import {randomUUID} from 'node:crypto';
import {armForSweep,disarmAfterSweep,preflightArmedSweep,fixtureRpc} from './armed.mjs';
import {setTransition,openWindow,closeWindow} from '../person-transition.mjs';
import {pgSite} from '../person-trial.mjs';import {reconcilePage} from '../person-reconcile.mjs';import * as lib from '../dist/worker-lib.mjs';
const url=process.env.LOCAL_DATABASE_URL;
if(!url||new URL(url).hostname!=='127.0.0.1'||new URL(url).pathname!=='/person_tenancy_scope_test')throw Error('local scope fixture required');
const db=new pg.Pool({connectionString:url,max:2});db.on('error',()=>{});const env={LOCAL_DATABASE_URL:url,PERSON_TARGET_PROJECT_REF:'local'};
const runId=randomUUID().slice(0,8),sentinels=['01000000','02000000'].map(p=>p+randomUUID().slice(8)),ids=['fa000000','fb000000','fc000000'].map(p=>p+randomUUID().slice(8));
const page=async xs=>(await db.query('select c.id,coalesce(q.version,0) captured_version from candidates c left join person_change_queue q on q.candidate_id=c.id where c.id=any($1::uuid[]) order by c.id',[xs])).rows;
const snapshot=async()=>{const out={};for(const table of ['candidates','candidate_sources','candidate_profile_state','candidate_contacts','person_change_queue','person_change_events','person_audit_anchors']){out[table]=(await db.query(`select to_jsonb(t) r from ${table} t where ${table==='candidates'?'id':'candidate_id'}=any($1::uuid[]) order by to_jsonb(t)::text`,[sentinels])).rows;}return out;};
test('only owned fixture IDs are reconciled and anchored; unrelated pending and ready people stay unchanged',async()=>{
 for(const [i,id] of [...sentinels,...ids].entries())await db.query("insert into candidates(id,full_name,linkedin_username,email,source,created_at) values($1,'Synthetic scope',$2,$3,'leaktest','2025-01-01')",[id,`zzlk${i<2?'foreign':runId}s-li${i}`,`scope${i}@example.test`]);
 const site=await pgSite(url);try{const run=`sentinel-${runId}`;await site.rpc('person_reconcile_start',{p_run:run,p_commit:'c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc',p_limit:1,p_batch:1,p_resume:false,p_scope:'queue',p_external_hash:'1'.repeat(32)});await reconcilePage({site,lib,config:{run,dry:false},page:await page([sentinels[1]])});}finally{await site.end();}
 const before=await snapshot();const preflight=await preflightArmedSweep(env);let ownership;
 await assert.rejects(armForSweep({runId,candidateIds:ids,preflight:{...preflight,controller:{...preflight.controller,revision:'0'}}},env),/controller_changed/);
 await assert.rejects(armForSweep({runId,candidateIds:[sentinels[0]],preflight},env),/not_owned/);
 await assert.rejects(armForSweep({runId,candidateIds:[ids[0],ids[0]],preflight},env),/tenancy_armed_people/);
 assert.deepEqual(await snapshot(),before);
 try{const r=await armForSweep({runId,candidateIds:ids,preflight,onOwnership:o=>{ownership=o;}},env);assert.equal(r.reconciled,3);assert.equal(r.anchored,3);
 assert.deepEqual((await db.query('select candidate_id from person_reconcile_people where run_id=$1 order by candidate_id',[`tenancy-${runId}`])).rows.map(x=>x.candidate_id),ids);
 assert.deepEqual((await db.query('select candidate_id from person_audit_anchors order by candidate_id')).rows.map(x=>x.candidate_id),ids);
 assert.deepEqual(await snapshot(),before);
 const run=(await db.query('select status,notes from backfill_runs where run_id=$1',[`tenancy-${runId}`])).rows[0];assert.equal(run.status,'paused');assert.equal(run.notes.fixture_only,true);assert.equal(run.notes.source_scan_complete,false);
 }finally{if(ownership)await disarmAfterSweep({ownership},env);}
});
test('a controller change before anchor commit cannot borrow a foreign maintenance window',async()=>{
 const expected=(await preflightArmedSweep(env)).controller,call=fixtureRpc(db,expected);
 const inputs=await call('person_audit_anchor_inputs',{p_ids:[sentinels[1]]});
 const items=inputs.map(lib.prepareLegacyAuditAnchor);assert.equal(items[0].status,'ready');
 const other=new pg.Client({connectionString:url});other.on('error',()=>{});await other.connect();let window;
 try{
  await setTransition(other,'arm','foreign_scope_test','disabled');await setTransition(other,'drain','foreign_scope_test','open');await setTransition(other,'seal','foreign_scope_test','draining');
  window=await openWindow(other,'anchors',`foreign-${runId}`,5,'foreign_scope_test','held');
  const state=(await other.query('select person_transition_status() r')).rows[0].r;
  await assert.rejects(call('person_audit_anchor_commit',{p_items:items}),/tenancy_armed_precondition:controller_changed/);
  assert.equal((await other.query('select count(*)::int n from person_audit_anchors where candidate_id=$1',[sentinels[1]])).rows[0].n,0);
  assert.deepEqual((await other.query('select person_transition_status() r')).rows[0].r,state);
  assert.equal((await other.query('select status from person_private.transition_work where id=$1',[window.work_id])).rows[0].status,'active');
 }finally{if(window)await closeWindow(other,window.work_id,'foreign_scope_test_done');await setTransition(other,'disarm','foreign_scope_test_done','held');await other.end();}
});
test.after(()=>db.end());
