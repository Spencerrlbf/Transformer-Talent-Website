// Local PostgreSQL only. The directory connection must survive a server-side
// disconnect while idle (the failure that stopped the 2026-09-26 reconciliation
// at 412,500 of 423,050): no unhandled 'error' event, and the next statement
// reopens the connection with the read-only default restored.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { openComms, readOnly } from "../person-trial.mjs";

const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
  throw Error("Local database required");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function terminate(admin) {
  const { rowCount } = await admin.query(
    "select pg_terminate_backend(pid) from pg_stat_activity where application_name='tt-website-person-trial' and pid<>pg_backend_pid()",
  );
  assert.ok(rowCount >= 1, "found the directory connection to terminate");
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
    await terminate(admin);
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
    const killer = (async () => { await wait(200); await terminate(admin); })();
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
