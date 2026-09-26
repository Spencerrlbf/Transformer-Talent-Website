import assert from "node:assert/strict";
import { test, after } from "node:test";
import pg from "pg";
import * as lib from "../dist/worker-lib.mjs";
import { prepareAuditFixture } from "./local-fixture.mjs";
const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw Error("local_database_required");
const db = new pg.Pool({ connectionString: url, max: 4 });
after(() => db.end());
const id = (n) => `d8000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function seed(n, anchored = true) {
  await db.query(
    "insert into candidates(id,full_name,linkedin_username,current_title,current_company,created_at) values($1,'Synthetic Guard',$2,'Engineer','Synthetic Co','2020-01-01')",
    [id(n), `guard-${n}`],
  );
  if (anchored) await prepareAuditFixture(id(n));
}
async function tx(n, fn) {
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query(
      "set local statement_timeout='15s';set local lock_timeout='3s'",
    );
    await c.query("select pg_advisory_xact_lock_shared(72005,0)");
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [id(n)]);
    const before = (
      await c.query("select * from candidates where id=$1 for update", [id(n)])
    ).rows[0];
    const r = await fn(c, before);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
const open = (c, before, writer = "projection") =>
  lib.beginGuardedAuditOperationLocked(c, before, {
    writer,
    receiptRef: `${writer}:${crypto.randomUUID()}`,
  });
const change = (c, op, n, title) =>
  lib.attributeAuditMutation(
    c,
    op,
    { scope: "profile", table: "candidates", rowId: id(n) },
    () =>
      c.query(
        "update candidates set current_title=$2 where id=$1 returning id",
        [id(n), title],
      ),
  );
test("guard and mutation interfaces exist", () => {
  assert.equal(typeof lib.beginGuardedAuditOperationLocked, "function");
  assert.equal(typeof lib.attributeAuditMutation, "function");
});
test("missing anchor refuses source changes before creating an operation", async () => {
  await seed(1, false);
  await assert.rejects(
    tx(1, (c, b) => open(c, b)),
    /audit_anchor_required/,
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from person_audit_operations where candidate_id=$1",
        [id(1)],
      )
    ).rows[0].n,
    0,
  );
});
test("exact attributed transitions permit the next guarded write", async () => {
  await seed(2);
  await tx(2, async (c, b) => {
    const op = await open(c, b);
    await change(c, op, 2, "Staff Engineer");
  });
  await tx(2, async (c, b) => {
    const op = await open(c, b);
    await change(c, op, 2, "Principal Engineer");
  });
  const rows = (
    await db.query(
      "select * from person_change_attributions where candidate_id=$1",
      [id(2)],
    )
  ).rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.scope === "profile"));
});
test("an unattributed source edit between valid operations cannot be laundered", async () => {
  await seed(3);
  await tx(3, async (c, b) => {
    await change(c, await open(c, b), 3, "Staff Engineer");
  });
  await db.query(
    "update candidates set current_title='Unknown change' where id=$1",
    [id(3)],
  );
  await assert.rejects(
    tx(3, (c, b) => open(c, b)),
    /audit_unattributed_change/,
  );
});
test("mixed field scopes roll back the covered mutation and operation", async () => {
  await seed(4);
  await assert.rejects(
    tx(4, async (c, b) => {
      const op = await open(c, b);
      await lib.attributeAuditMutation(
        c,
        op,
        { scope: "profile", table: "candidates", rowId: id(4) },
        () =>
          c.query(
            "update candidates set current_title='Mixed',linkedin_data='{}' where id=$1 returning id",
            [id(4)],
          ),
      );
    }),
    /audit_event_fields/,
  );
  assert.equal(
    (
      await db.query("select current_title from candidates where id=$1", [
        id(4),
      ])
    ).rows[0].current_title,
    "Engineer",
  );
});
test("mutable captured evidence is rehashed rather than trusted through an attribution join", async () => {
  await seed(5);
  await tx(5, async (c, b) => {
    await change(c, await open(c, b), 5, "Staff Engineer");
  });
  await db.query(
    "update person_change_events set payload=jsonb_set(payload,'{location}','\"Altered\"') where id=(select max(event_id) from person_change_attributions where candidate_id=$1)",
    [id(5)],
  );
  await assert.rejects(
    tx(5, (c, b) => open(c, b)),
    /audit_attribution_invalid/,
  );
});
test("workflow changes and raw ledgers are not mistaken for candidate source drift", async () => {
  await seed(6);
  await db.query(
    "update candidates set status='Do Not Contact',notes='Synthetic workflow' where id=$1",
    [id(6)],
  );
  await db.query(
    "insert into candidate_enrichments(candidate_id,organization_id,linkedin_username,raw_payload) values($1,'801865a7-6533-41d2-9c45-e4a90e6ad51a','guard-6','{}')",
    [id(6)],
  );
  await tx(6, (c, b) => open(c, b));
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from person_change_attributions a join person_change_events e on e.id=a.event_id where a.candidate_id=$1 and e.source_table='candidate_enrichments'",
        [id(6)],
      )
    ).rows[0].n,
    0,
  );
});
test("auxiliary edits refuse publication without replacing the legacy witness", async () => {
  await seed(7);
  const a = (
    await db.query(
      "select anchor_hash from person_audit_anchors where candidate_id=$1",
      [id(7)],
    )
  ).rows[0].anchor_hash;
  await db.query(
    "insert into candidate_emails_v2(candidate_id,email_raw,email_normalized) values($1,'changed@example.test','changed@example.test')",
    [id(7)],
  );
  await assert.rejects(
    tx(7, (c, b) => open(c, b)),
    /audit_auxiliary_changed/,
  );
  assert.equal(
    (
      await db.query(
        "select anchor_hash from person_audit_anchors where candidate_id=$1",
        [id(7)],
      )
    ).rows[0].anchor_hash,
    a,
  );
});
test("validated operation boundaries keep more than200 legitimate writes bounded", async () => {
  await seed(8);
  for (let i = 0; i < 205; i++)
    await tx(8, async (c, b) => {
      await change(c, await open(c, b), 8, `Role ${i}`);
    });
  await tx(8, (c, b) => open(c, b));
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from person_change_attributions where candidate_id=$1",
        [id(8)],
      )
    ).rows[0].n,
    205,
  );
});
test("a historical uncheckpointed capture overflow refuses publication", async () => {
  await seed(9);
  for (let i = 0; i < 201; i++)
    await db.query("update candidates set status=$2 where id=$1", [
      id(9),
      `workflow-${i}`,
    ]);
  await assert.rejects(
    tx(9, (c, b) => open(c, b)),
    /audit_event_limit/,
  );
});
test("a proven DNC-only receipt permits a newly verified legacy anchor", async () => {
  await seed(10, false);
  await db.query(
    "insert into person_directory_scans(workspace_id) values($1)",
    [id(5010)],
  );
  await db.query(
    "insert into person_directory_receipts(workspace_id,contact_id,snapshot_hash,snapshot,candidate_id,phase,result) values($1,$2,'synthetic',$3,$4,'suppressed',$5)",
    [
      id(5010),
      id(6010),
      { board: { do_not_contact: true } },
      id(10),
      { status: "suppressed", candidateId: id(10), created: false },
    ],
  );
  await db.query("update candidates set status='Do Not Contact' where id=$1", [
    id(10),
  ]);
  await prepareAuditFixture(id(10));
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from person_audit_anchors where candidate_id=$1",
        [id(10)],
      )
    ).rows[0].n,
    1,
  );
});
test("candidate contract dates have a fixed interpretation across session timezones", async () => {
  const c = await db.connect();
  try {
    const value = { id: id(99), created_at: "2020-01-01" };
    await c.query("set timezone='UTC'");
    const a = (
      await c.query("select person_private.audit_candidate_hash($1::jsonb) h", [
        value,
      ])
    ).rows[0].h;
    await c.query("set timezone='America/New_York'");
    const b = (
      await c.query("select person_private.audit_candidate_hash($1::jsonb) h", [
        value,
      ])
    ).rows[0].h;
    assert.equal(a, b);
  } finally {
    await c.query("reset timezone");
    c.release();
  }
});
async function createTx(n, fn, { receipt = true } = {}) {
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query(
      "set local lock_timeout='3s';set local statement_timeout='15s'",
    );
    await c.query("select pg_advisory_xact_lock_shared(72005,0)");
    await c.query(
      "insert into candidates(id,full_name,linkedin_username,linkedin_url,source,status) values($1,'Synthetic Created',$2::text,'https://www.linkedin.com/in/'||$2::text,'website_applicant','applicant')",
      [id(n), `created-${n}`],
    );
    if (receipt) {
      await c.query(
        "insert into website_applications(id,organization_id,name,email,candidate_id) values($1,'801865a7-6533-41d2-9c45-e4a90e6ad51a','Synthetic Created','synthetic@example.test',$2)",
        [id(n + 1000), id(n)],
      );
      await c.query(
        "insert into person_application_receipts(application_id,candidate_id,created_person,documents,application_snapshot) values($1,$2,true,'[]',$3)",
        [
          id(n + 1000),
          id(n),
          { name: "Synthetic Created", linkedin_username: `created-${n}` },
        ],
      );
    }
    const before = (
      await c.query("select * from candidates where id=$1 for update", [id(n)])
    ).rows[0];
    const r = await fn(c, before);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
const createOp = (c, b, n) =>
  lib.createReceiptAuditAnchorLocked(c, b, {
    writer: "application",
    receiptRef: `application:${id(n + 1000)}`,
  });
test("new person seed is bound to its real receipt with no invented legacy source", async () => {
  assert.equal(typeof lib.createReceiptAuditAnchorLocked, "function");
  await createTx(20, (c, b) => createOp(c, b, 20));
  const a = (
    await db.query("select * from person_audit_anchors where candidate_id=$1", [
      id(20),
    ])
  ).rows[0];
  assert.equal(a.kind, "receipt_created");
  assert.equal(a.legacy_doc, null);
  assert.equal(a.source_catalog.length, 0);
  assert.ok(a.external_proof.creator_event_id);
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from person_change_attributions where candidate_id=$1 and scope='creation'",
        [id(20)],
      )
    ).rows[0].n,
    1,
  );
  await tx(20, (c, b) => open(c, b));
});
test("a formatted creator reference without an actual receipt cannot authorize a person", async () => {
  await assert.rejects(
    createTx(21, (c, b) => createOp(c, b, 21), { receipt: false }),
    /audit_creation_receipt/,
  );
  assert.equal(
    (await db.query("select 1 from candidates where id=$1", [id(21)])).rowCount,
    0,
  );
});
test("creation and evidence roll back together after attribution", async () => {
  await assert.rejects(
    createTx(22, async (c, b) => {
      await createOp(c, b, 22);
      throw Error("injected_creation_failure");
    }),
    /injected_creation_failure/,
  );
  for (const table of [
    "candidates",
    "person_audit_anchors",
    "person_audit_operations",
  ])
    assert.equal(
      (
        await db.query(
          `select count(*)::int n from ${table} where ${table === "candidates" ? "id" : "candidate_id"}=$1`,
          [id(22)],
        )
      ).rows[0].n,
      0,
    );
});
test("a nonempty profile mutation before creation anchoring stays unexplained", async () => {
  await assert.rejects(
    createTx(23, async (c, b) => {
      await c.query(
        "update candidates set current_title='Unproven' where id=$1",
        [id(23)],
      );
      return createOp(c, b, 23);
    }),
    /audit_unattributed_change/,
  );
});
test("generic live save refuses an unanchored person and retains no partial facts", async () => {
  await seed(30, false);
  const row = (
    await db.query("select to_jsonb(c) r from candidates c where id=$1", [
      id(30),
    ])
  ).rows[0].r;
  const c = await db.connect();
  try {
    await assert.rejects(
      lib.savePersonOnConnection(c, lib.fromLegacyImport(row), {
        mode: "live",
      }),
      /audit_anchor_required/,
    );
  } finally {
    c.release();
  }
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from candidate_sources where candidate_id=$1",
        [id(30)],
      )
    ).rows[0].n,
    0,
  );
});
test("generic live projection and conditional undo keep exact source documents and event links", async () => {
  await seed(31);
  const raw = {
    headline: "Synthetic new facts",
    experience: [
      {
        position: "Staff Engineer",
        companyName: "Synthetic Co",
        startDate: { year: 2025, month: 1 },
      },
    ],
  };
  const ledger = {
    id: id(6031),
    candidate_id: id(31),
    organization_id: "801865a7-6533-41d2-9c45-e4a90e6ad51a",
    provider: "harvest",
    status: "ok",
    cache_status: "miss",
    created_at: "2026-09-01T00:00:00.000Z",
  };
  await db.query(
    "insert into candidate_enrichments(id,candidate_id,organization_id,created_at,raw_payload) values($1,$2,$3,$4,$5)",
    [
      ledger.id,
      ledger.candidate_id,
      ledger.organization_id,
      ledger.created_at,
      raw,
    ],
  );
  const doc = lib.fromHarvest(raw, ledger, id(31));
  const c = await db.connect();
  let result;
  try {
    result = await lib.savePersonOnConnection(c, doc, { mode: "live" });
    assert.equal(
      (await lib.undoPersonProjectionOnConnection(c, id(31), result.revision))
        .status,
      "restored",
    );
  } finally {
    c.release();
  }
  const operations = (
    await db.query(
      "select writer,evidence from person_audit_operations where candidate_id=$1 order by created_at",
      [id(31)],
    )
  ).rows;
  assert.equal(operations.length, 2);
  assert.deepEqual(operations[0].evidence.documents, [doc]);
  assert.equal(operations[1].writer, "undo");
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from person_change_attributions where candidate_id=$1 and scope='profile'",
        [id(31)],
      )
    ).rows[0].n,
    2,
  );
});

test("a callback updating the wrong person cannot pass with zero matching events", async () => {
  await seed(40);
  await seed(41);
  await assert.rejects(
    tx(40, async (c, b) => {
      const op = await open(c, b);
      await lib.attributeAuditMutation(
        c,
        op,
        { scope: "profile", table: "candidates", rowId: id(40) },
        () =>
          c.query(
            "update candidates set current_title='Wrong target' where id=$1 returning id",
            [id(41)],
          ),
      );
    }),
    /audit_mutation_scope/,
  );
  assert.equal(
    (
      await db.query("select current_title from candidates where id=$1", [
        id(41),
      ])
    ).rows[0].current_title,
    "Engineer",
  );
});
test("a genuine zero-row update is accepted without fabricated evidence", async () => {
  await seed(42);
  await tx(42, async (c, b) => {
    const op = await open(c, b);
    await lib.attributeAuditMutation(
      c,
      op,
      { scope: "profile", table: "candidates", rowId: id(42) },
      () =>
        c.query(
          "update candidates set current_title='Unused' where id=$1 and false returning id",
          [id(42)],
        ),
    );
  });
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from person_change_attributions where candidate_id=$1",
        [id(42)],
      )
    ).rows[0].n,
    0,
  );
});
test("an application receipt for a different LinkedIn identity cannot authorize creation", async () => {
  await assert.rejects(
    createTx(43, async (c, b) => {
      await c.query(
        "update person_application_receipts set application_snapshot=jsonb_set(application_snapshot,'{linkedin_username}','\"someone-else\"') where application_id=$1",
        [id(1043)],
      );
      return createOp(c, b, 43);
    }),
    /audit_creation_receipt/,
  );
});

test("a one-row update with missing capture fails and rolls back", async () => {
  await seed(44);
  await assert.rejects(
    tx(44, async (c, b) => {
      const op = await open(c, b);
      await c.query(
        "alter table candidates disable trigger person_capture_change",
      );
      await change(c, op, 44, "Uncaptured");
    }),
    /audit_mutation_scope/,
  );
  assert.equal(
    (
      await db.query("select current_title from candidates where id=$1", [
        id(44),
      ])
    ).rows[0].current_title,
    "Engineer",
  );
  assert.equal(
    (
      await db.query(
        "select tgenabled from pg_trigger where tgrelid='candidates'::regclass and tgname='person_capture_change'",
      )
    ).rows[0].tgenabled,
    "O",
  );
});
test("timestamped auxiliary proofs are stable across writer session timezones", async () => {
  await seed(45, false);
  await db.query(
    "insert into candidate_emails_v2(candidate_id,email_raw,email_normalized,created_at) values($1,'guard45@example.test','guard45@example.test','2026-09-01T01:00:00Z')",
    [id(45)],
  );
  await prepareAuditFixture(id(45));
  const c = await db.connect();
  try {
    const doc = (
      await c.query(
        "select legacy_doc from person_audit_anchors where candidate_id=$1",
        [id(45)],
      )
    ).rows[0].legacy_doc;
    for (const zone of ["UTC", "America/New_York", "Asia/Tokyo"]) {
      await c.query("select set_config('timezone',$1,false)", [zone]);
      await lib.savePersonOnConnection(c, doc, { mode: "shadow" });
    }
  } finally {
    await c.query("reset timezone");
    c.release();
  }
});
