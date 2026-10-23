import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { rmSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
const url = process.env.LOCAL_DATABASE_URL;
if (
  !/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_recruiter_admission_test$/.test(
    url ?? "",
  )
)
  throw Error("local_fixture_required");
Object.assign(process.env, {
  PERSON_DATABASE_URL: url,
  PERSON_TRANSITION_SUPPORT: "on",
  PERSON_WRITE_MODE: "live",
  SUPABASE_URL: "http://127.0.0.1:1",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic",
});
const pool = new pg.Pool({ connectionString: url });
let requests = [];
const authUser = randomUUID();
let authOrg = {
  id: "801865a7-6533-41d2-9c45-e4a90e6ad51a",
  slug: "transformer-talent",
  name: "Synthetic TT",
};
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  assert.equal(u.origin, "http://127.0.0.1:1");
  requests.push({ u, init });
  if (u.pathname === "/auth/v1/user") return Response.json({ id: authUser });
  if (u.pathname.endsWith("/org_members"))
    return Response.json([{ member_role: "owner", organizations: authOrg }]);
  if (
    init.method === "PATCH" &&
    /\/(website_applications|sourced_candidates)$/.test(u.pathname)
  )
    return Response.json([{ contact: JSON.parse(init.body).contact }]);
  if (u.pathname.endsWith("/rpc/person_transition_status"))
    return Response.json({ enabled: true, phase: "open" });
  throw Error("unexpected_rest");
};
const lib = await import("../dist/worker-lib.mjs");
const { prepareAuditFixture } = await import(
  "../person-audit/local-fixture.mjs"
);
async function fixture() {
  await pool.query(
    "update person_private.transition_control set enabled=false,phase='open'",
  );
  const id = randomUUID();
  await pool.query(
    "insert into candidates(id,full_name,linkedin_username,created_at) values($1,'Synthetic Endpoint',$2,'2020-01-01')",
    [id, "endpoint-" + id],
  );
  await prepareAuditFixture(id);
  await pool.query("update person_private.transition_control set enabled=true");
  return id;
}
test.after(() => pool.end());
test("actual unified endpoint helper saves certified TT contact without REST pool mutation", async () => {
  const id = await fixture();
  const out = await lib.saveUnifiedContact(
    lib.TT_ORG_ID,
    "net_" + id,
    { email: "endpoint@example.test" },
    { actorId: randomUUID(), requestId: randomUUID() },
  );
  assert.equal(out.contact?.email, "endpoint@example.test");
  assert.equal(requests.length, 0);
});
test("actual helper maps held and draining to temporary unavailable", async () => {
  for (const phase of ["held", "draining"]) {
    const id = await fixture();
    await pool.query("update person_private.transition_control set phase=$1", [
      phase,
    ]);
    assert.deepEqual(
      await lib.saveUnifiedContact(
        lib.TT_ORG_ID,
        "net_" + id,
        { email: "held@example.test" },
        { actorId: randomUUID(), requestId: randomUUID() },
      ),
      { error: "temporarily_unavailable" },
    );
  }
});
test("support-on TT legacy mode refuses before any raw REST mutation", async () => {
  process.env.PERSON_WRITE_MODE = "legacy";
  const n = requests.length;
  assert.deepEqual(
    await lib.saveUnifiedContact(
      lib.TT_ORG_ID,
      "net_" + randomUUID(),
      { email: "legacy@example.test" },
      { actorId: randomUUID(), requestId: randomUUID() },
    ),
    { error: "temporarily_unavailable" },
  );
  assert.equal(requests.length, n);
  process.env.PERSON_WRITE_MODE = "live";
});
test("foreign tenant cannot use pool while tenant app and source writes stay scoped", async () => {
  const org = randomUUID();
  assert.deepEqual(
    await lib.saveUnifiedContact(org, "net_" + randomUUID(), {
      email: "tenant@example.test",
    }),
    { error: "not_found" },
  );
  for (const prefix of ["app_", "src_"]) {
    const out = await lib.saveUnifiedContact(org, prefix + randomUUID(), {
      email: "tenant@example.test",
    });
    assert.equal(out.contact.email, "tenant@example.test");
    assert.equal(
      requests.at(-1).u.searchParams.get("organization_id"),
      "eq." + org,
    );
  }
});

test("actual authenticated PUT route returns 200, held503, replay200 and foreign404", async () => {
  const output = path.resolve("scripts/dist/recruiter-route-test.cjs");
  execFileSync("npx", [
    "--yes",
    "esbuild@0.28.2",
    "app/api/dashboard/candidates/v2/[key]/contact/route.ts",
    "--bundle",
    "--platform=node",
    "--external:pg",
    "--external:next/server",
    "--format=cjs",
    "--alias:@=" + process.cwd(),
    "--outfile=" + output,
    "--log-level=warning",
  ]);
  try {
    const { PUT } = createRequire(import.meta.url)(output);
    const id = await fixture(),
      requestId = randomUUID();
    const call = (rid = requestId) =>
      PUT(
        new Request("http://127.0.0.1/contact", {
          method: "PUT",
          headers: {
            authorization: "Bearer synthetic",
            "content-type": "application/json",
            "idempotency-key": rid,
          },
          body: JSON.stringify({ email: "http@example.test" }),
        }),
        { params: Promise.resolve({ key: "net_" + id }) },
      );
    let r = await call();
    assert.equal(r.status, 200);
    assert.equal((await r.json()).contact.email, "http@example.test");
    await pool.query(
      "update person_private.transition_control set phase='held'",
    );
    r = await call(randomUUID());
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: "temporarily_unavailable" });
    assert.equal((await call()).status, 200);
    authOrg = {
      id: randomUUID(),
      slug: "synthetic-tenant",
      name: "Synthetic tenant",
    };
    assert.equal((await call()).status, 404);
  } finally {
    rmSync(output, { force: true });
  }
});
