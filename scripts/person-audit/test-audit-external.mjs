import test from 'node:test';import assert from 'node:assert/strict';import net from 'node:net';
import {externalReader} from './external.mjs';import {openComms} from '../person-trial.mjs';
const scope=(ids=[])=>({contact_ids:ids,contact_count:ids.length,scope_hash:'a'.repeat(32),v2_hash:'b'.repeat(32),v2_rows:0});
const pool=inputs=>({connect:async()=>({release(){},query:async sql=>({rows:sql.includes('external_inputs')?[{r:inputs.shift()??scope()}]:[]})})});
const lib={directorySnapshotHash:x=>JSON.stringify(x)};
test('missing external access and partial coverage never certify a snapshot',async()=>{
 const absent=externalReader({pool:pool([]),lib});assert.equal((await absent.page([{boundary:{directory_epochs:[{contact_id:'a'}]}}])).complete,false);
 const partial=externalReader({pool:pool([]),comms:{},cols:{},lib,read:async()=>new Map()});assert.equal((await partial.fingerprint()).complete,true);
 const missing=externalReader({pool:pool([scope(['a'])]),comms:{},cols:{},lib,read:async()=>new Map()});assert.equal((await missing.fingerprint()).complete,false);
});
test('page uses all receipt/candidate links and reads full provenance in bounded chunks',async()=>{
 const calls=[],ids=Array.from({length:205},(_,i)=>String(i).padStart(3,'0'));
 const reader=externalReader({pool:pool([]),comms:{},cols:{},lib,read:async(_db,chunk,_cols,options)=>{calls.push(chunk);assert.equal(options.provenance,true);return new Map(chunk.map(id=>[id,{id}]))}});
 const r=await reader.page([{boundary:{directory_epochs:ids.map(contact_id=>({contact_id}))}}]);assert.equal(r.rows.size,205);assert.deepEqual(calls.map(x=>x.length),[100,100,5]);
});
test('provenance-only source changes alter the fingerprint; changing website scope refuses it',async()=>{
 const observation=async version=>externalReader({pool:pool([scope(['a']),scope(['a'])]),comms:{},cols:{},lib,read:async()=>new Map([['a',{board:{id:'a'},source_versions:[{version}]}]])}).fingerprint();
 assert.notEqual((await observation(1)).hash,(await observation(2)).hash);
 const moved=externalReader({pool:pool([scope(['a']),scope(['a','b'])]),comms:{},cols:{},lib,read:async()=>new Map([['a',{}]])});assert.equal((await moved.fingerprint()).reason,'external_scope_moved');
});
test('load and time gates stop before source access and propagate safely',async()=>{
 let reads=0;const args={pool:pool([]),comms:{},cols:{},lib,read:async()=>{reads++;return new Map()}};
 for(const overrides of [{expired:()=>true},{gate:async()=>{throw Error('audit_capacity')}}])await assert.rejects(externalReader({...args,...overrides}).page([{boundary:{directory_epochs:[{contact_id:'a'}]}}]),/audit_duration|audit_capacity/);
 assert.equal(reads,0);
});
test('audit transport bounds PostgreSQL startup even when a TCP endpoint stalls',async()=>{
 const sockets=new Set(),server=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let timer;const started=Date.now();try{await assert.rejects(Promise.race([openComms(`postgresql://postgres@127.0.0.1:${server.address().port}/synthetic`,{connectionTimeoutMillis:60,statementTimeoutMillis:100}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('unbounded_connection')),1200)})]),/timeout|terminated/);assert.ok(Date.now()-started<2000);}finally{clearTimeout(timer);for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}
});
test('URL timeout overrides cannot disable audit query watchdogs after startup',async()=>{
 const sockets=new Set(),server=net.createServer(s=>{sockets.add(s);let ready=false;s.on('close',()=>sockets.delete(s));s.on('data',()=>{if(!ready){ready=true;s.write(Buffer.from([82,0,0,0,8,0,0,0,0,90,0,0,0,5,73]));}});});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let timer;try{await assert.rejects(Promise.race([openComms(`postgresql://postgres@127.0.0.1:${server.address().port}/synthetic?query_timeout=&statement_timeout=0&options=-c%20statement_timeout%3D0`,{connectionTimeoutMillis:100,statementTimeoutMillis:60}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('unbounded_query')),2000)})]),/timeout/);}finally{clearTimeout(timer);for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}
});
