import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {runNormalizedRefresh} from '../person-refresh/worker.mjs';
import * as lib from '../dist/worker-lib.mjs';
const org='801865a7-6533-41d2-9c45-e4a90e6ad51a';
const queue='a1000000-0000-4000-8000-000000000001';
const token='a1000000-0000-4000-8000-000000000002';
const noEffects=new Proxy({}, {get:()=>()=>{throw Error('unexpected_effect')}});
for(const [support,error] of [['on',/person_refresh_execution_unavailable/],['yes',/transition_configuration/]]) {
 for(const mode of [undefined,'legacy','shadow','live'])
  test(`actual refresh CLI rejects ${support}/${mode??'default'} before any network`,()=>{
   const out=spawnSync(process.execPath,['--import','./scripts/person-directory-input/no-network.mjs','scripts/refresh-worker.mjs'],{
    encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,PERSON_TRANSITION_SUPPORT:support,
    ...(mode?{PERSON_WRITE_MODE:mode}:{}),SUPABASE_URL:'http://127.0.0.1:9',SUPABASE_SERVICE_ROLE_KEY:'synthetic',
    HARVEST_API_KEY:'synthetic',OPENAI_API_KEY:'synthetic',PRECOMPUTE_BACKFILL:'5'}
   });
   assert.equal(out.status,1);assert.match(out.stderr,error);assert.doesNotMatch(out.stderr,/unexpected_network_effect/);
  });
 test(`direct normalized worker rejects ${support} before queue/topup/provider/derivative effects`,async()=>{
  process.env.PERSON_TRANSITION_SUPPORT=support;
  try {
   await assert.rejects(runNormalizedRefresh({lib:{...noEffects,TT_ORG_ID:org,pickRefreshRows:noEffects.pick},
    rest:noEffects.rest,organizationId:org,mode:'live',dailyCap:50,allowPaid:true,noTopup:false,
    harvestProfile:noEffects.harvest,log:noEffects.log,warn:noEffects.warn}),error);
  }finally{delete process.env.PERSON_TRANSITION_SUPPORT;}
 });
 test(`old direct refresh interfaces reject ${support} before a database query`,async()=>{
  process.env.PERSON_TRANSITION_SUPPORT=support;const calls=[];const c={query:async()=>{calls.push('query');throw Error('unexpected_database_effect')}};
  const key={organizationId:org,queueId:queue,token};
  try {
   for(const [fn,args] of [
    ['pickRefreshRowsOnConnection',{organizationId:org,status:'queued',limit:10}],
    ['claimRefreshOnConnection',{...key,dailyCap:50,allowPaid:true}],
    ['storeRefreshPayloadOnConnection',{...key,raw:{headline:'Synthetic'}}],
    ['saveRefreshOnConnection',{...key,mode:'live'}],['failRefreshOnConnection',key]]){
    await assert.rejects(lib[fn](c,args),error,fn);
   }
   assert.deepEqual(calls,[]);
  }finally{delete process.env.PERSON_TRANSITION_SUPPORT;}
 });
 test(`public refresh wrappers reject ${support} before opening a pool`,async()=>{
  process.env.PERSON_TRANSITION_SUPPORT=support;delete process.env.PERSON_DATABASE_URL;
  const key={organizationId:org,queueId:queue,token};
  try {
   for(const [fn,args] of [['pickRefreshRows',{organizationId:org,status:'queued',limit:10}],
    ['claimRefresh',{...key,dailyCap:50,allowPaid:true}],['storeRefreshPayload',{...key,raw:{headline:'Synthetic'}}],
    ['saveRefresh',{...key,mode:'shadow'}],['failRefresh',key]])await assert.rejects(async()=>lib[fn](args),error,fn);
  }finally{delete process.env.PERSON_TRANSITION_SUPPORT;}
 });
}
