import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import * as lib from "../dist/worker-lib.mjs";
import "../person-lookup-mutations/test-intake.mjs";
import {
  app,
  processApp,
} from "../person-application-enrichment/test-tt-enrichment.mjs";
const url = process.env.LOCAL_DATABASE_URL;
if (
  !/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_directory_(?:execution|publication|creation|outcomes|suppression)_test$/.test(
    url || "",
  )
)
  throw Error("local fixture required");
const pool = new pg.Pool({
    connectionString: url,
    max: 8,
    statement_timeout: 15000,
  }),
  org = lib.TT_ORG_ID;
const phase = (enabled = true, state = "open") =>
  pool.query(
    "update person_private.transition_control set enabled=$1,phase=$2 where singleton",
    [enabled, state],
  );
const rpc = async (c, name, values = []) =>
  (
    await c.query(
      `select ${name}(${values.map((_, i) => "$" + (i + 1)).join(",")}) r`,
      values,
    )
  ).rows[0].r;
async function use(fn) {
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    await c.query("rollback");
    c.release();
  }
}
const row = async (id) =>
  (await pool.query("select to_jsonb(c) r from candidates c where id=$1", [id]))
    .rows[0]?.r;
async function fixture(
  patchSnapshot = () => {},
  prepareCandidate = async () => {},
) {
  await phase(false);
  delete process.env.PERSON_TRANSITION_SUPPORT;
  const id = randomUUID(),
    username = "directory-" + id,
    workspaceId = randomUUID(),
    contact = randomUUID();
  await pool.query(
    "insert into candidates(id,full_name,linkedin_username,linkedin_url,created_at) values($1,'Synthetic', $2::text,'https://www.linkedin.com/in/'||$2::text,'2025-01-01')",
    [id, username],
  );
  await prepareCandidate(pool, id);
  const before = await row(id),
    doc = lib.fromLegacyImport(before, [], [], []);
  await rpc(pool, "public.save_person", [doc]);
  const run = "directory-execution-synthetic";
  await pool.query(
    "insert into backfill_runs(run_id,pass,status,notes) values($1,'shadow','paused',$2) on conflict do nothing",
    [
      run,
      {
        kind: "reconcile",
        parser: "person-v3",
        commit: "c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc",
      },
    ],
  );
  await pool.query(
    "insert into person_reconcile_people(run_id,candidate_id,status,revision,captured_version,source_hash,checks,counted) select $1,$2,'verified',rev,(select coalesce(max(id),0) from person_change_events where candidate_id=$2),'synthetic','{\"integrity_ok\":true,\"external_stable\":true}',true from candidate_profile_state where candidate_id=$2",
    [run, id],
  );
  const input = (
    await rpc(pool, "public.person_audit_anchor_inputs", [JSON.stringify([id])])
  )[0];
  const prepared = lib.prepareLegacyAuditAnchor(input);
  assert.equal(prepared.status, "ready");
  assert.equal(
    (
      await rpc(pool, "public.person_audit_anchor_commit", [
        JSON.stringify([prepared]),
      ])
    )[0].status,
    "created",
  );
  await phase();
  process.env.PERSON_TRANSITION_SUPPORT = "on";
  const token = randomUUID();
  await rpc(pool, "public.person_directory_claim", [org, workspaceId, token]);
  const snapshot = {
    board: {
      contact_id: contact,
      name: "Synthetic Directory",
      linkedin_url: "https://www.linkedin.com/in/" + username,
      title: "New Engineer",
      updated_at: "2026-09-25",
    },
    harvest: null,
    exps: [],
    edus: [],
    emails: [],
    phones: [],
    facts: [],
    identifiers: [],
  };
  patchSnapshot(snapshot);
  const staged = await rpc(pool, "public.person_directory_stage", [
    org,
    workspaceId,
    token,
    lib.directorySnapshotHash(snapshot),
    snapshot,
  ]);
  return {
    id,
    before,
    snapshot,
    token,
    args: {
      organizationId: org,
      workspaceId,
      receiptId: staged.receiptId,
      executionId: randomUUID(),
      mode: "shadow",
    },
  };
}
const run = (f, hook) =>
  use((c) =>
    lib.saveCertifiedDirectoryOnConnection(
      hook
        ? {
            query: async (sql, v) => {
              await hook(sql, v, c);
              return c.query(sql, v);
            },
          }
        : c,
      f.args,
    ),
  );
