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
import {main as finalize,parseArgs,finalizeSql,parseCliIdentity,safeReason} from '../person-reconcile-finalize.mjs';

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
// RR-07: the three workers that build their own REST helpers stop before any request
// when the configuration is mixed. They import the worker bundle, built by the runner.
const WORKERS=['scripts/review-queue.mjs','scripts/refresh-worker.mjs','scripts/sync-directory.mjs'];
const mixed={PERSON_TARGET_PROJECT_REF:TARGET,PERSON_WRITE_MODE:'live',PERSON_TRANSITION_SUPPORT:'on',SUPABASE_URL:`https://${OTHER}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:jwt(TARGET),
 PERSON_DATABASE_URL:`postgres://postgres.${TARGET}:secret-sentinel@aws-0-us-east-2.pooler.supabase.com:6543/postgres`,COMMS_DATABASE_URL:'postgresql://synthetic:secret-sentinel@127.0.0.1:55487/fixture',OPENAI_API_KEY:'synthetic',HARVEST_API_KEY:'synthetic',REFRESH_DAILY_CAP:'1',CONCURRENCY:'1',MAX:'1'};
for(const script of WORKERS)test(`${script}: REST on another project than the selection stops before any request`,()=>{
 if(!fs.existsSync(path.join(root,'scripts/dist/worker-lib.mjs')))assert.fail('worker bundle missing: run scripts/person-target/run-offline-tests.sh');
 const r=run(script,mixed);
 assert.equal(r.status,1,r.stderr.slice(0,400));assert.match(r.stderr,/person_target:rest_mismatch/);assert.equal(r.attempts,'');
 assert.doesNotMatch(r.stderr,/secret-sentinel/);
});
test('package.json sync-roles references only scripts that exist (RR-15)',()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 const refs=[...pkg.scripts['sync-roles'].matchAll(/node (scripts\/[^ &]+)/g)].map(m=>m[1]);
 assert.deepEqual(refs,['scripts/build-worker-lib.mjs','scripts/sync-org-roles.mjs','scripts/embed-roles.mjs']);
 for(const f of refs)assert.ok(fs.existsSync(path.join(root,f)),f);
});

