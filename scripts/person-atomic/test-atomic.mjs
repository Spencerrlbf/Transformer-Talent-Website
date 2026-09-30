import { prepareAuditFixture } from "../person-audit/local-fixture.mjs";
import assert from "node:assert/strict";
import pg from "pg";
import { pgSite, readNew, projectionInput } from "../person-trial.mjs";
import * as lib from "../dist/worker-lib.mjs";
assert.equal(
  typeof lib.savePersonOnConnection,
  "function",
  "atomic shared writer is implemented",
);
assert.equal(
  typeof lib.undoPersonProjectionOnConnection,
  "function",
  "conditional undo is implemented",
);
const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
  throw Error("Local database required");
const db = new pg.Client({ connectionString: url });
await db.connect();
const id = "c0000000-0000-4000-8000-000000000001";
const row = {
  id,
  full_name: "Synthetic Person",
  linkedin_username: "synthetic-atomic",
  current_title: "Engineer",
  current_company: "Synthetic Co",
  created_at: "2025-01-01T00:00:00Z",
  source: "directory",
  email: "atomic@example.com",
  status: "Engaged",
  contact: { github: "https://github.com/synthetic" },
  notes: "Keep workflow notes",
  work_experience: [
    {
      title: "Engineer",
      company: "Synthetic Co",
      is_current: true,
      start_date: { year: 2020, month: "Jan" },
    },
  ],
};
const read = async () =>
  (await db.query("select to_jsonb(c) row from candidates c where id=$1", [id]))
    .rows[0].row;
const count = async (table) =>
  (
    await db.query(
      `select count(*)::int n from ${table} where candidate_id=$1`,
      [id],
    )
  ).rows[0].n;
