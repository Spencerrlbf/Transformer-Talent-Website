import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import * as lib from "../dist/worker-lib.mjs";
import {
  runDirectory,
  drainDirectoryEmbeddings,
} from "../person-directory/worker.mjs";
const url = process.env.LOCAL_DATABASE_URL;
if (
  !/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_directory_(?:input|execution|publication|creation|outcomes|suppression|readmission|worker)_test$/.test(
    url || "",
  )
)
  throw Error("local fixture required");
const pool = new pg.Pool({ connectionString: url, max: 8 });
const org = lib.TT_ORG_ID;
const snap = (contact = randomUUID()) => ({
  board: {
    contact_id: contact,
    name: "Synthetic Directory",
    updated_at: "2026-09-25",
  },
  harvest: null,
  exps: [],
  edus: [],
  emails: [],
  phones: [],
  facts: [],
  identifiers: [],
});
const phase = (enabled = true, state = "open") =>
  pool.query(
    "update person_private.transition_control set enabled=$1,phase=$2 where singleton",
    [enabled, state],
  );
async function rpc(c, name, args) {
  return (
    await c.query(
      `select public.person_directory_${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) result`,
      args.map((x) => (Array.isArray(x) ? JSON.stringify(x) : x)),
    )
  ).rows[0].result;
}
async function use(fn, role = true) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    if (role) await c.query("set local role service_role");
    const r = await fn(c);
    await c.query("commit");
    return r;
  } finally {
    await c.query("rollback");
    c.release();
  }
}
const claim = async (workspace = randomUUID(), token = randomUUID()) => ({
  workspace,
  token,
  ...(await use((c) => rpc(c, "claim", [org, workspace, token]))),
});
const stage = (lease, snapshot, hash = lib.directorySnapshotHash(snapshot)) =>
  use((c) =>
    rpc(c, "stage", [org, lease.workspace, lease.token, hash, snapshot]),
  );
const checkpoint = (
  lease,
  cursor = lease.cursor,
  release = false,
  complete = false,
) =>
  use((c) =>
    rpc(c, "checkpoint", [
      org,
      lease.workspace,
      lease.token,
      cursor,
      release,
      complete,
    ]),
  );
test.after(() => pool.end());
test.beforeEach(async () => {
  delete process.env.PERSON_TRANSITION_SUPPORT;
  await phase();
});
async function legacy() {
  await phase(false);
  const w = randomUUID(),
    s = snap();
  try {
    await pool.query(
      "insert into person_directory_scans(workspace_id,token,lease_until) values($1,$2,clock_timestamp()+interval '10 minutes')",
      [w, randomUUID()],
    );
    const r = (
      await pool.query(
        "insert into person_directory_receipts(workspace_id,contact_id,snapshot_hash,snapshot) values($1,$2,$3,$4) returning id",
        [w, s.board.contact_id, lib.directorySnapshotHash(s), s],
      )
    ).rows[0];
    await pool.query(
      "insert into person_directory_state(contact_id,workspace_id,latest_receipt_id,seen_cycle) values($1,$2,$3,1)",
      [s.board.contact_id, w, r.id],
    );
    return { w, s, id: r.id };
  } finally {
    await phase();
  }
}
for (const table of ["scans", "receipts", "state"])
  for (const op of ["update", "delete"])
    test(`required raw ${table} ${op} is refused`, async () => {
      const f = await legacy();
      await assert.rejects(
        use((c) =>
          c.query(
            op === "delete"
              ? `delete from person_directory_${table} where workspace_id=$1`
              : `update person_directory_${table} set ${table === "scans" ? "cycle=cycle+1" : table === "receipts" ? "snapshot='{}'" : "seen_cycle=seen_cycle+1"} where workspace_id=$1`,
            [f.w],
          ),
        ),
        /directory_input_/,
      );
    });