test.after(() => pool.end());
test.beforeEach(() => phase());
test("certified shadow execution is available", () =>
  assert.equal(typeof lib.saveCertifiedDirectoryOnConnection, "function"));
test("genuine receipt normalizes atomically without changing any candidate field", async () => {
  const f = await fixture(),
    out = await run(f);
  assert.equal(out.status, "done");
  assert.equal(out.candidateId, f.id);
  assert.equal(out.projected, false);
  assert.equal(out.created, false);
  assert.deepEqual(await row(f.id), f.before);
  const r = (
    await pool.query("select * from person_directory_receipts where id=$1", [
      f.args.receiptId,
    ])
  ).rows[0];
  assert.equal(r.phase, "done");
  assert.deepEqual(r.result, out);
  assert.ok(r.documents.length);
  assert.equal(
    (
      await pool.query(
        "select status from person_private.transition_work where family='directory' and resource_key=$1",
        [`directory:${f.args.receiptId}:${f.args.executionId}`],
      )
    ).rows[0].status,
    "completed",
  );
  assert.equal(
    (
      await pool.query(
        "select header->'current_title'->>'value' title from candidate_profile_state where candidate_id=$1",
        [f.id],
      )
    ).rows[0].title,
    "New Engineer",
  );
  assert.deepEqual(await run(f), out);
});
for (const field of ["organizationId", "workspaceId", "receiptId", "mode"])
  test(`completed replay rejects changed ${field}`, async () => {
    const f = await fixture();
    await run(f);
    f.args[field] =
      field === "receiptId"
        ? "999999"
        : field === "mode"
          ? "live"
          : randomUUID();
    await assert.rejects(run(f), /directory_/);
  });
test("completed replay returns original result after later state and candidate edits", async () => {
  const f = await fixture(),
    out = await run(f);
  await phase(false);
  await pool.query(
    "update candidates set full_name='Later legitimate edit' where id=$1",
    [f.id],
  );
  await phase();
  assert.deepEqual(await run(f), out);
  assert.equal((await row(f.id)).full_name, "Later legitimate edit");
});
for (const suffix of [
  "directory_seal",
  "directory_normalize",
  "directory_complete",
])
  test(`failure at ${suffix} rolls back work, sources and completion`, async () => {
    const f = await fixture(),
      before = (
        await pool.query(
          "select count(*)::int n from candidate_sources where candidate_id=$1",
          [f.id],
        )
      ).rows[0].n;
    await assert.rejects(
      run(f, async (sql) => {
        if (sql.includes(suffix + "(")) throw Error("synthetic_failure");
      }),
      /synthetic_failure/,
    );
    assert.deepEqual(await row(f.id), f.before);
    assert.equal(
      (
        await pool.query(
          "select phase from person_directory_receipts where id=$1",
          [f.args.receiptId],
        )
      ).rows[0].phase,
      "ready",
    );
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from candidate_sources where candidate_id=$1",
          [f.id],
        )
      ).rows[0].n,
      before,
    );
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from person_private.transition_work where family='directory' and resource_key=$1",
          [`directory:${f.args.receiptId}:${f.args.executionId}`],
        )
      ).rows[0].n,
      0,
    );
  });
test("held controller refuses before any directory work", async () => {
  const f = await fixture();
  await phase(true, "held");
  await assert.rejects(run(f), /directory_held/);
  assert.deepEqual(await row(f.id), f.before);
});
for (const table of ["person_directory_receipts", "person_directory_primary"])
  test(`required raw ${table} mutation refused`, async () => {
    const f = await fixture();
    await assert.rejects(
      pool.query(
        table === "person_directory_receipts"
          ? "update person_directory_receipts set phase='done',documents='[]' where id=$1"
          : "insert into person_directory_primary(candidate_id,kind,directory_contact_id,receipt_id) values($1,'email',$2,$3)",
        table === "person_directory_receipts"
          ? [f.args.receiptId]
          : [f.id, f.snapshot.board.contact_id, f.args.receiptId],
      ),
      /directory_/,
    );
  });

