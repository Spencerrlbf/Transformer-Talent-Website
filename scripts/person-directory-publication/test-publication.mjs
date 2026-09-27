import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  pool,
  org,
  rpc,
  phase,
  row,
  fixture,
  run,
  stageExisting,
} from "../person-directory-execution/test-execution.mjs";
import {
  app,
  processApp,
} from "../person-application-enrichment/test-tt-enrichment.mjs";

test("certified ready directory live save publishes current winners atomically", async () => {
  const f = await fixture();
  f.args.mode = "live";
  const out = await run(f);
  assert.equal(out.status, "done");
  assert.equal(out.candidateId, f.id);
  assert.equal(out.projected, true);
  const candidate = await row(f.id);
  assert.equal(candidate.current_title, "New Engineer");
  assert.equal(candidate.directory_contact_id, f.snapshot.board.contact_id);
  assert.equal(candidate.source, "directory");
  const revision = (
    await pool.query(
      "select s.rev::text,p.revision::text from candidate_profile_state s join person_projection_state p using(candidate_id) where candidate_id=$1",
      [f.id],
    )
  ).rows[0];
  assert.equal(revision.rev, revision.revision);
  assert.equal(out.revision, revision.rev);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from person_derivative_jobs where candidate_id=$1",
        [f.id],
      )
    ).rows[0].n,
    1,
  );
  const receipt = (
    await pool.query("select * from person_directory_receipts where id=$1", [
      f.args.receiptId,
    ])
  ).rows[0];
  assert.equal(receipt.projected, true);
  assert.ok(receipt.derivative_text);
  assert.equal(String(receipt.derivative_revision), out.revision);
  assert.deepEqual(await run(f), out);
});
test("shadow upgrade retains original decision and both immutable replay results", async () => {
  const f = await fixture(),
    shadow = await run(f),
    original = (
      await pool.query(
        "select evidence,decision from person_private.directory_executions where id=$1",
        [f.args.executionId],
      )
    ).rows[0];
  const live = {
      ...f,
      args: { ...f.args, mode: "live", executionId: randomUUID() },
    },
    published = await run(live);
  assert.equal(published.projected, true);
  const upgraded = (
    await pool.query(
      "select evidence,decision from person_private.directory_executions where id=$1",
      [live.args.executionId],
    )
  ).rows[0];
  assert.deepEqual(upgraded, original);
  assert.deepEqual(await run(f), shadow);
  assert.deepEqual(await run(live), published);
});
test("shadow then legitimate application then live upgrade keeps newer normalized facts", async () => {
  const f = await fixture(),
    shadow = await run(f);
  const a = await processApp(
    await app(
      { email: randomUUID() + "@example.test" },
      f.before.linkedin_username,
    ),
    {
      harvest: "fresh",
      harvestPayload: {
        firstName: "Synthetic",
        lastName: "Newer",
        headline: "Newer application headline",
        experience: [
          {
            position: "Newer app engineer",
            companyName: "Synthetic newer company",
            startDate: { year: 2026 },
          },
        ],
      },
    },
  );
  assert.equal(a.status, "processed", a.error?.message);
  const before = await row(f.id);
  assert.equal(before.current_title, "Newer app engineer");
  const live = {
    ...f,
    args: { ...f.args, mode: "live", executionId: randomUUID() },
  };
  const out = await run(live);
  assert.equal(out.status, "done");
  assert.equal((await row(f.id)).current_title, before.current_title);
  assert.deepEqual(await run(f), shadow);
});
for (const boundary of [
  "directory_project",
  "directory_metadata",
  "directory_enqueue",
  "directory_complete",
])
  test(`failure at ${boundary} rolls back compatible fields and queued derivatives`, async () => {
    const f = await fixture();
    f.args.mode = "live";
    await assert.rejects(
      run(f, async (sql) => {
        if (sql.includes(boundary + "("))
          throw Error("synthetic_publication_failure");
      }),
      /synthetic_publication_failure/,
    );
    assert.deepEqual(await row(f.id), f.before);
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from person_projection_state where candidate_id=$1",
          [f.id],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from person_derivative_jobs where candidate_id=$1",
          [f.id],
        )
      ).rows[0].n,
      0,
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
  });

