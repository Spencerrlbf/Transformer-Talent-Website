import assert from "node:assert/strict";
import { test, after } from "node:test";
import pg from "pg";
import * as lib from "../dist/worker-lib.mjs";
const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw Error("Local database required");
const db = new pg.Pool({ connectionString: url, max: 4 });
const org = "801865a7-6533-41d2-9c45-e4a90e6ad51a";
const uuid = (n) => `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const withClient = async (fn) => {
  const c = await db.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
};
const input = (n, username = "synthetic-intake") => ({
  organizationId: org,
  applicationId: uuid(n),
  linkedinUsername: username,
  name: "Synthetic Intake",
  parsed: {
    current_title: "Engineer",
    current_company: "Synthetic Co",
    top_skills: ["Rust"],
    profile_summary: "Synthetic summary",
    phone: "+1 202 555 0101",
  },
  resumeText: "Synthetic resume",
  harvest: null,
  mode: "live",
});
async function application(
  n,
  username = "synthetic-intake",
  organization = org,
) {
  await db.query(
    `insert into website_applications(id,organization_id,name,email,linkedin_username,linkedin_url,created_at) values($1,$2,'Synthetic Intake',$3,$4,$5,'2026-09-26T01:00:00Z')`,
    [
      uuid(n),
      organization,
      `synthetic-${n}@example.com`,
      username,
      `https://www.linkedin.com/in/${username}`,
    ],
  );
}
after(() => db.end());
await test("intake writer is available and flags default to legacy", () => {
  assert.equal(typeof lib.saveApplicationPersonOnConnection, "function");
  assert.equal(lib.personWriteMode({}), "legacy");
  assert.equal(lib.personWriteMode({ PERSON_WRITE_MODE: "shadow" }), "shadow");
  assert.throws(() => lib.personWriteMode({ PERSON_WRITE_MODE: "typo" }));
});
if (typeof lib.saveApplicationPersonOnConnection !== "function")
  throw Error("intake_missing");
