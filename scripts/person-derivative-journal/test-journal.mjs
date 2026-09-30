// Real producer paths on the complete disposable directory-worker schema.
import "../person-recruiter-admission/test-cross-family.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as worker from "../dist/worker-lib.mjs";
import {
  pool,
  phase,
  fixture,
  run,
  row,
  use,
  org,
} from "../person-directory-execution/test-execution.mjs";
import {
  app,
  processApp,
} from "../person-application-enrichment/test-tt-enrichment.mjs";

async function journal(id) {
  return (
    await pool.query(
      `select j.*,w.status work_status from person_private.derivative_job_changes j
 join person_private.transition_work w on w.id=j.work_id where j.candidate_id=$1 order by j.sequence`,
      [id],
    )
  ).rows;
}
async function current(id) {
  return (
    await pool.query("select person_private.derivative_job_current($1) valid", [
      id,
    ])
  ).rows[0].valid;
}
test("application enqueue has checked journal before application work completes", async () => {
  let id;
  const out = await processApp(await app(), {
    afterIntake: async (saved) => {
      id = saved.candidateId;
      const entries = await journal(id);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].work_status, "active");
      assert.equal(entries[0].owner_binding.family, "application");
      assert.equal(await current(id), true);
    },
  });
  assert.equal(out.status, "processed", out.error?.message);
  assert.equal((await journal(id))[0].work_status, "completed");
  assert.equal(await current(id), true);
});
test("directory publication appends once and replay retains the same head", async () => {
  const f = await fixture();
  f.args.mode = "live";
  const result = await run(f);
  assert.equal(result.status, "done");
  const before = await journal(f.id);
  assert.equal(before.length, 1);
  assert.equal(before[0].owner_binding.family, "directory");
  assert.deepEqual(await run(f), result);
  assert.deepEqual(await journal(f.id), before);
  assert.equal(await current(f.id), true);
});
test("owned public job cannot be changed while transition enforcement is off", async () => {
  const out = await processApp(await app());
  assert.equal(out.status, "processed", out.error?.message);
  const id = out.result.candidateId;
  await phase(false);
  try {
    await assert.rejects(
      pool.query(
        "update person_derivative_jobs set attempts=attempts+1 where candidate_id=$1",
        [id],
      ),
      /derivative_producer_frame/,
    );
    assert.equal(await current(id), true);
  } finally {
    await phase();
  }
});

test("two genuine application enqueues in one transaction retain both certificates", async () => {
  let repeated = false;
  const out = await processApp(await app(), {
    queryHook: async (sql, values, c) => {
      if (!repeated && sql.includes("person_private.derivative_enqueue(")) {
        repeated = true;
        await c.query(sql, values);
      }
    },
  });
  assert.equal(out.status, "processed", out.error?.message);
  assert.equal(repeated, true);
  const entries = await journal(out.result.candidateId);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].previous_id, entries[0].id);
  assert.deepEqual(entries[1].before_row, entries[0].after_row);
  assert.equal(entries[1].work_id, entries[0].work_id);
  assert.equal(await current(out.result.candidateId), true);
});

for (const table of ["derivative_job_changes", "derivative_job_heads"])
  for (const kind of ["suppress", "corrupt"])
    test(`${kind} ${table} rolls back the producer and public job`, async () => {
      const f = await fixture();
      f.args.mode = "live";
      const action =
        kind === "suppress"
          ? "return null;"
          : table === "derivative_job_changes"
            ? "new.seal_hash:=repeat('0',64);return new;"
            : "new.sequence:=999;return new;";
      await pool.query(
        `create function person_private.synthetic_journal() returns trigger language plpgsql as $$begin ${action}end$$;create trigger zz_synthetic_journal before insert on person_private.${table} for each row execute function person_private.synthetic_journal()`,
      );
      try {
        await assert.rejects(run(f), /derivative_journal/);
        assert.equal(
          (
            await pool.query(
              "select count(*)::int n from person_derivative_jobs where candidate_id=$1",
              [f.id],
            )
          ).rows[0].n,
          0,
        );
        assert.equal((await journal(f.id)).length, 0);
      } finally {
        await pool.query(
          `drop trigger zz_synthetic_journal on person_private.${table};drop function person_private.synthetic_journal()`,
        );
      }
    });

test("late public job mutation during head insertion rolls back the entire producer", async () => {
  const f = await fixture();
  f.args.mode = "live";
  await pool.query(
    "create function person_private.synthetic_late_job() returns trigger language plpgsql as $$begin update public.person_derivative_jobs set attempts=attempts+1 where candidate_id=new.candidate_id;return new;end$$;create trigger zz_synthetic_late_job after insert on person_private.derivative_job_heads for each row execute function person_private.synthetic_late_job()",
  );
  try {
    await assert.rejects(run(f), /derivative_producer/);
    assert.equal((await journal(f.id)).length, 0);
  } finally {
    await pool.query(
      "drop trigger zz_synthetic_late_job on person_private.derivative_job_heads;drop function person_private.synthetic_late_job()",
    );
  }
});

