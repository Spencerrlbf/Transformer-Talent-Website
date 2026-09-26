// Local PostgreSQL only. Proves the cutover runbook scripts on synthetic people:
// dry run writes nothing; publish keeps a before-image tagged with the run;
// a re-run is a no-op; a crash between commit and checkpoint converges on
// resume; a legacy edit after publish is refused as drift; undo restores the
// exact profile and refuses a drifted row; review/hold skips; the write guard
// rejects unaudited profile writes, allows workflow writes and audited writes.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import * as lib from "../dist/worker-lib.mjs";
import { prepareAuditFixture } from "../person-audit/local-fixture.mjs";
import { runPublish, SPEC as PUBLISH_SPEC } from "../person-publish.mjs";
import { runUndo } from "../person-publish-undo.mjs";
import { guardStatus, setGuard, testRejected, testAllowed } from "../person-guard.mjs";
import { parseOptions, databaseConfig } from "./lib.mjs";

const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
  throw Error("Local database required");
const pool = new pg.Pool(databaseConfig({ LOCAL_DATABASE_URL: url }, "tt-publish-test"));
const A = "c0000000-0000-4000-8000-00000000a001";
const B = "c0000000-0000-4000-8000-00000000b002";
const OTHER = "c0000000-0000-4000-8000-00000000c003";
const quiet = () => {};
const profileOf = (row) => Object.fromEntries(lib.PROFILE_FIELDS.map((k) => [k, row[k] ?? null]));
const read = async (id) => (await pool.query("select to_jsonb(c) row from candidates c where id=$1", [id])).rows[0].row;
const count = async (sql, args = []) => (await pool.query(sql, args)).rows[0].n;
const historyRows = (id) => count("select count(*)::int n from person_projection_history where candidate_id=$1", [id]);
const opts = (argv) => parseOptions(argv, PUBLISH_SPEC);
async function fixture(id, username, title) {
  await pool.query(
    `insert into candidates(id,full_name,linkedin_username,current_title,current_company,email,source,status,notes,work_experience,created_at)
     values($1,$2,$3,$4,'Synthetic Co',$5,'directory','Engaged','Keep workflow notes',$6,'2025-01-01T00:00:00Z')`,
    [id, `Synthetic ${username}`, username, title, `${username}@example.com`,
      JSON.stringify([{ title, company: "Synthetic Co", is_current: true, start_date: { year: 2020, month: "Jan" } }])],
  );
  await prepareAuditFixture(id);
  return read(id);
}
let originalA, originalB;
test.before(async () => {
  originalA = await fixture(A, "synthetic-publish-a", "Engineer");
  originalB = await fixture(B, "synthetic-publish-b", "Analyst");
  await pool.query("insert into candidates(id,full_name,linkedin_username) values($1,'Synthetic Other','synthetic-publish-other')", [OTHER]);
});
test.after(async () => { await pool.end(); });

test("option parsing refuses unknown, unbounded and malformed values", () => {
  assert.throws(() => opts(["--run-id=bad id"]), /publish_option/);
  assert.throws(() => opts(["--run-id=r1", "--batch-size=501"]), /publish_option/);
  assert.throws(() => opts(["--run-id=r1", "--mode=live"]), /publish_option/);
  assert.throws(() => opts(["--run-id=r1", "--ids=not-a-uuid"]), /publish_option/);
  assert.throws(() => opts(["--run-id=r1", "--resume=yes"]), /publish_option/);
  assert.throws(() => opts(["--mode=dry"]), /publish_option_required:run-id/);
  const o = opts(["--run-id=r1", "--mode=publish", "--ids=" + A + "," + B, "--review=publish", "--resume"]);
  assert.deepEqual([o.runId, o.mode, o.review, o.resume, o.ids.length, o.batch], ["r1", "publish", "publish", true, 2, 100]);
});

test("dry run reports the change and writes nothing", async () => {
  const before = await read(A);
  const summary = await runPublish({ pool, lib, options: opts(["--run-id=dry-a", "--mode=dry", `--ids=${A}`]), onProgress: quiet });
  assert.equal(summary.dry_changed, 1);
  assert.deepEqual(await read(A), before);
  assert.equal(await historyRows(A), 0);
  assert.equal(await count("select count(*)::int n from person_publish_runs"), 0);
  assert.equal(await count("select count(*)::int n from person_projection_state where candidate_id=$1", [A]), 0);
});

