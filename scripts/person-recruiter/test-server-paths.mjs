// Actual server helpers with local PostgreSQL and a sealed REST fixture.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import pg from "pg";
const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw Error("local database required");
Object.assign(process.env, {
  PERSON_DATABASE_URL: url,
  PERSON_WRITE_MODE: "live",
  SUPABASE_URL: "http://127.0.0.1:1",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic",
});
for (const key of ["OPENAI_API_KEY", "HARVEST_API_KEY", "RESEND_API_KEY"])
  delete process.env[key];
const db = new pg.Pool({ connectionString: url });
after(() => db.end());
const calls = [];
let extended = false,
  sent = null;
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.origin !== "http://127.0.0.1:1") throw Error("external_forbidden");
  const table = u.pathname.split("/").at(-1),
    method = init.method ?? "GET";
  calls.push({ table, method, url: u });
  if (extended) {
    if (table === "candidates" && method === "GET")
      return Response.json(
        (
          await db.query("select * from candidates where id=$1", [
            "d2000000-0000-4000-8000-000000000006",
          ])
        ).rows,
      );
    if (table === "network_people_by_fit")
      return Response.json([
        {
          candidate_id: "d2000000-0000-4000-8000-000000000006",
          latest_match_at: "2026-09-01",
          matches: [],
          total_people: 1,
          total_matches: 0,
          new_since_yesterday: 0,
        },
      ]);
    if (table === "network_roles_by_fit") return Response.json([]);
    if (table === "org_roles")
      return Response.json([
        {
          id: "d2000000-0000-4000-8000-000000009001",
          external_id: "123",
          title: "Synthetic Role",
          linked_org_role: null,
        },
      ]);
    if (table === "website_applications" && method === "POST") {
      sent = JSON.parse(init.body);
      return Response.json([{ id: "d2000000-0000-4000-8000-000000009999" }]);
    }
    if (
      method === "GET" &&
      [
        "website_applications",
        "candidate_enrichments",
        "match_verdicts",
        "no_reply_marks",
        "candidate_no_reply_marks",
        "candidate_list_members",
        "candidate_lists",
        "org_member_job_permissions",
        "org_members",
        "candidate_role_statuses",
      ].includes(table)
    )
      return Response.json([]);
  }
  if (["candidate_emails", "candidate_emails_v2"].includes(table))
    return Response.json([]);
  if (
    ["sourced_candidates", "website_applications", "candidates"].includes(
      table,
    ) &&
    method === "PATCH"
  )
    return Response.json([{ contact: JSON.parse(init.body).contact }]);
  throw Error(`unexpected:${table}:${method}`);
};
const lib = await import("../dist/worker-lib.mjs");
const id = (n) => `d2000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
test("live pool resolver ignores unsafe legacy override for a published person", async () => {
  const before = calls.length;
  const map = await lib.poolEmails(
    [id(9)],
    new Map([[id(9), "unsafe-overlay@example.test"]]),
  );
  assert.deepEqual(map.get(id(9)), [
    { email: "old-10@example.test", verified: false },
  ]);
  assert.equal(calls.length, before);
});
test("unpublished person retains the legacy resolver while live is enabled", async () => {
  const map = await lib.poolEmails(
    [id(8)],
    new Map([[id(8), "legacy-visible@example.test"]]),
  );
  assert.equal(map.get(id(8))[0].email, "legacy-visible@example.test");
  assert.equal(calls.at(-1).method, "GET");
});
test("actual unified contact save uses normalized service and returns effective contacts", async () => {
  const r = await lib.saveUnifiedContact(
    lib.TT_ORG_ID,
    `net_${id(6)}`,
    { email: "new-server@example.test", phone: "2025550166", otherEmails: [] },
    { actorId: id(9000), requestId: id(1020) },
  );
  assert.equal(r.contact.email, "new-server@example.test");
  assert.equal(r.contact.phone, "+12025550166");
  assert.equal(
    calls.some((x) => x.table === "candidates" && x.method === "PATCH"),
    false,
  );
});
test("tenant helpers keep app/src scoped writes and cannot call the pool service", async () => {
  const org = id(999);
  const before = calls.length;
  assert.equal(
    (
      await lib.saveUnifiedContact(org, `net_${id(6)}`, {
        email: "foreign@example.test",
      })
    ).error,
    "not_found",
  );
  assert.equal(calls.length, before);
  for (const key of [`app_${id(99)}`, `src_${id(99)}`]) {
    const r = await lib.saveUnifiedContact(org, key, {
      email: "tenant@example.test",
    });
    assert.equal(r.contact.email, "tenant@example.test");
    assert.equal(
      calls.at(-1).url.searchParams.get("organization_id"),
      `eq.${org}`,
    );
  }
});
test("shadow pool reads keep legacy behavior and do not open new normalized reads", async () => {
  process.env.PERSON_WRITE_MODE = "shadow";
  const r = await lib.poolEmails(
    [id(9)],
    new Map([[id(9), "shadow-overlay@example.test"]]),
  );
  assert.equal(r.get(id(9))[0].email, "shadow-overlay@example.test");
  process.env.PERSON_WRITE_MODE = "live";
});

test("actual drawer, Network and Send snapshots share normalized eligible email and phone", async () => {
  extended = true;
  await db.query(
    "update candidate_contacts set status='bounced',rank=null where candidate_id=$1 and kind='phone'",
    [id(6)],
  );
  await db.query(
    "update candidates set contact=jsonb_set(contact,'{email}','\"unsafe-overlay@example.test\"'::jsonb) where id=$1",
    [id(6)],
  );
  const network = await lib.listNetworkMatches(lib.TT_ORG_ID);
  assert.equal(network.people[0].email, "new-server@example.test");
  assert.equal(network.people[0].phone, null);
  const detail = await lib.unifiedCandidateDetail(
    lib.TT_ORG_ID,
    `net_${id(6)}`,
  );
  assert.equal(detail.contact.email, "new-server@example.test");
  assert.equal(detail.contact.phone, null);
  assert.deepEqual(detail.contact.otherEmails, []);
  const result = await lib.sendNetworkCandidate(lib.TT_ORG_ID, id(6), "123");
  assert.equal(result.ok, true);
  assert.equal(sent.contact.email, "new-server@example.test");
  assert.equal(sent.contact.phone, null);
});
