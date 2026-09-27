import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import "../person-directory-publication/test-publication.mjs";
import {
  pool,
  org,
  rpc,
  phase,
  row,
  run,
  use,
  fixture,
} from "../person-directory-execution/test-execution.mjs";
import {
  app,
  processApp,
} from "../person-application-enrichment/test-tt-enrichment.mjs";
import * as lib from "../dist/worker-lib.mjs";
import { planAudit } from "../person-audit/postcutover.mjs";
async function fresh(mode = "live", patch = () => {}) {
  const workspaceId = randomUUID(),
    token = randomUUID(),
    username = "new-directory-" + randomUUID();
  await phase();
  process.env.PERSON_TRANSITION_SUPPORT = "on";
  await rpc(pool, "public.person_directory_claim", [org, workspaceId, token]);
  const snapshot = {
    board: {
      contact_id: randomUUID(),
      name: "Synthetic New Person",
      linkedin_url: "https://www.linkedin.com/in/" + username,
      title: "New Engineer",
      updated_at: "2026-09-26",
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
  const staged = await rpc(pool, "public.person_directory_stage", [
    org,
    workspaceId,
    token,
    lib.directorySnapshotHash(snapshot),
    snapshot,
  ]);
  return {
    username,
    snapshot,
    token,
    args: {
      organizationId: org,
      workspaceId,
      receiptId: staged.receiptId,
      executionId: randomUUID(),
      mode,
    },
  };
}
async function assess(id, f) {
  const snap = (
    await pool.query(
      "select person_postcutover_audit_inputs_with_witness($1) r",
      [JSON.stringify([id])],
    )
  ).rows[0].r[0];
  return planAudit(snap, lib, {
    complete: true,
    rows: new Map([[f.snapshot.board.contact_id, f.snapshot]]),
  });
}
for (const mode of ["live", "shadow"])
  test(`new directory ${mode} atomically creates one certified person with legacy producer disposition`, async () => {
    const f = await fresh(mode),
      out = await run(f);
    assert.equal(out.status, "done");
    assert.equal(out.created, true);
    assert.equal(out.projected, true);
    const candidate = await row(out.candidateId);
    assert.equal(candidate.linkedin_username, f.username);
    assert.equal(candidate.full_name, "Synthetic New Person");
    assert.equal(candidate.current_title, "New Engineer");
    assert.equal(candidate.source, "directory");
    const receipt = (
      await pool.query("select * from person_directory_receipts where id=$1", [
        f.args.receiptId,
      ])
    ).rows[0];
    assert.equal(receipt.created_person, true);
    assert.equal(receipt.projected, true);
    assert.ok(receipt.derivative_text);
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from person_derivative_jobs where candidate_id=$1",
          [out.candidateId],
        )
      ).rows[0].n,
      mode === "live" ? 1 : 0,
    );
    const anchor = (
      await pool.query(
        "select kind,creator_ref from person_audit_anchors where candidate_id=$1",
        [out.candidateId],
      )
    ).rows[0];
    assert.equal(anchor.kind, "receipt_created");
    assert.equal(anchor.creator_ref, "directory:" + f.args.receiptId);
    assert.deepEqual(await run(f), out);
    const audit = await assess(out.candidateId, f);
    assert.equal(audit.status, "verified", audit.reason);
  });