test("publish writes the projection once, keeps a run-tagged before-image and is a no-op on resume", async () => {
  const summary = await runPublish({ pool, lib, options: opts(["--run-id=pub-1", "--mode=publish", `--ids=${A}`]), onProgress: quiet });
  assert.equal(summary.projected, 1);
  const saved = await read(A);
  assert.notDeepEqual(profileOf(saved), profileOf(originalA));
  assert.ok(saved.work_experience[0].company_ref, "projection added the company reference");
  assert.equal(saved.notes, originalA.notes);
  assert.equal(saved.status, originalA.status);
  assert.equal(saved.email, originalA.email);
  const history = (await pool.query("select run_id,before_profile,restored_at from person_projection_history where candidate_id=$1", [A])).rows;
  assert.equal(history.length, 1);
  assert.equal(history[0].run_id, "pub-1");
  assert.deepEqual(history[0].before_profile, profileOf(originalA));
  const run = (await pool.query("select status,processed,counts from person_publish_runs where run_id='pub-1'")).rows[0];
  assert.equal(run.status, "complete");
  assert.equal(run.processed, 1);
  assert.equal(run.counts.projected, 1);
  const result = (await pool.query("select status,history_id,changed_fields from person_publish_results where run_id='pub-1' and candidate_id=$1", [A])).rows[0];
  assert.equal(result.status, "projected");
  assert.ok(result.history_id);
  assert.ok(result.changed_fields.includes("work_experience"));
  await assert.rejects(runPublish({ pool, lib, options: opts(["--run-id=pub-1", "--mode=publish", `--ids=${A}`]), onProgress: quiet }), /publish_run_exists/);
  const again = await runPublish({ pool, lib, options: opts(["--run-id=pub-1", "--mode=publish", `--ids=${A}`, "--resume"]), onProgress: quiet });
  assert.equal(again.unchanged, 1);
  assert.equal(await historyRows(A), 1);
  assert.deepEqual(await read(A), saved);
});

test("a crash after commit but before the checkpoint converges on resume without a second before-image", async () => {
  await assert.rejects(
    runPublish({ pool, lib, options: opts(["--run-id=pub-2", "--mode=publish", `--ids=${B}`]), onProgress: quiet,
      hooks: { afterPerson: () => { throw Error("publish_test_crash"); } } }),
    /publish_test_crash/,
  );
  assert.equal((await pool.query("select status from person_publish_runs where run_id='pub-2'")).rows[0].status, "failed");
  assert.equal(await historyRows(B), 1, "the person's own transaction committed before the crash");
  assert.notDeepEqual(profileOf(await read(B)), profileOf(originalB));
  const resumed = await runPublish({ pool, lib, options: opts(["--run-id=pub-2", "--mode=publish", `--ids=${B}`, "--resume"]), onProgress: quiet });
  assert.equal(resumed.unchanged, 1);
  assert.equal(await historyRows(B), 1);
  assert.equal((await pool.query("select run_id from person_projection_history where candidate_id=$1", [B])).rows[0].run_id, "pub-2");
});

test("undo restores the exact before-image, is idempotent and preserves normalized facts", async () => {
  const dry = await runUndo({ pool, lib, options: parseOptions(["--run-id=pub-2"], (await import("../person-publish-undo.mjs")).SPEC), onProgress: quiet });
  assert.equal(dry.pending, 1);
  assert.notDeepEqual(profileOf(await read(B)), profileOf(originalB));
  const applied = await runUndo({ pool, lib, options: parseOptions(["--run-id=pub-2", "--apply"], (await import("../person-publish-undo.mjs")).SPEC), onProgress: quiet });
  assert.equal(applied.restored, 1);
  const restored = await read(B);
  assert.deepEqual(profileOf(restored), profileOf(originalB));
  assert.equal(restored.notes, originalB.notes);
  assert.equal(await count("select count(*)::int n from candidate_sources where candidate_id=$1", [B]), 1);
  assert.equal(await count("select count(*)::int n from candidate_profile_state where candidate_id=$1", [B]), 1);
  const second = await runUndo({ pool, lib, options: parseOptions(["--run-id=pub-2", "--apply"], (await import("../person-publish-undo.mjs")).SPEC), onProgress: quiet });
  assert.equal(second.restored + second.conflict + second.missing, 0);
  assert.equal((await pool.query("select status from person_publish_runs where run_id='pub-2-undo'")).rows[0].status, "complete");
});

test("a legacy edit after publish is reported as drift and left alone; undo then refuses the drifted row", async () => {
  await pool.query("update candidates set headline='Legacy edit after publish' where id=$1", [A]);
  const summary = await runPublish({ pool, lib, options: opts(["--run-id=pub-3", "--mode=publish", `--ids=${A}`]), onProgress: quiet });
  assert.equal(summary.drift, 1);
  assert.equal((await read(A)).headline, "Legacy edit after publish");
  assert.equal(await historyRows(A), 1);
  const undo = await runUndo({ pool, lib, options: parseOptions(["--run-id=pub-1", "--apply"], (await import("../person-publish-undo.mjs")).SPEC), onProgress: quiet });
  assert.equal(undo.conflict, 1);
  assert.equal(undo.restored, 0);
  assert.equal((await read(A)).headline, "Legacy edit after publish");
});