async function stageExisting(id, patch = (s) => s) {
  const before = await row(id),
    workspaceId = randomUUID(),
    token = randomUUID();
  await rpc(pool, "public.person_directory_claim", [org, workspaceId, token]);
  const snapshot = {
    board: {
      contact_id: randomUUID(),
      name: "Synthetic Directory",
      linkedin_url: "https://www.linkedin.com/in/" + before.linkedin_username,
      title: "New Engineer",
      updated_at: "2026-09-25",
    },
    harvest: null,
    exps: [],
    edus: [],
    emails: [],
    phones: [],
    facts: [],
    identifiers: [],
  };
  patch(snapshot);
  const r = await rpc(pool, "public.person_directory_stage", [
    org,
    workspaceId,
    token,
    lib.directorySnapshotHash(snapshot),
    snapshot,
  ]);
  return {
    id,
    before,
    snapshot,
    args: {
      organizationId: org,
      workspaceId,
      receiptId: r.receiptId,
      executionId: randomUUID(),
      mode: "shadow",
    },
  };
}
for (const kind of ["creation", "update"])
  test(`audit rejects transferred ${kind} attribution owner`, async () => {
    const a = await processApp(
      await app({ email: randomUUID() + "@example.test" }),
    );
    assert.equal(a.status, "processed", a.error?.message);
    const f = await stageExisting(a.result.candidateId),
      other = await fixture();
    const event = (
      await pool.query(
        "select x.event_id from person_change_attributions x join person_change_events ev on ev.id=x.event_id where x.candidate_id=$1 and ev.source_table='candidates' and (x.scope='creation')=$2 order by ev.id desc limit 1",
        [f.id, kind === "creation"],
      )
    ).rows[0];
    assert.ok(event, "genuine attribution required");
    await phase(false);
    await pool.query(
      "alter table person_change_attributions disable trigger person_audit_immutable",
    );
    try {
      await pool.query(
        "update person_change_attributions set candidate_id=$2 where event_id=$1",
        [event.event_id, other.id],
      );
    } finally {
      await pool.query(
        "alter table person_change_attributions enable trigger person_audit_immutable",
      );
      await phase();
    }
    await assert.rejects(run(f), /audit_creation_event|audit_proof_chain/);
  });
test("real application following completed directory accepts certified audit chain", async () => {
  const f = await fixture();
  await run(f);
  const after = await processApp(
    await app(
      { email: randomUUID() + "@example.test" },
      f.before.linkedin_username,
    ),
  );
  assert.equal(after.status, "processed", after.error?.message);
});
for (const action of ["return null;", "new.rev:=old.rev;return new;"])
  test(`primary revision ${action} refuses completion`, async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        run(f, async (sql, v, c) => {
          if (sql.includes("directory_complete("))
            await c.query(
              `create function person_private.synthetic_revision() returns trigger language plpgsql as $$begin ${action}end$$;create trigger zz_directory_revision before update on candidate_profile_state for each row execute function person_private.synthetic_revision()`,
            );
        }),
        /directory_primary_actual/,
      );
      assert.equal(
        (
          await pool.query(
            "select phase from person_directory_receipts where id=$1",
            [f.args.receiptId],
          )
        ).rows[0].phase,
        "ready",
      );
      // Failed execution rolled back DDL. If the regression unexpectedly committed,
      // remove only these synthetic fixture objects before the next case.
    } finally {
      await pool.query(
        "drop trigger if exists zz_directory_revision on candidate_profile_state;drop function if exists person_private.synthetic_revision()",
      );
    }
  });
for (const table of [
  "directory_normalization_frames",
  "directory_input_frames",
])
  test(`suppressed private ${table} fails closed`, async () => {
    const f = await fixture();
    await assert.rejects(
      run(f, async (sql, v, c) => {
        if (sql.includes("directory_seal("))
          await c.query(
            `create function person_private.synthetic_frame() returns trigger language plpgsql as $$begin return null;end$$;create trigger zz_directory_frame before insert on person_private.${table} for each row execute function person_private.synthetic_frame()`,
          );
      }),
      /directory_normalization_frame|normalization_frame|directory_input_frame/,
    );
  });
