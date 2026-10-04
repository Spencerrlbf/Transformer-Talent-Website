// R2-02, sealed (no sockets, no database): the leak test's actual CLI try/finally
// path and the armed-mode helpers may change the controller only when THIS sweep
// armed it, and only with the exact revision/generation it produced.
//
// Part 1 runs scripts/test-tenancy.mjs itself as a child whose `pg` is the controller
// double (fake-controller-pg.cjs) and whose `fetch` records every request and fails
// the first fixture write: a failed setup, an already-enabled controller, a target
// mismatch and --keep must all leave the controller exactly as found.
// Part 2 drives disarmAfterSweep / recoverArmOwnership in-process against the same
// double: missing or stale ownership, foreign windows, a two-operator change that ends
// in the same phase, a lost commit acknowledgement, and the owned happy path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(import.meta.url);
const IDENTITY='7000000000000000001';
const WINDOW={work_id:'11111111-1111-4111-8111-111111111111',step:'publish',run_id:'existing-operator-run',status:'active',lease_until:'2099-01-01T00:00:00Z',expired:false};
const baseEnv={
 PATH:process.env.PATH,HOME:process.env.HOME,
 SUPABASE_URL:'http://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',SUPABASE_ANON_KEY:'synthetic-anon',
 PERSON_TARGET_PROJECT_REF:'local',LOCAL_DATABASE_URL:'postgresql://postgres@127.0.0.1:1/person_sealed_test',
};

// ---- Part 1: the real CLI in a sealed child ------------------------------------
const preload=path.join(os.tmpdir(),`tt-armed-seal-${process.pid}.cjs`);
fs.writeFileSync(preload,`
const fs=require('fs');const {install}=require(${JSON.stringify(path.join(root,'scripts/tenancy/fake-controller-pg.cjs'))});
install();
const log=process.env.SIM_LOG;const identity=JSON.parse(process.env.SIM_STATE).identity||'${IDENTITY}';
const restIdentity=process.env.SIM_REST_IDENTITY||identity;
globalThis.fetch=async(input,init={})=>{
 const u=new URL(String(input));const method=init.method||'GET';
 fs.appendFileSync(log,'fetch '+method+' '+u.hostname+u.pathname+'\\n');
 if(u.pathname.endsWith('/rpc/person_target_identity'))return new Response(JSON.stringify({system_identifier:restIdentity}),{status:200,headers:{'content-type':'application/json'}});
 if(u.pathname.endsWith('/rpc/person_transition_status'))return new Response(JSON.stringify({enabled:false,phase:'open'}),{status:200});
 return new Response('sealed',{status:503});
};
const net=require('net');net.Socket.prototype.connect=function(){fs.appendFileSync(log,'socket\\n');throw Error('sealed');};
`);
test.after(()=>fs.rmSync(preload,{force:true}));
function runCli(args,state,extraEnv={}){
 const log=path.join(os.tmpdir(),`tt-armed-seal-log-${process.pid}-${Math.random().toString(16).slice(2)}`);
 fs.writeFileSync(log,'');
 const r=spawnSync(process.execPath,['--require',preload,'scripts/test-tenancy.mjs',...args],{cwd:root,encoding:'utf8',timeout:60000,env:{...baseEnv,SIM_LOG:log,SIM_STATE:JSON.stringify(state),...extraEnv}});
 const lines=fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean);fs.rmSync(log,{force:true});
 return {...r,
  transitions:lines.filter(l=>/^(transition_set|maintenance_close)/.test(l)),
  writes:lines.filter(l=>/^fetch (POST|PATCH|PUT|DELETE)/.test(l)&&!/rpc\/person_(target_identity|transition_status)/.test(l)),
  sockets:lines.filter(l=>l==='socket'),
  lines};
}
const ENABLED_OPEN={identity:IDENTITY,control:{enabled:true,phase:'open',revision:'9',generation:'5'},windows:[WINDOW]};
const DISABLED={identity:IDENTITY,control:{enabled:false,phase:'open',revision:'4',generation:'2'}};