test("created shadow then newer application then live upgrade preserves original creator and both results", async () => {
  const f = await fresh("shadow"),
    shadow = await run(f),
    original = (
      await pool.query(
        "select to_jsonb(a) a from person_audit_anchors a where candidate_id=$1",
        [shadow.candidateId],
      )
    ).rows[0].a;
  const appResult = await processApp(
    await app({ email: randomUUID() + "@example.test" }, f.username),
    {
      harvest: "fresh",
      harvestPayload: {
        firstName: "Synthetic",
        lastName: "Latest",
        experience: [
          {
            position: "Latest engineer",
            companyName: "Synthetic latest",
            startDate: { year: 2026 },
          },
        ],
      },
    },
  );
  assert.equal(appResult.status, "processed", appResult.error?.message);
  assert.equal(
    (await row(shadow.candidateId)).current_title,
    "Latest engineer",
  );
  const promoted = {
      ...f,
      args: { ...f.args, executionId: randomUUID(), mode: "live" },
    },
    live = await run(promoted);
  assert.equal(live.candidateId, shadow.candidateId);
  assert.equal(live.created, true);
  assert.equal((await row(live.candidateId)).current_title, "Latest engineer");
  assert.deepEqual(
    (
      await pool.query(
        "select to_jsonb(a) a from person_audit_anchors a where candidate_id=$1",
        [shadow.candidateId],
      )
    ).rows[0].a,
    original,
  );
  assert.deepEqual(await run(f), shadow);
  assert.deepEqual(await run(promoted), live);
  const r = (
    await pool.query("select * from person_directory_receipts where id=$1", [
      f.args.receiptId,
    ])
  ).rows[0];
  assert.ok(r.derivative_text.includes("Latest engineer"));
  assert.equal(String(r.derivative_revision), live.revision);
  for (const key of [
    "derivative_token",
    "derivative_lease_until",
    "derivatives_claimed_at",
    "derivative_error",
  ])
    assert.equal(r[key], null);
  assert.equal(r.derivative_attempts, 0);
  assert.equal(r.derivative_done, false);
  assert.equal((await assess(live.candidateId, f)).status, "verified");
});
for (const boundary of [
  "directory_bind",
  "directory_audit_begin",
  "directory_normalize",
  "directory_project",
  "directory_enqueue",
  "directory_complete",
])
  test(`new candidate failure at ${boundary} retains neither seed nor partial proof`, async () => {
    const f = await fresh();
    await assert.rejects(
      run(f, async (sql) => {
        if (sql.includes(boundary + "("))
          throw Error("synthetic_creation_failure");
      }),
      /synthetic_creation_failure/,
    );
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from candidates where linkedin_username=$1",
          [f.username],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from person_private.directory_executions where id=$1",
          [f.args.executionId],
        )
      ).rows[0].n,
      0,
    );
  });
test("fresh application Harvest date survives a non-ISO caller session", async () => {
  const id = await app({ email: randomUUID() + "@example.test" });
  let changed = false;
  const result = await processApp(id, {
    harvest: "fresh",
    queryHook: async (sql, v, c) => {
      if (!changed && sql === "begin") {
        changed = true;
        await c.query(
          "set timezone='America/New_York';set datestyle='SQL,DMY'",
        );
      }
    },
  });
  assert.equal(result.status, "processed", result.error?.message);
  const r = (
    await pool.query(
      "select r.documents,extract(epoch from l.created_at)*1000 created_ms from person_application_receipts r join candidate_enrichments l on l.id=r.harvest_ledger_id where r.application_id=$1",
      [id],
    )
  ).rows[0];
  assert.equal(
    Date.parse(r.documents[2].source.fetched_at),
    Math.floor(Number(r.created_ms)),
  );
});

async function noSeed(f) {
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from candidates where linkedin_username=$1",
        [f.username],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from person_private.directory_executions where id=$1",
        [f.args.executionId],
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
}
// Missing creation attribution must roll back the whole candidate, not poison
// its audit anchor and make every subsequent legitimate intake fail.
for (const action of [
  "return null;",
  "new.scope:='profile';return new;",
  "new.event_hash:='unproved';return new;",
  "new.changed_fields:='{}';return new;",
])
  test(`creation attribution ${action} cannot commit a new person`, async () => {
    const f = await fresh();
    try {
      await assert.rejects(
        run(f, async (sql, v, c) => {
          if (sql.includes("directory_audit_begin("))
            await c.query(
              `create function person_private.synthetic_creation_attribution() returns trigger language plpgsql as $$begin if new.scope='creation' then ${action} end if;return new;end$$;create trigger zz_creation_attribution before insert on person_change_attributions for each row execute function person_private.synthetic_creation_attribution()`,
            );
        }),
        /audit_creation_event|directory_creation/,
      );
      await noSeed(f);
    } finally {
      await pool.query(
        "drop trigger if exists zz_creation_attribution on person_change_attributions;drop function if exists person_private.synthetic_creation_attribution()",
      );
    }
  });

