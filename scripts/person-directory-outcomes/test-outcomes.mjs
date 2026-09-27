import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fresh } from "../person-directory-creation/test-creation.mjs";
import {
  pool,
  org,
  rpc,
  phase,
  run,
  fixture,
  use,
} from "../person-directory-execution/test-execution.mjs";
import * as lib from "../dist/worker-lib.mjs";
const row = async (id) =>
  (await pool.query("select person_private.publication_candidate($1) r", [id]))
    .rows[0].r;
const state = async (f) =>
  (
    await pool.query(
      "select to_jsonb(s) s from person_directory_state s where contact_id=$1",
      [f.snapshot.board.contact_id],
    )
  ).rows[0].s;
const receipt = async (f) =>
  (
    await pool.query(
      "select to_jsonb(r) r from person_directory_receipts r where id=$1",
      [f.args.receiptId],
    )
  ).rows[0].r;
async function unchangedOutcome(f, want, id) {
  const beforeState = await state(f),
    before = id ? await row(id) : null,
    out = await run(f);
  assert.deepEqual(out, want);
  assert.deepEqual(await state(f), beforeState);
  if (id) assert.deepEqual(await row(id), before);
  const r = await receipt(f);
  assert.equal(r.phase, want.status);
  assert.deepEqual(r.result, want);
  assert.equal(r.projected, false);
  assert.equal(r.documents, null);
  assert.equal(r.derivative_text, null);
  assert.equal(r.created_person, false);
  assert.equal(
    (
      await pool.query(
        "select status from person_private.transition_work w join person_private.directory_executions e on e.work_id=w.id where e.id=$1",
        [f.args.executionId],
      )
    ).rows[0].status,
    "completed",
  );
  assert.deepEqual(await run(f), want);
  await phase(true, "held");
  assert.deepEqual(await run(f), want);
  await phase();
}
test("unknown person without LinkedIn gets a durable review with no candidate", async () => {
  const f = await fresh("live", (s) => {
    s.board.linkedin_url = null;
  });
  await unchangedOutcome(f, {
    status: "review",
    reason: "directory_linkedin_required",
  });
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from candidates where linkedin_username=$1",
        [f.username],
      )
    ).rows[0].n,
    0,
  );
});
for (const mode of ["live", "shadow"])
  test(`unknown suppressed ${mode} input completes without admitting a candidate`, async () => {
    const f = await fresh(mode, (s) => {
      s.board.do_not_contact = true;
    });
    await unchangedOutcome(f, {
      status: "suppressed",
      candidateId: null,
      created: false,
    });
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from candidates where linkedin_username=$1",
          [f.username],
        )
      ).rows[0].n,
      0,
    );
  });