test('CLI: an already-enabled controller with an operator window is refused before any fixture write; no transition, no window closed',()=>{
 for(const args of [['--armed','--base','http://127.0.0.1:1'],['--armed','--keep','--base','http://127.0.0.1:1']]){
  const r=runCli(args,ENABLED_OPEN);
  assert.equal(r.status,1,r.stdout+r.stderr);
  assert.match(r.stdout,/tenancy_armed_precondition:controller_enabled/);
  assert.match(r.stdout,/controller untouched: this sweep did not arm it/);
  assert.deepEqual(r.transitions,[],'the review\'s reproduction: drain → close → seal → disarm must not happen');
  assert.deepEqual(r.writes,[],'no fixture write before the precondition');
  assert.deepEqual(r.sockets,[]);
 }
});
test('CLI: setup fails while the controller is disabled; nothing is armed, nothing is disarmed',()=>{
 const r=runCli(['--armed','--base','http://127.0.0.1:1'],DISABLED);
 assert.equal(r.status,1);
 assert.match(r.stdout,/fixture target proved \(local, cluster 7000000000000000001\); controller disabled at revision 4/);
 assert.match(r.stdout,/CRASH/);
 assert.match(r.stdout,/controller untouched: this sweep did not arm it/);
 assert.deepEqual(r.transitions,[]);
 assert.ok(r.writes.length>=1,'setup attempted its first fixture write after preflight');
 assert.deepEqual(r.sockets,[]);
});
test('CLI: REST and PostgreSQL report different clusters: refused before any fixture write',()=>{
 const r=runCli(['--armed','--base','http://127.0.0.1:1'],DISABLED,{SIM_REST_IDENTITY:'7000000000000000002'});
 assert.equal(r.status,1);
 assert.match(r.stdout,/person_target:identity_mismatch/);
 assert.deepEqual(r.transitions,[]);assert.deepEqual(r.writes,[]);
});
test('CLI: a PostgreSQL URL for a hosted project under a local selection is refused offline, before any client',()=>{
 const r=runCli(['--armed','--base','http://127.0.0.1:1'],DISABLED,{LOCAL_DATABASE_URL:undefined,PERSON_PUBLISH_DATABASE_URL:'postgres://postgres.abcdefghijklmnopqrst:secret-sentinel@aws-0-us-east-2.pooler.supabase.com:5432/postgres'});
 assert.equal(r.status,1);
 assert.match(r.stdout,/person_target:database_mismatch/);
 assert.doesNotMatch(r.stdout+r.stderr,/secret-sentinel/);
 assert.deepEqual(r.transitions,[]);assert.deepEqual(r.writes,[]);
});
// ---- Part 2: the helpers in-process against the double --------------------------
const {install}=require('./fake-controller-pg.cjs');
let sim=install({state:{identity:IDENTITY}});
const armed=await import('./armed.mjs');
const env={...baseEnv};
const reset=(state)=>{sim=install({state:{identity:IDENTITY,...state}});return sim;};
const RUN_ID='k9x2abcd';
const owned=(over={})=>({database:IDENTITY,run:RUN_ID,revision:'10',generation:'6',phase:'open',last_action:'arm',...over});
const rejectsOwnership=(p,detail)=>assert.rejects(p,e=>e.message===`tenancy_armed_ownership:${detail}`||(detail instanceof RegExp&&detail.test(e.message)),String(detail));