for (const patch of [
  (s) => {
    s.board.linkedin_url = null;
  },
  (s) => {
    s.board.do_not_contact = true;
  },
  (s) => {
    s.board.status = "Do Not Contact";
  },
])
  test("unadmitted no-LinkedIn or suppressed snapshot creates no person", async () => {
    const f = await fresh("live", patch);
    await assert.rejects(
      use(async c => {
        await c.query('begin');
        await rpc(c,'person_private.directory_begin',[org,f.args.workspaceId,f.args.receiptId,f.args.executionId,'live',randomUUID()]);
        return rpc(c,'person_private.directory_seed',[f.args.executionId,f.username,JSON.stringify(lib.directoryIdentities(f.snapshot))]);
      }),
      /directory_linkedin_required|directory_suppression_unavailable/,
    );
    await noSeed(f);
  });
test("creation uses canonical Unicode URL and fallback name", async () => {
  const username = "synthetic-é-" + randomUUID(),
    f = await fresh("shadow", (s) => {
      s.board.name = "";
      s.board.linkedin_url =
        "https://www.linkedin.com/in/" + encodeURIComponent(username);
    });
  const out = await run(f),
    c = await row(out.candidateId);
  assert.equal(c.full_name, username);
  assert.equal(c.linkedin_username, username);
  assert.equal(
    c.linkedin_url,
    "https://www.linkedin.com/in/" + encodeURIComponent(username),
  );
});
test("new seed cannot commit or use generic completion before full execution", async () => {
  const f = await fresh();
  await use(async (c) => {
    await c.query("begin");
    const token = randomUUID(),
      admission = await rpc(c, "person_private.directory_begin", [
        org,
        f.args.workspaceId,
        f.args.receiptId,
        f.args.executionId,
        "live",
        token,
      ]);
    await rpc(c, "person_private.directory_seed", [
      f.args.executionId,
      f.username,
      JSON.stringify(lib.directoryIdentities(f.snapshot)),
    ]);
    await c.query("savepoint unfinished");
    await assert.rejects(
      rpc(c, "public.person_transition_finish", [
        admission.workId,
        token,
        "completed",
      ]),
      /directory_completion_witness/,
    );
    await c.query("rollback to savepoint unfinished");
    await assert.rejects(c.query("commit"), /directory_execution_incomplete/);
  });
  await noSeed(f);
});
for (const [table, action] of [
  ["candidates", "return null;"],
  ["candidates", "new.full_name:='Unproved';return new;"],
  ["person_private.directory_seed_frames", "return null;"],
  [
    "person_private.directory_seed_frames",
    'new.expected_row:=new.expected_row||\'{"status":"unproved"}\'::jsonb;return new;',
  ],
  ["person_private.directory_creations", "return null;"],
  [
    "person_private.directory_creations",
    "new.input_hash:='unproved';return new;",
  ],
])
  test(`seed ${table} ${action} rolls back creation`, async () => {
    const f = await fresh();
    try {
      await assert.rejects(
        run(f, async (sql, v, c) => {
          if (sql.includes("directory_seed("))
            await c.query(
              `create function person_private.synthetic_seed() returns trigger language plpgsql as $$begin ${action}end$$;create trigger zz_seed before insert on ${table} for each row execute function person_private.synthetic_seed()`,
            );
        }),
        /directory_seed|directory_creation|transition_required|candidate_mutation_frame/,
      );
      await noSeed(f);
    } finally {
      await pool.query(
        `drop trigger if exists zz_seed on ${table};drop function if exists person_private.synthetic_seed()`,
      );
    }
  });
