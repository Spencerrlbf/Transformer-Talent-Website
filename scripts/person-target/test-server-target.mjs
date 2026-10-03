// The server's two clients (REST via sbRest, PostgreSQL via withPersonConnection)
// refuse a mixed or unselected environment before any socket. `pg` is replaced by
// a recording module; `fetch` records and rejects. Everything is fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const TARGET='abcdefghijklmnopqrst',OTHER='tsrqponmlkjihgfedcba';
const jwt=(ref)=>['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',Buffer.from(JSON.stringify({iss:'supabase',ref,role:'service_role'})).toString('base64url'),'sig'].join('.');
const pooler=(ref,port=6543)=>`postgres://postgres.${ref}:secret-sentinel@aws-0-us-east-2.pooler.supabase.com:${port}/postgres`;

// Replace `pg` (left external by the bundle) with a recorder before importing.
const require=createRequire(fileURLToPath(import.meta.url));
const pgPath=require.resolve('pg');
const pools=[];
require.cache[pgPath]={id:pgPath,filename:pgPath,loaded:true,exports:{default:{Pool:class{constructor(config){this.config=config;pools.push(this);}on(){}async connect(){throw Error('sealed_pg_connect');}}}}};
const fetched=[];
globalThis.fetch=async(url)=>{fetched.push(new URL(String(url)).hostname);throw Error('sealed_fetch');};
const lib=await import('./dist/server.mjs');

function withEnv(values,fn){
 const saved={};
 for(const k of ['PERSON_TARGET_PROJECT_REF','PERSON_WRITE_MODE','PERSON_TRANSITION_SUPPORT','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','PERSON_DATABASE_URL']){saved[k]=process.env[k];if(values[k]===undefined)delete process.env[k];else process.env[k]=values[k];}
 lib.resetServerTargetCache();
 const restore=()=>{for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}lib.resetServerTargetCache();};
 let result;
 try{result=fn();}catch(error){restore();throw error;}
 if(result&&typeof result.then==='function')return result.finally(restore);
 restore();return result;
}
const rejectsTarget=async(promise,code)=>assert.rejects(promise,e=>e.message===`person_target:${code}`,code);

