import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectIn} from '../person-trial.mjs';
test('chunked reads run concurrently with a bound and retain deterministic order',async()=>{
 let active=0,peak=0;
 const site={async select(_table,{filters}){active++;peak=Math.max(peak,active);const ids=filters[0][2];await new Promise(r=>setTimeout(r,5+(20-ids[0])%7));active--;return ids.map(id=>({id}));}};
 const ids=Array.from({length:20},(_,i)=>i);
 assert.deepEqual(await selectIn(site,'candidates','id',ids,{chunk:2}),ids.map(id=>({id})));
 assert.ok(peak>1,'source chunks should overlap');assert.ok(peak<=4,'bounded reader concurrency');assert.equal(active,0);
});
test('a failed chunk does not return a partial source set or leave reads running',async()=>{
 let active=0;
 const site={async select(_table,{filters}){active++;try{await new Promise(r=>setTimeout(r,5));if(filters[0][2][0]===2)throw Error('synthetic read failure');return filters[0][2];}finally{active--;}}};
 await assert.rejects(selectIn(site,'candidates','id',[0,1,2,3,4,5,6,7],{chunk:2}),/synthetic read failure/);assert.equal(active,0);
});
test('REST concurrency stays bounded across separate source tables until bodies are consumed',async()=>{
 const {restSite}=await import('../person-trial.mjs');const previous=globalThis.fetch;let active=0,peak=0;
 globalThis.fetch=async()=>{active++;peak=Math.max(peak,active);return {ok:true,text:async()=>{await new Promise(r=>setTimeout(r,5));active--;return '[]';}};};
 try {const site=restSite('https://example.invalid','synthetic-key');await Promise.all(Array.from({length:12},()=>site.select('candidates',{order:'id.asc'})));assert.ok(peak<=4,`REST connections: ${peak}`);assert.equal(active,0);}
 finally{globalThis.fetch=previous;}
});
