// Local PostgreSQL only. The read-only projection preview must report, over
// the trial's reader, exactly what publishPersonProjectionOnConnection would
// write, and must find a legacy unique-email collision before publish does.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import * as lib from "../dist/worker-lib.mjs";
import { prepareAuditFixture } from "../person-audit/local-fixture.mjs";
import { pgSite } from "../person-trial.mjs";
import { previewPage, runPreview, SPEC } from "../person-publish-preview.mjs";
import { parseOptions, databaseConfig } from "./lib.mjs";

const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
  throw Error("Local database required");
const pool = new pg.Pool(databaseConfig({ LOCAL_DATABASE_URL: url }, "tt-preview-test"));
const P = "c0000000-0000-4000-8000-00000000d001";
const Q = "c0000000-0000-4000-8000-00000000d002";
const R = "c0000000-0000-4000-8000-00000000d003";
const NOSTATE = "c0000000-0000-4000-8000-00000000d004";
const quiet = () => {};
let site;
async function fixture(id, username, title, email) {
  await pool.query(
    `insert into candidates(id,full_name,linkedin_username,current_title,current_company,email,source,status,work_experience,created_at)
     values($1,$2,$3,$4,'Synthetic Co',$5,'directory','Engaged',$6,'2025-01-01T00:00:00Z')`,
    [id, `Synthetic ${username}`, username, title, email,
      JSON.stringify([{ title, company: "Synthetic Co", is_current: true, start_date: { year: 2020, month: "Jan" } }])],
  );
  await prepareAuditFixture(id);
}
test.before(async () => {
  await fixture(P, "synthetic-preview-p", "Engineer", "preview-p@example.com");
  await fixture(Q, "synthetic-preview-q", "Analyst", "preview-q@example.com");
  await fixture(R, "synthetic-preview-r", "Designer", "preview-r@example.com");
  await pool.query("insert into candidates(id,full_name,linkedin_username,email) values($1,'Synthetic No State','synthetic-preview-nostate','nostate@example.com')", [NOSTATE]);
  site = await pgSite(url);
});
test.after(async () => { await site?.end(); await pool.end(); });

test("the preview over the trial reader matches the publish dry run for every person", async () => {
  const preview = await previewPage({ site, lib, ids: [P, Q, R, NOSTATE] });
  const byId = new Map(preview.map((r) => [r.id, r]));
  assert.equal(byId.get(NOSTATE).status, "missing");
  const client = await pool.connect();
  try {
    for (const id of [P, Q, R]) {
      const dry = await lib.publishPersonProjectionOnConnection(client, id, { runId: "preview-parity", dryRun: true });
      assert.equal(byId.get(id).status, dry.status === "dry_changed" ? "changed" : "unchanged", id);
      assert.deepEqual(byId.get(id).changed, dry.changedFields, id);
      assert.equal(byId.get(id).emailChanged, dry.changedFields.includes("email"));
      assert.equal(byId.get(id).emailCollision, dry.emailCollision);
      assert.equal(byId.get(id).review, false);
    }
  } finally { client.release(); }
  assert.equal(await (await pool.query("select count(*)::int n from person_projection_history where candidate_id=any($1::uuid[])", [[P, Q, R]])).rows[0].n, 0, "the preview wrote nothing");
});

test("a projected address already held by another candidate is a collision, and the preview reports what publish keeps", async () => {
  // Q's normalized contacts gain R's address as a newer manual primary, so Q's
  // projection wants preview-r@example.com, which the legacy unique constraint refuses.
  const legacy = (await pool.query("select to_jsonb(c) row from candidates c where id=$1", [Q])).rows[0].row;
  const doc = lib.fromLegacyImport(legacy);
  const taken = {
    ...doc,
    contacts: [{ ...doc.contacts.find((c) => c.kind === "email"), value_raw: "preview-r@example.com", value_normalized: "preview-r@example.com", is_manual: true, source_detail: "synthetic-manual" }],
    jobs: undefined, educations: undefined, skills: undefined,
    source: { ...doc.source, source: "recruiter", fetched_at: "2026-09-01T00:00:00Z", payload_hash: "preview-taken", source_ref: "synthetic-edit" },
  };
  const client = await pool.connect();
  try {
    const saved = await lib.savePersonOnConnection(client, taken, { mode: "shadow" });
    assert.ok(saved.changed);
    const [q] = await previewPage({ site, lib, ids: [Q] });
    assert.equal(q.emailCollision, true, "R already holds the address");
    assert.equal(q.emailChanged, false, "publish keeps today's address on a collision");
    assert.ok(!q.changed.includes("email"));
    const dry = await lib.publishPersonProjectionOnConnection(client, Q, { runId: "preview-parity", dryRun: true });
    assert.equal(dry.emailCollision, true);
    assert.ok(!dry.changedFields.includes("email"));
    assert.deepEqual(q.changed, dry.changedFields);
    assert.equal(q.status, dry.status === "dry_changed" ? "changed" : "unchanged");
  } finally { client.release(); }
});

test("held people are skipped, open review records are flagged, and the scan pages with a cursor and limit", async () => {
  await pool.query(
    `insert into person_source_holds(candidate_id,ledger_id,evidence_hash,reason,evidence) values($1,gen_random_uuid(),'preview-test-hold','harvest_cache_date_unknown','{}'::jsonb)`, [P]);
  await pool.query(
    `insert into identity_conflicts(kind,candidate_ids,incoming,evidence_hash,status) values('identity_taken',array[$1::uuid,$2::uuid],'{}'::jsonb,'preview-test-review','open')`, [R, NOSTATE]);
  const first = await runPreview({ site, lib, options: parseOptions(["--limit=1", "--batch-size=1"], SPEC), onProgress: quiet });
  assert.equal(first.people, 1);
  const all = await runPreview({ site, lib, options: parseOptions(["--batch-size=2"], SPEC), onProgress: quiet });
  assert.ok(all.people >= 3);
  assert.equal(all.held, 1);
  assert.ok(all.review >= 1);
  assert.equal(all.email_collision, 1);
  assert.equal(all.collision_ids[0], Q);
  assert.ok(Object.hasOwn(all.by_column, "email"));
  const rest = await runPreview({ site, lib, options: parseOptions([`--after=${P}`, "--batch-size=500"], SPEC), onProgress: quiet });
  const upToP = (await pool.query("select count(*)::int n from candidate_profile_state where candidate_id<=$1", [P])).rows[0].n;
  assert.equal(rest.people, all.people - upToP, "the cursor skips every migrated id up to P");
  assert.equal(rest.held, 0, "P, the held person, is behind the cursor");
  const ids = await runPreview({ site, lib, options: parseOptions([`--ids=${Q},${NOSTATE}`], SPEC), onProgress: quiet });
  assert.equal(ids.people, 1, "an id without normalized state is not a migrated person");
  await pool.query("update person_source_holds set resolved_at=clock_timestamp(),resolution='{\"test\":true}'::jsonb where candidate_id=$1", [P]);
});