test("required raw scan insert refused", async () => {
  await assert.rejects(
    use((c) =>
      c.query("insert into person_directory_scans(workspace_id) values($1)", [
        randomUUID(),
      ]),
    ),
    /directory_input_/,
  );
});
test("claim replay preserves token/cursor/lease; competitors busy and tenant rejected", async () => {
  const l = await claim();
  assert.equal(l.status, "claimed");
  assert.deepEqual(
    await use((c) => rpc(c, "claim", [org, l.workspace, l.token])),
    { status: "claimed", token: l.token, cursor: l.cursor, cycle: l.cycle },
  );
  assert.equal((await claim(l.workspace)).status, "busy");
  await assert.rejects(
    use((c) => rpc(c, "claim", [randomUUID(), randomUUID(), randomUUID()])),
    /directory_input_scope/,
  );
});
test("stage response loss replays one certified retained input; arrays compare as multisets", async () => {
  const l = await claim(),
    s = snap();
  s.facts = [{ value: "b" }, { value: "a" }, { value: "a" }];
  const a = await stage(l, s);
  assert.equal(a.phase, "ready");
  assert.equal(
    (await stage(l, { ...s, facts: [...s.facts].reverse() })).receiptId,
    a.receiptId,
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from person_directory_receipts where contact_id=$1",
        [s.board.contact_id],
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(
    stage(
      l,
      { ...s, board: { ...s.board, name: "Changed" } },
      lib.directorySnapshotHash(s),
    ),
    /directory_input_collision/,
  );
  await assert.rejects(
    stage(
      l,
      { ...s, facts: [{ value: "b" }, { value: "a" }] },
      lib.directorySnapshotHash(s),
    ),
    /directory_input_collision/,
  );
});
test("pending previous is retained and recoverable without external source reads", async () => {
  const l = await claim(),
    s = snap(),
    a = await stage(l, s),
    b = await stage(l, { ...s, board: { ...s.board, name: "Changed" } });
  assert.equal(b.receiptId, a.receiptId);
  assert.equal(b.pendingPrevious, true);
  assert.deepEqual(
    await use((c) => rpc(c, "pending", [org, l.workspace, l.token, 100])),
    { status: "ready", receiptIds: [a.receiptId] },
  );
});
test("historical uncertified inputs explicitly require review on stage, inspect and recovery", async () => {
  const f = await legacy();
  await phase(false);
  await pool.query(
    "update person_directory_scans set lease_until=clock_timestamp()-interval '1 second' where workspace_id=$1",
    [f.w],
  );
  await phase();
  const l = await claim(f.w);
  assert.equal((await stage(l, f.s)).phase, "input_review");
  assert.equal(
    (await use((c) => rpc(c, "pending", [org, l.workspace, l.token, 100])))
      .status,
    "input_review",
  );
  const items = [
    { snapshot_hash: lib.directorySnapshotHash(f.s), snapshot: f.s },
  ];
  assert.equal(
    (await use((c) => rpc(c, "inspect", [org, l.workspace, l.token, items])))[0]
      .phase,
    "input_review",
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from person_private.directory_inputs where receipt_id=$1",
        [f.id],
      )
    ).rows[0].n,
    0,
  );
});
test("held claim refused; retained observation survives drain; checkpoint cannot advance", async () => {
  const l = await claim();
  await phase(true, "draining");
  assert.equal((await claim()).status, "held");
  const a = await stage(l, snap());
  assert.ok(a.receiptId);
  await assert.rejects(checkpoint(l, randomUUID()), /directory_input_held/);
  await assert.rejects(
    checkpoint(l, l.cursor, true, true),
    /directory_input_held/,
  );
  assert.equal((await checkpoint(l, l.cursor, true)).status, "checkpointed");
});
test("wrong token/workspace and invalid shape never create input", async () => {
  const l = await claim();
  await assert.rejects(
    stage({ ...l, token: randomUUID() }, snap()),
    /directory_input_lease/,
  );
  await assert.rejects(
    stage({ ...l, workspace: randomUUID() }, snap()),
    /directory_input_lease/,
  );
  await assert.rejects(
    use((c) =>
      rpc(c, "stage", [
        org,
        l.workspace,
        l.token,
        "a".repeat(64),
        { ...snap(), facts: {} },
      ]),
    ),
    /directory_input_shape/,
  );
  const s = snap(),
    a = await stage(l, s),
    other = await claim();
  await assert.rejects(stage(other, s), /directory_input_workspace/);
  assert.ok(a.receiptId);
});
test("certified source fields cannot change or disappear even after disabling enforcement", async () => {
  const l = await claim(),
    a = await stage(l, snap());
  await phase(false);
  for (const sql of [
    "update person_directory_receipts set snapshot='{}' where id=$1",
    "update person_directory_receipts set captured_at=captured_at+interval '1 second' where id=$1",
    "delete from person_directory_receipts where id=$1",
  ])
    await assert.rejects(
      use((c) => c.query(sql, [a.receiptId])),
      /directory_input_immutable/,
    );
});
async function trigger(table, timing, body, fn) {
  await pool.query(
    `create function person_private.synthetic_directory_input() returns trigger language plpgsql as $$begin ${body}end$$;create trigger zz_synthetic_directory_input ${timing} on ${table} for each row execute function person_private.synthetic_directory_input()`,
  );
  try {
    await fn();
  } finally {
    await pool.query(
      `drop trigger zz_synthetic_directory_input on ${table};drop function person_private.synthetic_directory_input()`,
    );
  }
}
for (const [table, body] of [
  ["person_directory_receipts", "return null;"],
  [
    "person_directory_receipts",
    "new.snapshot_hash:=repeat('0',64);return new;",
  ],
  ["person_private.directory_inputs", "return null;"],
  [
    "person_private.directory_inputs",
    "new.input_hash:=repeat('0',64);return new;",
  ],
  ["person_directory_state", "return null;"],
])
  test(`stage detects suppressed/altered ${table}: ${body}`, async () => {
    const l = await claim(),
      s = snap();
    await trigger(table, "before insert", body, () =>
      assert.rejects(stage(l, s), /directory_input_/),
    );
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from person_directory_receipts where contact_id=$1",
          [s.board.contact_id],
        )
      ).rows[0].n,
      0,
    );
  });