const doc = lib.fromLegacyImport(row);
try {
  await db.query(
    `insert into candidates(id,full_name,linkedin_username,current_title,current_company,email,source,status,contact,notes,work_experience,created_at)
 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      row.full_name,
      row.linkedin_username,
      row.current_title,
      row.current_company,
      row.email,
      row.source,
      row.status,
      row.contact,
      row.notes,
      JSON.stringify(row.work_experience),
      row.created_at,
    ],
  );
  await prepareAuditFixture(id);
  const original = await read();
  await db.query(`create function public.synthetic_projection_failure() returns trigger language plpgsql as $$ begin if current_setting('person_test.fail',true)='yes' then raise exception 'synthetic projection failure' using errcode='23514'; end if; return new; end $$;
 create trigger synthetic_projection_failure before update on candidates for each row execute function synthetic_projection_failure()`);
  await db.query("set person_test.fail='yes'");
  const incoming = lib.fromHarvest(
    {
      experience: [
        {
          position: "Injected new role",
          companyName: "New synthetic employer",
          startDate: { year: 2026, month: 1 },
        },
      ],
    },
    {
      id: "c0000000-0000-4000-8000-000000000099",
      created_at: "2026-09-20T00:00:00Z",
      cache_status: "miss",
    },
    id,
  );
  const baselineRevision = (
    await db.query(
      "select rev from candidate_profile_state where candidate_id=$1",
      [id],
    )
  ).rows[0].rev;
  await assert.rejects(
    lib.savePersonOnConnection(db, incoming, { mode: "live" }),
    /synthetic projection failure/,
  );
  assert.equal(
    (
      await db.query(
        "select rev from candidate_profile_state where candidate_id=$1",
        [id],
      )
    ).rows[0].rev,
    baselineRevision,
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from candidate_sources where candidate_id=$1 and payload_hash=$2",
        [id, incoming.source.payload_hash],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(await count("person_audit_operations"), 0);
  assert.deepEqual(await read(), original);
  assert.equal(await count("candidate_sources"), 1);
  assert.equal(await count("person_projection_history"), 0);
  await db.query("set person_test.fail='no'");
  console.log(
    "PASS failure after normalized save rolls back both representations",
  );
  const shadow = await lib.savePersonOnConnection(db, doc, { mode: "shadow" });
  assert.equal(shadow.changed, false);
  assert.deepEqual(await read(), original);
  assert.equal(await count("person_projection_history"), 0);
  const live = await lib.savePersonOnConnection(db, doc, { mode: "live" });
  assert.equal(live.projected, true);
  let saved = await read();
  assert.equal(saved.source, row.source);
  assert.equal(saved.status, row.status);
  assert.equal(saved.notes, row.notes);
  assert.deepEqual(saved.contact, row.contact);
  assert.equal(saved.work_experience[0].title, "Engineer");
  assert.ok(saved.work_experience[0].company_ref);
  assert.equal(saved.current_company_id, saved.work_experience[0].company_ref);
  assert.equal(saved.email, row.email);
  await db.query(
    "update companies set name='Canonical Employer Name' where id=(select company_id from candidate_experiences where candidate_id=$1 and source='person' and removed_at is null limit 1)",
    [id],
  );
  const site = await pgSite(url);
  try {
    assert.deepEqual(
      lib.project(await lib.readPersonProjection(db, id)),
      lib.project(
        projectionInput(id, await readNew(site, [id], { globalCounts: false })),
      ),
    );
  } finally {
    await site.end();
  }
  console.log(
    "PASS atomic read projection matches the independently audited trial reader",
  );
  const again = await lib.savePersonOnConnection(db, doc, { mode: "live" });
  assert.equal(again.changed, false);
  assert.equal(again.projected, false);
  assert.equal(again.revision, live.revision);
  assert.deepEqual(await read(), saved);
  console.log(
    "PASS shadow isolation, compatibility projection, workflow preservation and exact replay",
  );
  const history = await count("person_projection_history");
  const undo = await lib.undoPersonProjectionOnConnection(
    db,
    id,
    live.revision,
  );
  assert.equal(undo.status, "restored");
  assert.equal((await read()).work_experience[0].company_ref, undefined);
  assert.equal(await count("candidate_sources"), 1);
  console.log("PASS conditional projection undo preserves normalized evidence");
  const reproject = await lib.savePersonOnConnection(db, doc, { mode: "live" });
  assert.equal(reproject.projected, true);
  const newer = {
    ...doc,
    header: { ...doc.header, current_title: "Staff Engineer" },
    source: {
      ...doc.source,
      source: "recruiter",
      fetched_at: "2026-09-01T00:00:00Z",
      payload_hash: "atomic-newer",
      source_ref: "synthetic-edit",
    },
    jobs: undefined,
    educations: undefined,
    skills: undefined,
  };
  const other = new pg.Client({ connectionString: url });
  await other.connect();
  try {
    await Promise.all([
      lib.savePersonOnConnection(db, doc, { mode: "live" }),
      lib.savePersonOnConnection(other, newer, { mode: "live" }),
    ]);
  } finally {
    await other.end();
  }
  assert.equal((await read()).current_title, "Staff Engineer");
  assert.equal(
    (await lib.undoPersonProjectionOnConnection(db, id, live.revision)).status,
    "conflict",
  );
  assert.ok((await count("person_projection_history")) >= history);
  console.log(
    "PASS concurrent sources converge and older revision cannot undo a newer save",
  );
  assert.equal(
    lib.semanticProfileHash({
      work_experience: [
        {
          title: "Engineer",
          company: "Co",
          description: "A\nB",
          company_ref: "old",
        },
      ],
    }),
    lib.semanticProfileHash({
      work_experience: [
        {
          title: "Engineer",
          company: "Co",
          description: "A B",
          company_ref: "new",
        },
      ],
    }),
  );
  assert.notEqual(
    lib.semanticProfileHash({ current_title: "Engineer" }),
    lib.semanticProfileHash({ current_title: "Staff Engineer" }),
  );
  console.log(
    "PASS semantic hash ignores representation while detecting factual changes",
  );
  const partialId = "c0000000-0000-4000-8000-000000000002";
  await db.query(
    "insert into candidates(id,full_name,linkedin_username,current_title,current_company,email) values($1,'Partial Person','partial-atomic','Keep Title','Keep Employer','collision@example.com')",
    [partialId],
  );
  await prepareAuditFixture(partialId);
  const partial = lib.fromApplication(
    {
      id: "c0000000-0000-4000-8000-000000000003",
      candidate_id: partialId,
      name: "Partial Person",
      created_at: "2026-09-02T00:00:00Z",
    },
    false,
  );
  await lib.savePersonOnConnection(db, partial, { mode: "live" });
  const preserved = (
    await db.query("select * from candidates where id=$1", [partialId])
  ).rows[0];
  assert.equal(preserved.current_title, "Keep Title");
  assert.equal(preserved.current_company, "Keep Employer");
  assert.equal(preserved.email, "collision@example.com");
  console.log(
    "PASS a partial application never blanks unrelated existing facts/contacts",
  );
  const collision = {
    ...newer,
    mode: "contacts_only",
    source: {
      ...newer.source,
      payload_hash: "atomic-collision",
      fetched_at: "2026-09-03T00:00:00Z",
    },
    contacts: [
      {
        ...doc.contacts[0],
        value_normalized: "collision@example.com",
        value_raw: "collision@example.com",
        is_manual: true,
        source_detail: "recruiter_primary",
      },
    ],
  };
  await lib.savePersonOnConnection(db, collision, { mode: "live" });
  assert.equal((await read()).email, "atomic@example.com");
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from identity_conflicts where kind='legacy_email_collision' and $1=any(candidate_ids)",
        [id],
      )
    ).rows[0].n,
    1,
  );
  const collisionRow = await read();
  const collisionHistory = await count("person_projection_history");
  const repeatedCollision = await lib.savePersonOnConnection(db, collision, {
    mode: "live",
  });
  assert.equal(repeatedCollision.projected, false);
  assert.deepEqual(await read(), collisionRow);
  assert.equal(await count("person_projection_history"), collisionHistory);
  console.log(
    "PASS legacy email collision preserves identities and repeat is a no-op",
  );
  const access = (
    await db.query(
      "select has_table_privilege('anon','person_projection_history','select') as anon,has_table_privilege('authenticated','person_projection_history','select') as auth",
    )
  ).rows[0];
  assert.equal(access.anon, false);
  assert.equal(access.auth, false);
  console.log("PASS before-images are inaccessible to public/browser roles");
  const listDoc = lib.fromLegacyImport({
    ...row,
    education: "Synthetic College - BS in CS",
    top_skills: ["Python"],
  });
  listDoc.source.fetched_at = "2026-09-04T00:00:00Z";
  listDoc.source.payload_hash = "lists-with-values";
  await lib.savePersonOnConnection(db, listDoc, { mode: "live" });
  assert.ok((await read()).education_schools.length);
  assert.ok((await read()).top_skills.length);
  const clear = {
    ...listDoc,
    source: {
      ...listDoc.source,
      source: "harvest",
      fetched_at: "2026-09-05T00:00:00Z",
      payload_hash: "explicit-empty-lists",
    },
    jobs: [],
    educations: [],
    skills: [],
    header: {},
    contacts: [],
  };
  await lib.savePersonOnConnection(db, clear, { mode: "live" });
  assert.deepEqual((await read()).work_experience, []);
  assert.deepEqual((await read()).education_schools, []);
  assert.deepEqual((await read()).top_skills, []);
  console.log(
    "PASS explicit empty owned lists clear while omitted lists are preserved",
  );
  const raw = new pg.Client({ connectionString: url });
  await raw.connect();
  try {
    await raw.query("begin");
    await raw.query("select save_person($1::jsonb)", [
      {
        ...clear,
        source: { ...clear.source, payload_hash: "concurrent-shadow" },
        header: { ...doc.header, current_title: "Staff Engineer" },
      },
    ]);
    const waiting = lib.savePersonOnConnection(db, doc, { mode: "live" });
    await raw.query("select pg_sleep(0.1)");
    await raw.query("commit");
    await waiting;
  } finally {
    await raw.end();
  }
  assert.equal((await read()).current_title, "Staff Engineer");
  console.log("PASS raw shadow writer and atomic live writer share lock order");
  const driftPublication = await lib.savePersonOnConnection(db, incoming, {
    mode: "live",
  });
  assert.equal(driftPublication.projected, true);
  const driftRevision = driftPublication.revision;
  await db.query(
    "update candidates set current_title='Concurrent Recruiter Edit' where id=$1",
    [id],
  );
  assert.equal(
    (await lib.undoPersonProjectionOnConnection(db, id, driftRevision)).status,
    "conflict",
  );
  assert.equal((await read()).current_title, "Concurrent Recruiter Edit");
  console.log(
    "PASS undo refuses changed live rows even at the same normalized revision",
  );
  await assert.rejects(
    lib.savePersonOnConnection(db, doc, { mode: "live" }),
    /audit_unattributed_change/,
  );
  assert.equal((await read()).current_title, "Concurrent Recruiter Edit");
  console.log(
    "PASS projection refuses an uncaptured legacy edit instead of overwriting it",
  );
} finally {
  await db.end();
}
