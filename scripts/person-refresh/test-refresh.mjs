import assert from "node:assert/strict";
import { test, after } from "node:test";
import pg from "pg";
import * as lib from "../dist/worker-lib.mjs";
const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
  throw Error("local database required");
const pool = new pg.Pool({ connectionString: url, max: 4 });
const org = lib.TT_ORG_ID,
  other = "b0000000-0000-4000-8000-000000000999";
const id = (n) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const use = async (fn) => {
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
};
const claim = (n, extra = {}) =>
  use((c) =>
    lib.claimRefreshOnConnection(c, {
      organizationId: org,
      queueId: id(n + 1000),
      dailyCap: 50,
      allowPaid: true,
      ...extra,
    }),
  );
const save = (n, token, mode = "live") =>
  use((c) =>
    lib.saveRefreshOnConnection(c, {
      organizationId: org,
      queueId: id(n + 1000),
      token,
      mode,
    }),
  );
const fail = (n, token) =>
  use((c) =>
    lib.failRefreshOnConnection(c, {
      organizationId: org,
      queueId: id(n + 1000),
      token,
    }),
  );
const raw = {
  headline: "Synthetic refreshed profile",
  experience: [
    {
      position: "Staff Engineer",
      companyName: "Synthetic Co",
      startDate: { year: 2020, month: 1 },
    },
  ],
};
async function fixture(
  n,
  {
    cache = true,
    organization = org,
    status = "queued",
    reason = "search",
    hold = false,
  } = {},
) {
  await pool.query(
    `insert into candidates(id,full_name,linkedin_username,linkedin_url,current_title,created_at) values($1,'Synthetic Refresh',$2,$3,'Old title','2020-01-01')`,
    [id(n), `refresh-${n}`, `https://www.linkedin.com/in/refresh-${n}`],
  );
  await pool.query("select save_person($1)", [
    lib.fromLegacyImport({
      id: id(n),
      full_name: "Synthetic Refresh",
      linkedin_username: `refresh-${n}`,
      created_at: "2020-01-01",
      current_title: "Old title",
    }),
  ]);
  await pool.query(
    `insert into refresh_queue(id,organization_id,candidate_id,status,reason) values($1,$2,$3,$4,$5)`,
    [id(n + 1000), organization, id(n), status, reason],
  );
  if (cache)
    await pool.query(
      `insert into candidate_enrichments(id,candidate_id,organization_id,linkedin_username,raw_payload,created_at) values($1,$2,$3,$4,$5,now()-interval '1 day')`,
      [id(n + 2000), id(n), organization, `refresh-${n}`, raw],
    );
  if (hold)
    await pool.query(
      `insert into candidate_enrichments(id,candidate_id,organization_id,linkedin_username,cache_status,raw_payload) values($1,$2,$3,$4,'hit',$5)`,
      [id(n + 3000), id(n), org, `refresh-${n}`, raw],
    );
}
after(() => pool.end());
await test("normalized refresh has explicit claim/save/retry interfaces", () => {
  for (const k of [
    "claimRefreshOnConnection",
    "storeRefreshPayloadOnConnection",
    "saveRefreshOnConnection",
    "failRefreshOnConnection",
    "claimRefreshDerivativesOnConnection",
  ])
    assert.equal(typeof lib[k], "function", k);
});
if (!lib.claimRefreshOnConnection) throw Error("refresh_missing");
await test("overlapping claims admit one worker, reuse original cache date and complete atomically", async () => {
  await fixture(1);
  const claims = await Promise.all([claim(1), claim(1)]);
  assert.equal(claims.filter((c) => c.status === "claimed").length, 1);
  const winner = claims.find((c) => c.status === "claimed");
  assert.equal(winner.needsHarvest, false);
  const result = await save(1, winner.token);
  assert.equal(result.status, "done");
  const c = (
    await pool.query(
      "select current_title,linkedin_enrichment_date from candidates where id=$1",
      [id(1)],
    )
  ).rows[0];
  assert.equal(c.current_title, "Staff Engineer");
  const ledger = (
    await pool.query(
      "select created_at from candidate_enrichments where id=$1",
      [id(2001)],
    )
  ).rows[0];
  assert.equal(
    c.linkedin_enrichment_date.toISOString(),
    ledger.created_at.toISOString(),
  );
  assert.equal((await claim(1)).status, "done");
  assert.equal(
    (
      await pool.query("select status from refresh_queue where id=$1", [
        id(1001),
      ])
    ).rows[0].status,
    "done",
  );
});
await test("tenant queue and held source never authorize a pool write or paid request", async () => {
  await fixture(2, { organization: other });
  assert.equal((await claim(2)).status, "missing");
  await assert.rejects(claim(2, { organizationId: other }));
  await fixture(3, { hold: true });
  assert.equal((await claim(3)).status, "review");
});
await test("shadow saves normalized facts while retaining the deployed profile", async () => {
  await fixture(4);
  const c = await claim(4);
  await save(4, c.token, "shadow");
  assert.equal(
    (
      await pool.query("select current_title from candidates where id=$1", [
        id(4),
      ])
    ).rows[0].current_title,
    "Old title",
  );
  assert.equal(
    (
      await pool.query(
        "select header->'current_title'->>'value' title from candidate_profile_state where candidate_id=$1",
        [id(4)],
      )
    ).rows[0].title,
    "Staff Engineer",
  );
});
await test("save failure cannot report done and free recovery stays bounded", async () => {
  await fixture(5);
  const c = await claim(5);
  await pool.query(
    `create function public.refresh_test_fail() returns trigger language plpgsql as $$begin if new.id='${id(5)}' then raise exception 'synthetic failure';end if;return new;end$$;create trigger refresh_test_fail before update on candidates for each row execute function refresh_test_fail()`,
  );
  await assert.rejects(save(5, c.token));
  assert.equal(
    (
      await pool.query("select status from refresh_queue where id=$1", [
        id(1005),
      ])
    ).rows[0].status,
    "queued",
  );
  await fail(5, c.token);
  await pool.query(
    "drop trigger refresh_test_fail on candidates;drop function refresh_test_fail()",
  );
  const retry = await claim(5, { dailyCap: 0 });
  assert.equal(retry.needsHarvest, false);
  await save(5, retry.token);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from candidate_enrichments where candidate_id=$1",
        [id(5)],
      )
    ).rows[0].n,
    1,
  );
  await fixture(6);
  for (let n = 0; n < 3; n++) {
    const a = await claim(6);
    assert.equal(a.status, "claimed");
    await fail(6, a.token);
  }
  assert.equal((await claim(6)).status, "review");
});
await test("expired claims fence stale saves and preserve their ledger for the next worker", async () => {
  await fixture(7);
  const first = await claim(7);
  await pool.query(
    "update person_refresh_attempts set lease_until=now()-interval '1 second' where queue_id=$1",
    [id(1007)],
  );
  const second = await claim(7);
  assert.equal(second.status, "claimed");
  assert.notEqual(first.token, second.token);
  await assert.rejects(save(7, first.token));
  await save(7, second.token);
});
await test("paid reservation is bounded and an uncertain call is never automatically purchased twice", async () => {
  await fixture(8, { cache: false });
  const spent = Number(
    (
      await pool.query(
        "select count(*) n from candidate_enrichments where provider='harvest' and cache_status='miss' and created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'",
      )
    ).rows[0].n,
  );
  assert.equal((await claim(8, { dailyCap: spent })).status, "budget");
  const c = await claim(8, { dailyCap: spent + 1 });
  assert.equal(c.needsHarvest, true);
  await fixture(9, { cache: false });
  assert.equal((await claim(9, { dailyCap: spent + 1 })).status, "budget");
  await pool.query(
    "update person_refresh_attempts set lease_until=now()-interval '1 second' where queue_id=$1",
    [id(1008)],
  );
  assert.equal((await claim(8)).status, "review");
  await use((db) =>
    lib.storeRefreshPayloadOnConnection(db, {
      organizationId: org,
      queueId: id(1008),
      token: c.token,
      raw,
    }),
  );
  const retry = await claim(8, { dailyCap: 0 });
  assert.equal(retry.status, "claimed");
  assert.equal(retry.needsHarvest, false);
  await save(8, retry.token);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from candidate_enrichments where candidate_id=$1",
        [id(8)],
      )
    ).rows[0].n,
    1,
  );
});
await test("cache hit reuse dates are excluded and an old failed row cannot purchase enrichment", async () => {
  await fixture(10, { cache: false, status: "patch_failed" });
  const c = await claim(10);
  assert.equal(c.status, "review");
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from candidate_enrichments where candidate_id=$1",
        [id(10)],
      )
    ).rows[0].n,
    0,
  );
});
await test("an uncertain paid request also fences another queue row for the same person", async () => {
  await fixture(12, { cache: false });
  const c = await claim(12);
  assert.equal(c.needsHarvest, true);
  await fail(12, c.token);
  await pool.query(
    "insert into refresh_queue(id,organization_id,candidate_id,status) values($1,$2,$3,'queued')",
    [id(9012), org, id(12)],
  );
  const second = await claim(12, { queueId: id(9012) });
  assert.equal(second.status, "review");
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from person_refresh_attempts where candidate_id=$1 and paid_requested_at is not null",
        [id(12)],
      )
    ).rows[0].n,
    1,
  );
});
await test("the immutable cache snapshot survives a later ledger edit and terminal history is retained", async () => {
  await fixture(11);
  const c = await claim(11);
  await pool.query(
    "update candidate_enrichments set raw_payload=$2 where id=$1",
    [id(2011), { headline: "Later unrelated replacement" }],
  );
  await pool.query(
    "insert into refresh_queue(id,organization_id,candidate_id,status) values($1,$2,$3,'done')",
    [id(9011), org, id(11)],
  );
  await save(11, c.token);
  assert.equal(
    (
      await pool.query("select current_title from candidates where id=$1", [
        id(11),
      ])
    ).rows[0].current_title,
    "Staff Engineer",
  );
  assert.match(
    (
      await pool.query("select status from refresh_queue where id=$1", [
        id(9011),
      ])
    ).rows[0].status,
    /^archived_/,
  );
  assert.equal(
    (
      await pool.query(
        "select jsonb_array_length(previous_queue_rows) n from person_refresh_attempts where queue_id=$1",
        [id(1011)],
      )
    ).rows[0].n,
    1,
  );
});
await test("derivative reservation occurs at most once and never for a shadow receipt", async () => {
  const reserve = (n) =>
    use((c) =>
      lib.claimRefreshDerivativesOnConnection(c, {
        organizationId: org,
        queueId: id(n + 1000),
      }),
    );
  const claims = await Promise.all([reserve(1), reserve(1)]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await reserve(4), null);
});
await test("attempt evidence remains private to the service role", async () => {
  const r = (
    await pool.query(
      "select has_table_privilege('anon','person_refresh_attempts','select') a,has_table_privilege('authenticated','person_refresh_attempts','select') b,has_table_privilege('service_role','person_refresh_attempts','select') s",
    )
  ).rows[0];
  assert.deepEqual(r, { a: false, b: false, s: true });
});
await test("queue selection excludes completed, exhausted, review and actively leased work", async () => {
  await fixture(13);
  const active = await claim(13);
  await fixture(14, { status: "patch_failed" });
  const rows = await use((c) =>
    lib.pickRefreshRowsOnConnection(c, {
      organizationId: org,
      status: "patch_failed",
      limit: 50,
    }),
  );
  assert.equal(
    rows.some(
      (r) => r.id === id(1006) || r.id === id(1013) || r.id === id(1001),
    ),
    false,
  );
  assert.equal(
    rows.some((r) => r.id === id(1014)),
    true,
  );
  assert.ok(active.token);
});

