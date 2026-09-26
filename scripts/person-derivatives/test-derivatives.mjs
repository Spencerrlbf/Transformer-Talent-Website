import assert from "node:assert/strict";
import { test, after } from "node:test";
import pg from "pg";
import * as lib from "../dist/worker-lib.mjs";
import { runNormalizedRefresh } from "../person-refresh/worker.mjs";
const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw Error("local database required");
const db = new pg.Pool({ connectionString: url, max: 4 });
after(() => db.end());
test("gate timeout rolls back before returning a connection to its pool", async () => {
  const gate = await db.connect(),
    worker = await db.connect();
  try {
    await gate.query("begin");
    await gate.query("select pg_advisory_xact_lock(72005,0)");
    await assert.rejects(
      lib.preparePersonDerivativesOnConnection(worker, {
        organizationId: lib.TT_ORG_ID,
        candidateId: "d4000000-0000-4000-8000-000000000001",
      }),
      (e) => e.code === "55P03",
    );
    assert.equal((await worker.query("select 1 as n")).rows[0].n, 1);
  } finally {
    await gate.query("rollback");
    await worker.query("rollback");
    gate.release();
    worker.release();
  }
});
const id = (n) => `d4000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const use = async (fn) => {
  const c = await db.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
};
const scope = (n) => ({ organizationId: lib.TT_ORG_ID, candidateId: id(n) });
const enqueue = (n) =>
  use(async (c) => {
    await c.query("begin");
    try {
      await c.query("select pg_advisory_xact_lock_shared(72005,0)");
      await c.query("select pg_advisory_xact_lock(hashtext($1))", [id(n)]);
      await c.query("select id from candidates where id=$1 for update", [
        id(n),
      ]);
      const r = await lib.enqueuePersonDerivativesLocked(c, {
        ...scope(n),
        receiptRef: "test",
      });
      await c.query("commit");
      return r;
    } catch (e) {
      await c.query("rollback");
      throw e;
    }
  });
const prepare = (n) =>
  use((c) => lib.preparePersonDerivativesOnConnection(c, scope(n)));
const complete = (job, vectors) =>
  use((c) => lib.completePersonDerivativesOnConnection(c, { ...job, vectors }));
const fail = (job) => use((c) => lib.failPersonDerivativesOnConnection(c, job));
const vectors = (job) => job.missing.map(() => Array(1536).fill(0.1));
const job = (n) =>
  db
    .query("select * from person_derivative_jobs where candidate_id=$1", [
      id(n),
    ])
    .then((r) => r.rows[0]);
const chunks = (n) =>
  db
    .query(
      "select id,source_type,content,model from candidate_embeddings where candidate_id=$1 order by source_type,chunk_index",
      [id(n)],
    )
    .then((r) => r.rows);
async function fixture(n, resume = "Retained resume", extra = {}) {
  const row = {
    id: id(n),
    full_name: "Synthetic Derivative",
    linkedin_username: `derivative-${n}`,
    current_title: "Engineer",
    profile_summary: "Canonical summary",
    top_skills: ["Rust"],
    created_at: "2020-01-01",
    ...extra,
  };
  await db.query(
    "insert into candidates(id,full_name,linkedin_username,resume_text) values($1,$2,$3,$4)",
    [row.id, row.full_name, row.linkedin_username, resume],
  );
  await use((c) =>
    lib.savePersonOnConnection(c, lib.fromLegacyImport(row), { mode: "live" }),
  );
  await enqueue(n);
}
await test("canonical derivative interface exists", () =>
  assert.equal(typeof lib.preparePersonDerivativesOnConnection, "function"));
if (!lib.preparePersonDerivativesOnConnection)
  throw Error("derivative_interface_missing");
test("atomic full set, stable IDs and unchanged completion do not reopen work", async () => {
  await fixture(1);
  const a = await prepare(1);
  assert.equal(a.status, "claimed");
  assert.deepEqual(a.managed, ["linkedin_profile", "resume", "summary"]);
  assert.ok(a.missing.some((x) => x.content === "Retained resume"));
  assert.equal((await complete(a, vectors(a))).status, "done");
  const before = await chunks(1);
  assert.equal(before.length, 3);
  await enqueue(1);
  assert.equal((await prepare(1)).status, "done");
  assert.deepEqual(await chunks(1), before);
});
test("new resume without revision fences stale completion and stale failure", async () => {
  await fixture(2);
  const a = await prepare(2);
  await db.query(
    "update candidates set resume_text='New canonical resume' where id=$1",
    [id(2)],
  );
  await enqueue(2);
  const b = await prepare(2);
  assert.equal(b.status, "claimed");
  await fail(a);
  assert.equal((await job(2)).claim_token, b.token);
  assert.equal((await complete(a, vectors(a))).status, "stale");
  assert.equal((await complete(b, vectors(b))).status, "done");
  assert.ok(
    (await chunks(2)).some((x) => x.content === "New canonical resume"),
  );
});
test("contact-only revision rebases in-flight text without spending an attempt", async () => {
  await fixture(3);
  const a = await prepare(3);
  await db.query(
    "update candidate_profile_state set rev=rev+1 where candidate_id=$1",
    [id(3)],
  );
  await db.query(
    "update person_projection_state set revision=revision+1 where candidate_id=$1",
    [id(3)],
  );
  await enqueue(3);
  assert.equal((await job(3)).attempts, 1);
  assert.equal((await complete(a, vectors(a))).status, "done");
  assert.equal(
    String((await job(3)).desired_revision),
    String(Number(a.revision) + 1),
  );
});
test("explicit empty resume clears only its own managed rows, keeps unchanged IDs", async () => {
  await fixture(4);
  let a = await prepare(4);
  await complete(a, vectors(a));
  const before = (await chunks(4)).filter((x) => x.source_type !== "resume");
  await db.query("update candidates set resume_text=null where id=$1", [id(4)]);
  await enqueue(4);
  a = await prepare(4);
  assert.equal(a.missing.length, 0);
  await complete(a, []);
  assert.deepEqual(await chunks(4), before);
});
test("concurrent claims have one owner; third process death enters review and new content resets", async () => {
  await fixture(5);
  const claims = await Promise.all([prepare(5), prepare(5)]);
  assert.equal(claims.filter((x) => x.status === "claimed").length, 1);
  for (let i = 0; i < 3; i++) {
    await db.query(
      "update person_derivative_jobs set lease_until=clock_timestamp()-interval '1 second' where candidate_id=$1",
      [id(5)],
    );
    await prepare(5);
  }
  assert.equal((await job(5)).status, "review");
  assert.equal((await job(5)).attempts, 3);
  await enqueue(5);
  assert.equal((await job(5)).status, "review");
  await db.query(
    "update candidates set resume_text='Changed generation' where id=$1",
    [id(5)],
  );
  await enqueue(5);
  assert.equal((await job(5)).attempts, 0);
  assert.equal((await prepare(5)).status, "claimed");
});
test("API failure and malformed complete vectors preserve the previous set", async () => {
  await fixture(6);
  let a = await prepare(6);
  await complete(a, vectors(a));
  const before = await chunks(6);
  await db.query(
    "update candidates set resume_text='Replacement' where id=$1",
    [id(6)],
  );
  await enqueue(6);
  a = await prepare(6);
  for (const bad of [[], [[0]], [Array(1536).fill(NaN)]])
    await assert.rejects(complete(a, bad), /person_derivative_vectors/);
  await fail(a);
  assert.deepEqual(await chunks(6), before);
  assert.equal((await job(6)).status, "pending");
});
test("failure after delete rolls back vector set and retains retryable claim", async () => {
  await fixture(7);
  let a = await prepare(7);
  await complete(a, vectors(a));
  const before = await chunks(7);
  await db.query(
    "update candidates set resume_text='Rollback replacement' where id=$1",
    [id(7)],
  );
  await enqueue(7);
  a = await prepare(7);
  await db.query(
    `create function derivative_test_failure() returns trigger language plpgsql as $$begin if new.candidate_id='${id(7)}' then raise exception 'synthetic_insert_failure';end if;return new;end$$;create trigger derivative_test_failure before insert on candidate_embeddings for each row execute function derivative_test_failure()`,
  );
  try {
    await assert.rejects(complete(a, vectors(a)), /synthetic_insert_failure/);
    assert.deepEqual(await chunks(7), before);
  } finally {
    await db.query(
      "drop trigger derivative_test_failure on candidate_embeddings;drop function derivative_test_failure()",
    );
  }
  await complete(a, vectors(a));
});
test("model mismatch cannot reuse old chunks, and tenant checks occur before DB access", async () => {
  await fixture(8);
  let a = await prepare(8);
  await complete(a, vectors(a));
  await db.query(
    "update candidate_embeddings set model='old-model' where candidate_id=$1",
    [id(8)],
  );
  await db.query(
    "update person_derivative_jobs set status='pending' where candidate_id=$1",
    [id(8)],
  );
  a = await prepare(8);
  assert.equal(a.missing.length, 3);
  await complete(a, vectors(a));
  assert.ok(
    (await chunks(8)).every((x) => x.model === "text-embedding-3-small"),
  );
  await assert.rejects(
    lib.preparePersonDerivativesOnConnection(
      {
        query() {
          throw Error("DB touched");
        },
      },
      { ...scope(8), organizationId: id(999) },
    ),
    /person_derivative_scope/,
  );
});
test("job schema denies all client grants and enables RLS", async () => {
  const r = (
    await db.query(
      "select relrowsecurity rls,has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE') anon,has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE') authenticated from pg_class where oid='person_derivative_jobs'::regclass",
    )
  ).rows[0];
  assert.deepEqual(r, { rls: true, anon: false, authenticated: false });
});
test("UTF8 chunking caps inputs and preserves explicit empty/omitted source meaning", () => {
  const r = lib.personDerivativeChunks({
    resume: "漢😀".repeat(20000),
    summary: "",
  });
  assert.equal(r.length, 6);
  assert.ok(
    r.every(
      (x) => Buffer.byteLength(x.content) <= 7500 && x.content.length <= 2800,
    ),
  );
  assert.deepEqual(lib.personDerivativeChunks({ summary: "" }), []);
});
test("embedding API validates/reorders indices and has a deadline without leaking response bodies", async () => {
  const parts = [{ content: "first" }, { content: "second" }];
  let signal;
  const fetcher = async (_url, opts) => {
    signal = opts.signal;
    assert.deepEqual(JSON.parse(opts.body).input, ["first", "second"]);
    return {
      ok: true,
      json: async () => ({
        model: "text-embedding-3-small",
        data: [
          { index: 1, embedding: Array(1536).fill(2) },
          { index: 0, embedding: Array(1536).fill(1) },
        ],
      }),
    };
  };
  assert.deepEqual(
    (await lib.embedPersonDerivativeChunks(parts, "synthetic", fetcher)).map(
      (x) => x[0],
    ),
    [1, 2],
  );
  assert.ok(signal instanceof AbortSignal);
  for (const data of [
    [],
    [
      { index: 0, embedding: Array(1536).fill(1) },
      { index: 0, embedding: Array(1536).fill(1) },
    ],
    [{ index: 2, embedding: [] }],
    [{ index: 0, embedding: Array(1536).fill(Infinity) }],
  ])
    await assert.rejects(
      lib.embedPersonDerivativeChunks(parts, "synthetic", async () => ({
        ok: true,
        json: async () => ({ model: "text-embedding-3-small", data }),
      })),
      /person_derivative_response/,
    );
  await assert.rejects(
    lib.embedPersonDerivativeChunks(parts, "synthetic", async () => ({
      ok: false,
      status: 429,
      text() {
        throw Error("private body read");
      },
    })),
    /^Error: person_derivative_http_429$/,
  );
});
test("no API key preserves pending attempt; bounded drain recovers jobs without Harvest work", async () => {
  await fixture(9);
  delete process.env.OPENAI_API_KEY;
  process.env.PERSON_DATABASE_URL = url;
  assert.equal(
    (await lib.processPersonDerivatives(scope(9))).status,
    "not_configured",
  );
  assert.equal((await job(9)).attempts, 0);
  await assert.rejects(
    lib.drainPersonDerivatives({ organizationId: lib.TT_ORG_ID, limit: 51 }),
    /person_derivative_limit/,
  );
  const prior = globalThis.fetch;
  let apiCalls = 0;
  globalThis.fetch = async (u, options) => {
    assert.equal(u, "https://api.openai.com/v1/embeddings");
    apiCalls++;
    const input = JSON.parse(options.body).input;
    return new Response(
      JSON.stringify({
        model: "text-embedding-3-small",
        data: input.map((_, index) => ({
          index,
          embedding: Array(1536).fill(0.1),
        })),
      }),
      { status: 200 },
    );
  };
  process.env.OPENAI_API_KEY = "synthetic";
  try {
    await runNormalizedRefresh({
      lib: { ...lib, pickRefreshRows: async () => [] },
      rest: () => {
        throw Error("REST not needed");
      },
      organizationId: lib.TT_ORG_ID,
      mode: "live",
      dailyCap: 0,
      allowPaid: false,
      noTopup: true,
      log: () => {},
      warn: () => {},
    });
    assert.equal((await job(9)).status, "done");
    assert.ok(apiCalls > 0 && apiCalls <= 50);
  } finally {
    globalThis.fetch = prior;
    delete process.env.OPENAI_API_KEY;
  }
});
test("application matching vector is fenced by incumbent canonical profile and retained resume", async () => {
  for (const n of [20, 21]) {
    await fixture(n, "Retained original resume");
    const raw = {
      headline: "Senior engineer",
      about: "Senior canonical summary",
      experience: [
        {
          position: "Senior engineer",
          companyName: "Incumbent",
          startDate: { year: 2022 },
          endDate: { text: "Present" },
        },
      ],
    };
    await use((c) =>
      lib.savePersonOnConnection(
        c,
        lib.fromHarvest(
          raw,
          {
            id: id(n + 100),
            created_at: "2026-09-27T00:00:00Z",
            cache_status: "miss",
          },
          id(n),
        ),
        { mode: "live" },
      ),
    );
    await db.query(
      "insert into website_applications(id,organization_id,name,email,linkedin_username,created_at) values($1,$2,'Synthetic',$3,$4,'2026-09-26T01:00:00Z')",
      [
        id(n + 200),
        lib.TT_ORG_ID,
        `synthetic-${n}@example.test`,
        `derivative-${n}`,
      ],
    );
    const summary =
      n === 21 ? "Senior canonical summary" : "Junior applicant summary";
    await use((c) =>
      lib.saveApplicationPersonOnConnection(c, {
        organizationId: lib.TT_ORG_ID,
        applicationId: id(n + 200),
        linkedinUsername: `derivative-${n}`,
        name: "Synthetic",
        parsed: { profile_summary: summary },
        resumeText: "Incoming application resume",
        matchingVector: Array(1536).fill(0.1),
        mode: n === 21 ? "shadow" : "live",
      }),
    );
    const r = (
      await db.query(
        "select profile_summary,resume_text,matching_embedding from candidates where id=$1",
        [id(n)],
      )
    ).rows[0];
    assert.equal(r.profile_summary, "Senior canonical summary");
    assert.equal(r.resume_text, "Retained original resume");
    assert.equal(r.matching_embedding, null);
    if (n !== 21) {
      const pending = await job(n);
      assert.equal(pending.sources.summary, "Senior canonical summary");
      assert.equal(pending.sources.resume, "Retained original resume");
    }
  }
});

test("resume-only application vector cannot overwrite a retained different resume", async () => {
  await fixture(22, "Retained original resume", {
    current_title: null,
    profile_summary: null,
    top_skills: [],
  });
  await db.query(
    "insert into website_applications(id,organization_id,name,email,linkedin_username,created_at) values($1,$2,'Synthetic',$3,$4,'2026-09-26T01:00:00Z')",
    [id(222), lib.TT_ORG_ID, "resume-only@example.test", "derivative-22"],
  );
  await use((c) =>
    lib.saveApplicationPersonOnConnection(c, {
      organizationId: lib.TT_ORG_ID,
      applicationId: id(222),
      linkedinUsername: "derivative-22",
      name: "Synthetic",
      parsed: null,
      resumeText: "Incoming application resume",
      matchingVector: Array(1536).fill(0.1),
      mode: "live",
    }),
  );
  const r = (
    await db.query(
      "select resume_text,matching_embedding is null as empty from candidates where id=$1",
      [id(22)],
    )
  ).rows[0];
  assert.deepEqual(r, { resume_text: "Retained original resume", empty: true });
  assert.equal((await job(22)).sources.resume, "Retained original resume");
});
