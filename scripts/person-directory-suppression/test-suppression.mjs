import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import "../person-directory-outcomes/test-outcomes.mjs";
import * as lib from "../dist/worker-lib.mjs";
import {
  pool,
  org,
  rpc,
  phase,
  run,
  fixture,
  stageExisting,
  use,
} from "../person-directory-execution/test-execution.mjs";
import { assess } from "../person-directory-creation/test-creation.mjs";
import {
  app,
  processApp,
} from "../person-application-enrichment/test-tt-enrichment.mjs";
const row = async (id) =>
  (await pool.query("select person_private.publication_candidate($1) r", [id]))
    .rows[0].r;
const receipt = async (f) =>
  (
    await pool.query(
      "select to_jsonb(r) r from person_directory_receipts r where id=$1",
      [f.args.receiptId],
    )
  ).rows[0].r;
const state = async (f) =>
  (
    await pool.query(
      "select to_jsonb(s) s from person_directory_state s where contact_id=$1",
      [f.snapshot.board.contact_id],
    )
  ).rows[0].s;
const capture = (row) =>
  Object.fromEntries(
    Object.entries(row).filter(
      ([k]) =>
        ![
          "resume_embedding",
          "matching_embedding",
          "resume_text",
          "notes",
        ].includes(k),
    ),
  );
const evidence = async (id) =>
  use(async (c) => {
    await c.query(
      "begin;set local timezone='UTC';set local datestyle='ISO,YMD'",
    );
    const tables = [
      "candidate_profile_state",
      "candidate_sources",
      "candidate_identities",
      "candidate_experiences",
      "candidate_educations",
      "candidate_skills",
      "candidate_contacts",
      "person_directory_primary",
      "person_projection_state",
      "person_projection_history",
      "person_derivative_jobs",
      "person_audit_anchors",
      "person_audit_operations",
    ];
    const result = {};
    for (const table of tables)
      result[table] = (
        await c.query(
          `select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') rows from ${table} x where candidate_id=$1`,
          [id],
        )
      ).rows[0].rows;
    return result;
  });
async function setup(kind, mode) {
  const f = await fixture(
    (s) => {
      s.board.do_not_contact = true;
    },
    async (c, id) => {
      await c.query(
        "update candidates set resume_text='Synthetic retained resume',notes='Synthetic note',resume_embedding=$2::vector,matching_embedding=$2::vector where id=$1",
        [id, JSON.stringify(Array(1536).fill(0.25))],
      );
      if (kind === "already")
        await c.query(
          "update candidates set status='Do Not Contact' where id=$1",
          [id],
        );
    },
  );
  f.args.mode = mode;
  if (kind === "unmigrated" || kind === "anchorless") {
    await phase(false);
    await pool.query(
      "delete from candidate_profile_state where candidate_id=$1",
      [f.id],
    );
    await phase();
  }
  if (kind === "anchorless") {
    await pool.query("alter table person_audit_anchors disable trigger all");
    try {
      await pool.query(
        "delete from person_audit_anchors where candidate_id=$1",
        [f.id],
      );
    } finally {
      await pool.query("alter table person_audit_anchors enable trigger all");
    }
  }
  if (kind === "held") {
    await pool.query("alter table person_source_holds disable trigger all");
    try {
      await pool.query(
        "insert into person_source_holds(candidate_id,ledger_id,evidence_hash,reason,evidence) values($1,$2,'synthetic','harvest_cache_date_unknown','{}')",
        [f.id, randomUUID()],
      );
    } finally {
      await pool.query("alter table person_source_holds enable trigger all");
    }
  }
  return f;
}
for (const mode of ["live", "shadow"])
  for (const kind of ["normal", "already", "unmigrated", "held", "anchorless"])
    test(`${mode} suppression ${kind} changes only DNC without admitted facts`, async () => {
      const f = await setup(kind, mode),
        before = await row(f.id),
        beforeEvidence = await evidence(f.id),
        beforeState = await state(f),
        boundary = (
          await pool.query(
            "select coalesce(max(id),0)::text id from person_change_events where candidate_id=$1",
            [f.id],
          )
        ).rows[0].id;
      await pool.query(
        "update person_private.write_guard set enabled=true where id",
      );
      try {
        const out = await run(f);
        assert.deepEqual(out, {
          status: "suppressed",
          candidateId: f.id,
          created: false,
        });
        const after = await row(f.id);
        assert.deepEqual(
          { ...after, status: before.status, updated_at: before.updated_at },
          before,
        );
        assert.equal(after.status, "Do Not Contact");
        assert.deepEqual(await evidence(f.id), beforeEvidence);
        assert.deepEqual(await state(f), beforeState);
        const events = (
          await pool.query(
            "select to_jsonb(ev) ev from person_change_events ev where candidate_id=$1 and id>$2 and source_table='candidates'",
            [f.id, boundary],
          )
        ).rows.map((x) => x.ev);
        assert.equal(events.length, kind === "already" ? 0 : 1);
        if (kind === "already") assert.deepEqual(after, before);
        else {
          assert.deepEqual(events[0].previous_payload, capture(before));
          assert.deepEqual(events[0].payload, capture(after));
          assert.equal(events[0].operation, "UPDATE");
        }
        const r = await receipt(f);
        assert.equal(r.phase, "suppressed");
        assert.equal(r.candidate_id, f.id);
        assert.equal(r.attempts, 1);
        assert.equal(r.documents, null);
        assert.equal(r.projected, false);
        assert.deepEqual(r.source_reviews, []);
        assert.equal(r.derivative_text, null);
        await phase(true, "held");
        assert.deepEqual(await run(f), out);
        assert.deepEqual(await row(f.id), after);
        await phase();
      } finally {
        await pool.query(
          "update person_private.write_guard set enabled=false where id",
        );
      }
    });
