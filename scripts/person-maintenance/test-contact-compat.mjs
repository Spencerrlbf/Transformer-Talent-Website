import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {prepareCompatibilityRuntime} from './contact-compat-runtime.mjs';
const pinned=(process.env.PINNED_RUNNER_DIR??new URL('../../../pinned/',import.meta.url).pathname).replace(/\/?$/,'/');
const id='11111111-1111-4111-8111-111111111111';
const fixture=(kind='email',suppressed=true)=>{const s={candidate_ids:[id],contacts:[{candidate_id:id,kind,value_normalized:kind==='email'?'test@example.invalid':'+12025550100',rank:null,status:'active',never_primary:false}],decisions:[{candidate_id:id,kind,chosen_value:null,suppressed}],contact_summary:[{candidate_id:id,primary_email:null,primary_phone:null,secondary_email:null,secondary_phone:null,usable_emails:[]}],profile_state:[{candidate_id:id,rev:1}]};Object.defineProperty(s,'row_counts',{enumerable:true,get:()=>[{candidate_id:id,contacts:s.contacts.length,decisions:s.decisions.length}]});return s;};
const input={row:{work_experience:[]},legacy:[],v2:[],ledger:[],apps:[]};
const lib={project:()=>({})};
const tally=()=>({badChecks:[],run(){},bad(k){this.badChecks.push(k);}});
async function read(mod,snap){return mod.readNew({rpc:async()=>snap,select:async()=>[]},[id],{globalCounts:false});}
test('actual historical verifier rejects legitimate suppressed contacts; derived verifier accepts email/phone/both',async()=>{
 const historical=await import(pathToFileURL(pinned+'scripts/person-trial.mjs'));
 const runtime=prepareCompatibilityRuntime({root:pinned,bundleHash:'fixture'});
 const derived=await import(pathToFileURL(runtime.root+'/scripts/person-trial.mjs'));
 for(const kind of ['email','phone','both']){
  const snap=fixture(kind==='both'?'email':kind);
  if(kind==='both'){snap.contacts.push(...fixture('phone').contacts);snap.decisions.push(...fixture('phone').decisions);}
  const stored=await read(derived,snap);
  const red=tally();historical.checkStored(red,id,input,[],stored,lib);
  assert.ok(red.badChecks.some(x=>x.startsWith('one_primary_')));
  const green=tally();derived.checkStored(green,id,input,[],stored,lib);
  assert.deepEqual(green.badChecks,[]);
 }
});
test('automatic, absent and selected decisions preserve ordinary integrity; suppression rejects any rank',async()=>{
 const runtime=prepareCompatibilityRuntime({root:pinned});const mod=await import(pathToFileURL(runtime.root+'/scripts/person-trial.mjs'));
 for(const mode of ['automatic','absent','selected','suppressed'])for(const rank of [null,1,2]){
  const snap=fixture();snap.contacts[0].rank=rank;
  if(mode==='absent')snap.decisions=[];
  if(mode==='automatic')snap.decisions[0].suppressed=false;
  if(mode==='selected'){snap.decisions[0].suppressed=false;snap.decisions[0].chosen_value=snap.contacts[0].value_normalized;}
  snap.contact_summary[0].primary_email=rank===1?snap.contacts[0].value_normalized:null;
  const t=tally();mod.checkStored(t,id,input,[],await read(mod,snap),lib);
  assert.equal(t.badChecks.includes('one_primary_email'),mode==='suppressed'?rank!==null:rank!==1,`${mode} rank ${rank}`);
 }
});
test('failed/malformed/incomplete snapshots fail closed and use no global decision scan',async()=>{
 const runtime=prepareCompatibilityRuntime({root:pinned});const mod=await import(pathToFileURL(runtime.root+'/scripts/person-trial.mjs'));
 for(const alter of [s=>null,s=>({...s,candidate_ids:[]}),s=>({...s,decisions:null}),s=>({...s,decisions:[...s.decisions,...s.decisions]}),s=>({...s,decisions:[{...s.decisions[0],suppressed:null}]}),s=>({...s,decisions:[{...s.decisions[0],chosen_value:'wrong'}]}),s=>({...s,contact_summary:[...s.contact_summary,...s.contact_summary]})])await assert.rejects(read(mod,alter(fixture())),/contact_snapshot/);
 await assert.rejects(mod.readNew({rpc:async()=>{throw Error('snapshot unavailable');},select:async()=>[]},[id]),/snapshot unavailable/);
 let calls=0;
 const data=await mod.readNew({rpc:async(name,args)=>{calls++;assert.equal(name,'person_catchup_contact_snapshot');assert.deepEqual(args.p_candidate_ids,[id]);return fixture();},select:async(table)=>{assert.notEqual(table,'person_recruiter_primary');assert.notEqual(table,'candidate_profile_state');assert.notEqual(table,'candidate_contact_summary');assert.notEqual(table,'candidate_contacts');return [];}},[id],{globalCounts:false});
 assert.equal(calls,1);assert.equal(data.decisions.size,1);
});
test('snapshot scalar contains >1001 rows without provider row-cap loss; source hash and hosted acknowledgement fail closed',async()=>{
 const {contactSnapshot}=await import('./contact-compat-snapshot.mjs');
 const {checkCompatibilityApproval,COMPATIBILITY_ID}=await import('./contact-compat-runtime.mjs');
 const snap=fixture();snap.contacts=Array.from({length:1500},(_,n)=>({...snap.contacts[0],value_normalized:`contact-${n}@example.invalid`}));
 assert.equal((await contactSnapshot({rpc:async()=>snap},[id])).contacts.length,1500);
 assert.throws(()=>checkCompatibilityApproval({},'hosted'),/compatibility_approval/);
 assert.doesNotThrow(()=>checkCompatibilityApproval({PERSON_CATCHUP_COMPATIBILITY_ID:COMPATIBILITY_ID},'hosted'));
 assert.doesNotThrow(()=>checkCompatibilityApproval({},'local'));
});
test('selected contact that later becomes ineligible keeps pinned fallback behavior',async()=>{
 const historical=await import(pathToFileURL(pinned+'scripts/person-trial.mjs'));
 const runtime=prepareCompatibilityRuntime({root:pinned});const derived=await import(pathToFileURL(runtime.root+'/scripts/person-trial.mjs'));
 const snap=fixture('email',false);snap.decisions[0].chosen_value=snap.contacts[0].value_normalized;
 snap.contacts[0].status='bounced';snap.contacts.push({...snap.contacts[0],value_normalized:'fallback@example.invalid',status:'active',rank:1});snap.contact_summary[0].primary_email='fallback@example.invalid';
 const stored=await read(derived,snap);
 for(const mod of [historical,derived]){const t=tally();mod.checkStored(t,id,input,[],stored,lib);assert.deepEqual(t.badChecks,[]);}
});

