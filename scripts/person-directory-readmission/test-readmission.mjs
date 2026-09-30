import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  row,
  state,
} from "../person-directory-suppression/test-suppression.mjs";
import {
  pool,
  org,
  rpc,
  phase,
  run,
  fixture,
  use,
} from "../person-directory-execution/test-execution.mjs";
import { fresh } from "../person-directory-creation/test-creation.mjs";
import {
  app,
  processApp,
} from "../person-application-enrichment/test-tt-enrichment.mjs";
import * as lib from "../dist/worker-lib.mjs";
const receipt = (f) =>
  use(async (c) => {
    await c.query(
      "begin;set local timezone='UTC';set local datestyle='ISO,YMD'",
    );
    return (
      await c.query(
        "select to_jsonb(r) r from person_directory_receipts r where id=$1",
        [f.args.receiptId],
      )
    ).rows[0].r;
  });
const retry = (f, mode = f.args.mode) => ({
  ...f,
  args: { ...f.args, executionId: randomUUID(), mode },
});
async function hold(f) {
  const id = randomUUID();
  await pool.query("alter table person_source_holds disable trigger all");
  try {
    await pool.query(
      "insert into person_source_holds(candidate_id,ledger_id,evidence_hash,reason,evidence) values($1,$2,'synthetic','harvest_cache_date_unknown','{}')",
      [f.id, id],
    );
  } finally {
    await pool.query("alter table person_source_holds enable trigger all");
  }
  return id;
}
async function resolve(id) {
  await pool.query("alter table person_source_holds disable trigger all");
  try {
    await pool.query(
      "update person_source_holds set resolved_at=clock_timestamp(),resolution='{}' where ledger_id=$1",
      [id],
    );
  } finally {
    await pool.query("alter table person_source_holds enable trigger all");
  }
}
test("resolved hold reuses the same certified receipt and preserves every UUID result", async () => {
  const f = await fixture((s) => {
      s.board.name = "Synthetic";
    }),
    h = await hold(f),
    original = await receipt(f),
    out = await run(f);
  assert.equal(out.reason, "directory_source_hold");
  await resolve(h);
  const next = retry(f),
    saved = await run(next);
  assert.equal(saved.status, "done");
  assert.equal(saved.candidateId, f.id);
  assert.deepEqual(await run(f), out);
  const after = await receipt(f);
  assert.deepEqual(after.snapshot, original.snapshot);
  assert.equal(after.captured_at, original.captured_at);
  assert.equal(after.snapshot_hash, original.snapshot_hash);
  assert.equal(after.attempts, 2);
  const live = retry(f, "live"),
    published = await run(live);
  assert.equal(published.status, "done");
  assert.equal(published.projected, true);
  assert.deepEqual(await run(next), saved);
  assert.deepEqual(await run(f), out);
  const snapshot = structuredClone(f.snapshot);
  snapshot.board.updated_at = "2026-09-28";
  const staged = await rpc(pool, "public.person_directory_stage", [
    org,
    f.args.workspaceId,
    f.token,
    lib.directorySnapshotHash(snapshot),
    snapshot,
  ]);
  const latest = {
    ...f,
    snapshot,
    args: {
      ...f.args,
      receiptId: staged.receiptId,
      executionId: randomUUID(),
      mode: "live",
    },
  };
  assert.equal((await run(latest)).status, "done");
  assert.equal(
    String((await state(f)).applied_receipt_id),
    String(staged.receiptId),
  );
});
test("unchanged source hold gets a new bounded review without losing attempts or old result", async () => {
  const f = await fixture(),
    h = await hold(f),
    out = await run(f),
    before = await row(f.id),
    next = retry(f);
  assert.deepEqual(await run(next), out);
  assert.equal((await receipt(f)).attempts, 2);
  assert.deepEqual(await row(f.id), before);
  assert.deepEqual(await run(f), out);
  await resolve(h);
});
test("unknown suppression reconsiders an identity created by a real application", async () => {
  const f = await fresh("live", (s) => {
      s.board.do_not_contact = true;
    }),
    out = await run(f),
    original = await receipt(f);
  assert.deepEqual(out, {
    status: "suppressed",
    candidateId: null,
    created: false,
  });
  const a = await processApp(
    await app({ email: randomUUID() + "@example.test" }, f.username),
  );
  assert.equal(a.status, "processed", a.error?.message);
  const cid = a.result.candidateId,
    before = await row(cid);
  assert.notEqual(before.status, "Do Not Contact");
  assert.deepEqual(await run(f), out);
  assert.deepEqual(await row(cid), before);
  const next = retry(f),
    suppressed = await run(next);
  assert.deepEqual(suppressed, {
    status: "suppressed",
    candidateId: cid,
    created: false,
  });
  assert.equal((await row(cid)).status, "Do Not Contact");
  assert.equal((await receipt(f)).attempts, 1);
  assert.deepEqual((await receipt(f)).snapshot, original.snapshot);
  assert.equal((await receipt(f)).captured_at, original.captured_at);
  const last = retry(f, "shadow"),
    unchanged = await row(cid);
  assert.deepEqual(await run(last), suppressed);
  assert.equal((await receipt(f)).attempts, 2);
  assert.deepEqual(await row(cid), unchanged);
  await phase(true, "held");
  assert.deepEqual(await run(f), out);
  assert.deepEqual(await run(next), suppressed);
  await phase();
});
test("restored normalized state makes the original reviewed input eligible", async () => {
  const f = await fixture((s) => {
      s.board.name = "Synthetic";
    }),
    profile = (
      await pool.query(
        "select to_jsonb(s) s from candidate_profile_state s where candidate_id=$1",
        [f.id],
      )
    ).rows[0].s;
  await phase(false);
  await pool.query(
    "delete from candidate_profile_state where candidate_id=$1",
    [f.id],
  );
  await phase();
  const out = await run(f);
  assert.equal(out.reason, "directory_person_not_migrated");
  await phase(false);
  await pool.query(
    "insert into candidate_profile_state select * from jsonb_populate_record(null::candidate_profile_state,$1)",
    [profile],
  );
  await phase();
  const next = retry(f);
  assert.equal((await run(next)).status, "done");
  assert.equal((await receipt(f)).attempts, 2);
  assert.deepEqual(await run(f), out);
});
for (const final of ["review", "normalized"])
  test(`restoring an older public result cannot hide the latest ${final} completion`, async () => {
    const f = await fixture((s) => {
        s.board.name = "Synthetic";
      }),
      h = await hold(f);
    await run(f);
    const older = await receipt(f);
    if (final === "normalized") await resolve(h);
    const next = retry(f);
    await run(next);
    const newer = await receipt(f);
    await use(async (c) => {
      await c.query(
        "begin;set local timezone='UTC';set local datestyle='ISO,YMD'",
      );
      await rpc(c, "person_private.directory_mutate", [
        "person_directory_receipts",
        newer,
        older,
      ]);
      await c.query("commit");
    });
    await assert.rejects(run(retry(f)), /directory_head_receipt/);
    assert.deepEqual(await receipt(f), older);
    assert.deepEqual(await run(next), newer.result);
  });
