// Run the actual worker and bundled shared code against a local REST fixture.
// External calls are prohibited by the preload; all records are synthetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const CID = "00000000-0000-4000-8000-000000000001";
const QID = "00000000-0000-4000-8000-000000000002";

async function runWorker({ failures = 0, recovery = false, spent = 0, missingPayload = false, retried = false, missingCandidate = false, newerCandidate = false } = {}) {
  const fetchedAt = new Date(Date.now() - 86400000).toISOString();
  const state = {
    queue: [{ id: QID, candidate_id: CID, linkedin_url: "https://www.linkedin.com/in/test-person", linkedin_username: "test-person", priority: 10,
      status: recovery ? "patch_failed" : "queued", reason: retried ? "patch_retry" : "search", processed_at: fetchedAt }],
    candidate: { id: CID, updated_at: "2025-01-01T00:00:00Z", ...(newerCandidate ? { linkedin_enrichment_date: new Date().toISOString(), current_title: "Newer directory title" } : {}) },
    ledger: [], patchAttempts: 0, unexpected: [],
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const table = url.pathname.split("/").at(-1);
    const method = req.method;
    let raw = "";
    for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : null;
    const reply = (value, status = 200, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value)); };
    if (table === "organizations") return reply([{ id: "00000000-0000-4000-8000-000000000003" }]);
    if (table === "candidate_enrichments") {
      if (method === "POST") { state.ledger.push(body); return reply(null, 201); }
      if (url.searchParams.has("cache_status")) return reply([], 200, { "content-range": `0-0/${spent}` });
      return reply(missingPayload ? [] : [{ created_at: fetchedAt, raw_payload: {
        headline: "Engineer", experience: [{ position: "Staff Engineer", companyName: "Example Corp", startDate: { year: 2020, month: 1 } }],
      } }]);
    }
    if (table === "candidate_experiences" && method === "POST") return reply(null, 201);
    if (table === "candidates" && method === "GET") return reply(missingCandidate ? [] : [state.candidate]);
    if (table === "candidates" && method === "PATCH") {
      const before = url.searchParams.get("or")?.match(/linkedin_enrichment_date.lte.([^,)]+)/)?.[1];
      if (before && state.candidate.linkedin_enrichment_date > before) return reply([]);
      state.patchAttempts++;
      if (state.patchAttempts <= failures) return reply({ code: "23505", message: "private-data-marker", details: "private-data-marker" }, 409);
      if (missingCandidate) return reply([]);
      Object.assign(state.candidate, body);
      return reply([{ id: CID }]);
    }
    if (table === "refresh_queue") {
      let rows = state.queue;
      for (const key of ["status", "id", "candidate_id", "reason"]) {
        const filter = url.searchParams.get(key);
        if (filter?.startsWith("eq.")) rows = rows.filter(r => String(r[key]) === filter.slice(3));
        if (filter?.startsWith("neq.")) rows = rows.filter(r => String(r[key]) !== filter.slice(4));
      }
      if (url.searchParams.get("or")?.includes("reason")) rows = rows.filter(r => r.reason == null || r.reason !== "patch_retry");
      if (method === "PATCH") { rows.forEach(r => Object.assign(r, body)); return reply(rows.map(r => ({ id: r.id }))); }
      if (method === "DELETE") { state.queue = state.queue.filter(r => !rows.includes(r)); return reply(null); }
      return reply(rows.slice(0, Number(url.searchParams.get("limit") ?? 1000)));
    }
    state.unexpected.push(`${method} ${table}`);
    reply({ code: "FIXTURE_UNEXPECTED" }, 500);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const { stdout, stderr } = await exec(process.execPath, ["--import", "./scripts/test-support/local-fetch-only.mjs", "scripts/refresh-worker.mjs"], {
      cwd: new URL("../", import.meta.url), timeout: 10000,
      env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${server.address().port}`, SUPABASE_SERVICE_ROLE_KEY: "test-only",
        HARVEST_API_KEY: "test-only", OPENAI_API_KEY: "", REFRESH_DAILY_CAP: "1", NO_TOPUP: "1", CONCURRENCY: "1", PRECOMPUTE_BACKFILL: "" },
    });
    state.logs = stdout + stderr;
    assert.deepEqual(state.unexpected, []);
    assert.doesNotMatch(state.logs, /EXTERNAL_FETCH_FORBIDDEN/);
    return state;
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test("successful cached refresh stamps updated_at and keeps the source fetch time", async () => {
  const s = await runWorker();
  assert.equal(s.queue[0].status, "done");
  assert.equal(s.candidate.current_title, "Staff Engineer");
  assert.ok(Date.parse(s.candidate.updated_at) > Date.parse(s.candidate.linkedin_enrichment_date));
});
test("one failed profile save is retried before declaring success", async () => {
  const s = await runWorker({ failures: 1 });
  assert.equal(s.patchAttempts, 2);
  assert.equal(s.queue[0].status, "done");
  assert.equal(s.candidate.current_title, "Staff Engineer");
});
test("repeated save failure stays patch_failed and records no extra paid pull", async () => {
  const s = await runWorker({ failures: 99 });
  assert.equal(s.patchAttempts, 2);
  assert.equal(s.queue[0].status, "patch_failed");
  assert.equal(s.ledger.length, 1);
  assert.equal(s.ledger[0].cache_status, "hit");
  assert.doesNotMatch(s.logs, /private-data-marker/);
});
test("a missing candidate is a failed save even when REST returns HTTP 200", async () => {
  const s = await runWorker({ missingCandidate: true });
  assert.equal(s.queue[0].status, "patch_failed");
});
test("free recovery runs with the paid budget exhausted and writes no ledger rows", async () => {
  const s = await runWorker({ recovery: true, spent: 1 });
  assert.equal(s.queue[0].status, "done");
  assert.equal(s.queue[0].reason, "patch_retry");
  assert.equal(s.candidate.current_title, "Staff Engineer");
  assert.equal(s.ledger.length, 0);
});
test("recovery cannot fall back to a paid pull when its cached payload is unavailable", async () => {
  const s = await runWorker({ recovery: true, spent: 1, missingPayload: true });
  assert.equal(s.queue[0].status, "patch_failed");
  assert.equal(s.queue[0].reason, "patch_retry");
  assert.equal(s.patchAttempts, 0);
  assert.equal(s.ledger.length, 0);
});
test("recovery is attempted only once across runs", async () => {
  const s = await runWorker({ recovery: true, retried: true, spent: 1 });
  assert.equal(s.patchAttempts, 0);
  assert.equal(s.queue[0].status, "patch_failed");
  assert.equal(s.ledger.length, 0);
});

test("a recovery save cannot roll back a newer directory profile", async () => {
  const s = await runWorker({ recovery: true, spent: 1, newerCandidate: true });
  assert.equal(s.candidate.current_title, "Newer directory title");
  assert.equal(s.queue[0].status, "done");
  assert.equal(s.ledger.length, 0);
});
test("repeated recovery failure retains the failed queue row and consumes no credit", async () => {
  const s = await runWorker({ recovery: true, failures: 99, spent: 1 });
  assert.equal(s.queue.length, 1);
  assert.equal(s.queue[0].status, "patch_failed");
  assert.equal(s.queue[0].reason, "patch_retry");
  assert.equal(s.patchAttempts, 2);
  assert.equal(s.ledger.length, 0);
});