for (const family of ["application", "directory"])
  for (const corrupt of ["remove", "transfer"])
    test(`${family} rejects ${corrupt}d original directory creator attribution`, async () => {
      const f = await fresh(),
        out = await run(f),
        other = await processApp(
          await app({ email: randomUUID() + "@example.test" }),
        );
      assert.equal(other.status, "processed");
      const ev = (
        await pool.query(
          "select creator_event_id from person_private.directory_creations where candidate_id=$1",
          [out.candidateId],
        )
      ).rows[0].creator_event_id;
      await phase(false);
      await pool.query(
        "alter table person_change_attributions disable trigger all",
      );
      try {
        if (corrupt === "remove")
          await pool.query(
            "delete from person_change_attributions where event_id=$1",
            [ev],
          );
        else
          await pool.query(
            "update person_change_attributions set candidate_id=$2 where event_id=$1",
            [ev, other.result.candidateId],
          );
      } finally {
        await pool.query(
          "alter table person_change_attributions enable trigger all",
        );
        await phase();
      }
      if (family === "application") {
        const a = await processApp(
          await app({ email: randomUUID() + "@example.test" }, f.username),
        );
        assert.equal(a.status, "failed");
        assert.match(a.error?.message || "", /audit_creation_event/);
      } else {
        const next = await nextReceipt(f);
        await assert.rejects(run(next), /audit_creation_event/);
      }
    });