test("journal and head mutation remain refused after work completion and disabling enforcement", async () => {
  const out = await processApp(await app());
  assert.equal(out.status, "processed", out.error?.message);
  const id = out.result.candidateId,
    entries = await journal(id);
  await phase(false);
  try {
    await assert.rejects(
      pool.query(
        "update person_private.derivative_job_changes set seal_hash=repeat('0',64) where candidate_id=$1",
        [id],
      ),
      /derivative_journal/,
    );
    await assert.rejects(
      pool.query(
        "delete from person_private.derivative_job_heads where candidate_id=$1",
        [id],
      ),
      /derivative_journal/,
    );
    await assert.rejects(
      pool.query("delete from person_derivative_jobs where candidate_id=$1", [
        id,
      ]),
      /derivative_producer_frame/,
    );
    await assert.rejects(
      pool.query("truncate person_private.derivative_job_changes cascade"),
      /derivative_journal/,
    );
    await assert.rejects(
      pool.query(
        "update person_private.transition_work set family='maintenance' where id=$1",
        [entries[0].work_id],
      ),
    );
    assert.deepEqual(await journal(id), entries);
    assert.equal(await current(id), true);
  } finally {
    await phase();
  }
});

// Deliberately damaged history in this disposable loopback fixture must fail
// closed; privileged fixture repair restores the exact previously checked head.
async function replaceHead(id, head) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(
      "alter table person_private.derivative_job_heads disable trigger user",
    );
    await c.query(
      "delete from person_private.derivative_job_heads where candidate_id=$1",
      [id],
    );
    if (head)
      await c.query(
        "insert into person_private.derivative_job_heads select * from jsonb_populate_record(null::person_private.derivative_job_heads,$1)",
        [head],
      );
    await c.query(
      "alter table person_private.derivative_job_heads enable trigger user",
    );
    await c.query("commit");
  } finally {
    await c.query("rollback");
    c.release();
  }
}
test("missing head cannot turn retained history into a new genesis or an unowned job", async () => {
  const f = await fixture((s) => {
    s.board.name = "Synthetic";
  });
  f.args.mode = "live";
  await run(f);
  const head = (
    await pool.query(
      "select to_jsonb(h) h from person_private.derivative_job_heads h where candidate_id=$1",
      [f.id],
    )
  ).rows[0].h;
  await replaceHead(f.id, null);
  try {
    assert.equal(await current(f.id), false);
    await phase(false);
    await assert.rejects(
      pool.query(
        "update person_derivative_jobs set attempts=attempts+1 where candidate_id=$1",
        [f.id],
      ),
      /derivative_producer_frame/,
    );
    await phase();
    const out = await processApp(
      await app({ preferred_roles: ["New"] }, f.before.linkedin_username),
    );
    assert.equal(out.status, "failed");
    assert.match(out.error?.message || "", /derivative_journal_missing_head/);
    assert.equal((await journal(f.id)).length, 1);
  } finally {
    await replaceHead(f.id, head);
    await phase();
  }
  assert.equal(await current(f.id), true);
});

test("application lease crossing during head insertion rejects before its intake commits", async () => {
  const id = await app();
  let delayed = false;
  await pool.query(
    "create function person_private.synthetic_journal_delay() returns trigger language plpgsql as $$begin perform pg_sleep(0.4);return new;end$$;create trigger zz_synthetic_journal_delay after insert on person_private.derivative_job_heads for each row execute function person_private.synthetic_journal_delay()",
  );
  try {
    const out = await processApp(id, {
      queryHook: async (sql, values, c) => {
        if (!delayed && sql.includes("person_private.derivative_enqueue(")) {
          delayed = true;
          await c.query(
            "update person_private.transition_work set lease_until=clock_timestamp()+interval '200 milliseconds' where id=nullif(current_setting('person.work_id',true),'')::uuid",
          );
        }
      },
    });
    assert.equal(delayed, true);
    assert.equal(out.status, "failed");
    assert.match(out.error?.message || "", /expired|admission/);
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from person_application_receipts where application_id=$1",
          [id],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await pool.query(
      "drop trigger zz_synthetic_journal_delay on person_private.derivative_job_heads;drop function person_private.synthetic_journal_delay()",
    );
  }
});

