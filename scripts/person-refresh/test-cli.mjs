import {prepareAuditFixture} from '../person-audit/local-fixture.mjs';
// Actual CLI + compiled shared library + local PostgreSQL. The fetch preload
// forbids every network destination except this local REST fixture.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import * as lib from "../dist/worker-lib.mjs";
const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw Error("local database required");
const db = new pg.Pool({ connectionString: url, max: 2 });
const org = lib.TT_ORG_ID;
const id = (n) => `b1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const calls = [];
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const table = u.pathname.split("/").at(-1);
  calls.push(`${req.method} ${table}`);
  let rows;
  if (table === "organizations" && req.method === "GET") rows = [{ id: org }];
  else if (table === "candidates" && req.method === "GET")
    rows = (
      await db.query("select * from candidates where id=$1", [
        u.searchParams.get("id").slice(3),
      ])
    ).rows;
  else {
    res.writeHead(500);
    res.end("{}");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(rows));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(async () => {
  await db.end();
  await new Promise((r) => server.close(r));
});
await db.query("truncate refresh_queue,person_refresh_attempts");
const exec = promisify(execFile);
async function fixture(n) {
  await db.query(
    "insert into candidates(id,full_name,linkedin_username,current_title,created_at) values($1,'Synthetic CLI',$2,'Old title','2020-01-01')",
    [id(n), `cli-${n}`],
  );
  await prepareAuditFixture(id(n));
  await db.query(
    "insert into candidate_enrichments(candidate_id,organization_id,linkedin_username,raw_payload,created_at) values($1,$2,$3,$4,now()-interval '1 day')",
    [
      id(n),
      org,
      `cli-${n}`,
      {
        headline: "Synthetic refresh",
        experience: [
          {
            position: "Staff Engineer",
            companyName: "Synthetic Co",
            startDate: { year: 2020, month: 1 },
          },
        ],
      },
    ],
  );
  await db.query(
    "insert into refresh_queue(id,organization_id,candidate_id,status) values($1,$2,$3,'patch_failed')",
    [id(n + 100), org, id(n)],
  );
}
async function run(mode) {
  try {
    return {
      code: 0,
      ...(await exec(
        process.execPath,
        [
          "--import",
          "./scripts/test-support/local-fetch-only.mjs",
          "scripts/refresh-worker.mjs",
        ],
        {
          cwd: new URL("../../", import.meta.url),
          timeout: 15000,
          env: {
            ...process.env,
            PERSON_WRITE_MODE: mode,
            PERSON_DATABASE_URL: url,
            SUPABASE_URL: `http://127.0.0.1:${server.address().port}`,
            SUPABASE_SERVICE_ROLE_KEY: "synthetic",
            HARVEST_API_KEY: "",
            OPENAI_API_KEY: "",
            REFRESH_DAILY_CAP: "0",
            CONCURRENCY: "2",
            NO_TOPUP: "1",
            PRECOMPUTE_BACKFILL: "",
          },
        },
      )),
    };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}
await test("actual normalized CLI saves cached shadow work without Harvest credentials or budget", async () => {
  await fixture(1);
  const result = await run("shadow");
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /"refreshed":1/);
  assert.equal(
    (await db.query("select status from refresh_queue where id=$1", [id(101)]))
      .rows[0].status,
    "done",
  );
  assert.equal(
    (
      await db.query("select current_title from candidates where id=$1", [
        id(1),
      ])
    ).rows[0].current_title,
    "Old title",
  );
  assert.deepEqual(calls, ["GET organizations"]);
});
await test("actual CLI fails visibly, retains cached input and recovers free on its next run", async () => {
  await fixture(2);
  await db.query(
    `create function public.refresh_cli_fail() returns trigger language plpgsql as $$begin if new.id='${id(2)}' then raise exception 'private-data-marker';end if;return new;end$$;create trigger refresh_cli_fail before update on candidates for each row execute function refresh_cli_fail()`,
  );
  const failed = await run("live");
  assert.equal(failed.code, 1);
  assert.doesNotMatch(
    failed.stdout + failed.stderr,
    /private-data-marker|EXTERNAL_FETCH_FORBIDDEN/,
  );
  assert.equal(
    (await db.query("select status from refresh_queue where id=$1", [id(102)]))
      .rows[0].status,
    "patch_failed",
  );
  await db.query(
    "drop trigger refresh_cli_fail on candidates;drop function refresh_cli_fail()",
  );
  const retry = await run("live");
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(
    (
      await db.query("select current_title from candidates where id=$1", [
        id(2),
      ])
    ).rows[0].current_title,
    "Staff Engineer",
  );
  const receipt = (
    await db.query(
      "select attempts,phase from person_refresh_attempts where queue_id=$1",
      [id(102)],
    )
  ).rows[0];
  assert.deepEqual(receipt, { attempts: 2, phase: "done" });
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from candidate_enrichments where candidate_id=$1",
        [id(2)],
      )
    ).rows[0].n,
    1,
  );
  assert.ok(
    calls.every((x) => ["GET organizations", "GET candidates"].includes(x)),
  );
});
