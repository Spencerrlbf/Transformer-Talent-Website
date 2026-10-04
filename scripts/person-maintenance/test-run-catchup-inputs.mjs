// Sealed (no database, no sockets): the catch-up runner refuses every late input the
// pinned parser would otherwise prefer over the validated BACKFILL_CONFIG, refuses a
// pinned tree carrying an env file, and refuses an unsupported Node runtime before
// any preparation. Real entry points are spawned where the check is about ordering.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {checkInputs,checkPinnedTree,checkConfig,main} from './run-catchup.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const CONFIG=JSON.stringify({'run-id':'run-1',reconcile:true,scope:'queue','dry-run':false,resume:true,limit:100,'batch-size':10});
const env={PERSON_TARGET_PROJECT_REF:'local',SUPABASE_URL:'http://127.0.0.1:1',SUPABASE_SERVICE_ROLE_KEY:'synthetic',COMMS_DATABASE_URL:'postgresql://postgres@127.0.0.1:2/comms',PINNED_RUNNER_DIR:'/nonexistent',BACKFILL_CONFIG:CONFIG};

test('late inputs: CLI arguments and BACKFILL_* aliases are refused',()=>{
 assert.doesNotThrow(()=>checkInputs(env,[]));
 assert.throws(()=>checkInputs(env,['--dry-run=true']),/catchup_run:arguments/);
 assert.throws(()=>checkInputs(env,['--commit=0000000000000000000000000000000000000000']),/catchup_run:arguments/);
 for(const k of ['BACKFILL_RUN_ID','BACKFILL_RESUME','BACKFILL_DRY_RUN','BACKFILL_LIMIT','BACKFILL_MAX_SECONDS'])assert.throws(()=>checkInputs({...env,[k]:'x'},[]),/catchup_run:aliases/,k);
 assert.deepEqual(checkConfig(env),{run:'run-1',target:'local'});
});
test('a pinned tree carrying an env file is refused (it would fill variables after validation)',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tt-pinned-'));
 try{
  assert.doesNotThrow(()=>checkPinnedTree(dir));
  fs.writeFileSync(path.join(dir,'.env.scripts'),'LOCAL_DATABASE_URL=postgresql://postgres@127.0.0.1:3/elsewhere\n');
  assert.throws(()=>checkPinnedTree(dir),/catchup_run:pinned_env_file/);
  fs.rmSync(path.join(dir,'.env.scripts'));fs.writeFileSync(path.join(dir,'.env'),'');
  assert.throws(()=>checkPinnedTree(dir),/catchup_run:pinned_env_file/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('main refuses inputs before verifying or preparing anything',async()=>{
 let verified=0;
 await assert.rejects(main({env,argv:['--resume=false'],verify:()=>{verified++;return {root,bundleHash:'x'};},out:()=>{}}),/catchup_run:arguments/);
 await assert.rejects(main({env:{...env,BACKFILL_RESUME:'false'},argv:[],verify:()=>{verified++;return {root,bundleHash:'x'};},out:()=>{}}),/catchup_run:aliases/);
 await assert.rejects(main({env:{...env,BACKFILL_CONFIG:JSON.stringify({...JSON.parse(CONFIG),resume:false})},argv:[],verify:()=>{verified++;return {root,bundleHash:'x'};},out:()=>{}}),/catchup_run:config/);
 assert.equal(verified,0,'no pinned verification/bundle build on a refused input');
 // a verified tree with an env file: refused before the transport listener and any import
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tt-pinned-'));
 try{fs.writeFileSync(path.join(dir,'.env.scripts'),'LOCAL_DATABASE_URL=x\n');
  await assert.rejects(main({env,argv:[],verify:()=>({root:dir,bundleHash:'x'}),out:()=>{}}),/catchup_run:pinned_env_file/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
const NODE20=`${os.homedir()}/.nvm/versions/node/v20.19.2/bin/node`;
const spawn=(node,script,extra={})=>spawnSync(node,[script],{cwd:root,encoding:'utf8',timeout:60000,env:{PATH:process.env.PATH,HOME:process.env.HOME,...env,...extra}});
test('actual entry points under an unsupported runtime stop before any side effect',{skip:!fs.existsSync(NODE20)&&'Node 20 interpreter not installed on this machine'},()=>{
 for(const script of ['scripts/person-maintenance/run-catchup.mjs','scripts/person-maintenance/start-catchup.mjs','scripts/person-reconcile-finalize.mjs','scripts/person-transition.mjs','scripts/person-publish.mjs','scripts/person-audit-anchors.mjs','scripts/test-tenancy.mjs']){
  const r=spawn(NODE20,script,{BACKFILL_CONFIG:CONFIG,PERSON_PUBLISH_DATABASE_URL:'postgresql://postgres@127.0.0.1:2/x',SUPABASE_ANON_KEY:'synthetic'});
  assert.notEqual(r.status,0,script);
  assert.match(r.stderr+r.stdout,/node_runtime:unsupported:v20\.19\.2/,`${script}\n${r.stderr}${r.stdout}`);
  assert.doesNotMatch(r.stdout,/catchup_runner|catchup_started|reconcile_finalized|transition_|publish_start|run /,script);
 }
 const h=spawnSync('bash',['scripts/person-target/run-offline-tests.sh'],{cwd:root,encoding:'utf8',timeout:60000,env:{PATH:`${path.dirname(NODE20)}:${process.env.PATH}`,HOME:process.env.HOME}});
 assert.notEqual(h.status,0);assert.match(h.stderr,/node_runtime:unsupported/);
});
test('under the supported runtime the same entry point proceeds to its own input check',()=>{
 const r=spawn(process.execPath,'scripts/person-maintenance/run-catchup.mjs',{BACKFILL_RESUME:'false'});
 assert.equal(r.status,1);assert.match(r.stderr,/catchup_run:aliases/);
 assert.doesNotMatch(r.stderr,/node_runtime/);
});
