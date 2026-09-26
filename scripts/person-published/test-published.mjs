import { prepareAuditFixture } from "../person-audit/local-fixture.mjs";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import pg from "pg";
import * as lib from "../dist/worker-lib.mjs";
const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw Error("local database required");
const db = new pg.Pool({ connectionString: url, max: 4 });
after(() => db.end());
const id = (n) => `d3000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
await test("published snapshots have a checked, server-only interface", () => {
  assert.equal(typeof lib.publishedPoolProfilesOnConnection, "function");
});
if (!lib.publishedPoolProfilesOnConnection)
  throw Error("published_interface_missing");
const use = async (fn) => {
  const c = await db.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
};
const read = (n) =>
  use((c) => lib.publishedPoolProfilesOnConnection(c, [id(n)]));
async function fixture(n, publish = true, extra = {}) {
  const row = {
    id: id(n),
    full_name: "Synthetic Published",
    linkedin_username: `published-${n}`,
    email: `visible-${n}@example.test`,
    current_title: "Canonical Role",
    current_company: "Synthetic Employer",
    profile_summary: "Canonical summary",
    top_skills: ["TypeScript"],
    created_at: "2020-01-01",
    work_experience: [
      {
        title: "Canonical Role",
        company: "Synthetic Employer",
        is_current: true,
        start_date: { year: 2020, month: "Jan" },
      },
    ],
    education: "Synthetic School - BSc in Engineering",
    ...extra,
  };
  const keys = Object.keys(row);
  await db.query(
    `insert into candidates(${keys.join(",")}) values(${keys.map((_, i) => `$${i + 1}`).join(",")})`,
    keys.map((k) =>
      k === "work_experience" ? JSON.stringify(row[k]) : row[k],
    ),
  );
  const doc = await prepareAuditFixture(row.id);
  if (publish)
    await use((c) => lib.savePersonOnConnection(c, doc, { mode: "live" }));
  return doc;
}
test("published snapshot exposes canonical compatibility data, contacts and no private payloads", async () => {
  await fixture(1);
  await db.query(
    "update candidates set linkedin_data='{\"private\":true}',resume_text='private resume',notes='private notes' where id=$1",
    [id(1)],
  );
  const r = (await read(1)).get(id(1));
  assert.equal(r.profile.current_title, "Canonical Role");
  assert.equal(r.contact.email, "visible-1@example.test");
  assert.equal(r.harvest.experience[0].position, "Canonical Role");
  assert.deepEqual(r.harvest.skills, [{ name: "TypeScript" }]);
  for (const key of [
    "linkedin_data",
    "resume_text",
    "notes",
    "matching_embedding",
  ])
    assert.equal(Object.hasOwn(r.profile, key), false);
});
test("never-published and missing candidates are absent, preserving explicit legacy routing", async () => {
  await fixture(2, false);
  assert.equal((await read(2)).size, 0);
  assert.equal((await read(99)).size, 0);
});
test("a normalized revision ahead of its published profile is unavailable for both read paths", async () => {
  await fixture(3);
  await db.query(
    "update candidate_profile_state set rev=rev+1 where candidate_id=$1",
    [id(3)],
  );
  await assert.rejects(read(3), /person_profile_unavailable/);
  await assert.rejects(
    use((c) => lib.publishedPoolContactsOnConnection(c, [id(3)])),
    /person_profile_unavailable/,
  );
});
test("legacy compatibility drift never falls back to raw or stale fields", async () => {
  await fixture(4);
  await db.query(
    "update candidates set current_title='Unattributed edit' where id=$1",
    [id(4)],
  );
  await assert.rejects(read(4), /person_profile_unavailable/);
});
test("a published profile with an unresolved provenance hold is unavailable", async () => {
  await fixture(5);
  await db.query(
    "insert into person_source_holds(candidate_id,ledger_id,evidence_hash,reason,evidence) values($1,$2,'synthetic','harvest_cache_date_unknown','{}')",
    [id(5), id(500)],
  );
  await assert.rejects(read(5), /person_profile_unavailable/);
});
test("a concurrent uncommitted profile update cannot mix old profile and new contacts", async () => {
  await fixture(6);
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query(
      "update candidates set current_title='Uncommitted edit' where id=$1",
      [id(6)],
    );
    const r = (await read(6)).get(id(6));
    assert.equal(r.profile.current_title, "Canonical Role");
    assert.equal(r.contact.email, "visible-6@example.test");
  } finally {
    await c.query("rollback");
    c.release();
  }
});
test("an explicit empty canonical history and skills remain empty in the compatible snapshot", async () => {
  const snapshot = lib.canonicalProfileSnapshot({
    id: id(9),
    work_experience: [],
    education: null,
    education_schools: [],
    top_skills: [],
    all_skills_text: null,
    profile_summary: null,
  });
  assert.deepEqual(snapshot.experience, []);
  assert.deepEqual(snapshot.education, []);
  assert.deepEqual(snapshot.skills, []);
  assert.equal(snapshot.about, undefined);
});
test("read failures and excessive batch size fail visibly", async () => {
  await assert.rejects(
    lib.publishedPoolProfilesOnConnection(
      {
        query: async () => {
          throw Error("read_failure");
        },
      },
      [id(1)],
    ),
    /read_failure/,
  );
  await assert.rejects(
    lib.publishedPoolProfilesOnConnection(db, Array(1001).fill(id(1))),
    /person_profile_read_limit/,
  );
});
test("sent profile retains structured dated and explicitly ended employment for downstream facts", () => {
  const snapshot = lib.canonicalProfileSnapshot({
    id: id(20),
    headline: "Canonical headline",
    location: "Synthetic location",
    work_experience: [
      {
        title: "Ended Role",
        company: "Past Employer",
        is_current: false,
        start_date: { year: 2015, month: "Jan" },
        end_date: { year: 2020, month: "Dec" },
      },
      {
        title: "Current Role",
        company: "Current Employer",
        is_current: true,
        start_date: { year: 2021, month: "Feb" },
        end_date: null,
      },
    ],
  });
  const rows = lib.harvestToExperiences(snapshot);
  assert.deepEqual(
    rows.map((r) => [
      r.start_year,
      r.start_month,
      r.end_year,
      r.end_month,
      r.is_current,
    ]),
    [
      [2015, 1, 2020, 12, false],
      [2021, 2, null, null, true],
    ],
  );
  assert.match(lib.linkedinProfileText(snapshot), /Canonical headline/);
  assert.equal(snapshot.location, "Synthetic location");
});
test("explicitly ended employment with unknown end date never becomes a current job", () => {
  const snapshot = lib.canonicalProfileSnapshot({
    id: id(21),
    work_experience: [
      {
        title: "Ended Role",
        company: "Past Employer",
        is_current: false,
        start_date: { year: 2015 },
        end_date: null,
      },
    ],
  });
  assert.equal(lib.harvestToExperiences(snapshot)[0].is_current, false);
  assert.equal(snapshot.experience[0].datesText.includes("Present"), false);
});

test("empty published lists and unusable contacts are available as an authoritative empty snapshot", async () => {
  await fixture(7, true, {
    current_title: null,
    current_company: null,
    work_experience: [],
    education: null,
    top_skills: [],
    profile_summary: null,
  });
  await fixture(8);
  await db.query(
    "update candidate_contacts set status='bounced',rank=null where candidate_id=$1 and kind='email'",
    [id(8)],
  );
  const empty = (await read(7)).get(id(7));
  assert.deepEqual(empty.harvest.experience, []);
  assert.deepEqual(empty.harvest.skills, []);
  assert.equal((await read(8)).get(id(8)).contact.email, null);
});
test("unmarked Harvest profiles keep their existing current-role inference", () => {
  assert.equal(
    lib.harvestToExperiences({
      experience: [{ position: "Legacy", is_current: false }],
    })[0].is_current,
    true,
  );
});