async function publicationFault(table, operation, action, at = "before") {
  const f = await fixture();
  f.args.mode = "live";
  try {
    await pool.query(
      `create function person_private.synthetic_publication_fault() returns trigger language plpgsql as $$begin ${action} end$$;create trigger zz_publication_fault ${at} ${operation} on ${table} for each row execute function person_private.synthetic_publication_fault()`,
    );
    await assert.rejects(run(f));
    assert.deepEqual(await row(f.id), f.before);
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
      `drop trigger if exists zz_publication_fault on ${table};drop function if exists person_private.synthetic_publication_fault()`,
    );
  }
}
test("changed publication requires retained before-image despite suppressed history insert", () =>
  publicationFault("person_projection_history", "insert", "return null;"));
for (const [table, op, action] of [
  [
    "person_projection_history",
    "insert",
    "new.before_profile:='{}';return new;",
  ],
  ["person_projection_state", "insert", "return null;"],
  [
    "person_projection_state",
    "insert",
    "new.revision:=new.revision+1;return new;",
  ],
  ["person_private.directory_projection_frames", "insert", "return null;"],
  [
    "person_private.directory_projection_frames",
    "insert",
    "new.work_id:=gen_random_uuid();return new;",
  ],
  ["person_private.directory_candidate_frames", "insert", "return null;"],
  [
    "person_private.directory_candidate_frames",
    "insert",
    'new.after_row:=new.after_row||\'{"status":"tampered"}\';return new;',
  ],
  ["person_derivative_jobs", "insert", "return null;"],
  [
    "person_derivative_jobs",
    "insert",
    "new.desired_revision:=new.desired_revision+1;return new;",
  ],
  ["person_private.derivative_producer_frames", "insert", "return null;"],
  [
    "person_private.derivative_producer_frames",
    "insert",
    "new.work_id:=gen_random_uuid();return new;",
  ],
])
  test(`publication rolls back suppressed/altered ${table} ${action}`, () =>
    publicationFault(table, op, action));
test("ready live publication is independent of connection timezone and DateStyle", async () => {
  const f = await fixture();
  f.args.mode = "live";
  let configured = false;
  const out = await run(f, async (sql, v, c) => {
    if (!configured && sql === "begin") {
      configured = true;
      await c.query("set timezone='America/New_York';set datestyle='SQL,DMY'");
    }
  });
  assert.equal(out.status, "done");
  // Pool connection returned with session settings restored for other fixture users.
  await pool.query("set timezone='UTC';set datestyle='ISO,YMD'");
});
test("live result replay rejects changed mode and new unreviewed intent", async () => {
  const f = await fixture();
  f.args.mode = "live";
  const result = await run(f);
  await assert.rejects(
    run({ ...f, args: { ...f.args, mode: "shadow" } }),
    /directory_execution_binding/,
  );
  await assert.rejects(
    run({ ...f, args: { ...f.args, executionId: randomUUID() } }),
    /directory_receipt_ineligible/,
  );
  assert.deepEqual(await run(f), result);
});
test("raw derivative queue mutations remain fenced after genuine production", async () => {
  const f = await fixture();
  f.args.mode = "live";
  await run(f);
  await assert.rejects(
    pool.query(
      "update person_derivative_jobs set status='pending' where candidate_id=$1",
      [f.id],
    ),
    /derivative_producer_frame/,
  );
  await assert.rejects(
    pool.query("delete from person_derivative_jobs where candidate_id=$1", [
      f.id,
    ]),
    /derivative_producer_frame/,
  );
});
const auditLib = await import("../dist/worker-lib.mjs"),
  { planAudit } = await import("../person-audit/postcutover.mjs");