test("concurrent producers serialize their journal through the candidate lock", async () => {
  const username = "journal-concurrent-" + randomUUID();
  const first = await processApp(await app({}, username));
  assert.equal(first.status, "processed", first.error?.message);
  const ids = [
    await app({ preferred_roles: ["One"] }, username),
    await app({ preferred_roles: ["Two"] }, username),
  ];
  const results = await Promise.all(ids.map((id) => processApp(id)));
  for (const result of results)
    assert.equal(result.status, "processed", result.error?.message);
  const entries = await journal(first.result.candidateId);
  assert.equal(entries.length, 3);
  for (let i = 1; i < entries.length; i++) {
    assert.equal(entries[i].previous_id, entries[i - 1].id);
    assert.deepEqual(entries[i].before_row, entries[i - 1].after_row);
  }
  assert.equal(await current(first.result.candidateId), true);
});

test("refresh and later application append without invalidating completed directory history", async () => {
  const f = await fixture((s) => {
    s.board.name = "Synthetic";
  });
  f.args.mode = "live";
  await run(f);
  const first = await journal(f.id),
    queue = randomUUID(),
    requestId = randomUUID();
  await phase(false);
  await pool.query(
    "insert into refresh_queue(id,organization_id,candidate_id) values($1,$2,$3)",
    [queue, org, f.id],
  );
  await pool.query(
    "insert into candidate_enrichments(candidate_id,organization_id,linkedin_username,raw_payload,created_at) values($1,$2,$3,$4,clock_timestamp()-interval '1 day')",
    [
      f.id,
      org,
      f.before.linkedin_username,
      { headline: "Synthetic refresh", experience: [] },
    ],
  );
  await phase();
  process.env.PERSON_TRANSITION_SUPPORT = "on";
  const args = {
    organizationId: org,
    queueId: queue,
    requestId,
    token: randomUUID(),
    dailyCap: 0,
    allowPaid: false,
    mode: "live",
  };
  assert.equal(
    (await use((c) => worker.claimCertifiedRefreshOnConnection(c, args)))
      .status,
    "claimed",
  );
  assert.equal(
    (await use((c) => worker.saveCertifiedRefreshOnConnection(c, args))).status,
    "done",
  );
  const application = await processApp(
    await app(
      { email: randomUUID() + "@example.test" },
      f.before.linkedin_username,
    ),
  );
  assert.equal(application.status, "processed", application.error?.message);
  const entries = await journal(f.id);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], first[0]);
  assert.deepEqual(
    entries.map((e) => e.owner_binding.family),
    ["directory", "refresh", "application"],
  );
  for (const entry of entries)
    assert.equal(
      (
        await pool.query(
          "select person_private.derivative_job_change_valid($1) valid",
          [entry.id],
        )
      ).rows[0].valid,
      true,
    );
  assert.equal(await current(f.id), true);
});

test("suppressed head update cannot advance a second producer or lose the prior job", async () => {
  const username = "journal-update-" + randomUUID(),
    first = await processApp(await app({}, username));
  assert.equal(first.status, "processed", first.error?.message);
  const id = first.result.candidateId,
    before = await journal(id);
  await pool.query(
    "create function person_private.synthetic_head_update() returns trigger language plpgsql as $$begin return null;end$$;create trigger zz_synthetic_head_update before update on person_private.derivative_job_heads for each row execute function person_private.synthetic_head_update()",
  );
  try {
    const out = await processApp(
      await app({ preferred_roles: ["New"] }, username),
    );
    assert.equal(out.status, "failed");
    assert.match(out.error?.message || "", /derivative_journal_actual/);
    assert.deepEqual(await journal(id), before);
    assert.equal(await current(id), true);
  } finally {
    await pool.query(
      "drop trigger zz_synthetic_head_update on person_private.derivative_job_heads;drop function person_private.synthetic_head_update()",
    );
  }
});

test("moving an owned job to an unowned candidate is refused with enforcement off", async () => {
  const first = await processApp(await app());
  assert.equal(first.status, "processed", first.error?.message);
  const f = await fixture();
  await phase(false);
  try {
    await assert.rejects(
      pool.query(
        "update person_derivative_jobs set candidate_id=$2 where candidate_id=$1",
        [first.result.candidateId, f.id],
      ),
      /derivative_producer_frame/,
    );
    assert.equal(await current(first.result.candidateId), true);
  } finally {
    await phase();
  }
});

for (const table of ["derivative_journal_frames", "derivative_producer_frames"])
  test(`suppressed ${table} cleanup cannot leave a committed certificate`, async () => {
    const f = await fixture();
    f.args.mode = "live";
    await pool.query(
      `create function person_private.synthetic_cleanup() returns trigger language plpgsql as $$begin return null;end$$;create trigger zz_synthetic_cleanup before delete on person_private.${table} for each row execute function person_private.synthetic_cleanup()`,
    );
    try {
      await assert.rejects(run(f), /derivative_journal/);
      assert.equal((await journal(f.id)).length, 0);
    } finally {
      await pool.query(
        `drop trigger zz_synthetic_cleanup on person_private.${table};drop function person_private.synthetic_cleanup()`,
      );
    }
  });
