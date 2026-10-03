// Sealed process tests: the operator utilities refuse a missing or mismatched
// destination before any socket is opened. Each child runs with a `fetch` and
// `pg` that record attempts and fail; the assertions are "zero attempts".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {main as finalize,parseArgs,finalizeSql,safeReason} from '../person-reconcile-finalize.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const TARGET='abcdefghijklmnopqrst',OTHER='tsrqponmlkjihgfedcba';
const jwt=(ref)=>['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',Buffer.from(JSON.stringify({iss:'supabase',ref,role:'service_role'})).toString('base64url'),'sig'].join('.');
// Preload: any network attempt is recorded to a file and rejected.
const preload=path.join(os.tmpdir(),`tt-seal-${process.pid}.cjs`);
fs.writeFileSync(preload,`const fs=require('fs');const log=process.env.SEAL_LOG;
globalThis.fetch=async(u)=>{fs.appendFileSync(log,'fetch '+new URL(String(u)).hostname+'\\n');throw Error('sealed');};
const net=require('net');net.Socket.prototype.connect=function(){fs.appendFileSync(log,'socket\\n');throw Error('sealed');};`);
function run(script,env){
 const log=path.join(os.tmpdir(),`tt-seal-log-${process.pid}-${Math.random().toString(16).slice(2)}`);
 fs.writeFileSync(log,'');
 const r=spawnSync(process.execPath,['--require',preload,script],{cwd:root,encoding:'utf8',timeout:20000,env:{PATH:process.env.PATH,SEAL_LOG:log,...env}});
 const attempts=fs.readFileSync(log,'utf8').trim();fs.rmSync(log,{force:true});
 return {...r,attempts};
}
test.after(()=>fs.rmSync(preload,{force:true}));

