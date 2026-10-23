// R2-05, sealed (no sockets): the armed sweep's operator database handle must be the
// hardened operational adapter, not a raw pg.Pool. A raw pool has no 'error'
// listener, so an idle connection dropped by the server during reconciliation,
// anchoring or a drain wait becomes an uncaught exception that aborts cleanup.
// `pg` is the controller double (an EventEmitter pool and clients like the real
// ones); the database-backed loss cases run in test-armed.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {install}=require('./fake-controller-pg.cjs');
const sim=install({state:{}});
const {operatorPool}=await import('./armed.mjs');
const env={PERSON_TARGET_PROJECT_REF:'local',LOCAL_DATABASE_URL:'postgresql://postgres@127.0.0.1:1/person_sealed_test'};
const idleError=()=>Object.assign(Error('terminating connection due to administrator command'),{code:'57P01',severity:'FATAL'});

test('the operator handle is the hardened adapter: an idle-connection error is handled, waits are bounded, sessions set their timeout',async()=>{
 const uncaught=[];const onUncaught=(e)=>uncaught.push(e);process.on('uncaughtException',onUncaught);
 try{
  const db=await operatorPool(env);
  const pool=sim.lastPool;
  assert.ok(pool.listenerCount('error')>=1,'a raw pg.Pool has no error listener: the review\'s reproduction');
  assert.doesNotThrow(()=>pool.emit('error',idleError()));
  assert.equal(sim.lastConfig.connectionTimeoutMillis,10000);
  assert.equal(sim.lastConfig.statement_timeout,20000);assert.equal(sim.lastConfig.query_timeout,21000);
  assert.equal(sim.lastConfig.max,2);assert.equal(sim.lastConfig.application_name,'tt-tenancy-armed');
  const sql=[];sim.onQuery=(text)=>sql.push(text);
  const client=await db.connect();
  assert.match(sql.at(-1),/set statement_timeout='20s'/,'every checkout bounds its session before use');
  await client.query('select 1');client.release();
  assert.equal(pool.idle.length,1,'a healthy session returns to the pool');
  await db.end();
  await new Promise(r=>setImmediate(r));
  assert.deepEqual(uncaught,[]);
 }finally{process.off('uncaughtException',onUncaught);sim.onQuery=undefined;}
});
test('a checked-out session that loses its backend reports the failure and is disposed, not reused',async()=>{
 const db=await operatorPool(env);
 const pool=sim.lastPool;
 const client=await db.connect();
 const raw=sim.lastClient;
 assert.equal(raw.listenerCount('error'),1,'the checkout listens for the session\'s transport error');
 raw.emit('error',idleError());
 await assert.rejects(client.query('select 1'),/57P01|administrator command/);
 client.release();
 assert.equal(raw.destroyed,true,'released with the error: pg destroys it');
 assert.equal(pool.idle.length,0);
 assert.equal(raw.listenerCount('error'),0,'no listener leaks after release');
 // the adapter is still usable: the next checkout is a fresh session
 await db.query('select 1');
 await db.end();
 await assert.rejects(db.query('select 1'),/pool_ended/);
});