test("partial genuine work cannot commit or generic-finish", async () => {
  const f = await fixture();
  await use(async (c) => {
    await c.query("begin");
    const token = randomUUID();
    const a = await rpc(c, "person_private.directory_begin", [
      org,
      f.args.workspaceId,
      f.args.receiptId,
      f.args.executionId,
      "shadow",
      token,
    ]);
    await c.query("savepoint unfinished");
    await assert.rejects(
      rpc(c, "public.person_transition_finish", [a.workId, token, "completed"]),
      /directory_completion_witness/,
    );
    await c.query("rollback to savepoint unfinished");
    await assert.rejects(c.query("commit"), /directory_execution_incomplete/);
  });
});
test("service role has no private seal, begin, normalize or completion capability", async () => {
  for (const fn of [
    "directory_begin(uuid,uuid,bigint,uuid,text,uuid)",
    "directory_seal(uuid,jsonb,jsonb,text)",
    "directory_normalize(uuid,integer)",
    "directory_complete(uuid)",
  ])
    assert.equal(
      (
        await pool.query(
          "select has_function_privilege('service_role',$1,'EXECUTE') allowed",
          ["person_private." + fn],
        )
      ).rows[0].allowed,
      false,
    );
});
test("actual evidence substitution refuses before any normalization", async () => {
  const f = await fixture();
  await assert.rejects(
    run(f, async (sql, v) => {
      if (sql.includes("directory_seal(")) {
        const input = JSON.parse(v[1]);
        input.sources.push({
          id: randomUUID(),
          payload_hash: "invented",
          parser_version: "person-v3",
          fetched_at: "2026-01-01",
        });
        v[1] = JSON.stringify(input);
      }
    }),
    /directory_decision_input/,
  );
});

test("completed predecessor cannot disappear through a disabled legacy cache edit", async () => {
  const f = await fixture();
  await run(f);
  await phase(false);
  await pool.query(
    "update person_directory_receipts set documents=null where id=$1",
    [f.args.receiptId],
  );
  await phase();
  const next = await stageExisting(f.id);
  await assert.rejects(run(next), /directory_prior_review/);
});
test("certified operation registry is independent of caller timezone", async () => {
  const f = await fixture();
  await run(f);
  await use(async (c) => {
    await c.query("begin");
    await c.query("set local timezone='Pacific/Auckland'");
    assert.equal(
      (
        await c.query(
          "select count(*)::int n from person_private.certified_audit_operations where candidate_id=$1",
          [f.id],
        )
      ).rows[0].n,
      1,
    );
  });
});