for (const frame of ["candidate", "projection"])
  test(`already DNC rejects nested ${frame} authority`, async () => {
    const f = await setup("already", "live");
    await assert.rejects(
      run(f, async (sql, v, c) => {
        if (sql.includes("directory_outcome(")) {
          if (frame === "candidate")
            await c.query(
              "insert into person_private.directory_candidate_frames(backend_pid,transaction_id,execution_id,before_row,after_row) select pg_backend_pid(),pg_current_xact_id(),id,person_private.publication_candidate($2),person_private.publication_candidate($2) from person_private.directory_executions where id=$1",
              [f.args.executionId, f.id],
            );
          else
            await c.query(
              "insert into person_private.directory_projection_frames(backend_pid,transaction_id,work_id,candidate_id,operation_id,before_profile,after_profile,execution_id) select pg_backend_pid(),pg_current_xact_id(),work_id,$2,gen_random_uuid(),'{}','{}',id from person_private.directory_executions where id=$1",
              [f.args.executionId, f.id],
            );
        }
      }),
      /directory_suppression_nested/,
    );
    assert.equal((await receipt(f)).phase, "ready");
  });
for (const [table, action, when] of [
  [
    "person_private.directory_candidate_frames",
    "return null;",
    "before delete",
  ],
  ["candidates", "return null;", "before update"],
  ["candidates", "new.full_name:='Unproved';return new;", "before update"],
  [
    "person_private.directory_candidate_frames",
    "return null;",
    "before insert",
  ],
  [
    "person_private.directory_candidate_frames",
    'new.after_row:=new.after_row||\'{"status":"Active"}\';return new;',
    "before insert",
  ],
  ["person_change_events", "return null;", "before insert"],
  ["person_change_events", "new.payload:='{}';return new;", "before insert"],
  [
    "person_private.directory_outcomes",
    "new.suppression:=null;return new;",
    "before insert",
  ],
  [
    "person_private.directory_outcomes",
    "new.suppression:=jsonb_set(new.suppression,'{event}','null');return new;",
    "before insert",
  ],
  ["person_directory_receipts", "return null;", "before update"],
  [
    "person_directory_receipts",
    "new.result:='{}';return new;",
    "before update",
  ],
])
  test(`suppression ${table} ${action} cannot commit partial result`, async () => {
    const f = await setup("normal", "live"),
      before = await row(f.id),
      beforeEvidence = await evidence(f.id);
    try {
      await assert.rejects(
        run(f, async (sql, v, c) => {
          if (sql.includes("directory_outcome("))
            await c.query(
              `create function person_private.synthetic_suppression() returns trigger language plpgsql as $$begin ${action}end$$;create trigger zz_suppression ${when} on ${table} for each row execute function person_private.synthetic_suppression()`,
            );
        }),
        /directory_|candidate_|null value|no rows|audit_|transition_/,
      );
      assert.deepEqual(await row(f.id), before);
      assert.deepEqual(await evidence(f.id), beforeEvidence);
      assert.equal((await receipt(f)).phase, "ready");
    } finally {
      await pool.query(
        `drop trigger if exists zz_suppression on ${table};drop function if exists person_private.synthetic_suppression()`,
      );
    }
  });