const ROLE_UTILITIES=['scripts/sync-org-roles.mjs','scripts/embed-roles.mjs'];
for(const script of ROLE_UTILITIES){
 test(`${script}: missing SUPABASE_URL stops before any request`,()=>{
  const r=run(script,{SUPABASE_SERVICE_ROLE_KEY:jwt(TARGET),OPENAI_API_KEY:'synthetic'});
  assert.equal(r.status,1);assert.match(r.stderr,/SUPABASE_URL/);assert.equal(r.attempts,'');
 });
 test(`${script}: empty SUPABASE_URL stops before any request`,()=>{
  const r=run(script,{SUPABASE_URL:'',SUPABASE_SERVICE_ROLE_KEY:jwt(TARGET),OPENAI_API_KEY:'synthetic'});
  assert.equal(r.status,1);assert.equal(r.attempts,'');
 });
 test(`${script}: URL for another project than the selection stops before any request`,()=>{
  const r=run(script,{PERSON_TARGET_PROJECT_REF:TARGET,SUPABASE_URL:`https://${OTHER}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:jwt(OTHER),OPENAI_API_KEY:'synthetic'});
  assert.equal(r.status,1);assert.match(r.stderr,/person_target:rest_mismatch/);assert.equal(r.attempts,'');
 });
 test(`${script}: key for another project than the URL stops before any request`,()=>{
  const r=run(script,{PERSON_TARGET_PROJECT_REF:TARGET,SUPABASE_URL:`https://${TARGET}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:jwt(OTHER),OPENAI_API_KEY:'synthetic'});
  assert.equal(r.status,1);assert.match(r.stderr,/person_target:key_mismatch/);assert.equal(r.attempts,'');
 });
}
test('package.json sync-roles references only scripts that exist (RR-15)',()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 const refs=[...pkg.scripts['sync-roles'].matchAll(/node (scripts\/[^ &]+)/g)].map(m=>m[1]);
 assert.deepEqual(refs,['scripts/build-worker-lib.mjs','scripts/sync-org-roles.mjs','scripts/embed-roles.mjs']);
 for(const f of refs)assert.ok(fs.existsSync(path.join(root,f)),f);
});

// Finalizer: explicit destination, no original default.
const session=(ref)=>`postgres://postgres.${ref}:secret-sentinel@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
function fakeClient(identity='7000000000000000001'){
 const sql=[];let ended=0;
 const client={
  async query(text){sql.push(text);if(text.includes('person_target_identity'))return {rows:[{identity:{system_identifier:identity}}]};
   return [{},{},{},{},{rows:[{person_reconcile_finish:{status:'reconciled'}}]},{}];},
  async end(){ended++;},
 };
 return {client,sql,ended:()=>ended,connect:async()=>client};
}
test('parseArgs accepts only --run-id and --workdir',()=>{
 assert.deepEqual(parseArgs(['--run-id=run-1']),{run:'run-1',workdir:undefined});
 assert.throws(()=>parseArgs(['--run-id=bad run']),/finalize_run_id/);
 assert.throws(()=>parseArgs(['--run-id=r','--commit=x']),/finalize_option/);
 assert.throws(()=>parseArgs([]),/finalize_run_id/);
 assert.throws(()=>finalizeSql("x';drop"),/finalize_run_id/);
});
test('finalizer refuses a missing selection before opening anything',async()=>{
 let connects=0;
 await assert.rejects(finalize(['--run-id=run-1'],{env:{PERSON_PUBLISH_DATABASE_URL:session(TARGET)},connect:async()=>{connects++;}}),/person_target:missing/);
 assert.equal(connects,0);
});
test('finalizer refuses a destination for another project before opening anything',async()=>{
 let connects=0;
 await assert.rejects(finalize(['--run-id=run-1'],{env:{PERSON_TARGET_PROJECT_REF:TARGET,PERSON_PUBLISH_DATABASE_URL:session(OTHER)},connect:async()=>{connects++;}}),/person_target:database_mismatch/);
 await assert.rejects(finalize(['--run-id=run-1'],{env:{PERSON_TARGET_PROJECT_REF:TARGET,PERSON_PUBLISH_DATABASE_URL:session(TARGET).replace(':5432',':6543')},connect:async()=>{connects++;}}),/person_target:database_port/);
 await assert.rejects(finalize(['--run-id=run-1'],{env:{PERSON_TARGET_PROJECT_REF:TARGET},connect:async()=>{connects++;}}),/finalize_destination_required/);
 assert.equal(connects,0);
});
test('finalizer with a linked workdir requires that workdir to be linked to the selection',async()=>{
 let execs=0;
 const deps={env:{PERSON_TARGET_PROJECT_REF:TARGET},readFile:()=>`${OTHER}\n`,exec:()=>{execs++;return '';}};
 await assert.rejects(finalize(['--run-id=run-1','--workdir=/nonexistent'],deps),/person_target:workdir_mismatch/);
 await assert.rejects(finalize(['--run-id=run-1','--workdir=/nonexistent'],{...deps,readFile:()=>{throw Error('ENOENT');}}),/person_target:workdir_mismatch/);
 await assert.rejects(finalize(['--run-id=run-1','--workdir=/nonexistent'],{...deps,env:{PERSON_TARGET_PROJECT_REF:TARGET,PERSON_PUBLISH_DATABASE_URL:session(TARGET)},readFile:()=>TARGET}),/finalize_one_destination/);
 assert.equal(execs,0);
 const ok=await finalize(['--run-id=run-1','--workdir=/nonexistent'],{...deps,readFile:()=>`${TARGET}\n`,out:()=>{}});
 assert.deepEqual(ok,{run:'run-1',target:TARGET,via:'cli'});assert.equal(execs,1);
});
test('finalizer proves REST and PostgreSQL identity agree before finishing',async()=>{
 const f=fakeClient();const out=[];
 const env={PERSON_TARGET_PROJECT_REF:TARGET,PERSON_PUBLISH_DATABASE_URL:session(TARGET),SUPABASE_URL:`https://${TARGET}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:jwt(TARGET)};
 const fetched=[];
 const fetchFn=async(url,init)=>{fetched.push(new URL(url).pathname);return {ok:true,json:async()=>({system_identifier:'7000000000000000001'})};};
 const r=await finalize(['--run-id=run-1'],{env,connect:f.connect,fetchFn,out:x=>out.push(x)});
 assert.equal(r.via,'postgres');assert.deepEqual(r.result,{person_reconcile_finish:{status:'reconciled'}});
 assert.deepEqual(fetched,['/rest/v1/rpc/person_target_identity']);
 assert.ok(f.sql[0].includes('person_target_identity'));assert.ok(f.sql[1].startsWith('begin;'));assert.equal(f.ended(),1);
 assert.doesNotMatch(out.join(''),/secret-sentinel/);
});
test('finalizer stops when REST and PostgreSQL are different clusters',async()=>{
 const f=fakeClient('7000000000000000002');
 const env={PERSON_TARGET_PROJECT_REF:TARGET,PERSON_PUBLISH_DATABASE_URL:session(TARGET),SUPABASE_URL:`https://${TARGET}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:jwt(TARGET)};
 const fetchFn=async()=>({ok:true,json:async()=>({system_identifier:'7000000000000000001'})});
 await assert.rejects(finalize(['--run-id=run-1'],{env,connect:f.connect,fetchFn}),/person_target:identity_mismatch/);
 assert.equal(f.sql.filter(x=>x.startsWith('begin;')).length,0);assert.equal(f.ended(),1);
});
test('finalizer stops when the destination lacks the identity function',async()=>{
 const f=fakeClient();f.client.query=async(text)=>{f.sql.push(text);throw Object.assign(Error('secret-sentinel'),{code:'42883'});};
 await assert.rejects(finalize(['--run-id=run-1'],{env:{PERSON_TARGET_PROJECT_REF:TARGET,PERSON_PUBLISH_DATABASE_URL:session(TARGET)},connect:f.connect}),/person_target:identity_database/);
 assert.equal(f.sql.filter(x=>x.startsWith('begin;')).length,0);
});
test('finalizer reasons never expose driver text',()=>{
 assert.equal(safeReason(Error('secret-sentinel')),'operation_failed:unknown');
 assert.equal(safeReason(Object.assign(Error('x'),{code:'57014'})),'operation_failed:57014');
 assert.equal(safeReason(Error('person_target:missing')),'person_target:missing');
});