// Finalizer: explicit destination, no original default.
const session=(ref)=>`postgres://postgres.${ref}:secret-sentinel@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
function fakeClient(identity='7000000000000000001',label=TARGET){
 const sql=[];let ended=0;
 const client={
  async query(text){sql.push(text);if(text.includes('person_target_identity'))return {rows:[{identity:{system_identifier:identity,project_ref:label}}]};
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
// R2-01: a destination whose query options would move pg to another host, role or
// port is refused before any client is opened, with or without REST credentials
// (without them the identity comparison cannot catch the wrong project).
test('finalizer refuses PostgreSQL URL overrides before opening anything',async()=>{
 let connects=0,fetches=0;
 const connect=async()=>{connects++;};
 const fetchFn=async()=>{fetches++;throw Error('sealed');};
 for(const url of [`${session(TARGET)}?user=postgres.${OTHER}`,`${session(TARGET)}?host=db.${OTHER}.supabase.co`,`${session(TARGET)}?%68ost=db.${OTHER}.supabase.co`,`${session(TARGET)}?port=6543`,`${session(TARGET)}?sslmode=require&sslmode=disable`,`${session(TARGET)}?options=x`]){
  await assert.rejects(finalize(['--run-id=run-1'],{env:{PERSON_TARGET_PROJECT_REF:TARGET,PERSON_PUBLISH_DATABASE_URL:url},connect,fetchFn}),/person_target:database_options/);
  await assert.rejects(finalize(['--run-id=run-1'],{env:{PERSON_TARGET_PROJECT_REF:TARGET,PERSON_PUBLISH_DATABASE_URL:url,SUPABASE_URL:`https://${TARGET}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:jwt(TARGET)},connect,fetchFn}),/person_target:database_options/);
 }
 assert.equal(connects,0);assert.equal(fetches,0);
});
// The CLI (--workdir) path: `exec` is the Supabase CLI. It answers the identity file
// with `label` and records which files it was given; the finish file must never be
// sent before the identity proved the linked database.
function fakeCli(label=TARGET,identity='7000000000000000001',{envelope=false}={}){
 const calls=[];
 const exec=(cli,args)=>{
  const file=args[args.indexOf('-f')+1];const sql=fs.readFileSync(file,'utf8');
  calls.push({args:args.filter(a=>!a.startsWith('/')),kind:sql.includes('person_target_identity')?'identity':sql.includes('person_reconcile_finish')?'finish':'other'});
  if(calls.at(-1).kind!=='identity')return 'finish output';
  const rows=JSON.stringify([{identity:{system_identifier:identity,project_ref:label,database:'postgres'}}]);
  return envelope?`Untrusted data below\n<untrusted>\n${rows}\n</untrusted>\n`:rows;
 };
 return {exec,calls,kinds:()=>calls.map(c=>c.kind)};
}
test('finalizer with a linked workdir requires that workdir to be linked to the selection, then proves the linked database\'s label before the finish file',async()=>{
 const cli=fakeCli();
 const deps={env:{PERSON_TARGET_PROJECT_REF:TARGET},readFile:()=>`${OTHER}\n`,exec:cli.exec};
 await assert.rejects(finalize(['--run-id=run-1','--workdir=/nonexistent'],deps),/person_target:workdir_mismatch/);
 await assert.rejects(finalize(['--run-id=run-1','--workdir=/nonexistent'],{...deps,readFile:()=>{throw Error('ENOENT');}}),/person_target:workdir_mismatch/);
 await assert.rejects(finalize(['--run-id=run-1','--workdir=/nonexistent'],{...deps,env:{PERSON_TARGET_PROJECT_REF:TARGET,PERSON_PUBLISH_DATABASE_URL:session(TARGET)},readFile:()=>TARGET}),/finalize_one_destination/);
 assert.deepEqual(cli.calls,[]);
 const ok=await finalize(['--run-id=run-1','--workdir=/nonexistent'],{...deps,readFile:()=>`${TARGET}\n`,out:()=>{}});
 assert.deepEqual(ok,{run:'run-1',target:TARGET,via:'cli',system_identifier:'7000000000000000001',project_ref:TARGET});
 assert.deepEqual(cli.kinds(),['identity','finish']);
 assert.deepEqual(cli.calls[0].args,['db','query','--linked','--workdir','--output','json','--agent','no','-f']);
 assert.deepEqual(cli.calls[1].args,['db','query','--linked','--workdir','-f']);
});
test('finalizer CLI path: an unlabelled or foreign-labelled linked database, or one whose identity cannot be read, never receives the finish file',async()=>{
 const base={env:{PERSON_TARGET_PROJECT_REF:TARGET},readFile:()=>`${TARGET}\n`,out:()=>{}};
 for(const [cli,code] of [[fakeCli(null),'identity_unlabelled'],[fakeCli(OTHER),'identity_label_mismatch'],[fakeCli('Prod'),'identity_unlabelled'],[{exec:()=>'',calls:[],kinds:()=>['identity']},'identity_database'],[{exec:()=>{throw Error('secret-sentinel');},calls:[],kinds:()=>['identity']},'identity_database']]){
  await assert.rejects(finalize(['--run-id=run-1','--workdir=/nonexistent'],{...base,exec:cli.exec}),new RegExp(`person_target:${code}$`),code);
  assert.ok(!cli.kinds().includes('finish'),`${code}: no finish`);
 }
 // the agent envelope around the JSON is tolerated; the correct label proceeds
 const cli=fakeCli(TARGET,'7000000000000000001',{envelope:true});
 assert.equal((await finalize(['--run-id=run-1','--workdir=/nonexistent'],{...base,exec:cli.exec})).via,'cli');assert.deepEqual(cli.kinds(),['identity','finish']);
});
test('finalizer CLI path with REST: the other clone (same cluster identifier, other label) is refused; REST and CLI must agree on the label',async()=>{
 const env={PERSON_TARGET_PROJECT_REF:TARGET,SUPABASE_URL:`https://${TARGET}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:jwt(TARGET)};
 const rest=(label)=>async()=>({ok:true,json:async()=>({system_identifier:'7000000000000000001',project_ref:label})});
 const base={env,readFile:()=>`${TARGET}\n`,out:()=>{}};
 let cli=fakeCli(OTHER);
 await assert.rejects(finalize(['--run-id=run-1','--workdir=/nonexistent'],{...base,exec:cli.exec,fetchFn:rest(TARGET)}),/person_target:identity_label_mismatch/);
 assert.deepEqual(cli.kinds(),['identity']);
 cli=fakeCli(TARGET);
 await assert.rejects(finalize(['--run-id=run-1','--workdir=/nonexistent'],{...base,exec:cli.exec,fetchFn:rest(OTHER)}),/person_target:identity_label_mismatch/);
 assert.deepEqual(cli.kinds(),['identity']);
 cli=fakeCli(TARGET);
 await assert.rejects(finalize(['--run-id=run-1','--workdir=/nonexistent'],{...base,exec:cli.exec,fetchFn:rest(null)}),/person_target:identity_unlabelled/);
 cli=fakeCli(TARGET);
 await assert.rejects(finalize(['--run-id=run-1','--workdir=/nonexistent'],{...base,env:{...env,SUPABASE_URL:`https://${OTHER}.supabase.co`},exec:cli.exec,fetchFn:rest(TARGET)}),/person_target:rest_mismatch/);
 assert.deepEqual(cli.kinds(),[],'offline refusal before any CLI call');
 cli=fakeCli(TARGET);
 assert.equal((await finalize(['--run-id=run-1','--workdir=/nonexistent'],{...base,exec:cli.exec,fetchFn:rest(TARGET)})).project_ref,TARGET);
 assert.deepEqual(cli.kinds(),['identity','finish']);
});
test('parseCliIdentity reads only a JSON row carrying identity',()=>{
 assert.deepEqual(parseCliIdentity('[{"identity":{"system_identifier":"1","project_ref":"abcdefghijklmnopqrst"}}]'),{system_identifier:'1',project_ref:'abcdefghijklmnopqrst'});
 assert.deepEqual(parseCliIdentity('warning\n[{"identity":"{\\"system_identifier\\":\\"1\\"}"}]\n'),{system_identifier:'1'});
 assert.equal(parseCliIdentity(''),null);assert.equal(parseCliIdentity('[]'),null);assert.equal(parseCliIdentity('[{"other":1}]'),null);assert.equal(parseCliIdentity('not json ['),null);assert.equal(parseCliIdentity(undefined),null);
});
test('finalizer proves REST and PostgreSQL identity agree before finishing',async()=>{
 const f=fakeClient();const out=[];
 const env={PERSON_TARGET_PROJECT_REF:TARGET,PERSON_PUBLISH_DATABASE_URL:session(TARGET),SUPABASE_URL:`https://${TARGET}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:jwt(TARGET)};
 const fetched=[];
 const fetchFn=async(url,init)=>{fetched.push(new URL(url).pathname);return {ok:true,json:async()=>({system_identifier:'7000000000000000001',project_ref:TARGET})};};
 const r=await finalize(['--run-id=run-1'],{env,connect:f.connect,fetchFn,out:x=>out.push(x)});
 assert.equal(r.via,'postgres');assert.deepEqual(r.result,{person_reconcile_finish:{status:'reconciled'}});
 assert.deepEqual(fetched,['/rest/v1/rpc/person_target_identity']);
 assert.ok(f.sql[0].includes('person_target_identity'));assert.ok(f.sql[1].startsWith('begin;'));assert.equal(f.ended(),1);
 assert.doesNotMatch(out.join(''),/secret-sentinel/);
});
test('finalizer stops when REST and PostgreSQL are different clusters',async()=>{
 const f=fakeClient('7000000000000000002');
 const env={PERSON_TARGET_PROJECT_REF:TARGET,PERSON_PUBLISH_DATABASE_URL:session(TARGET),SUPABASE_URL:`https://${TARGET}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:jwt(TARGET)};
 const fetchFn=async()=>({ok:true,json:async()=>({system_identifier:'7000000000000000001',project_ref:TARGET})});
 await assert.rejects(finalize(['--run-id=run-1'],{env,connect:f.connect,fetchFn}),/person_target:identity_mismatch/);
 assert.equal(f.sql.filter(x=>x.startsWith('begin;')).length,0);assert.equal(f.ended(),1);
});
test('finalizer refuses a changed multi-statement result instead of reporting success',async()=>{
 const f=fakeClient();
 f.client.query=async(text)=>{f.sql.push(text);if(text.includes('person_target_identity'))return {rows:[{identity:{system_identifier:'7000000000000000001',project_ref:TARGET}}]};return [{},{},{},{},{rows:[{something_else:1}]},{}];};
 await assert.rejects(finalize(['--run-id=run-1'],{env:{PERSON_TARGET_PROJECT_REF:TARGET,PERSON_PUBLISH_DATABASE_URL:session(TARGET)},connect:f.connect}),/finalize_result/);
 assert.equal(f.ended(),1);
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
test('finalizer refuses a destination whose label is missing or names another project, and a clone pair (same cluster, different labels), before finishing',async()=>{
 const env={PERSON_TARGET_PROJECT_REF:TARGET,PERSON_PUBLISH_DATABASE_URL:session(TARGET),SUPABASE_URL:`https://${TARGET}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:jwt(TARGET)};
 const rest=(payload)=>async()=>({ok:true,json:async()=>payload});
 for(const [label,restLabel,code] of [[OTHER,OTHER,'identity_label_mismatch'],[null,null,'identity_unlabelled'],[TARGET,OTHER,'identity_label_mismatch'],[OTHER,TARGET,'identity_label_mismatch']]){
  const f=fakeClient('7000000000000000001',label);
  await assert.rejects(finalize(['--run-id=run-1'],{env,connect:f.connect,fetchFn:rest({system_identifier:'7000000000000000001',project_ref:restLabel}),out:()=>{}}),new RegExp(`person_target:${code}`));
  assert.ok(!f.sql.some(t=>t.startsWith('begin;')),'the finish statement never ran');assert.equal(f.ended(),1);
 }
});