for (const boundary of ["receipt", "finish", "commit"])
  test(`late ${boundary} suppression witness corruption rolls back status`, async () => {
    const f = await setup("normal", "live"),
      before = await row(f.id);
    try {
      await assert.rejects(
        run(f, async (sql, v, c) => {
          if (sql.includes("directory_outcome(") && boundary !== "commit")
            await c.query(
              `create function person_private.synthetic_suppression_late() returns trigger language plpgsql as $$begin update person_private.directory_outcomes set suppression=jsonb_set(suppression,'{event}','null');return new;end$$;create trigger zz_suppression_late after update on ${boundary === "receipt" ? "person_directory_receipts" : "person_private.transition_work"} for each row execute function person_private.synthetic_suppression_late()`,
            );
          if (sql === "commit" && boundary === "commit")
            await c.query(
              "update person_private.directory_outcomes set suppression=jsonb_set(suppression,'{event}','null') where execution_id=$1",
              [f.args.executionId],
            );
        }),
        /directory_outcome|directory_execution_incomplete/,
      );
      assert.deepEqual(await row(f.id), before);
      assert.equal((await receipt(f)).phase, "ready");
    } finally {
      await pool.query(
        `drop trigger if exists zz_suppression_late on ${boundary === "receipt" ? "person_directory_receipts" : "person_private.transition_work"};drop function if exists person_private.synthetic_suppression_late()`,
      );
    }
  });
for (const when of ["before", "after"])
  test(`late ${when} candidate trigger expiry rolls back suppression`, async () => {
    const f = await setup("normal", "live"),
      before = await row(f.id);
    try {
      await assert.rejects(
        run(f, async (sql, v, c) => {
          if (sql.includes("directory_outcome("))
            await c.query(
              `create function person_private.synthetic_suppression_expire() returns trigger language plpgsql as $$begin update person_private.transition_work set lease_until=clock_timestamp()-interval '1 second' where id=current_setting('person.work_id')::uuid;return new;end$$;create trigger zz_suppression_expire ${when} update on candidates for each row execute function person_private.synthetic_suppression_expire()`,
            );
        }),
        /transition_expired/,
      );
      assert.deepEqual(await row(f.id), before);
      assert.equal((await receipt(f)).phase, "ready");
    } finally {
      await pool.query(
        "drop trigger if exists zz_suppression_expire on candidates;drop function if exists person_private.synthetic_suppression_expire()",
      );
    }
  });