await test("two TT applications resolve atomically to one LinkedIn person, preserving claims", async () => {
  await application(1);
  await application(2);
  const results = await Promise.all(
    [1, 2].map((n) =>
      withClient((c) => lib.saveApplicationPersonOnConnection(c, input(n))),
    ),
  );
  assert.equal(results[0].candidateId, results[1].candidateId);
  assert.equal(results.filter((r) => r.created).length, 1);
  const id = results[0].candidateId;
  const candidate = (
    await db.query("select * from candidates where id=$1", [id])
  ).rows[0];
  assert.equal(candidate.current_title, "Engineer");
  assert.deepEqual(candidate.top_skills, ["Rust"]);
  assert.equal(candidate.resume_text, "Synthetic resume");
  const contacts = (
    await db.query(
      "select status,rank,value_normalized from candidate_contacts where candidate_id=$1 and kind='email' order by value_normalized",
      [id],
    )
  ).rows;
  assert.equal(contacts.length, 2);
  assert.equal(
    contacts.filter((c) => c.status === "claimed" && c.rank === null).length,
    1,
  );
  assert.equal(
    contacts.filter((c) => c.status === "active" && c.rank === 1).length,
    1,
  );
  assert.equal(
    (
      await db.query(
        "select count(distinct candidate_id)::int n from website_applications where id=any($1)",
        [[uuid(1), uuid(2)]],
      )
    ).rows[0].n,
    1,
  );
});
await test("a replay uses the original creation decision, parsed data and date", async () => {
  const before = (
    await db.query(
      "select to_jsonb(c) r from candidates c where linkedin_username=$1",
      ["synthetic-intake"],
    )
  ).rows[0].r;
  const result = await withClient((c) =>
    lib.saveApplicationPersonOnConnection(c, {
      ...input(1),
      name: "Untrusted later name",
      parsed: { current_title: "Do not reparse" },
    }),
  );
  const after = (
    await db.query("select to_jsonb(c) r from candidates c where id=$1", [
      result.candidateId,
    ])
  ).rows[0].r;
  assert.deepEqual(after, before);
  const source = (
    await db.query(
      "select fetched_at from candidate_sources where candidate_id=$1 and source='application' order by created_at limit 1",
      [result.candidateId],
    )
  ).rows[0];
  assert.equal(source.fetched_at.toISOString(), "2026-09-26T01:00:00.000Z");
});
await test("tenant and mismatched application organizations cannot enter the pool", async () => {
  await application(3, "synthetic-client", uuid(999));
  await assert.rejects(
    withClient((c) =>
      lib.saveApplicationPersonOnConnection(c, {
        ...input(3, "synthetic-client"),
        organizationId: uuid(999),
      }),
    ),
    /tenant/,
  );
  await assert.rejects(
    withClient((c) =>
      lib.saveApplicationPersonOnConnection(c, input(3, "synthetic-client")),
    ),
    /application/,
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from candidates where linkedin_username='synthetic-client'",
      )
    ).rows[0].n,
    0,
  );
});
await test("candidate and normalized writes roll back together while the application survives", async () => {
  await application(4, "synthetic-failure");
  await db.query(
    `create function public.fail_intake() returns trigger language plpgsql as $$begin if new.linkedin_username='synthetic-failure' and new.current_title is not null then raise exception 'synthetic failure';end if;return new;end$$; create trigger fail_intake before update on candidates for each row execute function public.fail_intake()`,
  );
  await assert.rejects(
    withClient((c) =>
      lib.saveApplicationPersonOnConnection(c, input(4, "synthetic-failure")),
    ),
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from candidates where linkedin_username='synthetic-failure'",
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await db.query(
        "select candidate_id from website_applications where id=$1",
        [uuid(4)],
      )
    ).rows[0].candidate_id,
    null,
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from person_application_receipts where application_id=$1",
        [uuid(4)],
      )
    ).rows[0].n,
    0,
  );
  await db.query(
    "drop trigger fail_intake on candidates;drop function public.fail_intake()",
  );
  const retried = await withClient((c) =>
    lib.saveApplicationPersonOnConnection(c, input(4, "synthetic-failure")),
  );
  assert.ok(retried.candidateId);
});
await test("a shared claimed email never merges two LinkedIn people", async () => {
  await application(5, "synthetic-distinct");
  await db.query(
    "update website_applications set email=(select email from candidates where linkedin_username=$2) where id=$1",
    [uuid(5), "synthetic-intake"],
  );
  const result = await withClient((c) =>
    lib.saveApplicationPersonOnConnection(c, input(5, "synthetic-distinct")),
  );
  const old = (
    await db.query(
      "select id from candidates where linkedin_username='synthetic-intake'",
    )
  ).rows[0];
  assert.notEqual(result.candidateId, old.id);
  assert.equal(
    (
      await db.query("select email from candidates where id=$1", [
        result.candidateId,
      ])
    ).rows[0].email,
    null,
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from candidate_contacts where candidate_id=$1 and kind='email'",
        [result.candidateId],
      )
    ).rows[0].n,
    1,
  );
});
await test("an existing person keeps incumbent name and contacts", async () => {
  await application(6, "synthetic-incumbent");
  const id = uuid(106);
  await db.query(
    "insert into candidates(id,full_name,linkedin_username,email,current_title,created_at) values($1,'Incumbent Name','synthetic-incumbent','synthetic-incumbent@example.com','Staff Engineer','2025-01-01')",
    [id],
  );
  await withClient((c) =>
    lib.savePersonOnConnection(
      c,
      lib.fromLegacyImport({
        id,
        full_name: "Incumbent Name",
        linkedin_username: "synthetic-incumbent",
        email: "synthetic-incumbent@example.com",
        current_title: "Staff Engineer",
        created_at: "2025-01-01",
      }),
      { mode: "shadow" },
    ),
  );
  await withClient((c) =>
    lib.saveApplicationPersonOnConnection(c, input(6, "synthetic-incumbent")),
  );
  const row = (await db.query("select * from candidates where id=$1", [id]))
    .rows[0];
  assert.equal(row.full_name, "Incumbent Name");
  assert.equal(row.email, "synthetic-incumbent@example.com");
  assert.equal(row.current_title, "Staff Engineer");
});
await test("shadow intake gives a new person a usable profile and leaves an incumbent profile unchanged", async () => {
  await application(7, "synthetic-shadow");
  const result = await withClient((c) =>
    lib.saveApplicationPersonOnConnection(c, {
      ...input(7, "synthetic-shadow"),
      mode: "shadow",
    }),
  );
  const before = (
    await db.query("select to_jsonb(c) r from candidates c where id=$1", [
      result.candidateId,
    ])
  ).rows[0].r;
  assert.equal(before.current_title, "Engineer");
  assert.ok(before.email);
  await application(8, "synthetic-shadow");
  await withClient((c) =>
    lib.saveApplicationPersonOnConnection(c, {
      ...input(8, "synthetic-shadow"),
      mode: "shadow",
    }),
  );
  assert.deepEqual(
    (
      await db.query("select to_jsonb(c) r from candidates c where id=$1", [
        result.candidateId,
      ])
    ).rows[0].r,
    before,
  );
});
await test("a cached Harvest source keeps its original date and does not replace a newer owner", async () => {
  await application(9, "synthetic-incumbent");
  const id = uuid(106),
    ledgerId = uuid(209);
  await db.query(
    "insert into candidate_enrichments(id,organization_id,candidate_id,linkedin_username,created_at,raw_payload) values($1,$2,$3,'synthetic-incumbent','2020-01-01T00:00:00Z',$4)",
    [
      ledgerId,
      org,
      id,
      {
        firstName: "Synthetic",
        headline: "Old headline",
        experience: [
          {
            position: "Old Engineer",
            companyName: "Old Co",
            startDate: { year: 2018 },
          },
        ],
      },
    ],
  );
  await withClient((c) =>
    lib.saveApplicationPersonOnConnection(c, {
      ...input(9, "synthetic-incumbent"),
      harvestLedgerId: ledgerId,
    }),
  );
  const source = (
    await db.query(
      "select fetched_at from candidate_sources where enrichment_id=$1",
      [ledgerId],
    )
  ).rows[0];
  assert.equal(source.fetched_at.toISOString(), "2020-01-01T00:00:00.000Z");
  assert.equal(
    (await db.query("select current_title from candidates where id=$1", [id]))
      .rows[0].current_title,
    "Staff Engineer",
  );
});
await test("resume contact evidence and school names are stored without guessing unpaired degrees", async () => {
  await application(10, "synthetic-resume");
  const result = await withClient((c) =>
    lib.saveApplicationPersonOnConnection(c, {
      ...input(10, "synthetic-resume"),
      resumeContacts: {
        phone: "+1 202 555 0198",
        emails: ["synthetic-resume-extra@example.com"],
      },
      parsed: {
        education_schools: ["Synthetic School One", "Synthetic School Two"],
        education_degrees: ["BS"],
        education_fields: ["CS"],
        total_experience_years: 7,
      },
    }),
  );
  const ed = (
    await db.query(
      "select degree,field_of_study from candidate_educations where candidate_id=$1",
      [result.candidateId],
    )
  ).rows;
  assert.equal(ed.length, 2);
  assert.ok(ed.every((e) => e.degree === null && e.field_of_study === null));
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from candidate_contacts where candidate_id=$1 and value_normalized='synthetic-resume-extra@example.com'",
        [result.candidateId],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await db.query(
        "select total_experience_years from candidates where id=$1",
        [result.candidateId],
      )
    ).rows[0].total_experience_years,
    7,
  );
  const snap = (
    await db.query(
      "select application_snapshot from person_application_receipts where application_id=$1",
      [uuid(10)],
    )
  ).rows[0].application_snapshot;
  assert.deepEqual(snap.parsed_profile.education_degrees, ["BS"]);
});
await test("receipt evidence is private", async () => {
  const row = (
    await db.query(
      "select has_table_privilege('anon','person_application_receipts','select') a,has_table_privilege('authenticated','person_application_receipts','select') b",
    )
  ).rows[0];
  assert.equal(row.a, false);
  assert.equal(row.b, false);
});