test("people with an open review record are skipped by default and published on request; held people are always skipped", async () => {
  await pool.query(
    `insert into identity_conflicts(kind,candidate_ids,incoming,evidence_hash,status) values('identity_taken',array[$1::uuid,$2::uuid],'{}'::jsonb,'publish-test-review','open')`,
    [OTHER, B],
  );
  const skipped = await runPublish({ pool, lib, options: opts(["--run-id=pub-4", "--mode=publish", `--ids=${B}`]), onProgress: quiet });
  assert.equal(skipped.review_skipped, 1);
  assert.equal(await historyRows(B), 1, "no new before-image while skipped");
  const published = await runPublish({ pool, lib, options: opts(["--run-id=pub-5", "--mode=publish", `--ids=${B}`, "--review=publish"]), onProgress: quiet });
  assert.equal(published.projected, 1);
  assert.equal(await historyRows(B), 2);
  await pool.query(
    `insert into person_source_holds(candidate_id,ledger_id,evidence_hash,reason,evidence) values($1,gen_random_uuid(),'publish-test-hold','harvest_cache_date_unknown','{}'::jsonb)`,
    [B],
  );
  const held = await runPublish({ pool, lib, options: opts(["--run-id=pub-6", "--mode=publish", `--ids=${B}`, "--review=publish"]), onProgress: quiet });
  assert.equal(held.held, 1);
  assert.equal(await historyRows(B), 2);
  await pool.query("update person_source_holds set resolved_at=clock_timestamp(),resolution='{\"test\":true}'::jsonb where candidate_id=$1", [B]);
});

test("the write guard rejects unaudited profile writes, allows workflow and audited writes, and can be disabled", async () => {
  assert.equal((await guardStatus(pool)).enabled, false);
  await pool.query("update candidates set headline='Unguarded write ok' where id=$1", [OTHER]);
  const enabled = await setGuard(pool, true, "publish test");
  assert.equal(enabled.enabled, true);
  await assert.rejects(pool.query("update candidates set headline='Should be rejected' where id=$1", [OTHER]), /person_profile_write_guard/);
  assert.equal((await read(OTHER)).headline, "Unguarded write ok");
  await pool.query("update candidates set status='Contacted',notes='workflow ok',follow_up_at=now() where id=$1", [OTHER]);
  assert.equal((await read(OTHER)).status, "Contacted");
  const client = await pool.connect();
  try {
    assert.equal(await testRejected(client, A), "rejected");
    assert.equal((await read(A)).headline, "Legacy edit after publish", "rejected probe rolled back");
    const headlineB = (await read(B)).headline;
    assert.equal(await testAllowed(client, B, lib), "allowed");
    assert.equal((await read(B)).headline, headlineB, "allowed probe rolled back too");
    // A carries an unattributed legacy edit: its audit chain is broken, so an
    // audited write is refused per person and the run continues.
    await assert.rejects(testAllowed(client, A, lib), /audit_unattributed_change/);
  } finally { client.release(); }
  // The audited paths pass the guard: undo B's publish, then republish B.
  const undoB = await runUndo({ pool, lib, options: parseOptions(["--run-id=pub-5", "--apply"], (await import("../person-publish-undo.mjs")).SPEC), onProgress: quiet });
  assert.equal(undoB.restored, 1, "audited undo passes the guard");
  const republish = await runPublish({ pool, lib, options: opts(["--run-id=pub-7", "--mode=publish", `--ids=${B}`, "--review=publish"]), onProgress: quiet });
  assert.equal(republish.projected, 1, "audited publish passes the guard");
  await assert.rejects(setGuard(pool, false, ""), /person_write_guard_invalid/);
  const disabled = await setGuard(pool, false, "publish test end");
  assert.equal(disabled.enabled, false);
  await pool.query("update candidates set headline='Unguarded again' where id=$1", [OTHER]);
  assert.equal((await read(OTHER)).headline, "Unguarded again");
  const client2 = await pool.connect();
  try { assert.equal(await testRejected(client2, OTHER), "allowed"); } finally { client2.release(); }
});

test("a scan pages migrated people by id, pauses at its limit and resumes from the cursor", async () => {
  const first = await runPublish({ pool, lib, options: opts(["--run-id=scan-1", "--mode=publish", "--limit=1", "--batch-size=1", "--review=publish"]), onProgress: quiet });
  assert.equal(first.phase, "publish_paused");
  assert.equal(first.processed, 1);
  assert.equal(first.last_id, A, "A sorts first and OTHER has no normalized state");
  const rest = await runPublish({ pool, lib, options: opts(["--run-id=scan-1", "--mode=publish", "--limit=100", "--batch-size=1", "--review=publish", "--resume"]), onProgress: quiet });
  assert.equal(rest.phase, "publish_complete");
  assert.equal(rest.processed, 2);
  assert.equal(rest.last_id, B);
  assert.equal(rest.drift, 1, "A still carries its legacy edit");
  assert.equal(rest.unchanged, 1, "B was republished in the guard test");
  const run = (await pool.query("select status,processed,counts from person_publish_runs where run_id='scan-1'")).rows[0];
  assert.equal(run.status, "complete");
  assert.equal(run.processed, 2);
  assert.equal(await count("select count(*)::int n from person_publish_results where run_id='scan-1'"), 2);
});
