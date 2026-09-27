import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";
const url = process.env.LOCAL_DATABASE_URL;
if (
  !/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_directory_worker_test$/.test(
    url || "",
  )
)
  throw Error("local fixture required");
const db = new pg.Client({ connectionString: url });
await db.connect();
test.after(() => db.end());
const ws = randomUUID(),
  contact = randomUUID(),
  username = "certified-cli-" + contact;
const call = (mode, dry = false) => {
  const out = spawnSync(
    process.execPath,
    [
      "--import",
      "./scripts/person-directory-worker/no-paid.mjs",
      "scripts/sync-directory.mjs",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30000,
      env: {
        PATH: process.env.PATH,
        PERSON_TRANSITION_SUPPORT: "on",
        PERSON_WRITE_MODE: mode,
        PERSON_DATABASE_URL: url,
        COMMS_DATABASE_URL: url,
        COMMS_WORKSPACE: "Synthetic certified directory",
        OPENAI_API_KEY: "synthetic-no-paid-calls",
        LIMIT: "5",
        DRY_RUN: dry ? "1" : "",
      },
    },
  );
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.trim().split("\n").at(-1));
};
const receipt = async () => {
  await db.query("set timezone='UTC';set datestyle='ISO,YMD'");
  return (
    await db.query(
      "select to_jsonb(r) r from person_directory_receipts r where workspace_id=$1",
      [ws],
    )
  ).rows[0]?.r;
};
const sourceHash = async () => {
  await db.query("set timezone='UTC';set datestyle='ISO,YMD'");
  return (
    await db.query(
      "select md5(jsonb_build_array((select to_jsonb(w) from comms.workspaces w where id=$1),(select to_jsonb(c) from comms.contacts c where id=$2),(select to_jsonb(b) from board.candidates b where contact_id=$2))::text) h",
      [ws, contact],
    )
  ).rows[0].h;
};
let before;
test("actual certified CLI dry run performs no website write", async () => {
  await db.query(
    "insert into comms.workspaces values($1,'Synthetic certified directory')",
    [ws],
  );
  await db.query("insert into comms.contacts values($1,$2)", [contact, ws]);
  await db.query(
    "insert into board.candidates values($1,'Synthetic Certified CLI',$2,null,null,'Replied',false,'2026-09-01')",
    [contact, "https://www.linkedin.com/in/" + username],
  );
  before = await sourceHash();
  const out = call("live", true);
  assert.equal(out.read, 1);
  assert.equal(out.saved, 0);
  assert.equal(out.embedded, 0);
  assert.equal(await receipt(), undefined);
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from candidates where linkedin_username=$1",
        [username],
      )
    ).rows[0].n,
    0,
  );
});
test("actual certified CLI creates in shadow, promotes live, then skips without paid calls", async () => {
  const shadow = call("shadow");
  assert.equal(shadow.saved, 1);
  assert.equal(shadow.derivativesDeferred, true);
  const first = await receipt();
  assert.equal(first.created_person, true);
  assert.equal(first.projected, true);
  const live = call("live");
  assert.equal(live.saved, 1);
  assert.equal(live.embedded, 0);
  assert.equal(live.derivativesDeferred, true);
  const second = await receipt();
  assert.equal(second.candidate_id, first.candidate_id);
  assert.equal(
    (
      await db.query(
        "select e.mode from person_private.directory_heads h join person_private.directory_executions e on e.id=h.execution_id where h.receipt_id=$1",
        [second.id],
      )
    ).rows[0].mode,
    "live",
  );
  const again = call("live");
  assert.equal(again.unchanged, 1);
  assert.equal(again.saved, 0);
  assert.deepEqual(await receipt(), second);
  assert.equal(await sourceHash(), before);
});
test("actual certified CLI held scan leaves the completed receipt and source untouched", async () => {
  const prior = await receipt();
  await db.query(
    "update person_private.transition_control set phase='held' where singleton",
  );
  try {
    assert.equal(call("live").status, "held");
    assert.deepEqual(await receipt(), prior);
    assert.equal(await sourceHash(), before);
  } finally {
    await db.query(
      "update person_private.transition_control set phase='open' where singleton",
    );
  }
});