await test("uncached paid work cannot hide a free cached queued person behind the batch limit", async () => {
  for (let n = 100; n < 150; n++) await fixture(n, { cache: false });
  await fixture(150);
  await pool.query(
    "update refresh_queue set queued_at='2030-01-01' where id=$1",
    [id(1150)],
  );
  const rows = await use((c) =>
    lib.pickRefreshRowsOnConnection(c, {
      organizationId: org,
      status: "queued",
      limit: 50,
    }),
  );
  assert.ok(rows.some((r) => r.id === id(1150)));
  const cached = await claim(150, { dailyCap: 0 });
  assert.equal(cached.status, "claimed");
  assert.equal(cached.needsHarvest, false);
});

await test("a late paid response restores a selectable free retry after a newer failed row archived its slot", async () => {
  await fixture(151, { cache: false });
  const first = await claim(151);
  await fail(151, first.token);
  await pool.query(
    "insert into refresh_queue(id,organization_id,candidate_id,status) values($1,$2,$3,'queued')",
    [id(9151), org, id(151)],
  );
  assert.equal((await claim(151, { queueId: id(9151) })).status, "review");
  assert.match(
    (
      await pool.query("select status from refresh_queue where id=$1", [
        id(1151),
      ])
    ).rows[0].status,
    /^archived_/,
  );
  await use((c) =>
    lib.storeRefreshPayloadOnConnection(c, {
      organizationId: org,
      queueId: id(1151),
      token: first.token,
      raw,
    }),
  );
  const rows = await use((c) =>
    lib.pickRefreshRowsOnConnection(c, {
      organizationId: org,
      status: "patch_failed",
      limit: 50,
    }),
  );
  assert.ok(rows.some((r) => r.id === id(1151)));
  const retry = await claim(151, { dailyCap: 0 });
  assert.equal(retry.needsHarvest, false);
  await save(151, retry.token);
  assert.equal(
    (
      await pool.query("select current_title from candidates where id=$1", [
        id(151),
      ])
    ).rows[0].current_title,
    "Staff Engineer",
  );
});
