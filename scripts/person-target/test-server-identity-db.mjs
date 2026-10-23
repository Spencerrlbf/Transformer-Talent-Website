// Database-backed half of the server gate's runtime proof: the production bundle's
// withPersonConnection against three loopback databases in ONE cluster (same
// pg_control_system identifier): A labelled `local`, B labelled for a fictional other
// project, C never labelled. REST is sealed (`.invalid`); the selection is `local`.
// Run through scripts/person-target/run-identity-tests.sh <port>.
import test from 'node:test';
import assert from 'node:assert/strict';
const urls={A:process.env.IDENTITY_DATABASE_A,B:process.env.IDENTITY_DATABASE_B,C:process.env.IDENTITY_DATABASE_C};
for(const [k,u] of Object.entries(urls))if(!new RegExp(`^postgresql://postgres@127\\.0\\.0\\.1:\\d+/person_identity_${k.toLowerCase()}_test$`).test(u||''))throw Error('local fixtures required');
globalThis.fetch=async()=>{throw Error('sealed_fetch');};
const lib=await import('./dist/server.mjs');
const base={PERSON_TARGET_PROJECT_REF:'local',PERSON_WRITE_MODE:'live',SUPABASE_URL:'http://local-only.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic'};
const KEYS=[...Object.keys(base),'PERSON_DATABASE_URL'];
async function withEnv(values,fn){
 const saved=Object.fromEntries(KEYS.map(k=>[k,process.env[k]]));
 for(const k of KEYS){if(values[k]===undefined)delete process.env[k];else process.env[k]=values[k];}
 lib.resetServerTargetCache();
 try{return await fn();}finally{for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}lib.resetServerTargetCache();}
}
const rejectsTarget=(p,code)=>assert.rejects(p,e=>e.message===`person_target:${code}`,code);

// One process-wide pool: the server caches it for the first URL it sees, so the order
// below matters and each database is exercised through its own child process instead.
test('the server runs no operation on the other clone or on an unlabelled database, and proceeds on the labelled selection',async()=>{
 const {spawnSync}=await import('node:child_process');
 const run=(url,snippet)=>{
  const r=spawnSync(process.execPath,['--input-type=module','-e',`
   globalThis.fetch=async()=>{throw Error('sealed_fetch')};
   const lib=await import(${JSON.stringify(new URL('./dist/server.mjs',import.meta.url).href)});
   let ran=0;
   try{const v=await lib.withPersonConnection(async()=>{ran++;return 'reached';});console.log(JSON.stringify({ok:v,ran}));}
   catch(e){console.log(JSON.stringify({error:e.message,ran}));}
  `],{encoding:'utf8',env:{...process.env,...base,PERSON_DATABASE_URL:url},timeout:60000});
  assert.equal(r.status,0,r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
 };
 assert.deepEqual(run(urls.B),{error:'person_target:identity_label_mismatch',ran:0});
 assert.deepEqual(run(urls.C),{error:'person_target:identity_unlabelled',ran:0});
 assert.deepEqual(run(urls.A),{ok:'reached',ran:1});
});
test('in-process: the proof is made once per configuration and a refusal names no value',async()=>{
 await withEnv({...base,PERSON_DATABASE_URL:urls.B},async()=>{
  let ran=0;
  await rejectsTarget(lib.withPersonConnection(async()=>{ran++;}),'identity_label_mismatch');
  await rejectsTarget(lib.withPersonConnection(async()=>{ran++;}),'identity_label_mismatch');
  assert.equal(ran,0);
 });
});