test('ownership: reason codes are unique per run and action and fit the controller\'s format',()=>{
 assert.equal(armed.sweepReason('arm','k9x2abcd'),'tenancy_sweep_arm_k9x2abcd');
 assert.equal(armed.sweepReason('disarm','Run-1'),'tenancy_sweep_disarm_run_1');
 assert.throws(()=>armed.sweepReason('arm','x'.repeat(101)),/tenancy_armed_run/);
});
test('disarm without an ownership record changes nothing',async()=>{
 reset({control:{enabled:true,phase:'open',revision:'10',generation:'6'},windows:[WINDOW]});
 await rejectsOwnership(armed.disarmAfterSweep({},env),'missing');
 await rejectsOwnership(armed.disarmAfterSweep({ownership:{run:RUN_ID,revision:'10'}},env),'missing');
 await rejectsOwnership(armed.disarmAfterSweep({ownership:owned({revision:'1e3'})},env),'missing');
 assert.deepEqual(sim.actions,[]);assert.equal(sim.control.enabled,true);assert.equal(sim.windows.length,1);
});
test('disarm with a stale record (another operator moved the controller) changes nothing',async()=>{
 reset({control:{enabled:true,phase:'open',revision:'11',generation:'6'}});
 await rejectsOwnership(armed.disarmAfterSweep({ownership:owned()},env),'stale:open:11:6');
 assert.deepEqual(sim.actions,[]);
});
test('two operators: drain + reopen by someone else ends in the same phase and generation+1; the sweep\'s record is stale',async()=>{
 reset({control:{enabled:false,phase:'open',revision:'9',generation:'5'}});
 // this sweep arms (rev 10, gen 6), as armForSweep would
 const r=await armed.recoverArmOwnership({runId:RUN_ID},env);assert.equal(r,null,'no event yet');
 sim.events.push({action:'arm',reason_code:armed.sweepReason('arm',RUN_ID),revision:'10',generation:'6'});sim.control={enabled:true,phase:'open',revision:'10',generation:'6'};
 const mine=await armed.recoverArmOwnership({runId:RUN_ID,database:IDENTITY},env);
 assert.deepEqual(mine,owned());
 // another operator: drain (rev 11), reopen (rev 12, gen 7) -> phase open again
 sim.control={enabled:true,phase:'open',revision:'12',generation:'7'};
 await rejectsOwnership(armed.disarmAfterSweep({ownership:mine},env),'stale:open:12:7');
 await rejectsOwnership(armed.recoverArmOwnership({runId:RUN_ID,database:IDENTITY},env),'unresolved_arm:open:12:7');
 assert.deepEqual(sim.actions,[]);
});
test('a foreign maintenance window stops the sequence before any transition',async()=>{
 reset({control:{enabled:true,phase:'open',revision:'10',generation:'6'},windows:[WINDOW]});
 await rejectsOwnership(armed.disarmAfterSweep({ownership:owned()},env),'foreign_windows:1');
 assert.deepEqual(sim.actions,[]);assert.equal(sim.windows.length,1);
});
test('a different database than the one armed is refused',async()=>{
 reset({identity:'7000000000000000009',control:{enabled:true,phase:'open',revision:'10',generation:'6'}});
 await rejectsOwnership(armed.disarmAfterSweep({ownership:owned()},env),'database');
 await rejectsOwnership(armed.recoverArmOwnership({runId:RUN_ID,database:IDENTITY},env),'database');
 assert.deepEqual(sim.actions,[]);
});
test('owned happy path: drain, own window closed, seal, disarm, each CAS on the sweep\'s own values; unrelated unresolved work stops it',async()=>{
 reset({control:{enabled:true,phase:'open',revision:'10',generation:'6'},windows:[{...WINDOW,work_id:'22222222-2222-4222-8222-222222222222',run_id:`tenancy-${RUN_ID}`}]});
 const d=await armed.disarmAfterSweep({ownership:owned()},env);
 assert.deepEqual(d.steps,['drain','close:22222222-2222-4222-8222-222222222222','seal','disarm']);
 assert.deepEqual(sim.actions,[
  `transition_set drain 10 6 tenancy_sweep_drain_${RUN_ID}`,
  `maintenance_close 22222222-2222-4222-8222-222222222222 tenancy_sweep_close_${RUN_ID}`,
  `transition_set seal 11 6 tenancy_sweep_seal_${RUN_ID}`,
  `transition_set disarm 12 7 tenancy_sweep_disarm_${RUN_ID}`]);
 assert.deepEqual(sim.control,{enabled:false,phase:'open',revision:'13',generation:'8'});
 assert.deepEqual(d.ownership,owned({revision:'13',generation:'8',phase:'disabled',last_action:'disarm'}));
 // already disabled: a second call with the final record is a no-op
 const again=await armed.disarmAfterSweep({ownership:d.ownership},env);
 assert.equal(again.skipped,true);assert.equal(sim.actions.length,4);
 // unresolved TT work: drain happens (allowed), seal is refused, nothing forced
 reset({control:{enabled:true,phase:'open',revision:'10',generation:'6'},unresolved:[{family:'application',status:'uncertain',expired:false,n:1}]});
 await assert.rejects(armed.disarmAfterSweep({ownership:owned()},env),e=>e.message.startsWith('tenancy_armed_drain:')&&e.steps.join()==='drain');
 assert.deepEqual(sim.actions,[`transition_set drain 10 6 tenancy_sweep_drain_${RUN_ID}`]);
});
test('a lost commit acknowledgement during the owned sequence is resolved from the durable event, never guessed',async()=>{
 reset({control:{enabled:true,phase:'open',revision:'10',generation:'6'},failCommits:1});
 const d=await armed.disarmAfterSweep({ownership:owned()},env);
 assert.deepEqual(d.steps,['drain','seal','disarm']);
 assert.equal(sim.actions[1],'commit_ack_lost');
 assert.deepEqual(sim.control,{enabled:false,phase:'open',revision:'13',generation:'8'});
 // ...but when the event is there and the controller moved on before recovery, the
 // step is unresolved and nothing further is attempted
 reset({control:{enabled:true,phase:'open',revision:'10',generation:'6'},failCommits:1,onLostCommit:(state)=>{state.control={...state.control,revision:'99'};}});
 await rejectsOwnership(armed.disarmAfterSweep({ownership:owned()},env),'in_doubt_drain');
 assert.deepEqual(sim.actions,[`transition_set drain 10 6 tenancy_sweep_drain_${RUN_ID}`,'commit_ack_lost']);
});