for (const mutation of ["delete", "hash", "pointer", "work"])
  test(`missing or altered receipt head ${mutation} is never reconstructed`, async () => {
    const f = await fresh("live", (s) => {
      s.board.linkedin_url = null;
    });
    await run(f);
    const before = await receipt(f);
    await pool.query(
      "alter table person_private.directory_heads disable trigger all",
    );
    try {
      if (mutation === "delete")
        await pool.query(
          "delete from person_private.directory_heads where receipt_id=$1",
          [f.args.receiptId],
        );
      else
        await pool.query(
          `update person_private.directory_heads set ${mutation === "hash" ? "completion_hash='unproved'" : mutation === "pointer" ? "execution_id=gen_random_uuid()" : "work_id=gen_random_uuid()"} where receipt_id=$1`,
          [f.args.receiptId],
        );
    } finally {
      await pool.query(
        "alter table person_private.directory_heads enable trigger all",
      );
    }
    await assert.rejects(
      run(retry(f)),
      /directory_head_missing|directory_head_invalid/,
    );
    assert.deepEqual(await receipt(f), before);
  });
for (const [table, when, action] of [
  ["person_private.directory_heads", "before insert", "return null;"],
  [
    "person_private.directory_heads",
    "before insert",
    "new.completion_hash:='unproved';return new;",
  ],
  ["person_private.directory_head_frames", "before insert", "return null;"],
  ["person_private.directory_head_frames", "before delete", "return null;"],
  ["person_private.directory_admissions", "before insert", "return null;"],
  [
    "person_private.directory_admissions",
    "before insert",
    "new.ready_receipt:=new.ready_receipt||'{\"attempts\":99}';return new;",
  ],
])
  test(`fresh completion ${table} ${when} ${action} cannot leave partial authority`, async () => {
    const f = await fresh("live", (s) => {
        s.board.linkedin_url = null;
      }),
      before = await receipt(f);
    try {
      await assert.rejects(
        run(f, async (sql, v, c) => {
          if (sql.includes("directory_outcome("))
            await c.query(
              `create function person_private.synthetic_readmission() returns trigger language plpgsql as $$begin ${action}end$$;create trigger zz_readmission ${when} on ${table} for each row execute function person_private.synthetic_readmission()`,
            );
        }),
        /directory_head|directory_admission/,
      );
      assert.deepEqual(await receipt(f), before);
    } finally {
      await pool.query(
        `drop trigger if exists zz_readmission on ${table};drop function if exists person_private.synthetic_readmission()`,
      );
    }
  });
