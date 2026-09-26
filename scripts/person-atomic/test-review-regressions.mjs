import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import * as lib from "../dist/worker-lib.mjs";
const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
  throw Error("Local database required");
const db = new pg.Client({ connectionString: url });
await db.connect();
after(() => db.end());
async function person(n, extras = {}) {
  const id = `d1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const row = {
    id,
    full_name: "Synthetic Review",
    linkedin_username: `atomic-review-${n}`,
    created_at: "2025-01-01T00:00:00Z",
    ...extras,
  };
  const keys = Object.keys(row);
  await db.query(
    `insert into candidates(${keys.join(",")}) values(${keys.map((_, i) => `$${i + 1}`).join(",")})`,
    Object.values(row),
  );
  return row;
}
const read = async (id) =>
  (await db.query("select * from candidates where id=$1", [id])).rows[0];
test("claimed application contacts cannot erase incumbent email or phone", async () => {
  const row = await person(1, {
    email: "incumbent@example.com",
    phone: "+12025550101",
  });
  const doc = lib.fromApplication(
    {
      id: "d2000000-0000-4000-8000-000000000001",
      candidate_id: row.id,
      name: row.full_name,
      created_at: "2026-01-01",
      email: "claimed@example.com",
      contact: { phone: "+12025550102" },
    },
    false,
  );
  await lib.savePersonOnConnection(db, doc, { mode: "live" });
  const saved = await read(row.id);
  assert.equal(saved.email, row.email);
  assert.equal(saved.phone, row.phone);
});
test("a first no-op projection establishes a drift baseline", async () => {
  const row = await person(2);
  const doc = lib.fromLegacyImport(row);
  const first = await lib.savePersonOnConnection(db, doc, { mode: "live" });
  assert.equal(first.projected, false);
  await db.query(
    "update candidates set current_title='New legacy edit' where id=$1",
    [row.id],
  );
  await assert.rejects(
    lib.savePersonOnConnection(db, doc, { mode: "live" }),
    /legacy_projection_drift/,
  );
});
test("undo keeps drift protection for the restored profile", async () => {
  const row = await person(3, { current_title: "Old title" });
  const doc = lib.fromLegacyImport({
    ...row,
    current_title: "Corrected title",
  });
  const save = await lib.savePersonOnConnection(db, doc, { mode: "live" });
  assert.equal(
    (await lib.undoPersonProjectionOnConnection(db, row.id, save.revision))
      .status,
    "restored",
  );
  await db.query(
    "update candidates set current_title='New legacy edit' where id=$1",
    [row.id],
  );
  await assert.rejects(
    lib.savePersonOnConnection(db, doc, { mode: "live" }),
    /legacy_projection_drift/,
  );
});
test("projection and undo stamp candidate updated_at", async () => {
  const row = await person(4, {
    current_title: "Old title",
    updated_at: "2025-01-01",
  });
  const doc = lib.fromLegacyImport({
    ...row,
    current_title: "Corrected title",
  });
  const save = await lib.savePersonOnConnection(db, doc, { mode: "live" });
  const projected = await read(row.id);
  assert.ok(new Date(projected.updated_at) > new Date("2026-01-01"));
  await lib.undoPersonProjectionOnConnection(db, row.id, save.revision);
  assert.ok(
    new Date((await read(row.id)).updated_at) >= new Date(projected.updated_at),
  );
});
test("public application header cannot replace an existing name or location", async () => {
  const row = await person(5, { location: "Existing City" });
  const doc = lib.fromApplication(
    {
      id: "d2000000-0000-4000-8000-000000000005",
      candidate_id: row.id,
      name: "Claimed Different Person",
      location: "Claimed City",
      created_at: "2026-01-01",
    },
    false,
  );
  await lib.savePersonOnConnection(db, doc, { mode: "live" });
  const saved = await read(row.id);
  assert.equal(saved.full_name, row.full_name);
  assert.equal(saved.location, row.location);
});