test('snapshot requires complete valid state, summary, counts, contact ranks/status and bounded totals',async()=>{
 const {contactSnapshot}=await import('./contact-compat-snapshot.mjs');
 for(const change of [s=>({...s,profile_state:[]}),s=>({...s,contact_summary:[]}),s=>({...s,profile_state:[{candidate_id:id,rev:'garbage'}]}),s=>({...s,profile_state:[{candidate_id:id,rev:0}]}),s=>({...s,contact_summary:[{candidate_id:id,primary_email:null}]}),s=>({...s,row_counts:[{candidate_id:id,contacts:0,decisions:1}]}),...[-1,0,32768].map(rank=>s=>({...s,contacts:[{...s.contacts[0],rank}]})),s=>({...s,contacts:[{...s.contacts[0],status:'mystery'}]})])await assert.rejects(contactSnapshot({rpc:async()=>change(fixture())},[id]),/contact_snapshot/);
 const huge=fixture();huge.contacts=Array.from({length:10001},(_,n)=>({...huge.contacts[0],value_normalized:`huge-${n}@example.test`}));await assert.rejects(contactSnapshot({rpc:async()=>huge},[id]),/contact_snapshot_capacity/);
 const large=fixture();large.contacts[0].value_raw='x'.repeat(8388608);await assert.rejects(contactSnapshot({rpc:async()=>large},[id]),/contact_snapshot_capacity/);
 const runtime=prepareCompatibilityRuntime({root:pinned});const {checkArtifactApproval}=await import('./contact-compat-runtime.mjs');
 assert.equal(runtime.manifest.files['scripts/contact-compat-snapshot.mjs'].input_sha256,null);assert.match(runtime.manifest.snapshot_sql_sha256,/^[a-f0-9]{64}$/);
 assert.throws(()=>checkArtifactApproval({},'hosted',runtime.manifest),/artifact_approval/);assert.throws(()=>checkArtifactApproval({PERSON_CATCHUP_ARTIFACT_SHA256:'wrong'},'local',runtime.manifest),/artifact_approval/);
 assert.doesNotThrow(()=>checkArtifactApproval({},'local',runtime.manifest));assert.doesNotThrow(()=>checkArtifactApproval({PERSON_CATCHUP_ARTIFACT_SHA256:runtime.manifest.artifact_identity},'hosted',runtime.manifest));
});
test('derived artifact preserves historical loop, engine and bundle bytes and refuses changed trial source',async()=>{
 const runtime=prepareCompatibilityRuntime({root:pinned});
 for(const f of ['scripts/person-reconcile.mjs','scripts/person-backfill.mjs','scripts/person-backfill/engine.mjs','scripts/dist/worker-lib.mjs'])assert.deepEqual(fs.readFileSync(runtime.root+'/'+f),fs.readFileSync(pinned+f));
 const {default:os}=await import('node:os');const {default:path}=await import('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'f5-source-'));
 try{
  for(const f of ['scripts/person-trial.mjs','scripts/person-reconcile.mjs','scripts/person-backfill.mjs','scripts/person-backfill/engine.mjs','scripts/dist/worker-lib.mjs']){fs.mkdirSync(path.dirname(path.join(dir,f)),{recursive:true});fs.writeFileSync(path.join(dir,f),f==='scripts/person-trial.mjs'?fs.readFileSync(pinned+f)+'\n// tampered\n':'fixture');}
  assert.throws(()=>prepareCompatibilityRuntime({root:dir}),/compatibility_source/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