test("fresh suppression still respects global controller hold", async () => {
  const f = await setup("normal", "live"),
    before = await row(f.id);
  await phase(true, "held");
  await assert.rejects(run(f), /directory_held/);
  assert.deepEqual(await row(f.id), before);
  assert.equal((await receipt(f)).phase, "ready");
  await phase();
});
test("status-label suppression retains audit compatibility with later application and directory writes", async () => {
  const f = await fixture((s) => {
    s.board.status = "Do Not Contact";
  });
  f.args.mode = "live";
  const out = await run(f);
  assert.equal(out.status, "suppressed");
  const initial = await assess(f.id, f);
  assert.equal(initial.status, "pending");
  assert.equal(initial.reason, "directory_snapshot_not_admitted");
  const applied = await processApp(
    await app(
      { email: randomUUID() + "@example.test" },
      f.before.linkedin_username,
    ),
  );
  assert.equal(applied.status, "processed", applied.error?.message);
  assert.equal((await row(f.id)).status, "Do Not Contact");
  const snapshot = structuredClone(f.snapshot);
  snapshot.board.status = "Active";
  const current = await row(f.id);
  snapshot.board.name = current.full_name;
  snapshot.board.title = current.current_title;
  snapshot.board.updated_at = "2026-09-28";
  const newer = await rpc(pool, "public.person_directory_stage", [
    org,
    f.args.workspaceId,
    f.token,
    lib.directorySnapshotHash(snapshot),
    snapshot,
  ]);
  const next = {
    ...f,
    snapshot,
    args: { ...f.args, receiptId: newer.receiptId, executionId: randomUUID() },
  };
  const later = await run(next);
  assert.equal(later.status, "done");
  const after = await row(f.id);
  assert.equal(after.status, "Do Not Contact");
  const audit = await assess(f.id, next);
  assert.equal(audit.status, "verified", audit.reason);
  assert.deepEqual(await run(f), out);
  assert.deepEqual(await row(f.id), after);
});
test("suppression refuses work expired during an actual candidate row wait", async () => {
  const f = await setup("normal", "live"),
    before = await row(f.id),
    holder = await pool.connect();
  let pending,
    pid,
    observed = false;
  try {
    await holder.query("begin");
    await holder.query("select id from candidates where id=$1 for update", [
      f.id,
    ]);
    pending = run(f, async (sql, v, c) => {
      if (sql.includes("directory_outcome(")) {
        pid = (await c.query("select pg_backend_pid() pid")).rows[0].pid;
        await c.query(
          "update person_private.transition_work set lease_until=clock_timestamp()+interval '300 milliseconds' where id=current_setting('person.work_id')::uuid",
        );
      }
    }).then(
      () => null,
      (e) => e,
    );
    for (let n = 0; n < 100; n++) {
      if (
        pid &&
        (
          await pool.query(
            "select wait_event_type='Lock' waiting from pg_stat_activity where pid=$1",
            [pid],
          )
        ).rows[0]?.waiting
      ) {
        observed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(observed, true);
    await new Promise((r) => setTimeout(r, 320));
    await holder.query("rollback");
    assert.match((await pending)?.message || "", /transition_expired/);
    assert.deepEqual(await row(f.id), before);
    assert.equal((await receipt(f)).phase, "ready");
  } finally {
    await holder.query("rollback");
    if (pending) await pending;
    holder.release();
  }
});
test("private suppression capability remains inaccessible to browser and service roles", async () => {
  for (const role of ["service_role", "anon", "authenticated"])
    for (const fn of [
      "directory_suppression_change(uuid,jsonb,jsonb)",
      "directory_suppression_valid(uuid,jsonb,jsonb)",
    ])
      assert.equal(
        (
          await pool.query(
            "select has_function_privilege($1,$2,'EXECUTE') allowed",
            [role, "person_private." + fn],
          )
        ).rows[0].allowed,
        false,
      );
});
test("standalone status mutation cannot commit before receipt and work completion", async () => {
  const f = await setup("normal", "live"),
    before = await row(f.id);
  await use(async (c) => {
    await c.query("begin");
    await rpc(c, "person_private.directory_begin", [
      org,
      f.args.workspaceId,
      f.args.receiptId,
      f.args.executionId,
      f.args.mode,
      randomUUID(),
    ]);
    const identities = JSON.stringify(lib.directoryIdentities(f.snapshot)),
      observed = await rpc(c, "person_private.directory_outcome_observe", [
        f.args.executionId,
        identities,
      ]);
    await rpc(c, "person_private.directory_suppression_change", [
      f.args.executionId,
      identities,
      observed,
    ]);
    await assert.rejects(c.query("commit"), /directory_execution_incomplete/);
  });
  assert.deepEqual(await row(f.id), before);
  assert.equal((await receipt(f)).phase, "ready");
});
for (const mode of ["live", "shadow"])
  test(`already DNC ${mode} with NULL legacy update date is an exact no-op`, async () => {
    const f = await setup("already", mode);
    await phase(false);
    await pool.query("update candidates set updated_at=null where id=$1", [
      f.id,
    ]);
    await phase();
    const before = await row(f.id);
    assert.equal(before.updated_at, null);
    assert.deepEqual(await run(f), {
      status: "suppressed",
      candidateId: f.id,
      created: false,
    });
    assert.deepEqual(await row(f.id), before);
  });
test("a discarded first suppression witness cannot be replaced by a no-op completion", async () => {
  const f = await setup("normal", "live"),
    before = await row(f.id);
  await use(async (c) => {
    await c.query("begin");
    await rpc(c, "person_private.directory_begin", [
      org,
      f.args.workspaceId,
      f.args.receiptId,
      f.args.executionId,
      f.args.mode,
      randomUUID(),
    ]);
    const identities = JSON.stringify(lib.directoryIdentities(f.snapshot)),
      observed = await rpc(c, "person_private.directory_outcome_observe", [
        f.args.executionId,
        identities,
      ]);
    await rpc(c, "person_private.directory_suppression_change", [
      f.args.executionId,
      identities,
      observed,
    ]);
    await assert.rejects(
      rpc(c, "person_private.directory_outcome", [
        f.args.executionId,
        identities,
      ]),
      /directory_suppression|directory_outcome_order/,
    );
  });
  assert.deepEqual(await row(f.id), before);
  assert.equal((await receipt(f)).phase, "ready");
});
for (const action of ["return null;", "new.candidate_id:=null;return new;"])
  test(`suppression binding ${action} cannot permit an unrecorded mutation`, async () => {
    const f = await setup("normal", "live"),
      before = await row(f.id);
    try {
      await assert.rejects(
        run(f, async (sql, v, c) => {
          if (sql.includes("directory_outcome("))
            await c.query(
              `create function person_private.synthetic_suppression_binding() returns trigger language plpgsql as $$begin if new.candidate_id is not null and old.candidate_id is null then ${action}end if;return new;end$$;create trigger zz_suppression_binding before update on person_private.directory_executions for each row execute function person_private.synthetic_suppression_binding()`,
            );
        }),
        /directory_suppression_binding/,
      );
      assert.deepEqual(await row(f.id), before);
      assert.equal((await receipt(f)).phase, "ready");
    } finally {
      await pool.query(
        "drop trigger if exists zz_suppression_binding on person_private.directory_executions;drop function if exists person_private.synthetic_suppression_binding()",
      );
    }
  });

export { setup, row, receipt, state, evidence };