test('legacy mode with no selection keeps today\'s behavior: no target check',()=>{
 withEnv({PERSON_WRITE_MODE:'legacy',SUPABASE_URL:`https://${OTHER}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:jwt(TARGET),PERSON_DATABASE_URL:pooler(TARGET)},()=>{
  assert.equal(lib.personTargetRequired(),false);assert.equal(lib.assertServerTarget(),null);
 });
 withEnv({},()=>assert.equal(lib.personTargetRequired(),false));
});
test('shadow/live mode or transition support requires an explicit selection',()=>{
 withEnv({PERSON_WRITE_MODE:'shadow'},()=>{assert.equal(lib.personTargetRequired(),true);assert.throws(()=>lib.assertServerTarget(),/person_target:missing/);});
 withEnv({PERSON_WRITE_MODE:'live'},()=>assert.throws(()=>lib.assertServerTarget(),/person_target:missing/));
 withEnv({PERSON_TRANSITION_SUPPORT:'on'},()=>assert.throws(()=>lib.assertServerTarget(),/person_target:missing/));
 withEnv({PERSON_TARGET_PROJECT_REF:TARGET},()=>assert.equal(lib.personTargetRequired(),true));
});
test('a consistent selection passes and is cached per configuration',()=>{
 withEnv({PERSON_TARGET_PROJECT_REF:TARGET,PERSON_WRITE_MODE:'live',SUPABASE_URL:`https://${TARGET}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:jwt(TARGET),PERSON_DATABASE_URL:pooler(TARGET)},()=>{
  assert.equal(lib.assertServerTarget(),TARGET);assert.equal(lib.assertServerTarget(),TARGET);
  process.env.PERSON_DATABASE_URL=pooler(OTHER);
  assert.throws(()=>lib.assertServerTarget(),/person_target:database_mismatch/);
 });
});
test('REST on the copy while PostgreSQL names the original: refused before any socket',async()=>{
 await withEnv({PERSON_TARGET_PROJECT_REF:TARGET,PERSON_WRITE_MODE:'live',SUPABASE_URL:`https://${TARGET}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:jwt(TARGET),PERSON_DATABASE_URL:pooler(OTHER)},async()=>{
  const before=pools.length,beforeFetch=fetched.length;
  await rejectsTarget(lib.withPersonConnection(async()=>'reached'),'database_mismatch');
  await rejectsTarget(lib.sbRest('organizations?select=id'),'database_mismatch');
  assert.equal(pools.length,before);assert.equal(fetched.length,beforeFetch);
 });
});
test('PostgreSQL on the copy while REST names the original: refused before any socket',async()=>{
 await withEnv({PERSON_TARGET_PROJECT_REF:TARGET,PERSON_WRITE_MODE:'live',SUPABASE_URL:`https://${OTHER}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:jwt(TARGET),PERSON_DATABASE_URL:pooler(TARGET)},async()=>{
  const before=pools.length,beforeFetch=fetched.length;
  await rejectsTarget(lib.sbRest('organizations?select=id'),'rest_mismatch');
  await rejectsTarget(lib.withPersonConnection(async()=>'reached'),'rest_mismatch');
  assert.equal(pools.length,before);assert.equal(fetched.length,beforeFetch);
 });
});
test('a service key issued for another project is refused even when both URLs match',async()=>{
 await withEnv({PERSON_TARGET_PROJECT_REF:TARGET,PERSON_WRITE_MODE:'shadow',SUPABASE_URL:`https://${TARGET}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:jwt(OTHER),PERSON_DATABASE_URL:pooler(TARGET)},async()=>{
  const beforeFetch=fetched.length;
  await rejectsTarget(lib.sbRest('organizations?select=id'),'key_mismatch');
  assert.equal(fetched.length,beforeFetch);
 });
});
test('missing selection with support on: no REST request and no pool',async()=>{
 await withEnv({PERSON_TRANSITION_SUPPORT:'on',SUPABASE_URL:`https://${TARGET}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:jwt(TARGET),PERSON_DATABASE_URL:pooler(TARGET)},async()=>{
  const before=pools.length,beforeFetch=fetched.length;
  await rejectsTarget(lib.sbRest('organizations?select=id'),'missing');
  await rejectsTarget(lib.withPersonConnection(async()=>'reached'),'missing');
  assert.equal(pools.length,before);assert.equal(fetched.length,beforeFetch);
 });
});
test('a consistent live configuration proceeds to the (sealed) clients',async()=>{
 await withEnv({PERSON_TARGET_PROJECT_REF:TARGET,PERSON_WRITE_MODE:'live',SUPABASE_URL:`https://${TARGET}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:jwt(TARGET),PERSON_DATABASE_URL:pooler(TARGET)},async()=>{
  await assert.rejects(lib.sbRest('organizations?select=id'),/sealed_fetch/);
  assert.equal(fetched.at(-1),`${TARGET}.supabase.co`);
 });
});
test('a local selection accepts loopback clients only',async()=>{
 await withEnv({PERSON_TARGET_PROJECT_REF:'local',PERSON_WRITE_MODE:'live',SUPABASE_URL:'http://127.0.0.1:54321',SUPABASE_SERVICE_ROLE_KEY:'local-key',PERSON_DATABASE_URL:'postgresql://postgres@127.0.0.1:55487/fixture'},async()=>{
  assert.equal(lib.assertServerTarget(),'local');
  process.env.PERSON_DATABASE_URL=pooler(TARGET);lib.resetServerTargetCache();
  await rejectsTarget(lib.withPersonConnection(async()=>'reached'),'database_mismatch');
 });
});