for (const boundary of ["reset", "finish", "commit"])
  test(`failure after ${boundary} rolls readmission back to its completed receipt`, async () => {
    const f = await fixture(),
      h = await hold(f),
      out = await run(f),
      before = await receipt(f),
      next = retry(f);
    await resolve(h);
    try {
      await assert.rejects(
        run(next, async (sql, v, c) => {
          if (sql.includes("directory_outcome(") && boundary === "reset")
            await c.query(
              "create function person_private.synthetic_readmission_reset() returns trigger language plpgsql as $$begin if new.phase='ready' and old.phase='review' then raise exception 'synthetic_reset_abort';end if;return new;end$$;create trigger zz_readmission_reset after update on person_directory_receipts for each row execute function person_private.synthetic_readmission_reset()",
            );
          if (sql.includes("directory_outcome(") && boundary === "finish")
            await c.query(
              "create function person_private.synthetic_readmission_finish() returns trigger language plpgsql as $$begin if new.status='completed' then raise exception 'synthetic_finish_abort';end if;return new;end$$;create trigger zz_readmission_finish after update on person_private.transition_work for each row execute function person_private.synthetic_readmission_finish()",
            );
          if (sql === "commit" && boundary === "commit")
            await c.query(
              "update person_private.directory_admissions set ready_receipt=jsonb_set(ready_receipt,'{attempts}','99') where execution_id=$1",
              [next.args.executionId],
            );
        }),
        /synthetic_|directory_execution_incomplete/,
      );
      assert.deepEqual(await receipt(f), before);
      assert.deepEqual(await run(f), out);
      assert.equal(
        (
          await pool.query(
            "select count(*)::int n from person_private.directory_executions where id=$1",
            [next.args.executionId],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await pool.query(
        "drop trigger if exists zz_readmission_reset on person_directory_receipts;drop trigger if exists zz_readmission_finish on person_private.transition_work;drop function if exists person_private.synthetic_readmission_reset();drop function if exists person_private.synthetic_readmission_finish()",
      );
    }
  });

for (const boundary of ["reset", "commit"])
  for (const proof of [
    "outcome-change",
    "outcome-delete",
    "admission-change",
    "admission-delete",
    "suppression-event",
  ])
    test(`late predecessor ${proof} corruption at ${boundary} rolls back reconsideration`, async () => {
      const suppressed = proof === "suppression-event";
      const f = await fixture((s) => {
        if (suppressed) s.board.do_not_contact = true;
      });
      const h = suppressed ? null : await hold(f),
        out = await run(f),
        before = await receipt(f),
        next = retry(f);
      if (h) await resolve(h);
      const mutation =
        proof === "outcome-change"
          ? `update person_private.directory_outcomes set receipt_before=jsonb_set(receipt_before,'{snapshot}','{}') where execution_id='${f.args.executionId}'`
          : proof === "outcome-delete"
            ? `delete from person_private.directory_outcomes where execution_id='${f.args.executionId}'`
            : proof === "admission-change"
              ? `update person_private.directory_admissions set receipt_before=jsonb_set(receipt_before,'{attempts}','99') where execution_id='${f.args.executionId}'`
              : proof === "admission-delete"
                ? `delete from person_private.directory_admissions where execution_id='${f.args.executionId}'`
                : `update public.person_change_events set payload='{}' where id=(select (suppression->'event'->>'id')::bigint from person_private.directory_outcomes where execution_id='${f.args.executionId}')`;
      try {
        await assert.rejects(
          run(next, async (sql, v, c) => {
            if (sql.includes("directory_outcome(") && suppressed)
              await c.query(
                "alter table public.person_change_events disable trigger all",
              );
            if (sql === "commit" && boundary === "commit")
              await c.query(mutation);
            if (sql.includes("directory_outcome(") && boundary === "reset")
              await c.query(
                `create function person_private.synthetic_predecessor() returns trigger language plpgsql as $$begin if old.phase in ('review','suppressed') and new.phase='ready' then ${mutation};end if;return new;end$$;create trigger zz_predecessor after update on person_directory_receipts for each row execute function person_private.synthetic_predecessor()`,
              );
          }),
          /directory_admission_witness|directory_work_incomplete|directory_execution_incomplete/,
        );
        assert.deepEqual(await receipt(f), before);
        assert.deepEqual(await run(f), out);
      } finally {
        if (suppressed)
          await pool.query(
            "alter table public.person_change_events enable trigger all",
          );
        await pool.query(
          "drop trigger if exists zz_predecessor on person_directory_receipts;drop function if exists person_private.synthetic_predecessor()",
        );
      }
    });

for (const kind of ["receipt", "candidate"])
  test(`readmission rejects work expired during a real ${kind} row wait`, async () => {
    const f = await fixture(),
      h = await hold(f),
      original = await run(f),
      before = await receipt(f),
      next = retry(f);
    await resolve(h);
    const holder = await pool.connect();
    let pending,
      pid,
      observed = false;
    try {
      await holder.query("begin");
      await holder.query(
        kind === "receipt"
          ? "select id from person_directory_receipts where id=$1 for update"
          : "select id from candidates where id=$1 for update",
        [kind === "receipt" ? f.args.receiptId : f.id],
      );
      pending = run(next, async (sql, v, c) => {
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
      assert.deepEqual(await receipt(f), before);
      assert.deepEqual(await run(f), original);
    } finally {
      await holder.query("rollback");
      if (pending) await pending;
      holder.release();
    }
  });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
test("concurrent new UUIDs serialize against the latest completed review and preserve attempts", async () => {
  const f = await fixture(),
    h = await hold(f),
    original = await run(f),
    a = retry(f),
    b = retry(f),
    ready = deferred(),
    release = deferred();
  let secondPid, one, two;
  try {
    one = run(a, async (sql) => {
      if (sql.includes("directory_outcome(")) {
        ready.resolve();
        await release.promise;
      }
    });
    await ready.promise;
    two = run(b, async (sql, v, c) => {
      if (sql.includes("pg_advisory_xact_lock(72007"))
        secondPid = (await c.query("select pg_backend_pid() pid")).rows[0].pid;
    });
    let waiting = false;
    for (let n = 0; n < 100; n++) {
      if (
        secondPid &&
        (
          await pool.query(
            "select wait_event_type='Lock' waiting from pg_stat_activity where pid=$1",
            [secondPid],
          )
        ).rows[0]?.waiting
      ) {
        waiting = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(waiting, true);
    release.resolve();
    assert.deepEqual(await one, original);
    assert.deepEqual(await two, original);
    assert.equal((await receipt(f)).attempts, 3);
    assert.equal(
      (
        await pool.query(
          "select execution_id from person_private.directory_heads where receipt_id=$1",
          [f.args.receiptId],
        )
      ).rows[0].execution_id,
      b.args.executionId,
    );
    assert.deepEqual(await run(a), original);
    assert.deepEqual(await run(f), original);
  } finally {
    release.resolve();
    await Promise.allSettled([one, two].filter(Boolean));
    await resolve(h);
  }
});
test("superseded review cannot reenter even after its original hold is resolved", async () => {
  const f = await fixture(),
    h = await hold(f),
    out = await run(f);
  await resolve(h);
  const snapshot = structuredClone(f.snapshot);
  snapshot.board.updated_at = "2026-10-01";
  await rpc(pool, "public.person_directory_stage", [
    org,
    f.args.workspaceId,
    f.token,
    lib.directorySnapshotHash(snapshot),
    snapshot,
  ]);
  const before = await receipt(f);
  await assert.rejects(run(retry(f)), /directory_readmission_proof/);
  assert.deepEqual(await receipt(f), before);
  assert.deepEqual(await run(f), out);
});
test("new UUID cannot readmit a completed live normalized receipt", async () => {
  const f = await fixture();
  f.args.mode = "live";
  const out = await run(f),
    before = await receipt(f);
  await assert.rejects(
    run(retry(f)),
    /directory_receipt_ineligible|directory_shadow_proof/,
  );
  assert.deepEqual(await receipt(f), before);
  assert.deepEqual(await run(f), out);
});
test("private readmission capabilities and records are inaccessible to browser and service roles", async () => {
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const signature of [
      "directory_admit(uuid)",
      "directory_admission_valid(uuid)",
      "directory_completion_body(uuid)",
      "directory_completion_hash(uuid)",
      "directory_head_valid(jsonb,bigint)",
      "directory_outcome_history_valid(uuid)",
      "directory_suppression_history_valid(uuid,jsonb,jsonb)",
      "directory_head_guard()",
      "directory_head_complete()",
    ])
      assert.equal(
        (
          await pool.query(
            "select has_function_privilege($1,$2,'execute') allowed",
            [role, "person_private." + signature],
          )
        ).rows[0].allowed,
        false,
      );
    for (const table of [
      "directory_heads",
      "directory_admissions",
      "directory_head_frames",
    ])
      assert.equal(
        (
          await pool.query(
            "select has_table_privilege($1,$2,'select,insert,update,delete,truncate') allowed",
            [role, "person_private." + table],
          )
        ).rows[0].allowed,
        false,
      );
  }
});
for (const action of [
  "return null;",
  "new.completion_hash:='unproved';return new;",
])
  test(`readmission head update ${action} rolls back to the previous completion`, async () => {
    const f = await fixture(),
      h = await hold(f),
      out = await run(f),
      before = await receipt(f),
      next = retry(f);
    await resolve(h);
    try {
      await assert.rejects(
        run(next, async (sql, v, c) => {
          if (sql.includes("directory_outcome("))
            await c.query(
              `create function person_private.synthetic_head_update() returns trigger language plpgsql as $$begin ${action}end$$;create trigger zz_head_update before update on person_private.directory_heads for each row execute function person_private.synthetic_head_update()`,
            );
        }),
        /directory_head/,
      );
      assert.deepEqual(await receipt(f), before);
      assert.deepEqual(await run(f), out);
    } finally {
      await pool.query(
        "drop trigger if exists zz_head_update on person_private.directory_heads;drop function if exists person_private.synthetic_head_update()",
      );
    }
  });
for (const boundary of ["cas", "commit"])
  test(`head changed at ${boundary} cannot certify readmission`, async () => {
    const f = await fixture(),
      h = await hold(f),
      out = await run(f),
      before = await receipt(f),
      next = retry(f);
    await resolve(h);
    const mutation = `alter table person_private.directory_heads disable trigger all;update person_private.directory_heads set completion_hash='unproved' where receipt_id=${f.args.receiptId};alter table person_private.directory_heads enable trigger all;`;
    try {
      await assert.rejects(
        run(next, async (sql, v, c) => {
          if (sql === "commit" && boundary === "commit")
            await c.query(mutation);
          if (sql.includes("directory_outcome(") && boundary === "cas")
            await c.query(
              `create function person_private.synthetic_head_cas() returns trigger language plpgsql as $$begin if new.status='completed' then ${mutation}end if;return new;end$$;create trigger aaa_head_cas after update on person_private.transition_work for each row execute function person_private.synthetic_head_cas()`,
            );
        }),
        /directory_head_cas|directory_execution_incomplete/,
      );
      assert.deepEqual(await receipt(f), before);
      assert.deepEqual(await run(f), out);
    } finally {
      await pool.query(
        "drop trigger if exists aaa_head_cas on person_private.transition_work;drop function if exists person_private.synthetic_head_cas()",
      );
    }
  });
test("direct head mutations need the completing execution even for an unchanged row", async () => {
  const f = await fresh("live", (s) => {
    s.board.linkedin_url = null;
  });
  await run(f);
  for (const sql of [
    "update person_private.directory_heads set completion_hash=completion_hash where receipt_id=$1",
    "delete from person_private.directory_heads where receipt_id=$1",
  ])
    await assert.rejects(
      pool.query(sql, [f.args.receiptId]),
      /directory_head_frame/,
    );
  await assert.rejects(
    pool.query("truncate person_private.directory_heads"),
    /audit_proof_truncate/,
  );
});
for (const conflict of ["identity", "linkage"])
  test(`resolved ${conflict} conflict reconsiders current owners without replacing source evidence`, async () => {
    const other = randomUUID();
    const f = await fixture(
      (s) => {
        s.board.do_not_contact = true;
        if (conflict === "identity")
          s.identifiers = [
            { kind: "linkedin_username", value: "conflict-" + other },
          ];
      },
      async (c, id) => {
        if (conflict === "linkage")
          await c.query(
            "update candidates set directory_contact_id=$2 where id=$1",
            [id, other],
          );
      },
    );
    if (conflict === "identity") {
      await phase(false);
      await pool.query(
        "insert into candidates(id,full_name,linkedin_username) values($1,'Synthetic Other',$2)",
        [other, "conflict-" + other],
      );
      await phase();
    }
    const out = await run(f);
    assert.equal(
      out.reason,
      conflict === "identity"
        ? "directory_identity_conflict"
        : "directory_linkage_conflict",
    );
    const before = await receipt(f);
    await phase(false);
    if (conflict === "identity")
      await pool.query(
        "update candidates set linkedin_username=$2 where id=$1",
        [other, "resolved-" + other],
      );
    else
      await pool.query(
        "update candidates set directory_contact_id=null where id=$1",
        [f.id],
      );
    await phase();
    const next = retry(f),
      saved = await run(next);
    assert.deepEqual(saved, {
      status: "suppressed",
      candidateId: f.id,
      created: false,
    });
    assert.equal((await row(f.id)).status, "Do Not Contact");
    assert.deepEqual((await receipt(f)).snapshot, before.snapshot);
    assert.deepEqual(await run(f), out);
  });