test("published directory events and following genuine application pass offline audit", async () => {
  const f = await fixture((s) => {
    s.board.name = "Synthetic";
  });
  f.args.mode = "live";
  await run(f);
  const assess = async () => {
    const s = (
      await pool.query(
        "select person_postcutover_audit_inputs_with_witness($1) r",
        [JSON.stringify([f.id])],
      )
    ).rows[0].r[0];
    return planAudit(s, auditLib, {
      complete: true,
      rows: new Map([[f.snapshot.board.contact_id, f.snapshot]]),
    });
  };
  const first = await assess();
  assert.equal(first.status, "verified", first.reason);
  const application = await processApp(
    await app(
      { email: randomUUID() + "@example.test" },
      f.before.linkedin_username,
    ),
  );
  assert.equal(application.status, "processed", application.error?.message);
  const second = await assess();
  assert.equal(second.status, "verified", second.reason);
});
test("uncertified preexisting matching work cannot be silently retained by ready publication", async () => {
  const f = await fixture();
  f.args.mode = "live";
  await phase(false);
  await pool.query(
    "update person_directory_receipts set derivative_text='stale',derivative_revision=0 where id=$1",
    [f.args.receiptId],
  );
  await phase();
  await assert.rejects(run(f), /directory_derivative_unproven/);
  assert.deepEqual(await row(f.id), f.before);
});
test("shared application projection also requires its before-image", async () => {
  const id = await app({ email: randomUUID() + "@example.test" });
  try {
    await pool.query(
      "create function person_private.synthetic_app_history() returns trigger language plpgsql as $$begin return null;end$$;create trigger zz_app_history before insert on person_projection_history for each row execute function person_private.synthetic_app_history()",
    );
    const out = await processApp(id);
    assert.equal(out.status, "failed");
    assert.match(out.error?.message || "", /projection_history_actual/);
  } finally {
    await pool.query(
      "drop trigger if exists zz_app_history on person_projection_history;drop function if exists person_private.synthetic_app_history()",
    );
  }
});
test("genuine application producer accepts non-UTC and non-default DateStyle", async () => {
  const id = await app({ email: randomUUID() + "@example.test" });
  let changed = false;
  const out = await processApp(id, {
    queryHook: async (sql, v, c) => {
      if (!changed && sql === "begin") {
        changed = true;
        await c.query(
          "set timezone='America/New_York';set datestyle='SQL,DMY'",
        );
      }
    },
  });
  assert.equal(out.status, "processed", out.error?.message);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from person_derivative_jobs where candidate_id=$1",
        [out.result.candidateId],
      )
    ).rows[0].n,
    1,
  );
});
async function nextReceipt(f) {
  const snapshot = structuredClone(f.snapshot);
  snapshot.board.updated_at = "2026-09-26";
  snapshot.phones.push(
    "+1415555" + String(Math.floor(Math.random() * 10000)).padStart(4, "0"),
  );
  const receipt = await rpc(pool, "public.person_directory_stage", [
    org,
    f.args.workspaceId,
    f.token,
    auditLib.directorySnapshotHash(snapshot),
    snapshot,
  ]);
  return {
    ...f,
    snapshot,
    args: {
      ...f.args,
      receiptId: receipt.receiptId,
      executionId: randomUUID(),
      mode: "live",
    },
  };
}
for (const status of ["processing", "done"])
  test(`unchanged content preserves ${status} job attempts/token/completion while advancing revision`, async () => {
    const f = await fixture();
    f.args.mode = "live";
    await run(f);
    await phase(false);
    const token = status === "processing" ? randomUUID() : null;
    await pool.query(
      "update person_derivative_jobs set status=$2,attempts=2,claim_token=$3,lease_until=case when $3::uuid is null then null else clock_timestamp()+interval '5 minutes' end,claim_missing='[]',completed_hash=desired_hash,error_code='retained' where candidate_id=$1",
      [f.id, status, token],
    );
    await phase();
    const before = (
      await pool.query(
        "select to_jsonb(j) r from person_derivative_jobs j where candidate_id=$1",
        [f.id],
      )
    ).rows[0].r;
    const next = await nextReceipt(f);
    await run(next);
    const after = (
      await pool.query(
        "select to_jsonb(j) r from person_derivative_jobs j where candidate_id=$1",
        [f.id],
      )
    ).rows[0].r;
    for (const key of [
      "desired_hash",
      "status",
      "attempts",
      "claim_token",
      "lease_until",
      "claim_missing",
      "completed_hash",
      "error_code",
      "updated_at",
    ])
      assert.deepEqual(after[key], before[key], key);
    assert.ok(Number(after.desired_revision) > Number(before.desired_revision));
  });