for (const lock of ["username", "identity", "candidate"])
  test(`${lock} lock wait rechecks expired ownership`, async () => {
    const f = await fixture(),
      holder = await pool.connect();
    let pending,
      pid,
      observed = false;
    try {
      await holder.query("begin");
      if (lock === "candidate")
        await holder.query("select pg_advisory_xact_lock(hashtext($1))", [
          f.id,
        ]);
      else
        await holder.query(
          `select pg_advisory_xact_lock(${lock === "username" ? 72007 : 72012},hashtext($1))`,
          [
            lock === "username"
              ? f.before.linkedin_username
              : "directory_contact_id:" + f.snapshot.board.contact_id,
          ],
        );
      pending = run(f, async (sql, v, c) => {
        if (sql.includes("pg_advisory_xact_lock(72007")) {
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
      assert.equal(
        (
          await pool.query(
            "select phase from person_directory_receipts where id=$1",
            [f.args.receiptId],
          )
        ).rows[0].phase,
        "ready",
      );
    } finally {
      await holder.query("rollback");
      if (pending) await pending;
      holder.release();
    }
  });
test("controller hold overtakes waiting admission before directory work exists", async () => {
  const f = await fixture(),
    holder = await pool.connect();
  let pending,
    observed = false;
  try {
    await holder.query("begin");
    await holder.query(
      "update person_private.transition_control set phase='held' where singleton",
    );
    pending = run(f).then(
      () => null,
      (e) => e,
    );
    for (let n = 0; n < 100; n++) {
      observed = (
        await pool.query(
          "select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select person_private.directory_begin%') waiting",
        )
      ).rows[0].waiting;
      if (observed) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(observed, true);
    await holder.query("commit");
    assert.match((await pending)?.message || "", /directory_held/);
  } finally {
    await holder.query("rollback");
    if (pending) await pending;
    holder.release();
  }
});
test("directory contact ownership conflict is retained through genuine normalization", async () => {
  const owner = await processApp(
    await app({ email: "collision-" + randomUUID() + "@example.test" }),
  );
  assert.equal(owner.status, "processed", owner.error?.message);
  const owned = (
    await pool.query(
      "select value_normalized from candidate_contacts where candidate_id=$1 and kind='email' limit 1",
      [owner.result.candidateId],
    )
  ).rows[0].value_normalized;
  const original = await fixture(),
    f = await stageExisting(original.id, (s) => {
      s.board.primary_email = owned;
      s.board.email_status = "Verified";
      s.emails = [
        {
          normalized: owned,
          verification: {
            status: "Verified",
            primary: true,
            checked_at: "2026-09-25",
          },
        },
      ];
    });
  const out = await run(f);
  assert.equal(out.status, "done");
  assert.ok(
    (
      await pool.query(
        "select count(*)::int n from identity_conflicts where kind='email_owned_by_other' and $1=any(candidate_ids)",
        [f.id],
      )
    ).rows[0].n > 0,
  );
  assert.deepEqual(await row(f.id), f.before);
});
test("bounded large directory snapshot completes below statement timeout", async () => {
  const original = await fixture(),
    f = await stageExisting(original.id, (s) => {
      s.harvest = {
        fetched_at: "2026-09-25",
        public_identifier: original.before.linkedin_username,
        skills: Array.from(
          { length: 120 },
          (_, i) => "Directory synthetic skill " + i,
        ),
      };
      s.exps = Array.from({ length: 80 }, (_, i) => ({
        title: "Synthetic Engineer " + i,
        company_name: "Synthetic history company " + i + " " + original.id,
        start_year: 1990 + (i % 30),
        description: "Synthetic long history ".repeat(40),
      }));
      s.edus = Array.from({ length: 20 }, (_, i) => ({
        school_name: "Synthetic school " + i + " " + original.id,
        degree: "Synthetic degree",
        start_year: 2000 + i,
      }));
    });
  const out = await run(f);
  assert.equal(out.status, "done");
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from candidate_skills where candidate_id=$1",
        [f.id],
      )
    ).rows[0].n,
    120,
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from candidate_experiences where candidate_id=$1 and source='person'",
        [f.id],
      )
    ).rows[0].n,
    80,
  );
});

test("completed UUID remains replayable while admission is held", async () => {
  const f = await fixture(),
    out = await run(f);
  await phase(true, "held");
  assert.deepEqual(await run(f), out);
});
for (const type of ["same", "application"])
  test(`${type} nested frame refuses before core`, async () => {
    const f = await fixture();
    await assert.rejects(
      run(f, async (sql, v, c) => {
        if (sql.includes("directory_normalize(")) {
          if (type === "same")
            await c.query(
              "insert into person_private.directory_normalization_frames select pg_backend_pid(),pg_current_xact_id(),id,work_id,candidate_id,decision->'docs'->0 from person_private.directory_executions where id=$1",
              [f.args.executionId],
            );
          else
            await c.query(
              "insert into person_private.normalization_frames select pg_backend_pid(),pg_current_xact_id(),a.work_id,a.application_id,e.candidate_id,e.decision->'docs'->0 from person_private.application_work a cross join person_private.directory_executions e where e.id=$1 limit 1",
              [f.args.executionId],
            );
        }
      }),
      /normalization_nested/,
    );
  });
for (const key of ["document", "candidate_id", "work_id"])
  test(`altered ${key} in private normalization frame refuses before core`, async () => {
    const f = await fixture();
    await assert.rejects(
      run(f, async (sql, v, c) => {
        if (sql.includes("directory_seal("))
          await c.query(
            `create function person_private.synthetic_alter_frame() returns trigger language plpgsql as $$begin new.${key}:=${key === "document" ? "'{}'::jsonb" : "gen_random_uuid()"};return new;end$$;create trigger zz_directory_alter before insert on person_private.directory_normalization_frames for each row execute function person_private.synthetic_alter_frame()`,
          );
      }),
      /directory_normalization_frame|foreign key constraint/,
    );
  });

export { pool, org, phase, rpc, use, row, fixture, run, stageExisting };