await test("international LinkedIn usernames keep their exact decoded identity", async () => {
  await application(20, "josé-martínez");
  const result = await withClient((c) =>
    lib.saveApplicationPersonOnConnection(c, input(20, "josé-martínez")),
  );
  const row = (
    await db.query(
      "select linkedin_username,linkedin_url from candidates where id=$1",
      [result.candidateId],
    )
  ).rows[0];
  assert.equal(row.linkedin_username, "josé-martínez");
  assert.equal(
    row.linkedin_url,
    "https://www.linkedin.com/in/jos%C3%A9-mart%C3%ADnez",
  );
});
await test("receipt returns the winning resume and parse without filling a later mismatched vector", async () => {
  await application(21, "synthetic-canonical");
  const original = {
    ...input(21, "synthetic-canonical"),
    resumeText: "Original canonical resume",
  };
  const first = await withClient((c) =>
    lib.saveApplicationPersonOnConnection(c, original),
  );
  await db.query(
    "update website_applications set resume_text='Out of date extraction' where id=$1",
    [original.applicationId],
  );
  const replay = await withClient((c) =>
    lib.saveApplicationPersonOnConnection(c, {
      ...original,
      parsed: { profile_summary: "Losing parse" },
      resumeText: "Losing resume",
      matchingVector: Array(1536).fill(0.1),
    }),
  );
  assert.equal(replay.applicationSnapshot.resume_text, original.resumeText);
  assert.deepEqual(replay.applicationSnapshot.parsed_profile, original.parsed);
  assert.equal(
    (
      await db.query(
        "select resume_text from website_applications where id=$1",
        [original.applicationId],
      )
    ).rows[0].resume_text,
    original.resumeText,
  );
  assert.equal(
    (
      await db.query("select matching_embedding from candidates where id=$1", [
        first.candidateId,
      ])
    ).rows[0].matching_embedding,
    null,
  );
});
await test("a retained earlier parse never receives a vector from a failed replacement parse", async () => {
  await application(22, "synthetic-parse-fallback");
  await db.query(
    "update website_applications set parsed_profile=$2 where id=$1",
    [uuid(22), { profile_summary: "Retained parsed summary" }],
  );
  const result = await withClient((c) =>
    lib.saveApplicationPersonOnConnection(c, {
      ...input(22, "synthetic-parse-fallback"),
      parsed: null,
      matchingVector: Array(1536).fill(0.1),
    }),
  );
  assert.equal(
    result.applicationSnapshot.parsed_profile.profile_summary,
    "Retained parsed summary",
  );
  assert.equal(
    (
      await db.query("select matching_embedding from candidates where id=$1", [
        result.candidateId,
      ])
    ).rows[0].matching_embedding,
    null,
  );
});