test("private certificate tampering is detected on replay and private helpers deny service access", async () => {
  const l = await claim(),
    s = snap(),
    a = await stage(l, s);
  await pool.query(
    "update person_private.directory_inputs set input_hash=repeat('0',64) where receipt_id=$1",
    [a.receiptId],
  );
  await assert.rejects(stage(l, s), /directory_input_certificate/);
  assert.equal(
    (
      await pool.query(
        "select has_table_privilege('service_role','person_private.directory_inputs','INSERT') allowed",
      )
    ).rows[0].allowed,
    false,
  );
  await assert.rejects(
    use((c) =>
      c.query("select person_private.directory_verify($1)", [a.receiptId]),
    ),
    /permission denied/,
  );
});
async function waitLock(pid) {
  for (let i = 0; i < 150; i++) {
    if (
      (
        await pool.query(
          "select wait_event_type='Lock' waiting from pg_stat_activity where pid=$1",
          [pid],
        )
      ).rows[0]?.waiting
    )
      return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("expected real lock wait");
}
test("lease expires during actual contact lock wait without a receipt", async () => {
  const l = await claim(),
    s = snap(),
    hold = await pool.connect(),
    waiting = await pool.connect();
  let pending;
  try {
    await phase(false);
    await pool.query(
      "update person_directory_scans set lease_until=clock_timestamp()+interval '150 milliseconds' where workspace_id=$1",
      [l.workspace],
    );
    await phase();
    await hold.query("begin");
    await hold.query("select pg_advisory_xact_lock(72011,hashtext($1))", [
      s.board.contact_id,
    ]);
    const pid = (await waiting.query("select pg_backend_pid() pid")).rows[0]
      .pid;
    pending = rpc(waiting, "stage", [
      org,
      l.workspace,
      l.token,
      lib.directorySnapshotHash(s),
      s,
    ]).then(
      () => null,
      (e) => e,
    );
    await waitLock(pid);
    await new Promise((r) => setTimeout(r, 170));
    await hold.query("commit");
    assert.match((await pending)?.message || "", /directory_input_lease/);
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from person_directory_receipts where contact_id=$1",
          [s.board.contact_id],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await hold.query("rollback");
    if (pending) await pending;
    hold.release();
    waiting.release();
  }
});
test("support-on legacy directory mode and paid drain stop before any effect", async () => {
  process.env.PERSON_TRANSITION_SUPPORT = "on";
  const effects = new Proxy(
    { TT_ORG_ID: org },
    {
      get(t, k) {
        return t[k] ?? (() => assert.fail(`unexpected effect ${String(k)}`));
      },
    },
  );
  await assert.rejects(
    runDirectory({
      lib: effects,
      reader: effects,
      workspaceId: randomUUID(),
      mode: "legacy",
    }),
    /person_directory_execution_unavailable/,
  );
  await assert.rejects(
    drainDirectoryEmbeddings({ lib: effects, workspaceId: randomUUID() }),
    /person_directory_execution_unavailable/,
  );
});
test("support-on direct save and embedding entrypoints stop before querying", async () => {
  process.env.PERSON_TRANSITION_SUPPORT = "on";
  const c = { query: () => assert.fail("unexpected query") };
  for (const name of [
    "saveDirectoryOnConnection",
    "claimDirectoryEmbeddingOnConnection",
    "saveDirectoryEmbeddingOnConnection",
  ])
    await assert.rejects(
      lib[name](c, {
        organizationId: org,
        receiptId: "1",
        mode: "live",
        token: randomUUID(),
        vector: [],
      }),
      /person_directory_execution_unavailable/,
    );
});
test("support-on TypeScript claim/stage/checkpoint/pending bridge uses checked RPCs", async () => {
  process.env.PERSON_TRANSITION_SUPPORT = "on";
  const c = await pool.connect();
  try {
    const workspaceId = randomUUID(),
      l = await lib.claimDirectoryScanOnConnection(c, {
        organizationId: org,
        workspaceId,
      }),
      key = { organizationId: org, workspaceId, token: l.token },
      s = snap();
    const a = await lib.stageDirectoryOnConnection(c, { ...key, snapshot: s });
    assert.equal(a.phase, "ready");
    assert.deepEqual(
      await lib.pendingDirectoryReceiptsOnConnection(c, { ...key, limit: 100 }),
      [a.receiptId],
    );
    assert.deepEqual(
      await lib.inspectDirectoryPageOnConnection(c, { ...key, snapshots: [s] }),
      [],
    );
    await lib.checkpointDirectoryScanOnConnection(c, {
      ...key,
      cursor: l.cursor,
      release: true,
    });
  } finally {
    c.release();
  }
});
test("truncate refuses before waiting on the controller", async () => {
  const hold = await pool.connect(),
    c = await pool.connect();
  try {
    await hold.query("begin");
    await hold.query("select pg_advisory_xact_lock(72005,0)");
    await c.query("set lock_timeout='100ms'");
    await assert.rejects(
      c.query("truncate person_directory_scans cascade"),
      /directory_input_truncate/,
    );
  } finally {
    await hold.query("rollback");
    await c.query("reset lock_timeout");
    hold.release();
    c.release();
  }
});
test("checked inspect matches completed retained input independently of legacy hash", async () => {
  const l = await claim(),
    s = snap(),
    a = await stage(l, s);
  // Seed a legacy completed cache with enforcement disabled. This test proves
  // retained input equivalence only, not genuine execution completion.
  await phase(false);
  try {
    await pool.query(
      "update person_directory_receipts set phase='done',projected=true where id=$1",
      [a.receiptId],
    );
  } finally { await phase(); }
  const inspect = (snapshot) =>
    use((c) =>
      rpc(c, "inspect", [
        org,
        l.workspace,
        l.token,
        [{ snapshot_hash: lib.directorySnapshotHash(s), snapshot }],
      ]),
    );
  assert.equal((await inspect(s))[0].receiptId, a.receiptId);
  await assert.rejects(
    inspect({ ...s, board: { ...s.board, name: "Changed" } }),
    /directory_input_collision/,
  );
  await pool.query(
    "delete from person_private.directory_inputs where receipt_id=$1",
    [a.receiptId],
  );
  assert.equal((await inspect(s))[0].phase, "input_review");
});
test("certificate hashes survive session timezone changes", async () => {
  const l = await claim(),
    s = snap(),
    a = await stage(l, s);
  await use(async (c) => {
    await c.query("set local timezone='Pacific/Auckland'");
    assert.equal(
      (
        await rpc(c, "stage", [
          org,
          l.workspace,
          l.token,
          lib.directorySnapshotHash(s),
          s,
        ])
      ).receiptId,
      a.receiptId,
    );
  });
});
for (const table of ["person_directory_scans", "person_directory_state"])
  for (const change of ["null", "alter"])
    test(`checked ${table} update detects ${change} trigger`, async () => {
      const l = await claim(),
        s = snap();
      await stage(l, s);
      const body =
        change === "null"
          ? "return null;"
          : `new.${table.endsWith("scans") ? "cycle" : "seen_cycle"}:=new.${table.endsWith("scans") ? "cycle" : "seen_cycle"}+1;return new;`;
      await trigger(table, "before update", body, () =>
        assert.rejects(
          table.endsWith("scans") ? checkpoint(l) : stage(l, s),
          /directory_input_/,
        ),
      );
    });
for (const lock of ["scan", "state"])
  test(`lease is rechecked after actual ${lock} row wait`, async () => {
    const l = await claim(),
      s = snap();
    await stage(l, s);
    await phase(false);
    await pool.query(
      "update person_directory_scans set lease_until=clock_timestamp()+interval '200 milliseconds' where workspace_id=$1",
      [l.workspace],
    );
    await phase();
    const hold = await pool.connect(),
      waiting = await pool.connect();
    let pending;
    try {
      await hold.query("begin");
      await hold.query(
        `select * from person_directory_${lock === "scan" ? "scans" : "state"} where workspace_id=$1 for update`,
        [l.workspace],
      );
      const pid = (await waiting.query("select pg_backend_pid() pid")).rows[0]
        .pid;
      pending = rpc(waiting, "stage", [
        org,
        l.workspace,
        l.token,
        lib.directorySnapshotHash(s),
        s,
      ]).then(
        () => null,
        (e) => e,
      );
      await waitLock(pid);
      await new Promise((r) => setTimeout(r, 210));
      await hold.query("commit");
      assert.match((await pending)?.message || "", /directory_input_lease/);
    } finally {
      await hold.query("rollback");
      if (pending) await pending;
      hold.release();
      waiting.release();
    }
  });
test("late lease expiry rolls back the entire new receipt and certificate", async () => {
  const l = await claim(),
    s = snap();
  await phase(false);
  await pool.query(
    "update person_directory_scans set lease_until=clock_timestamp()+interval '100 milliseconds' where workspace_id=$1",
    [l.workspace],
  );
  await phase();
  await trigger(
    "person_directory_receipts",
    "after insert",
    "perform pg_sleep(0.15);return new;",
    () => assert.rejects(stage(l, s), /directory_input_lease/),
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from person_directory_receipts where contact_id=$1",
        [s.board.contact_id],
      )
    ).rows[0].n,
    0,
  );
});
test("partial work credentials cannot select disabled raw insert path", async () => {
  await phase(false);
  await assert.rejects(
    use(async (c) => {
      await c.query(
        "set local person.work_token='00000000-0000-4000-8000-000000000001'",
      );
      await c.query(
        "insert into person_directory_scans(workspace_id) values($1)",
        [randomUUID()],
      );
    }),
    /directory_input_/,
  );
});
test("raw insert cannot forge source or state under required mode", async () => {
  const l = await claim(),
    s = snap(),
    a = await stage(l, s);
  await assert.rejects(
    use((c) =>
      c.query(
        "insert into person_directory_receipts(workspace_id,contact_id,snapshot_hash,snapshot) values($1,$2,$3,$4)",
        [l.workspace, randomUUID(), "a".repeat(64), s],
      ),
    ),
    /directory_input_/,
  );
  await assert.rejects(
    use((c) =>
      c.query(
        "insert into person_directory_state(contact_id,workspace_id,latest_receipt_id,seen_cycle) values($1,$2,$3,1)",
        [randomUUID(), l.workspace, a.receiptId],
      ),
    ),
    /directory_input_/,
  );
});
test("legacy write holds controller until commit and waiting legacy writer rechecks arm", async () => {
  await phase(false);
  const old = await pool.connect(),
    control = await pool.connect();
  let pending;
  try {
    await old.query("begin");
    await old.query(
      "insert into person_directory_scans(workspace_id) values($1)",
      [randomUUID()],
    );
    let pid = (await control.query("select pg_backend_pid() pid")).rows[0].pid;
    pending = control.query(
      "update person_private.transition_control set enabled=true where singleton",
    );
    await waitLock(pid);
    await old.query("commit");
    await pending;
    pending = null;
    await phase(false);
    await control.query("begin");
    await control.query(
      "update person_private.transition_control set enabled=true where singleton",
    );
    pid = (await old.query("select pg_backend_pid() pid")).rows[0].pid;
    pending = old
      .query("insert into person_directory_scans(workspace_id) values($1)", [
        randomUUID(),
      ])
      .then(
        () => null,
        (e) => e,
      );
    await waitLock(pid);
    await control.query("commit");
    assert.match((await pending)?.message || "", /directory_input_/);
  } finally {
    await old.query("rollback");
    await control.query("rollback");
    if (pending) await pending;
    old.release();
    control.release();
  }
});
test("numeric scale rewrite cannot corrupt certified immutable input", async () => {
  const l = await claim(),
    s = snap();
  s.harvest = { numeric: 1 };
  const a = await stage(l, s);
  await assert.rejects(
    use((c) =>
      c.query(
        "update person_directory_receipts set snapshot=jsonb_set(snapshot,'{harvest,numeric}','1.0'::jsonb) where id=$1",
        [a.receiptId],
      ),
    ),
    /directory_input_immutable/,
  );
});
test("certificate binding with altered numeric representation is rejected", async () => {
  const l = await claim(),
    s = snap();
  s.harvest = { numeric: 1 };
  await trigger(
    "person_private.directory_inputs",
    "before insert",
    "new.binding:=jsonb_set(new.binding,'{snapshot,harvest,numeric}','1.0'::jsonb);return new;",
    () => assert.rejects(stage(l, s), /directory_input_certificate/),
  );
});
test("checked stage accepts the existing string-phone snapshot form", async () => {
  const l = await claim(),
    s = snap();
  s.phones = ["+12025550123"];
  const r = await stage(l, s);
  assert.equal(r.phase, "ready");
  assert.equal((await stage(l, s)).receiptId, r.receiptId);
});