test("promoted directory creator remains valid for later application and directory receipts", async () => {
  const f = await fresh("shadow"),
    shadow = await run(f);
  await run({
    ...f,
    args: { ...f.args, executionId: randomUUID(), mode: "live" },
  });
  const a = await processApp(
    await app({ email: randomUUID() + "@example.test" }, f.username),
  );
  assert.equal(a.status, "processed", a.error?.message);
  const next = await nextReceipt(f);
  const out = await run(next);
  assert.equal(out.created, false);
  assert.equal(out.candidateId, shadow.candidateId);
  const audit = await assess(out.candidateId, next);
  assert.equal(audit.status, "verified", audit.reason);
});
async function nextReceipt(f) {
  const snapshot = structuredClone(f.snapshot);
  snapshot.board.updated_at = "2026-09-28";
  const receipt = await rpc(pool, "public.person_directory_stage", [
    org,
    f.args.workspaceId,
    f.token,
    lib.directorySnapshotHash(snapshot),
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
test("self-consistent but altered creation anchor must roll back", async () => {
  const f = await fresh();
  try {
    await assert.rejects(
      run(f, async (sql, v, c) => {
        if (sql.includes("directory_audit_begin("))
          await c.query(
            "create function person_private.synthetic_creation_anchor() returns trigger language plpgsql as $$begin new.captured_version:=9223372036854770000;new.anchor_hash:=person_private.audit_anchor_hash(to_jsonb(new));return new;end$$;create trigger zz_creation_anchor before insert on person_audit_anchors for each row execute function person_private.synthetic_creation_anchor()",
          );
      }),
      /audit_creation_anchor|audit_creation_receipt/,
    );
    await noSeed(f);
  } finally {
    await pool.query(
      "drop trigger if exists zz_creation_anchor on person_audit_anchors;drop function if exists person_private.synthetic_creation_anchor()",
    );
  }
});
for (const [key, value] of [
  ["candidate_hash", "tampered"],
  ["version", "unproved"],
  ["captured_version", "9223372036854770000"],
  ["auxiliary", {}],
])
  test(`changed creator guard ${key} cannot certify a poisoned checkpoint`, async () => {
    const f = await fresh();
    try {
      await assert.rejects(
        run(f, async (sql, v, c) => {
          if (sql.includes("directory_audit_begin("))
            await c.query(
              `create function person_private.synthetic_creation_operation() returns trigger language plpgsql as $$begin if new.writer='directory' and new.evidence ? 'creator_event_id' then new.evidence:=jsonb_set(new.evidence,'{guard,${key}}','${JSON.stringify(value)}'::jsonb);end if;return new;end$$;create trigger zz_creation_operation before insert on person_audit_operations for each row execute function person_private.synthetic_creation_operation()`,
            );
        }),
        /audit_creation_event/,
      );
      await noSeed(f);
    } finally {
      await pool.query(
        "drop trigger if exists zz_creation_operation on person_audit_operations;drop function if exists person_private.synthetic_creation_operation()",
      );
    }
  });
for (const action of [
  "return null;",
  "new.anchor_hash:='unproved';return new;",
])
  test(`missing or changed private anchor certificate ${action} rolls back creation`, async () => {
    const f = await fresh();
    try {
      await assert.rejects(
        run(f, async (sql, v, c) => {
          if (sql.includes("directory_audit_begin("))
            await c.query(
              `create function person_private.synthetic_creation_certificate() returns trigger language plpgsql as $$begin ${action}end$$;create trigger zz_creation_certificate before insert on person_private.certified_audit_anchors for each row execute function person_private.synthetic_creation_certificate()`,
            );
        }),
        /audit_anchor_uncertified|audit_creation_anchor/,
      );
      await noSeed(f);
    } finally {
      await pool.query(
        "drop trigger if exists zz_creation_certificate on person_private.certified_audit_anchors;drop function if exists person_private.synthetic_creation_certificate()",
      );
    }
  });
test("existing anchored person with missing normalized state cannot claim creation", async () => {
  const f = await fixture();
  await assert.rejects(
    run(f, async (sql, v, c) => {
      if (sql.includes("directory_bind(")) {
        await c.query(
          "alter table candidate_profile_state disable trigger all",
        );
        await c.query(
          "delete from candidate_profile_state where candidate_id=$1",
          [f.id],
        );
        await c.query("alter table candidate_profile_state enable trigger all");
      }
    }),
    /directory_person_not_migrated/,
  );
});
test("unchanged created-shadow promotion preserves certified matching work and adds chunks", async () => {
  const f = await fresh("shadow"),
    shadow = await run(f),
    before = (
      await pool.query(
        "select to_jsonb(r) r from person_directory_receipts r where id=$1",
        [f.args.receiptId],
      )
    ).rows[0].r;
  const promoted = await run({
      ...f,
      args: { ...f.args, mode: "live", executionId: randomUUID() },
    }),
    after = (
      await pool.query(
        "select to_jsonb(r) r from person_directory_receipts r where id=$1",
        [f.args.receiptId],
      )
    ).rows[0].r;
  for (const k of [
    "derivative_text",
    "derivative_token",
    "derivative_lease_until",
    "derivatives_claimed_at",
    "derivative_attempts",
    "derivative_done",
    "derivative_error",
  ])
    assert.deepEqual(after[k], before[k], k);
  assert.equal(String(after.derivative_revision), promoted.revision);
  assert.ok(Number(promoted.revision) >= Number(shadow.revision));
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from person_derivative_jobs where candidate_id=$1",
        [shadow.candidateId],
      )
    ).rows[0].n,
    1,
  );
});
for (const mutation of [
  "derivative_token=gen_random_uuid()",
  "derivative_done=true",
  "derivative_attempts=3",
])
  test(`created-shadow upgrade refuses unproved matching mutation ${mutation}`, async () => {
    const f = await fresh("shadow"),
      shadow = await run(f);
    await phase(false);
    await pool.query(
      `update person_directory_receipts set ${mutation} where id=$1`,
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
    assert.deepEqual(await run(f), shadow);
  });
test("seed creation is independent of caller session date settings", async () => {
  const f = await fresh();
  let changed = false;
  const out = await run(f, async (sql, v, c) => {
    if (!changed && sql === "begin") {
      changed = true;
      await c.query("set timezone='Pacific/Auckland';set datestyle='SQL,DMY'");
    }
  });
  assert.equal(out.status, "done");
  const audit = await assess(out.candidateId, f);
  assert.equal(audit.status, "verified", audit.reason);
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
for (const first of ["directory", "application"])
  test(`${first} wins observed identity lock race; both intakes retain one candidate`, async () => {
    const f = await fresh(),
      applicationId = await app(
        { email: randomUUID() + "@example.test" },
        f.username,
      ),
      ready = deferred(),
      release = deferred(),
      secondReady = deferred();
    let identitySeen = false,
      paused = false,
      secondPid;
    const firstHook = async (sql, v, c) => {
      if (sql.includes("pg_advisory_xact_lock(72007")) identitySeen = true;
      else if (identitySeen && !paused) {
        paused = true;
        ready.resolve();
        await release.promise;
      }
    };
    const secondHook = async (sql, v, c) => {
      if (sql.includes("pg_advisory_xact_lock(72007")) {
        secondPid = (await c.query("select pg_backend_pid() pid")).rows[0].pid;
        secondReady.resolve();
      }
    };
    const call = (family, hook) =>
      family === "directory"
        ? run(f, hook)
        : processApp(applicationId, { queryHook: hook });
    const one = call(first, firstHook);
    let two;
    try {
      await ready.promise;
      two = call(
        first === "directory" ? "application" : "directory",
        secondHook,
      );
      await secondReady.promise;
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        waiting = (
          await pool.query(
            "select wait_event_type='Lock' waiting from pg_stat_activity where pid=$1",
            [secondPid],
          )
        ).rows[0]?.waiting;
        if (waiting) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal(waiting, true);
      release.resolve();
      const [a, b] = await Promise.all([one, two]),
        directory = first === "directory" ? a : b,
        application = first === "application" ? a : b;
      assert.equal(directory.status, "done");
      assert.equal(application.status, "processed", application.error?.message);
      assert.equal(directory.candidateId, application.result.candidateId);
      assert.equal(directory.created, first === "directory");
      assert.equal(
        (
          await pool.query(
            "select count(*)::int n from candidates where linkedin_username=$1",
            [f.username],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await pool.query(
            "select count(*)::int n from person_change_events where candidate_id=$1 and source_table='candidates' and operation='INSERT'",
            [directory.candidateId],
          )
        ).rows[0].n,
        1,
      );
      const audit = await assess(directory.candidateId, f);
      if (first === "directory")
        assert.equal(audit.status, "verified", audit.reason);
      else {
        // This snapshot predates the new application's name/title. Preserve the
        // chronology review and the newer facts while resolving the same identity.
        assert.equal(audit.status, "review");
        assert.equal(audit.reason, "directory_review");
        assert.equal(
          (await row(directory.candidateId)).current_title,
          "Engineer",
        );
        assert.deepEqual(
          (
            await pool.query(
              "select source_reviews from person_directory_receipts where id=$1",
              [f.args.receiptId],
            )
          ).rows[0].source_reviews,
          [
            { component: "full_name", reason: "directory_header_chronology" },
            {
              component: "current_title",
              reason: "directory_header_chronology",
            },
          ],
        );
      }
    } finally {
      release.resolve();
      await Promise.allSettled([one, ...(two ? [two] : [])]);
    }
  });
test("service and browser roles cannot invoke private creation authority", async () => {
  for (const role of ["service_role", "anon", "authenticated"])
    for (const fn of [
      "directory_seed(uuid,text,jsonb)",
      "directory_creation_valid(uuid,boolean)",
      "receipt_creator_valid(uuid,uuid,person_audit_anchors,uuid)",
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

export {fresh,assess};