test("multiple identity owners are retained unchanged in a durable review", async () => {
  const one = await fixture(),
    two = await fixture(),
    f = await fresh("live", (s) => {
      s.board.linkedin_url = one.snapshot.board.linkedin_url;
      s.identifiers = [
        { kind: "linkedin_username", value: two.before.linkedin_username },
      ];
    }),
    before = await row(two.id);
  await unchangedOutcome(
    f,
    { status: "review", reason: "directory_identity_conflict" },
    one.id,
  );
  assert.deepEqual(await row(two.id), before);
});
test("a different directory linkage is reviewed without claiming that candidate", async () => {
  const f = await fixture(
    () => {},
    async (c, id) => {
      await c.query(
        "update candidates set directory_contact_id=$2 where id=$1",
        [id, randomUUID()],
      );
    },
  );
  f.args.mode = "live";
  await unchangedOutcome(
    f,
    { status: "review", reason: "directory_linkage_conflict" },
    f.id,
  );
  assert.equal((await receipt(f)).candidate_id, null);
});
test("unmigrated existing person is reviewed without changing profile or applied marker", async () => {
  const f = await fixture();
  await phase(false);
  await pool.query(
    "delete from candidate_profile_state where candidate_id=$1",
    [f.id],
  );
  await phase();
  await unchangedOutcome(
    f,
    {
      status: "review",
      candidateId: f.id,
      reason: "directory_person_not_migrated",
    },
    f.id,
  );
});
test("source hold is durably reviewed without touching the held person", async () => {
  const f = await fixture();
  await pool.query("alter table person_source_holds disable trigger all");
  try {
    await pool.query(
      "insert into person_source_holds(candidate_id,ledger_id,evidence_hash,reason,evidence) values($1,$2,'synthetic','harvest_cache_date_unknown','{}')",
      [f.id, randomUUID()],
    );
  } finally {
    await pool.query("alter table person_source_holds enable trigger all");
  }
  await unchangedOutcome(
    f,
    { status: "review", candidateId: f.id, reason: "directory_source_hold" },
    f.id,
  );
});
test("superseded ready receipt cannot acknowledge or change the newer input", async () => {
  const f = await fresh();
  await phase(false);
  await pool.query(
    "update person_directory_receipts set phase='review' where id=$1",
    [f.args.receiptId],
  );
  await phase();
  const snapshot = structuredClone(f.snapshot);
  snapshot.board.title = "Newer";
  snapshot.board.updated_at = "2026-09-28";
  const newer = await rpc(pool, "public.person_directory_stage", [
    org,
    f.args.workspaceId,
    f.token,
    lib.directorySnapshotHash(snapshot),
    snapshot,
  ]);
  await phase(false);
  await pool.query(
    "update person_directory_receipts set phase='ready' where id=$1",
    [f.args.receiptId],
  );
  await phase();
  const next = { ...f, args: { ...f.args, receiptId: newer.receiptId } };
  const nextBefore = await receipt(next);
  await unchangedOutcome(f, { status: "superseded" });
  assert.deepEqual(await receipt(next), nextBefore);
});
test("late receipt trigger cannot corrupt retained outcome before-evidence", async () => {
  const f = await fresh("live", (s) => {
    s.board.linkedin_url = null;
  });
  try {
    await assert.rejects(
      run(f, async (sql, v, c) => {
        if (sql.includes("directory_outcome("))
          await c.query(
            "create function person_private.synthetic_late_outcome() returns trigger language plpgsql as $$begin if new.phase='review' then update person_private.directory_outcomes set receipt_before=jsonb_set(receipt_before,'{snapshot}','{}') where execution_id=(select id from person_private.directory_executions where receipt_id=new.id and completed_at is null);end if;return new;end$$;create trigger zz_late_outcome after update on person_directory_receipts for each row execute function person_private.synthetic_late_outcome()",
          );
      }),
      /directory_outcome/,
    );
    assert.equal((await receipt(f)).phase, "ready");
  } finally {
    await pool.query(
      "drop trigger if exists zz_late_outcome on person_directory_receipts;drop function if exists person_private.synthetic_late_outcome()",
    );
  }
});
test("directory owner resolution has indexed candidate access under production-shaped indexes", async () => {
  const f = await fresh(),
    c = await pool.connect(),
    plans = [];
  const notice = (n) => {
    const start = n.message.indexOf("{");
    if (start >= 0)
      try {
        plans.push(JSON.parse(n.message.slice(start)).Plan);
      } catch {}
  };
  c.on("notice", notice);
  try {
    await c.query("begin");
    await rpc(c, "person_private.directory_begin", [
      org,
      f.args.workspaceId,
      f.args.receiptId,
      f.args.executionId,
      "live",
      randomUUID(),
    ]);
    await c.query(
      "create index if not exists candidates_airtable_id_key on candidates(airtable_id);create index if not exists candidates_directory_contact_id_key on candidates(directory_contact_id) where directory_contact_id is not null",
    );
    await c.query(
      "load 'auto_explain';set local auto_explain.log_min_duration=0;set local auto_explain.log_nested_statements=on;set local auto_explain.log_format='json';set local auto_explain.log_level='notice';set local enable_seqscan=off;set local jit=off",
    );
    await rpc(c, "person_private.directory_outcome_observe", [
      f.args.executionId,
      JSON.stringify(lib.directoryIdentities(f.snapshot)),
    ]);
    const nodes = [];
    const visit = (p) => {
      if (!p) return;
      nodes.push(p);
      for (const child of p.Plans || []) visit(child);
    };
    plans.forEach(visit);
    const candidates = nodes.filter((p) => p["Relation Name"] === "candidates");
    assert.ok(candidates.length > 0, "capture actual nested owner plan");
    assert.equal(
      candidates.some((p) => p["Node Type"] === "Seq Scan"),
      false,
      "owner resolution must not scan every candidate",
    );
  } finally {
    await c.query("rollback");
    c.off("notice", notice);
    c.release();
  }
});
for (const [table, action, when] of [
  ["person_private.directory_outcomes", "return null;", "before insert"],
  [
    "person_private.directory_outcomes",
    "new.input_hash:='unproved';return new;",
    "before insert",
  ],
  ["person_directory_receipts", "return null;", "before update"],
  [
    "person_directory_receipts",
    "new.result:='{}';return new;",
    "before update",
  ],
])
  test(`terminal ${table} ${action} cannot commit partial proof`, async () => {
    const f = await fresh("live", (s) => {
      s.board.linkedin_url = null;
    });
    try {
      await assert.rejects(
        run(f, async (sql, v, c) => {
          if (sql.includes("directory_outcome("))
            await c.query(
              `create function person_private.synthetic_outcome() returns trigger language plpgsql as $$begin ${action}end$$;create trigger zz_outcome ${when} on ${table} for each row execute function person_private.synthetic_outcome()`,
            );
        }),
        /directory_outcome|directory_input/,
      );
      assert.equal((await receipt(f)).phase, "ready");
      assert.equal(
        (
          await pool.query(
            "select count(*)::int n from person_private.directory_executions where id=$1",
            [f.args.executionId],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await pool.query(
        `drop trigger if exists zz_outcome on ${table};drop function if exists person_private.synthetic_outcome()`,
      );
    }
  });
for (const boundary of ["finish", "commit"])
  test(`outcome proof is rechecked after ${boundary} boundary corruption`, async () => {
    const f = await fresh("live", (s) => {
      s.board.linkedin_url = null;
    });
    try {
      await assert.rejects(
        run(f, async (sql, v, c) => {
          if (boundary === "finish" && sql.includes("directory_outcome("))
            await c.query(
              "create function person_private.synthetic_outcome_finish() returns trigger language plpgsql as $$begin if new.status='completed' then update person_private.directory_outcomes set receipt_before=jsonb_set(receipt_before,'{snapshot}','{}') where work_id=new.id;end if;return new;end$$;create trigger zz_outcome_finish after update on person_private.transition_work for each row execute function person_private.synthetic_outcome_finish()",
            );
          if (boundary === "commit" && sql === "commit")
            await c.query(
              "update person_private.directory_outcomes set receipt_before=jsonb_set(receipt_before,'{snapshot}','{}') where execution_id=$1",
              [f.args.executionId],
            );
        }),
        /directory_outcome|directory_execution_incomplete/,
      );
      assert.equal((await receipt(f)).phase, "ready");
    } finally {
      await pool.query(
        "drop trigger if exists zz_outcome_finish on person_private.transition_work;drop function if exists person_private.synthetic_outcome_finish()",
      );
    }
  });
for (const field of ["mode", "receiptId", "workspaceId", "organizationId"])
  test(`terminal replay refuses changed ${field}`, async () => {
    const f = await fresh("live", (s) => {
      s.board.linkedin_url = null;
    });
    await run(f);
    const bad = {
      ...f,
      args: {
        ...f.args,
        [field]:
          field === "mode"
            ? "shadow"
            : field === "receiptId"
              ? String(Number(f.args.receiptId) + 1)
              : randomUUID(),
      },
    };
    await assert.rejects(
      run(bad),
      /directory_execution_binding|directory_execution_input|directory_input_scope/,
    );
  });
test("completed review under a new UUID remains unavailable before explicit readmission", async () => {
  const f = await fresh("live", (s) => {
      s.board.linkedin_url = null;
    }),
    out = await run(f);
  await assert.rejects(
    run({ ...f, args: { ...f.args, executionId: randomUUID() } }),
    /directory_receipt_ineligible/,
  );
  assert.deepEqual(await run(f), out);
});
for (const mutation of [
  "candidate_id=gen_random_uuid()",
  "result='{}'",
  "attempts=1",
  "error_code='unproved'",
  'source_reviews=\'[{"reason":"unproved"}]\'',
])
  test(`unproved ready ${mutation} cannot become outcome authority`, async () => {
    const f = await fresh("live", (s) => {
      s.board.linkedin_url = null;
    });
    await phase(false);
    await pool.query(
      "alter table person_directory_receipts disable trigger all",
    );
    try {
      await pool.query(
        `update person_directory_receipts set ${mutation} where id=$1`,
        [f.args.receiptId],
      );
    } finally {
      await pool.query(
        "alter table person_directory_receipts enable trigger all",
      );
      await phase();
    }
    await assert.rejects(run(f), /directory_outcome_unproven/);
  });
test("existing suppressed person cannot enter normalized binding as an unmigrated review", async () => {
  const f = await fixture((s) => {
    s.board.do_not_contact = true;
  });
  await phase(false);
  await pool.query(
    "delete from candidate_profile_state where candidate_id=$1",
    [f.id],
  );
  await phase();
  const before = await row(f.id);
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
    await assert.rejects(
      rpc(c, "person_private.directory_bind", [
        f.args.executionId,
        f.id,
        JSON.stringify(lib.directoryIdentities(f.snapshot)),
      ]),
      /directory_suppression_unavailable/,
    );
  });
  assert.deepEqual(await row(f.id), before);
  assert.equal((await receipt(f)).phase, "ready");
});
test("missing or transferred latest state is an invariant error, not supersession", async () => {
  const f = await fresh("live", (s) => {
    s.board.linkedin_url = null;
  });
  await phase(false);
  await pool.query("alter table person_directory_state disable trigger all");
  try {
    await pool.query(
      "update person_directory_state set workspace_id=$2 where contact_id=$1",
      [f.snapshot.board.contact_id, randomUUID()],
    );
  } finally {
    await pool.query("alter table person_directory_state enable trigger all");
    await phase();
  }
  await assert.rejects(run(f), /directory_input_state/);
  assert.equal((await receipt(f)).phase, "ready");
});
test("private outcome helpers are not callable by service or browser roles", async () => {
  for (const role of ["service_role", "anon", "authenticated"])
    for (const fn of [
      "directory_outcome(uuid,jsonb)",
      "directory_outcome_observe(uuid,jsonb)",
      "directory_outcome_valid(uuid)",
      "directory_identity_owners(uuid,jsonb)",
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
test("superseded receipt completes without waiting for an irrelevant candidate lock", async () => {
  const f = await fixture();
  await phase(false);
  await pool.query(
    "update person_directory_receipts set phase='review' where id=$1",
    [f.args.receiptId],
  );
  await phase();
  const snapshot = structuredClone(f.snapshot);
  snapshot.board.title = "Newer";
  snapshot.board.updated_at = "2026-09-28";
  await rpc(pool, "public.person_directory_stage", [
    org,
    f.args.workspaceId,
    f.token,
    lib.directorySnapshotHash(snapshot),
    snapshot,
  ]);
  await phase(false);
  await pool.query(
    "update person_directory_receipts set phase='ready' where id=$1",
    [f.args.receiptId],
  );
  await phase();
  const holder = await pool.connect();
  try {
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock(hashtext($1))", [f.id]);
    await holder.query("select id from candidates where id=$1 for update", [
      f.id,
    ]);
    assert.deepEqual(
      await run(f, async (sql, v, c) => {
        if (sql.includes("directory_outcome("))
          await c.query("set local lock_timeout='100ms'");
      }),
      { status: "superseded" },
    );
  } finally {
    await holder.query("rollback");
    holder.release();
  }
});
test("terminal sole-owner candidate wait rechecks expired ownership", async () => {
  const f = await fixture();
  await phase(false);
  await pool.query(
    "delete from candidate_profile_state where candidate_id=$1",
    [f.id],
  );
  await phase();
  const before = await row(f.id),
    holder = await pool.connect();
  let pending,
    pid,
    observed = false;
  try {
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock(hashtext($1))", [f.id]);
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
    assert.equal((await receipt(f)).phase, "ready");
    assert.deepEqual(await row(f.id), before);
  } finally {
    await holder.query("rollback");
    if (pending) await pending;
    holder.release();
  }
});
test("mixed-case legacy usernames remain owners without rewriting legacy identity", async () => {
  const f = await fixture(),
    username = "LEGACY-" + randomUUID().toUpperCase();
  await phase(false);
  await pool.query("alter table candidates disable trigger all");
  try {
    await pool.query("update candidates set linkedin_username=$2 where id=$1", [
      f.id,
      username,
    ]);
  } finally {
    await pool.query("alter table candidates enable trigger all");
    await phase();
  }
  const before = await row(f.id),
    owners = await pool.query(
      "select id from person_private.directory_identity_owners($1,$2)",
      [
        randomUUID(),
        JSON.stringify([
          { kind: "linkedin_username", value: username.toLowerCase() },
        ]),
      ],
    );
  assert.deepEqual(owners.rows, [{ id: f.id }]);
  assert.deepEqual(await row(f.id), before);
  assert.equal(before.linkedin_username, username);
});
test("resolved review permits a genuinely new receipt without adopting review as document evidence", async () => {
  const f = await fixture(),
    hold = randomUUID();
  await pool.query("alter table person_source_holds disable trigger all");
  try {
    await pool.query(
      "insert into person_source_holds(candidate_id,ledger_id,evidence_hash,reason,evidence) values($1,$2,'synthetic','harvest_cache_date_unknown','{}')",
      [f.id, hold],
    );
  } finally {
    await pool.query("alter table person_source_holds enable trigger all");
  }
  const out = await run(f);
  assert.equal(out.reason, "directory_source_hold");
  await pool.query("alter table person_source_holds disable trigger all");
  try {
    await pool.query(
      "update person_source_holds set resolved_at=clock_timestamp(),resolution='{}' where ledger_id=$1",
      [hold],
    );
  } finally {
    await pool.query("alter table person_source_holds enable trigger all");
  }
  const snapshot = structuredClone(f.snapshot);
  snapshot.board.title = "Newer";
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
  const applied = await run(next);
  assert.equal(applied.status, "done");
  assert.equal(applied.candidateId, f.id);
  assert.deepEqual(await run(f), out);
  assert.equal(
    String((await state(f)).applied_receipt_id),
    String(newer.receiptId),
  );
});