test("existing suppression and recruiter follow-up remain sticky during live publication", async () => {
  const f = await fixture(
    (s) => {
      s.board.follow_up_date = "2027-02-03";
    },
    async (db, id) =>
      db.query(
        "update candidates set status='Do Not Contact',follow_up_at='2027-01-02',contact='{\"preserved\":true}' where id=$1",
        [id],
      ),
  );
  f.args.mode = "live";
  await run(f);
  const after = await row(f.id);
  assert.equal(after.status, "Do Not Contact");
  assert.equal(after.follow_up_at, "2027-01-02");
  assert.deepEqual(after.contact, { preserved: true });
});
for (const corrupt of ["documents='[]'", "result='{}'", "source_reviews='[]'"])
  test(`shadow upgrade refuses altered public decision ${corrupt}`, async () => {
    const f = await fixture();
    await run(f);
    await phase(false);
    await pool.query(
      `update person_directory_receipts set ${corrupt} where id=$1`,
      [f.args.receiptId],
    );
    await phase();
    await assert.rejects(
      run({
        ...f,
        args: { ...f.args, mode: "live", executionId: randomUUID() },
      }),
      /directory_shadow_proof|directory_head_receipt/,
    );
  });
test("superseded shadow receipt cannot publish under a new execution", async () => {
  const f = await fixture(),
    shadow = await run(f);
  await nextReceipt(f);
  await assert.rejects(
    run({ ...f, args: { ...f.args, mode: "live", executionId: randomUUID() } }),
    /directory_receipt_ineligible/,
  );
  assert.deepEqual(await run(f), shadow);
});
for (const racing of [false, true])
  test(`directory ${racing ? "concurrent" : "preexisting"} email collision retains a checked fallback`, async () => {
    const email = randomUUID() + "@example.test",
      owner = randomUUID(),
      f = await fixture((s) => {
        s.board.primary_email = email;
        s.board.email_status = "Verified";
        s.emails = [
          {
            normalized: email,
            verification: {
              status: "Verified",
              primary: true,
              checked_at: "2026-09-25",
            },
          },
        ];
      });
    f.args.mode = "live";
    const competitor = await pool.connect();
    let waiting,
      observed = false;
    try {
      await competitor.query("begin");
      const result = await run(f, async (sql, v, c) => {
        if (!sql.includes("directory_project(")) return;
        const seed = {
          id: owner,
          full_name: "Synthetic",
          linkedin_username: "collision-" + owner,
          email,
          status: "Active",
        };
        await competitor.query(
          "select person_private.intake_frame_open($1,$2,$3,'seed',null,$4)",
          [randomUUID(), randomUUID(), owner, seed],
        );
        await competitor.query(
          "insert into candidates(id,full_name,linkedin_username,email) values($1,'Synthetic',$2,$3)",
          [owner, seed.linkedin_username, email],
        );
        await competitor.query("select person_private.intake_frame_clear()");
        if (!racing) {
          await competitor.query("commit");
          return;
        }
        const pid = (await c.query("select pg_backend_pid() pid")).rows[0].pid;
        waiting = (async () => {
          for (let n = 0; n < 100; n++) {
            observed = (
              await pool.query(
                "select wait_event_type='Lock' waiting from pg_stat_activity where pid=$1",
                [pid],
              )
            ).rows[0]?.waiting;
            if (observed) break;
            await new Promise((r) => setTimeout(r, 5));
          }
          await competitor.query("commit");
        })();
      });
      if (waiting) await waiting;
      if (racing) assert.equal(observed, true);
      assert.equal(result.status, "done");
      const after = await row(f.id),
        state = (
          await pool.query(
            "select * from person_projection_state where candidate_id=$1",
            [f.id],
          )
        ).rows[0];
      assert.equal(after.email, null);
      assert.equal(state.profile_hash, auditLib.projectionProfileHash(after));
      assert.equal(state.semantic_hash, auditLib.semanticProfileHash(after));
      assert.equal(
        (
          await pool.query(
            "select count(*)::int n from identity_conflicts where kind='legacy_email_collision' and $1=any(candidate_ids)",
            [f.id],
          )
        ).rows[0].n,
        1,
      );
    } finally {
      await competitor.query("rollback");
      if (waiting) await waiting;
      competitor.release();
    }
  });
