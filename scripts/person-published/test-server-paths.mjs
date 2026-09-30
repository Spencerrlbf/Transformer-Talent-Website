// Actual helpers; all REST calls are sealed synthetic responses. PG is local.
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
for (const k of ["OPENAI_API_KEY", "HARVEST_API_KEY", "RESEND_API_KEY"])
  delete process.env[k];
const db = new pg.Pool({ connectionString: url });
after(() => db.end());
const id = (n) => `d3000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let recipient = false;
let sent = null,
  client = false,
  calls = 0,
  staleReads = 0;
const old = {
  about: "Stale raw summary",
  experience: [{ position: "Stale Role", companyName: "Old Employer" }],
  skills: [{ name: "Old Skill" }],
};
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.origin !== "http://127.0.0.1:1") throw Error("external_forbidden");
  calls++;
  const table = u.pathname.split("/").at(-1),
    method = init.method ?? "GET";
  if (recipient && table === "website_applications" && method === "GET") {
    assert.equal(u.searchParams.get("organization_id"), `eq.${id(9999)}`);
    return Response.json([
      {
        ...sent,
        id: id(9998),
        created_at: "2026-09-26",
        resume_path: null,
        matched_role_ids: [],
      },
    ]);
  }
  if (recipient && table === "sourced_candidates" && method === "GET") {
    assert.equal(u.searchParams.get("organization_id"), `eq.${id(9999)}`);
    return Response.json([
      {
        id: id(9997),
        profile: old,
        contact: { email: "stale-source@example.test", phone: "+12025550188" },
        linkedin_username: "published-1",
      },
    ]);
  }

  if (table === "candidates" && method === "GET") {
    if (u.searchParams.get("id")?.startsWith("in."))
      return Response.json([
        {
          id: id(1),
          current_title: "Stale REST title",
          email: "stale-rest@example.test",
        },
      ]);
    return Response.json(
      (
        await db.query("select * from candidates where id=$1", [
          u.searchParams.get("id")?.slice(3),
        ])
      ).rows,
    );
  }
  if (table === "network_people_by_fit")
    return Response.json([
      {
        candidate_id: id(1),
        latest_match_at: "2026-09-01",
        matches: [],
        total_people: 1,
        total_matches: 0,
        new_since_yesterday: 0,
      },
    ]);
  if (table === "network_roles_by_fit") return Response.json([]);
  if (table === "candidate_enrichments") {
    staleReads++;
    return Response.json([{ raw_payload: old, created_at: "2099-01-01" }]);
  }
  if (table === "org_roles")
    return Response.json([
      {
        id: id(9000),
        external_id: "123",
        title: "Synthetic Role",
        linked_org_role: client ? { orgId: id(9999), jobId: "456" } : null,
      },
    ]);
  if (table === "match_verdicts" && client)
    return Response.json([
      {
        verdict: {
          v2: {
            label: "contact",
            paragraph: "private explanation",
            card: {
              rows: [
                {
                  kind: "tech",
                  tier: "required",
                  label: "TypeScript",
                  status: "yes",
                  evidence: "private quote",
                },
              ],
            },
          },
          private: "private evidence",
        },
      },
    ]);
  if (table === "website_applications" && method === "POST") {
    sent = JSON.parse(init.body);
    return Response.json([{ id: id(9998) }]);
  }
  if (
    method === "GET" &&
    [
      "candidate_emails",
      "candidate_emails_v2",
      "website_applications",
      "match_verdicts",
      "no_reply_marks",
      "candidate_no_reply_marks",
      "candidate_list_members",
      "candidate_lists",
      "org_member_job_permissions",
      "org_members",
    ].includes(table)
  )
    return Response.json([]);
  if (recipient && method === "GET") return Response.json([]);
  throw Error(`unexpected:${table}:${method}`);
};
const lib = await import("../dist/worker-lib.mjs");
test("actual published drawer ignores newer ledger reuse and shows canonical history", async () => {
  const before = staleReads;
  const r = await lib.unifiedCandidateDetail(lib.TT_ORG_ID, `net_${id(1)}`);
  assert.equal(r.experience[0].roles[0].title, "Canonical Role");
  assert.equal(r.about, "Canonical summary");
  assert.deepEqual(r.skills, ["TypeScript"]);
  assert.equal(staleReads, before);
});
test("actual Send carries the same canonical compatible profile and eligible contact", async () => {
  const before = staleReads;
  const r = await lib.sendNetworkCandidate(lib.TT_ORG_ID, id(1), "123");
  assert.equal(r.ok, true);
  assert.equal(sent.harvest_profile.experience[0].position, "Canonical Role");
  assert.equal(sent.harvest_profile.about, "Canonical summary");
  assert.equal(sent.contact.email, "visible-1@example.test");
  assert.equal(staleReads, before);
});
test("published stale revision cannot silently return legacy or send a payload", async () => {
  sent = null;
  await assert.rejects(
    lib.unifiedCandidateDetail(lib.TT_ORG_ID, `net_${id(3)}`),
    /person_profile_unavailable/,
  );
  await assert.rejects(
    lib.sendNetworkCandidate(lib.TT_ORG_ID, id(3), "123"),
    /person_profile_unavailable/,
  );
  assert.equal(sent, null);
});
test("unpublished profiles retain legacy raw behavior", async () => {
  const r = await lib.unifiedCandidateDetail(lib.TT_ORG_ID, `net_${id(2)}`);
  assert.equal(r.experience[0].roles[0].title, "Stale Role");
  await lib.sendNetworkCandidate(lib.TT_ORG_ID, id(2), "123");
  assert.equal(sent.harvest_profile.about, "Stale raw summary");
});
test("legacy mode uses old views without requiring normalized reads", async () => {
  process.env.PERSON_WRITE_MODE = "legacy";
  try {
    const r = await lib.unifiedCandidateDetail(lib.TT_ORG_ID, `net_${id(1)}`);
    assert.equal(r.experience[0].roles[0].title, "Stale Role");
  } finally {
    process.env.PERSON_WRITE_MODE = "live";
  }
});
test("pool helper boundaries reject other organizations before reading data", async () => {
  const before = calls;
  assert.equal(
    await lib.unifiedCandidateDetail(id(9999), `net_${id(1)}`),
    null,
  );
  assert.equal(
    (await lib.sendNetworkCandidate(id(9999), id(1), "123")).ok,
    false,
  );
  assert.equal(calls, before);
});
test("Network cards use the same published profile snapshot as their contacts", async () => {
  const r = await lib.listNetworkMatches(lib.TT_ORG_ID);
  assert.equal(r.people[0].currentTitle, "Canonical Role");
  assert.equal(r.people[0].email, "visible-1@example.test");
});

test("cross-organization Send snapshots retain only client-safe verdict information", async () => {
  client = true;
  try {
    const r = await lib.sendNetworkCandidate(lib.TT_ORG_ID, id(1), "123");
    assert.equal(r.ok, true);
    assert.equal(sent.organization_id, id(9999));
    assert.deepEqual(sent.role_ids, ["456"]);
    assert.equal(sent.harvest_profile.experience[0].position, "Canonical Role");
    assert.equal(sent.screening[0].scorecard.tier, "STRONG");
    assert.equal(JSON.stringify(sent.screening).includes("private"), false);
    assert.equal(Object.hasOwn(sent, "resume_text"), false);
  } finally {
    client = false;
  }
});
test("exact public contact error codes survive the pooled boundary", async () => {
  await db.query(
    "update candidate_contacts set status='bounced',rank=null where candidate_id=$1 and kind='email'",
    [id(6)],
  );
  const r = await lib.saveUnifiedContact(
    lib.TT_ORG_ID,
    `net_${id(6)}`,
    { email: "visible-6@example.test" },
    { actorId: id(8000), requestId: id(8001) },
  );
  assert.equal(r.error, "email_unusable");
});

test("recipient drawer displays the sent canonical snapshot even if an older sourced profile exists", async () => {
  client = true;
  try {
    await lib.sendNetworkCandidate(lib.TT_ORG_ID, id(1), "123");
    recipient = true;
    const r = await lib.unifiedCandidateDetail(id(9999), `app_${id(9998)}`);
    assert.equal(r.about, "Canonical summary");
    assert.equal(r.experience[0].roles[0].title, "Canonical Role");
    assert.deepEqual(r.skills, ["TypeScript"]);
  } finally {
    client = false;
    recipient = false;
  }
});

test("recipient drawer cannot resurrect an ineligible email or phone from its sourced copy", async () => {
  client = true;
  try {
    await lib.sendNetworkCandidate(lib.TT_ORG_ID, id(8), "123");
    recipient = true;
    const r = await lib.unifiedCandidateDetail(id(9999), `app_${id(9998)}`);
    assert.equal(r.contact.email, null);
    assert.equal(r.contact.phone, null);
  } finally {
    client = false;
    recipient = false;
  }
});
test("all pool service entry points reject a non-TT caller without any reads", async () => {
  const before = calls;
  await assert.rejects(lib.listNetworkMatches(id(9999)), /person_pool_tenant/);
  assert.equal(calls, before);
});
test("actual drawer and Send retain explicitly empty published lists", async () => {
  const r = await lib.unifiedCandidateDetail(lib.TT_ORG_ID, `net_${id(7)}`);
  assert.deepEqual(r.experience, []);
  assert.deepEqual(r.education, []);
  assert.deepEqual(r.skills, []);
  await lib.sendNetworkCandidate(lib.TT_ORG_ID, id(7), "123");
  assert.deepEqual(sent.harvest_profile.experience, []);
  assert.deepEqual(sent.harvest_profile.skills, []);
});
test("unmarked legacy sent applications retain existing sourced-profile precedence", async () => {
  client = true;
  try {
    await lib.sendNetworkCandidate(lib.TT_ORG_ID, id(1), "123");
    sent.harvest_profile = {
      about: "Legacy sent summary",
      experience: [],
      skills: [],
    };
    recipient = true;
    const r = await lib.unifiedCandidateDetail(id(9999), `app_${id(9998)}`);
    assert.equal(r.about, "Stale raw summary");
  } finally {
    client = false;
    recipient = false;
  }
});
