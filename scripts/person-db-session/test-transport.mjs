// Offline socket-failure probes for the actual CLI adapters. No database/provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import pg from 'pg';
import {openDatabase,withRunLock} from '../person-publish/lib.mjs';
import {openAnchorDatabase} from '../person-audit/database.mjs';
const originalPool=pg.Pool;
test.after(()=>{pg.Pool=originalPool;});
const env={LOCAL_DATABASE_URL:'postgresql://postgres@127.0.0.1:55487/offline_fixture'};
const fault=(code='ECONNRESET')=>Object.assign(Error('synthetic transport fault'),{code});
function fixture(handler=()=>{}){
 let pool;
 class Client extends EventEmitter{
  constructor(){super();this.sql=[];this.releases=[];this.idle=()=>{};}
  async query(sql,values){this.sql.push(sql);await handler(sql,this,values);return {rows:[{result:[],locked:true,released:true}]};}
  release(error){this.releases.push(error);pool.releases.push({client:this,error});this.removeListener('error',this.idle);if(error)pool.current=null;else this.on('error',this.idle);}
 }
 class Pool extends EventEmitter{
  constructor(){super();pool=this;this.current=null;this.clients=[];this.releases=[];this.ends=0;}
  async connect(){if(!this.current){this.current=new Client();this.clients.push(this.current);}this.current.removeListener('error',this.current.idle);return this.current;}
  // Model pg-pool's convenience query, including its checked-out error listener.
  async query(sql,values){const c=await this.connect(),onError=()=>{};c.on('error',onError);let broken;try{return await c.query(sql,values);}catch(e){broken=e;throw e;}finally{c.release(broken);c.removeListener('error',onError);}}
  async end(){this.ends++;}
 }
 pg.Pool=Pool;return {get:()=>pool};
}
test('publish initialization waits for SET and discards failed setup before business SQL',async()=>{
 const e=fault('42704'),f=fixture(sql=>{if(sql.startsWith('set '))throw e;});
 await assert.rejects(openDatabase(env),e);const p=f.get();assert.equal(p.ends,1);assert.deepEqual(p.clients[0].sql,["set statement_timeout='20s'"]);assert.equal(p.releases.length,1);assert.equal(p.releases[0].error,e);
});
test('publish checkout listens during initialization and each query',async()=>{
 const f=fixture((sql,c)=>assert.ok(c.listenerCount('error')>0,`missing listener: ${sql}`));const db=await openDatabase(env);await db.query('select synthetic');await db.end();assert.equal(f.get().ends,1);
});
for(const code of ['ECONNRESET','ETIMEDOUT','EPIPE','08006','57P01'])test(`publish disposes ${code} even when the error has a code`,async()=>{
 const e=fault(code),f=fixture(sql=>{if(sql==='select synthetic')throw e;});const db=await openDatabase(env);await assert.rejects(db.query('select synthetic'),e);assert.equal(f.get().releases.at(-1).error,e);assert.equal(f.get().releases.length,2);await db.end();
});
test('ordinary SQL error keeps a usable publish session',async()=>{
 const e=fault('23505'),f=fixture(sql=>{if(sql==='select synthetic')throw e;});const db=await openDatabase(env);await assert.rejects(db.query('select synthetic'),e);assert.equal(f.get().releases.at(-1).error,undefined);await db.query('select recovered');assert.equal(f.get().clients.length,1);await db.end();
});
test('a checked-out idle publish session handles its error and refuses further SQL',async()=>{
 const f=fixture();const db=await openDatabase(env),client=await db.connect(),raw=f.get().current,e=fault();const before=raw.sql.length;
 assert.doesNotThrow(()=>raw.emit('error',e));await assert.rejects(client.query('select forbidden'),e);assert.equal(raw.sql.length,before);client.release(false);assert.equal(raw.releases.at(-1),e);assert.equal(raw.releases.length,2);assert.equal(raw.listenerCount('error'),0);await db.end();
});
test('publish run-lock failure disposes its session exactly once',async()=>{
 const e=fault(),f=fixture((sql,c)=>{if(sql.includes('pg_advisory_unlock')){assert.ok(c.listenerCount('error')>0);c.emit('error',e);throw e;}});const db=await openDatabase(env);
 await assert.rejects(withRunLock(db,'synthetic-run',async()=>42),/publish_session_lock_lost/);assert.equal(f.get().releases.length,2);assert.ok(f.get().releases.at(-1).error);await db.end();
});
for(const stage of ['begin','set local','select public.','commit'])test(`anchor listener and disposal cover ${stage}`,async()=>{
 const e=fault(),f=fixture((sql,c)=>{if(sql.startsWith(stage)){assert.ok(c.listenerCount('error')>0,`missing listener: ${sql}`);c.emit('error',e);throw e;}}),db=await openAnchorDatabase(env);
 await assert.rejects(db.rpc('person_backfill_metrics',{}),e);const raw=f.get().clients[0];assert.equal(f.get().releases.length,2);assert.ok(f.get().releases.at(-1).error);assert.equal(raw.listenerCount('error'),0);if(stage==='set local')assert.ok(!raw.sql.some(x=>x.startsWith('select public.')));await db.end();
});
test('anchor failed rollback discards the session',async()=>{
 const f=fixture(sql=>{if(sql.startsWith('select public.'))throw fault('23505');if(sql==='rollback')throw fault('XX000');});const db=await openAnchorDatabase(env);await assert.rejects(db.rpc('person_backfill_metrics',{}),{code:'23505'});assert.equal(f.get().releases.length,2);assert.equal(f.get().releases.at(-1).error.code,'XX000');await db.end();
});
test('anchor SQL error rolls back before reuse and each later call rearms its own timeout',async()=>{
 let fail=true;const f=fixture(sql=>{if(sql.startsWith('select public.')&&fail){fail=false;throw fault('23505');}}),db=await openAnchorDatabase(env);
 await assert.rejects(db.rpc('person_backfill_metrics',{}),{code:'23505'});assert.equal(f.get().releases.at(-1).error,undefined);await db.rpc('person_backfill_metrics',{});
 assert.equal(f.get().clients.length,1);assert.deepEqual(f.get().current.sql.slice(1),['begin isolation level read committed',"set local statement_timeout='15s'",'select public.person_backfill_metrics() result','rollback','begin isolation level read committed',"set local statement_timeout='15s'",'select public.person_backfill_metrics() result','commit']);await db.end();
});