test("directory producer rechecks lease after an actual derivative row lock wait", async () => {
  const appResult = await processApp(
    await app({ email: randomUUID() + "@example.test" }),
  );
  assert.equal(appResult.status, "processed", appResult.error?.message);
  const f = await stageExisting(appResult.result.candidateId);
  f.args.mode = "live";
  const holder = await pool.connect();
  let release,
    observed = false;
  try {
    await holder.query("begin");
    await holder.query(
      "select 1 from person_derivative_jobs where candidate_id=$1 for update",
      [f.id],
    );
    await assert.rejects(
      run(f, async (sql, v, c) => {
        if (!sql.includes("directory_enqueue(")) return;
        await c.query(
          "update person_private.transition_work set lease_until=clock_timestamp()+interval '150 milliseconds' where id=current_setting('person.work_id')::uuid",
        );
        const pid = (await c.query("select pg_backend_pid() pid")).rows[0].pid;
        release = (async () => {
          for (let n = 0; n < 100; n++) {
            observed = (
              await pool.query(
                "select wait_event_type='Lock' waiting from pg_stat_activity where pid=$1",
                [pid],
              )
            ).rows[0]?.waiting;
            if (observed) break;
            await new Promise((r) => setTimeout(r, 5));
          }
          await new Promise((r) => setTimeout(r, 200));
          await holder.query("commit");
        })();
      }),
      /transition_expired/,
    );
    if (release) await release;
    assert.equal(observed, true);
    assert.deepEqual(await row(f.id), f.before);
  } finally {
    await holder.query("rollback");
    if (release) await release;
    holder.release();
  }
});
for (const family of ["application", "directory"])
  test(`existing ${family} projection frame cannot nest into directory publication`, async () => {
    const f = await fixture();
    f.args.mode = "live";
    await assert.rejects(
      run(f, async (sql, v, c) => {
        if (!sql.includes("directory_project(")) return;
        const e = (
          await c.query(
            "select * from person_private.directory_executions where id=$1",
            [f.args.executionId],
          )
        ).rows[0];
        if (family === "application")
          await c.query(
            "insert into person_private.application_projection_frames values(pg_backend_pid(),pg_current_xact_id(),$1,$2,$3,'{}','{}')",
            [e.work_id, f.id, e.audit_id],
          );
        else
          await c.query(
            "insert into person_private.directory_projection_frames values(pg_backend_pid(),pg_current_xact_id(),$1,$2,$3,'{}','{}',$4)",
            [e.work_id, f.id, e.audit_id, e.id],
          );
      }),
      /projection_nested/,
    );
    assert.deepEqual(await row(f.id), f.before);
  });
test("no service capability is granted for directory publication or derivative production", async () => {
  for (const signature of [
    "directory_prepare(uuid)",
    "directory_project(uuid,bigint,jsonb)",
    "directory_metadata(uuid,numeric,jsonb,date,timestamp with time zone)",
    "directory_enqueue(uuid,jsonb,jsonb,text,text)",
    "derivative_enqueue(uuid,uuid,text,jsonb,jsonb)",
    "projection_apply(uuid,uuid,uuid,uuid,bigint,jsonb)",
    "publication_candidate(uuid)",
  ])
    assert.equal(
      (
        await pool.query(
          "select has_function_privilege('service_role',$1,'EXECUTE') allowed",
          ["person_private." + signature],
        )
      ).rows[0].allowed,
      false,
      signature,
    );
});
test('completion rejects matching work changed after its checked producer',async()=>{
 const f=await fixture();f.args.mode='live';
 await assert.rejects(run(f,async(sql,v,c)=>{if(!sql.includes('directory_complete('))return;
  await c.query("set local timezone='UTC';set local datestyle='ISO,YMD'");
  const before=(await c.query('select to_jsonb(r) r from person_directory_receipts r where id=$1',[f.args.receiptId])).rows[0].r;
  await c.query("select person_private.directory_mutate('person_directory_receipts',$1,$2)",[before,{...before,derivative_text:'tampered'}]);
 }),/directory_publication_incomplete/);assert.deepEqual(await row(f.id),f.before);
});
