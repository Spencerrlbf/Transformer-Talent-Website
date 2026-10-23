// Local PostgreSQL only. The directory connection must survive a server-side
// disconnect while idle (the failure that stopped the 2026-09-26 reconciliation
// at 412,500 of 423,050): no unhandled 'error' event, and the next statement
// reopens the connection with the read-only default restored.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {randomUUID} from 'node:crypto';
import { openComms, readOnly } from "../person-trial.mjs";

const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
  throw Error("Local database required");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function terminate(admin, pid) {
  const { rows } = await admin.query(
    "select pg_terminate_backend(pid) stopped from pg_stat_activity where pid=$1 and datname=current_database() and pid<>pg_backend_pid()",[pid],
  );
  assert.equal(rows[0]?.stopped,true,"terminated only this test's exact directory backend");
}

test("an idle server-side disconnect is absorbed and the next statement reconnects read-only", async () => {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const comms = await openComms(url);
  try {
    assert.equal((await comms.query("select 1 one")).rows[0].one, 1);
    assert.equal((await comms.query("show default_transaction_read_only")).rows[0].default_transaction_read_only, "on");
    let unhandled = null;
    const trap = (e) => { unhandled = e; };
    process.once("uncaughtException", trap);
    await terminate(admin,(await comms.query('select pg_backend_pid() pid')).rows[0].pid);
    await wait(300);
    process.off("uncaughtException", trap);
    assert.equal(unhandled, null, "the dropped connection raised no unhandled error");
    assert.equal((await comms.query("select 2 two")).rows[0].two, 2, "the next statement reopened the connection");
    assert.equal(comms.reconnects, 1);
    assert.equal((await comms.query("show default_transaction_read_only")).rows[0].default_transaction_read_only, "on");
    await assert.rejects(comms.query("create table comms_reconnect_probe(x int)"), /read-only/);
  } finally {
    await comms.end();
    await admin.end();
  }
});

test("a statement that dies mid-flight fails to its caller, and a read-only transaction afterwards works", async () => {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const comms = await openComms(url);
  try {
    const pid=(await comms.query('select pg_backend_pid() pid')).rows[0].pid;
    const killer = (async () => { await wait(200); await terminate(admin,pid); })();
    await assert.rejects(comms.query("select pg_sleep(3)"), /terminat|closed|ended/i);
    await killer;
    const rows = await readOnly(comms, async () => (await comms.query("select 3 three")).rows);
    assert.equal(rows[0].three, 3);
    assert.equal(comms.reconnects, 1);
  } finally {
    await comms.end();
    await admin.end();
  }
});

test('disconnect between statements fails the whole snapshot and a new scope starts fresh', async () => {
  const admin=new pg.Client({connectionString:url});await admin.connect();
  const table=`comms_snapshot_${randomUUID().replaceAll('-','')}`;
  await admin.query(`create table ${table}(n int);insert into ${table} values(1)`);
  const comms=await openComms(url);let calls=0;
  try {
    await assert.rejects(readOnly(comms,async()=>{
      calls++;
      const first=(await comms.query(`select n,pg_backend_pid() pid,current_setting('transaction_isolation') isolation from ${table}`)).rows[0];
      assert.equal(first.n,1);assert.equal(first.isolation,'repeatable read');
      await admin.query(`update ${table} set n=2`);
      await terminate(admin,first.pid);await wait(150);
      return (await comms.query(`select n from ${table}`)).rows;
    }),/comms_snapshot_lost|terminat|closed|ended/i);
    assert.equal(calls,1,'no implicit replay of a partially executed callback');
    assert.equal(comms.reconnects,0,'rollback must not reopen a broken snapshot');
    const fresh=await readOnly(comms,async()=> (await comms.query(`select n,current_setting('transaction_isolation') isolation from ${table}`)).rows[0]);
    assert.equal(fresh.n,2);assert.equal(fresh.isolation,'repeatable read');
    assert.equal(comms.reconnects,1);
  } finally {await comms.end();await admin.query(`drop table ${table}`);await admin.end();}
});

test('a callback cannot return a partial success after its connection is lost', async () => {
  const admin=new pg.Client({connectionString:url});await admin.connect();
  const comms=await openComms(url);
  try {
    await assert.rejects(readOnly(comms,async()=>{
      const pid=(await comms.query('select pg_backend_pid() pid')).rows[0].pid;
      await terminate(admin,pid);await wait(150);
      return {partial:true};
    }),/comms_snapshot_lost|terminat|closed|ended/i);
    assert.equal(comms.reconnects,0);
  } finally {await comms.end();await admin.end();}
});

test('concurrent idle reads share one reconnect and closed clients cannot reopen', async () => {
  const admin=new pg.Client({connectionString:url});await admin.connect();
  const comms=await openComms(url);
  try {
    await terminate(admin,(await comms.query('select pg_backend_pid() pid')).rows[0].pid);await wait(150);
    const rows=await Promise.all(Array.from({length:4},()=>comms.query('select pg_backend_pid() pid')));
    assert.equal(new Set(rows.map(r=>r.rows[0].pid)).size,1);assert.equal(comms.reconnects,1);
    await comms.end();
    await assert.rejects(comms.query('select 1'),/comms_connection_closed/);
  } finally {await comms.end();await admin.end();}
});

test('an unrelated concurrent call cannot enter another callback snapshot', async () => {
  const comms=await openComms(url);let entered,release;
  const started=new Promise(r=>entered=r),proceed=new Promise(r=>release=r);
  const reading=readOnly(comms,async()=>{entered();await proceed;return (await comms.query('select 7 n')).rows[0].n;});
  try {
    await started;
    await assert.rejects(comms.query('select 8'),/comms_read_scope_busy/);
    await assert.rejects(readOnly(comms,()=>comms.query('select 9')),/comms_read_scope_busy/);
  } finally {release();assert.equal(await reading,7);await comms.end();}
});

test('a swallowed statement error cannot certify a partial callback result', async () => {
  const comms=await openComms(url);
  try {
    await assert.rejects(readOnly(comms,async()=>{
      await assert.rejects(comms.query('select 1/0'),/division by zero/);
      return {partial:true};
    }),/comms_snapshot_lost/);
    assert.equal(await readOnly(comms,async()=> (await comms.query('select 1 n')).rows[0].n),1);
  } finally {await comms.end();}
});

test('an unfinished query cannot turn into partial success during rollback', async () => {
  const comms=await openComms(url);
  try {
    await assert.rejects(readOnly(comms,()=>{
      void comms.query('select 1/0').catch(()=>{});
      return {partial:true};
    }),/comms_snapshot_incomplete|comms_snapshot_lost/);
    assert.equal(await readOnly(comms,async()=> (await comms.query('select 2 n')).rows[0].n),2);
    await assert.rejects(comms.query('begin transaction read only'),/comms_read_scope_required/);
  } finally {await comms.end();}
});
