// Executes the actual shared pipeline with a synthetic local database and an
// in-process REST fixture. No HTTP request can leave this process.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import pg from "pg";
const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw Error("Local database required");
const db = new pg.Pool({ connectionString: url });
after(() => db.end());
const TT = "801865a7-6533-41d2-9c45-e4a90e6ad51a",
  CLIENT = "f0000000-0000-4000-8000-000000000099";
const uuid = (n) => `f0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const unexpected = [];
let failCache = false,
  denyBudget = false;
for (const key of [
  "OPENAI_API_KEY",
  "HARVEST_API_KEY",
  "AIRTABLE_API_TOKEN",
  "RESEND_API_KEY",
  "NOTION_TOKEN",
  "TYPESAFE_API_KEY",
  "LLAMA_CLOUD_API_KEY",
])
  delete process.env[key];
Object.assign(process.env, {
  SUPABASE_URL: "http://127.0.0.1:1",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-only",
  PERSON_DATABASE_URL: url,
  PERSON_WRITE_MODE: "live",
});
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input.url),
    table = u.pathname.split("/").at(-1),
    method = init.method ?? "GET";
  if (u.origin !== "http://127.0.0.1:1") {
    unexpected.push(`external:${u.hostname}`);
    throw Error("EXTERNAL_FORBIDDEN");
  }
  const body = init.body ? JSON.parse(init.body) : null;
  if (table === "organizations")
    return json([
      {
        id: u.searchParams.get("id")?.slice(3) ?? TT,
        slug: "transformer-talent",
        daily_review_limit: denyBudget ? 0 : 300,
      },
    ]);
  if (table === "rate_limit_events")
    return json([], 200, { "content-range": "0-0/0" });
  if (["org_members", "org_roles", "sourced_candidates"].includes(table))
    return json([]);
  if (
    ![
      "website_applications",
      "candidate_enrichments",
      "person_application_receipts",
      "candidates",
    ].includes(table)
  ) {
    unexpected.push(`${method}:${table}`);
    throw Error("UNEXPECTED_REST");
  }
  if (table === "candidate_enrichments" && method === "GET" && failCache)
    return json({ code: "FIXTURE" }, 503);
  const params = [],
    where = [];
  for (const [key, value] of u.searchParams) {
    if (["select", "order", "limit"].includes(key)) continue;
    assert.match(key, /^[a-z_]+$/);
    if (value.startsWith("eq.")) {
      params.push(value.slice(3));
      where.push(`${key}=$${params.length}`);
    } else if (value.startsWith("gte.")) {
      params.push(value.slice(4));
      where.push(`${key}>=$${params.length}`);
    } else if (value === "not.is.null") where.push(`${key} is not null`);
    else if (key === "or")
      where.push("(source is null or source<>'transformer_talent')");
    else throw Error("UNEXPECTED_FILTER");
  }
  const predicate = where.length ? " where " + where.join(" and ") : "";
  if (method === "GET") {
    const columns = u.searchParams.get("select") ?? "*";
    assert.match(columns, /^(\*|[a-z_,]+)$/);
    const order = u.searchParams.get("order");
    if (order) assert.match(order, /^[a-z_,.]+$/);
    const suffix = order
      ? " order by " +
        order
          .split(",")
          .map((s) => s.replace(".", " "))
          .join(",")
      : "";
    const limit = Number(u.searchParams.get("limit") ?? 1000);
    return json(
      (
        await db.query(
          `select ${columns} from ${table}${predicate}${suffix} limit ${limit}`,
          params,
        )
      ).rows,
    );
  }
  if (method === "PATCH") {
    assert.ok(where.length);
    const assignments = [];
    for (const [key, value] of Object.entries(body)) {
      assert.match(key, /^[a-z_]+$/);
      params.push(
        ["matched_role_ids", "role_ids"].includes(key)
          ? value
          : value && typeof value === "object"
            ? JSON.stringify(value)
            : value,
      );
      assignments.push(`${key}=$${params.length}`);
    }
    return json(
      (
        await db.query(
          `update ${table} set ${assignments.join(",")}${predicate} returning *`,
          params,
        )
      ).rows,
    );
  }
  if (method === "POST") {
    const keys = Object.keys(body);
    for (const key of keys) assert.match(key, /^[a-z_]+$/);
    const values = keys.map((key) =>
      body[key] && typeof body[key] === "object"
        ? JSON.stringify(body[key])
        : body[key],
    );
    return json(
      (
        await db.query(
          `insert into ${table}(${keys.join(",")}) values(${keys.map((_, i) => "$" + (i + 1)).join(",")}) returning *`,
          values,
        )
      ).rows,
      201,
    );
  }
  throw Error("UNEXPECTED_METHOD");
};
const { runApplicantPipeline } = await import("../dist/worker-lib.mjs");
async function setup(n, { org = TT, source = null } = {}) {
  const username = `synthetic-pipeline-${n}`,
    id = uuid(n);
  await db.query(
    "insert into website_applications(id,organization_id,name,email,linkedin_username,linkedin_url,source) values($1,$2,$3,$4,$5,$6,$7)",
    [
      id,
      org,
      "Synthetic Pipeline",
      `synthetic-pipeline-${n}@example.com`,
      username,
      `https://www.linkedin.com/in/${username}`,
      source,
    ],
  );
  if (org === TT)
    await db.query(
      "insert into candidate_enrichments(id,organization_id,linkedin_username,created_at,raw_payload) values($1,$2,$3,$4,$5)",
      [
        uuid(100 + n),
        org,
        username,
        new Date().toISOString(),
        {
          firstName: "Synthetic",
          lastName: "Pipeline",
          publicIdentifier: username,
          headline: "Engineer",
          experience: [
            {
              position: "Engineer",
              companyName: "Synthetic Co",
              startDate: { year: 2020 },
            },
          ],
        },
      ],
    );
  return {
    submissionId: id,
    name: "Synthetic Pipeline",
    email: `synthetic-pipeline-${n}@example.com`,
    linkedin: `https://www.linkedin.com/in/${username}`,
    visa: "",
    preferredLocations: [],
    roleIds: [],
    speculative: false,
    resumeBuf: null,
    resumeSafeName: "resume.pdf",
    resumePath: null,
    boardOrg:
      org === TT
        ? null
        : { id: org, slug: "synthetic-client", name: "Synthetic Client" },
    orgId: org,
    applicationType: "Applied",
  };
}
for (const [n, label, extra] of [
  [1, "job-board application", {}],
  [2, "referral", { applicationType: "Referral" }],
  [
    3,
    "future interest",
    {
      applicationType: "Speculative",
      speculative: true,
      followUpAt: "2027-01-01",
      preferredRoles: ["Engineer"],
    },
  ],
  [4, "queued retry", { fromQueue: true }],
]) {
  test(`${label} uses the same normalized TT writer without external calls`, async () => {
    const input = await setup(n);
    await runApplicantPipeline({ ...input, ...extra });
    const row = (
      await db.query("select * from website_applications where id=$1", [
        input.submissionId,
      ])
    ).rows[0];
    assert.equal(row.status, "processed");
    assert.ok(row.candidate_id);
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from candidate_profile_state where candidate_id=$1",
          [row.candidate_id],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from person_application_receipts where application_id=$1",
          [row.id],
        )
      ).rows[0].n,
      1,
    );
    if (extra.followUpAt)
      assert.equal(
        (
          await db.query(
            "select follow_up_at::text date from candidates where id=$1",
            [row.candidate_id],
          )
        ).rows[0].date,
        extra.followUpAt,
      );
    assert.deepEqual(unexpected, []);
  });
}
test("a tenant applicant remains in its organization and never creates a pool source", async () => {
  const input = await setup(5, { org: CLIENT });
  await runApplicantPipeline(input);
  const app = (
    await db.query("select * from website_applications where id=$1", [
      input.submissionId,
    ])
  ).rows[0];
  assert.equal(app.status, "processed");
  assert.equal(app.candidate_id, app.id);
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from candidates where linkedin_username=$1",
        [`synthetic-pipeline-5`],
      )
    ).rows[0].n,
    0,
  );
  assert.deepEqual(unexpected, []);
});
test("a cache failure queues the durable application; retry succeeds without a paid request", async () => {
  const input = await setup(6);
  failCache = true;
  const failed = await runApplicantPipeline(input);
  assert.equal(failed, "failed");
  failCache = false;
  assert.equal(
    (
      await db.query("select status from website_applications where id=$1", [
        input.submissionId,
      ])
    ).rows[0].status,
    "queued",
  );
  await runApplicantPipeline({ ...input, fromQueue: true });
  assert.equal(
    (
      await db.query("select status from website_applications where id=$1", [
        input.submissionId,
      ])
    ).rows[0].status,
    "processed",
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from candidate_enrichments where linkedin_username=$1",
        ["synthetic-pipeline-6"],
      )
    ).rows[0].n,
    1,
  );
  assert.deepEqual(unexpected, []);
});
test("an exhausted application review budget retains the submission without pool admission", async () => {
  const input = await setup(7);
  denyBudget = true;
  await runApplicantPipeline(input);
  denyBudget = false;
  const app = (
    await db.query("select * from website_applications where id=$1", [
      input.submissionId,
    ])
  ).rows[0];
  assert.equal(app.status, "queued");
  assert.equal(app.candidate_id, null);
  assert.deepEqual(unexpected, []);
});
