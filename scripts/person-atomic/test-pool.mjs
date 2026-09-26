import assert from "node:assert/strict";
import pg from "pg";
import * as lib from "../dist/worker-lib.mjs";
const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
  throw Error("Local database required");
process.env.PERSON_DATABASE_URL = url;
const db = new pg.Client({ connectionString: url });
await db.connect();
const row = (
  await db.query(
    "select * from candidates where linkedin_username='atomic-review-5'",
  )
).rows[0];
const doc = (
  await db.query(
    "select legacy_doc from person_audit_anchors where candidate_id=$1",
    [row.id],
  )
).rows[0].legacy_doc;
try {
  if (process.argv.includes("--idle")) {
    await lib.savePerson(doc, { mode: "shadow" });
    await db.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where application_name='tt-person-writer' and datname=current_database() and state='idle'",
    );
    await new Promise((r) => setTimeout(r, 100));
    await lib.savePerson(doc, { mode: "shadow" });
    console.log(
      "PASS own idle socket failure does not crash writer process and a new connection works",
    );
  } else {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [row.id]);
    const attempts = Promise.allSettled(
      Array.from({ length: 5 }, () => lib.savePerson(doc, { mode: "shadow" })),
    );
    await new Promise((r) => setTimeout(r, 300));
    const count = (
      await db.query(
        "select count(*)::int n from pg_stat_activity where application_name='tt-person-writer' and datname=current_database()",
      )
    ).rows[0].n;
    await db.query("commit");
    const results = await attempts;
    assert.equal(results.filter((r) => r.status === "rejected").length, 0);
    assert.ok(count <= 2, `connection cap exceeded: ${count}`);
    console.log(
      "PASS five concurrent first calls share one pool with at most two connections",
    );
  }
} finally {
  await db.query("rollback").catch(() => {});
  await db.end();
}
