import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as engine from './engine.mjs';
import {restSite} from '../person-trial.mjs';
test('transient failures retry a bounded number of times with backoff',async()=>{
 let attempts=0;const delays=[];
 const value=await engine.retryTransient(async()=>{attempts++;if(attempts<3)throw Object.assign(Error('private'),{code:'40P01'});return 'ok';},{sleep:async n=>delays.push(n)});
 assert.equal(value,'ok');assert.equal(attempts,3);assert.deepEqual(delays,[250,500]);
 attempts=0;
 await assert.rejects(engine.retryTransient(async()=>{attempts++;throw Object.assign(Error('private'),{code:'55P03'});},{sleep:async()=>{}}));
 assert.equal(attempts,3);
});
test('integrity errors and unknown failures are never retried',async()=>{
 for(const code of ['23505','23503','22023',undefined]){let attempts=0;
  await assert.rejects(engine.retryTransient(async()=>{attempts++;throw Object.assign(Error('private'),{code});},{sleep:async()=>{}}));
  assert.equal(attempts,1);
 }
});
test('REST exposes SQLSTATE and gateway codes without putting response details in safe diagnostics',async()=>{
 const previous=globalThis.fetch;
 try{
  for(const [status,payload,expected] of [[409,{code:'23505',message:'private value'},'23505'],[503,{message:'private value'},'HTTP_503']]){
   globalThis.fetch=async()=>({ok:false,status,text:async()=>JSON.stringify(payload)});
   const error=await restSite('https://example.invalid','synthetic').rpc('person_backfill_save_many',{}).catch(e=>e);
   assert.equal(error.code,expected);assert.equal(engine.safeErrorCode(error),expected);
  }
  assert.equal(engine.safeErrorCode({code:'sensitive@example.com'}),'UNKNOWN');
 }finally{globalThis.fetch=previous;}
});
test('real timeout and response-body socket errors retain retryable transport codes',async()=>{
 const previous=globalThis.fetch;
 try{
  for(const kind of ['timeout','body']){
   let attempts=0;
   globalThis.fetch=async()=>{
    attempts++;
    if(attempts<3){
     if(kind==='timeout')throw new DOMException('synthetic timeout','TimeoutError');
     return {ok:true,text:async()=>{throw new TypeError('synthetic body interruption',{cause:Object.assign(Error('socket'),{code:'UND_ERR_SOCKET'})});}};
    }
    return {ok:true,text:async()=>'[]'};
   };
   const site=restSite('https://example.invalid','synthetic');
   assert.deepEqual(await engine.retryTransient(()=>site.rpc('person_backfill_save_many',{}),{sleep:async()=>{}}),[]);
   assert.equal(attempts,3);
  }
 }finally{globalThis.fetch=previous;}
});
