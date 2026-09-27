import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import * as lib from "../dist/worker-lib.mjs";
import { prepareAuditFixture } from "../person-audit/local-fixture.mjs";
const url = process.env.LOCAL_DATABASE_URL;
if (
  !/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_recruiter_admission_test$/.test(
    url ?? "",
  )
)
  throw Error("local_fixture_required");
const pool = new pg.Pool({
  connectionString: url,
  max: 8,
  options: "-c statement_timeout=15000",
});
const org = lib.TT_ORG_ID;
const phase = (enabled = true, phase = "open") =>
  pool.query(
    "update person_private.transition_control set enabled=$1,phase=$2 where singleton",
    [enabled, phase],
  );
const row = async (id) =>
  (await pool.query("select to_jsonb(c) r from candidates c where id=$1", [id]))
    .rows[0].r;
async function use(fn) {
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    await c.query("rollback");
    c.release();
  }
}
async function fixture(mode = "shadow") {
  await phase(false);
  const candidateId = randomUUID();
  await pool.query(
    "insert into candidates(id,full_name,linkedin_username,current_title,created_at,contact,notes,resume_text) values($1,'Synthetic Recruiter','recruiter-'||$1::uuid::text,'Original Engineer','2020-01-01','{}','Synthetic retained notes','Synthetic retained resume')",
    [candidateId],
  );
  await prepareAuditFixture(candidateId);
  const before = await row(candidateId);
  await phase();
  process.env.PERSON_TRANSITION_SUPPORT = "on";
  return {
    organizationId: org,
    candidateId,
    actorId: randomUUID(),
    requestId: randomUUID(),
    mode,
    contact: {
      email: "selected@example.test",
      phone: "2025550110",
      otherEmails: [],
    },
    before,
  };
}
const save = (a) => use((c) => lib.saveRecruiterContactOnConnection(c, a));
test.after(async () => {
  delete process.env.PERSON_TRANSITION_SUPPORT;
  await pool.end();
});
test("certified shadow edit updates intentional contacts only and completes one sealed work", async () => {
  const a = await fixture();
  const out = await save(a);
  assert.equal(out.replayed, false);
  assert.equal(out.contact.email, a.contact.email);
  const current = await row(a.candidateId);
  assert.deepEqual(
    { ...current, contact: a.before.contact, updated_at: a.before.updated_at },
    a.before,
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from person_private.transition_work where family='recruiter' and status='completed' and resource_key=$1",
        ["recruiter:" + a.requestId],
      )
    ).rows[0].n,
    1,
  );
  assert.deepEqual(await save(a), { contact: out.contact, replayed: true });
});
test("live contact edit publishes normalized contact and preserves unrelated workflow fields", async () => {
  const a = await fixture("live");
  const out = await save(a);
  assert.equal(out.contact.phone, "+12025550110");
  const current = await row(a.candidateId);
  assert.equal(current.notes, a.before.notes);
  assert.equal(current.resume_text, a.before.resume_text);
  assert.equal(
    (
      await pool.query(
        "select s.rev=p.revision ok from candidate_profile_state s join person_projection_state p using(candidate_id) where candidate_id=$1",
        [a.candidateId],
      )
    ).rows[0].ok,
    true,
  );
});
test("held and draining refuse new edits as temporary unavailable without claiming work", async () => {
  for (const p of ["held", "draining"]) {
    const a = await fixture();
    await phase(true, p);
    await assert.rejects(save(a), /person_recruiter_unavailable/);
    assert.deepEqual(await row(a.candidateId), a.before);
  }
});
test("completed replay returns current contact after later edit and mode change even while held", async () => {
  const a = await fixture();
  await save(a);
  const b = {
    ...a,
    requestId: randomUUID(),
    mode: "live",
    contact: { email: "later@example.test", phone: null, otherEmails: [] },
  };
  const latest = await save(b);
  await phase(true, "held");
  const before = await row(a.candidateId);
  assert.deepEqual(await save({ ...a, mode: "live" }), {
    contact: latest.contact,
    replayed: true,
  });
  assert.deepEqual(await row(a.candidateId), before);
});
async function intercept(a, needle, fn) {
  const c = await pool.connect(),
    query = c.query.bind(c);
  let used = false;
  c.query = async (sql, args) => {
    if (!used && typeof sql === "string" && sql.includes(needle)) {
      used = true;
      return fn(query, sql, args);
    }
    return query(sql, args);
  };
  try {
    return await lib.saveRecruiterContactOnConnection(c, a);
  } finally {
    await query("rollback");
    c.query = query;
    c.release();
  }
}
async function fault(table, event, body, fn) {
  await pool.query(
    `create function public.recruiter_test_fault() returns trigger language plpgsql as $fault$ begin ${body} end $fault$;create trigger zz_recruiter_test_fault ${event} on ${table} for each row execute function public.recruiter_test_fault()`,
  );
  try {
    return await fn();
  } finally {
    await pool.query(
      `drop trigger zz_recruiter_test_fault on ${table};drop function public.recruiter_test_fault()`,
    );
  }
}
async function unchanged(a) {
  assert.deepEqual(await row(a.candidateId), a.before);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from person_private.recruiter_saves where id=$1",
        [a.requestId],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from person_recruiter_receipts where id=$1",
        [a.requestId],
      )
    ).rows[0].n,
    0,
  );
}
for (const needle of [
  "recruiter_seal",
  "recruiter_audit_begin",
  "recruiter_normalize",
  "recruiter_contact",
  "recruiter_project",
  "recruiter_complete",
  "commit",
])
  test("failure at " + needle + " rolls back the entire edit", async () => {
    const a = await fixture("live");
    await assert.rejects(
      intercept(a, needle, () => {
        throw Error("synthetic_failure");
      }),
      /synthetic_failure/,
    );
    await unchanged(a);
    assert.equal((await save(a)).replayed, false);
  });
for (const [table, event, body] of [
  ["person_private.recruiter_saves", "before insert", "return null;"],
  [
    "person_private.recruiter_saves",
    "before update",
    "new.actor_id:=gen_random_uuid();return new;",
  ],
  [
    "person_private.recruiter_admission_frames",
    "before insert",
    "return null;",
  ],
  [
    "person_private.recruiter_admission_frames",
    "before delete",
    "return null;",
  ],
  ["person_private.recruiter_frames", "before insert", "return null;"],
  ["person_private.recruiter_frames", "before delete", "return null;"],
  [
    "person_private.recruiter_normalization_frames",
    "before insert",
    "return null;",
  ],
  [
    "person_private.recruiter_normalization_frames",
    "before delete",
    "return null;",
  ],
  [
    "person_private.recruiter_projection_frames",
    "before insert",
    "return null;",
  ],
  [
    "person_private.recruiter_projection_frames",
    "before delete",
    "return null;",
  ],
  [
    "public.person_audit_operations",
    "before insert",
    "new.evidence:='{}';return new;",
  ],
  [
    "person_private.recruiter_audit_operations",
    "before insert",
    "return null;",
  ],
  ["public.person_recruiter_receipts", "before insert", "return null;"],
  ["public.person_recruiter_receipts", "before update", "return null;"],
  ["public.person_recruiter_primary", "before insert", "return null;"],
  ["public.person_projection_state", "before insert", "return null;"],
  ["public.person_projection_history", "before insert", "return null;"],
  ["public.person_change_attributions", "before insert", "return null;"],
  ["public.candidates", "before update", "return null;"],
  ["public.candidate_profile_state", "before update", "return null;"],
  [
    "person_private.transition_work",
    "before update",
    "if new.status='completed' then return null;end if;return new;",
  ],
])
  test(
    "suppressed or altered " + table + " " + event + " cannot succeed",
    async () => {
      const a = await fixture("live");
      await fault(table, event, body, () => assert.rejects(save(a)));
      await unchanged(a);
    },
  );
test("partial admission and normalized edit cannot commit", async () => {
  for (const stop of [
    "recruiter_seal",
    "recruiter_contact",
    "recruiter_complete",
  ]) {
    const a = await fixture("live");
    await assert.rejects(
      intercept(a, stop, async (query) => {
        await query("commit");
        throw Error("partial_commit_accepted");
      }),
      /recruiter_incomplete/,
    );
    await unchanged(a);
  }
});
test("lost commit response recovers without a second edit", async () => {
  const a = await fixture("live");
  await assert.rejects(
    intercept(a, "commit", async (query, sql, args) => {
      await query(sql, args);
      throw Error("response_lost");
    }),
    /response_lost/,
  );
  const before = await row(a.candidateId);
  assert.equal((await save(a)).replayed, true);
  assert.deepEqual(await row(a.candidateId), before);
});
test("concurrent identical UUID and payload commit once", async () => {
  const a = await fixture("live");
  const r = await Promise.all([save(a), save(a)]);
  assert.deepEqual(r.map((x) => x.replayed).sort(), [false, true]);
  assert.deepEqual(r[0].contact, r[1].contact);
});
test("concurrent conflicting payload for one UUID refuses the second edit", async () => {
  const a = await fixture("live");
  const r = await Promise.allSettled([
    save(a),
    save({ ...a, contact: { email: "conflict@example.test" } }),
  ]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  assert.match(
    r.find((x) => x.status === "rejected").reason.message,
    /receipt_conflict/,
  );
});
test("concurrent different request edits serialize without corrupting the audit", async () => {
  const a = await fixture("live");
  const r = await Promise.all([
    save(a),
    save({
      ...a,
      requestId: randomUUID(),
      contact: { email: "second@example.test" },
    }),
  ]);
  assert.ok(r.every((x) => !x.replayed));
  assert.equal((await save(a)).replayed, true);
});
test("completed request rejects actor, candidate, tenant and payload substitutions", async () => {
  const a = await fixture();
  await save(a);
  for (const edit of [
    { actorId: randomUUID() },
    { candidateId: randomUUID() },
    { organizationId: randomUUID() },
    { contact: { email: "substitute@example.test" } },
  ])
    await assert.rejects(save({ ...a, ...edit }), /receipt_conflict|tenant/);
});
test("completed work cannot be moved to another family or resource", async () => {
  const a = await fixture();
  await save(a);
  await assert.rejects(
    pool.query(
      "update person_private.transition_work set family='refresh' where resource_key=$1",
      ["recruiter:" + a.requestId],
    ),
    /recruiter_work_proof/,
  );
  assert.equal((await save(a)).replayed, true);
});
test("private recruiter functions and tables deny service and browser roles", async () => {
  assert.equal(
    (
      await pool.query(
        "select bool_or(has_function_privilege(r.rolname,p.oid,'EXECUTE')) ok from pg_roles r cross join pg_proc p where r.rolname in ('anon','authenticated','service_role') and p.pronamespace='person_private'::regnamespace and p.proname like 'recruiter_%'",
      )
    ).rows[0].ok,
    false,
  );
  assert.equal(
    (
      await pool.query(
        "select bool_or(has_table_privilege(r.rolname,c.oid,'SELECT,INSERT,UPDATE,DELETE')) ok from pg_roles r cross join pg_class c where r.rolname in ('anon','authenticated','service_role') and c.relnamespace='person_private'::regnamespace and c.relname like 'recruiter_%' and c.relkind='r'",
      )
    ).rows[0].ok,
    false,
  );
});
for (const kind of ["email", "github"])
  test(
    "suppressed non-primary " + kind + " contact aborts the edit",
    async () => {
      const a = await fixture("live");
      a.contact = {
        ...a.contact,
        otherEmails: ["extra@example.test"],
        github: "https://github.com/synthetic-extra",
      };
      await fault(
        "candidate_contacts",
        "before insert",
        `if new.kind='${kind}' and (new.value_normalized='extra@example.test' or new.kind='github') then return null;end if;return new;`,
        () => assert.rejects(save(a), /recruiter_contacts_actual/),
      );
      await unchanged(a);
    },
  );
for (const [name, sql] of [
  [
    "candidate",
    "alter table candidates disable trigger user;update candidates set notes='corrupt' where id=$1;alter table candidates enable trigger user;",
  ],
  [
    "primary",
    "alter table person_recruiter_primary disable trigger user;delete from person_recruiter_primary where candidate_id=$1;alter table person_recruiter_primary enable trigger user;",
  ],
  [
    "contacts",
    "alter table candidate_contacts disable trigger user;delete from candidate_contacts where candidate_id=$1;alter table candidate_contacts enable trigger user;",
  ],
  [
    "projection",
    "alter table person_projection_state disable trigger user;delete from person_projection_state where candidate_id=$1;alter table person_projection_state enable trigger user;",
  ],
  [
    "history",
    "alter table person_projection_history disable trigger user;delete from person_projection_history where candidate_id=$1;alter table person_projection_history enable trigger user;",
  ],
  [
    "receipt",
    "alter table person_recruiter_receipts disable trigger user;update person_recruiter_receipts set effective_contact='{}' where candidate_id=$1;alter table person_recruiter_receipts enable trigger user;",
  ],
  [
    "boundary",
    "update person_private.recruiter_audit_operations set captured_version=captured_version+1 where candidate_id=$1;",
  ],
  [
    "attribution",
    "alter table person_change_attributions disable trigger user;delete from person_change_attributions where candidate_id=$1;alter table person_change_attributions enable trigger user;",
  ],
])
  for (const needle of ["recruiter_complete", "commit"])
    test(
      "late " + name + " corruption before " + needle + " rolls back",
      async () => {
        const a = await fixture("live");
        await assert.rejects(
          intercept(a, needle, async (query, original, args) => {
            for (const statement of sql.split(";").filter(Boolean))
              await query(
                statement,
                statement.includes("$1") ? [a.candidateId] : [],
              );
            return query(original, args);
          }),
        );
        await unchanged(a);
      },
    );
test("extra private audit authority cannot be minted alongside the genuine map", async () => {
  const a = await fixture("live");
  await assert.rejects(
    intercept(a, "commit", async (query, original, args) => {
      const oid = randomUUID();
      await query(
        "select person_private.audit_proof_frame('person_audit_operations',$1)",
        [a.candidateId],
      );
      await query(
        "insert into person_audit_operations select (jsonb_populate_record(null::person_audit_operations,to_jsonb(o)||jsonb_build_object('id',$2::uuid))).* from person_audit_operations o join person_private.recruiter_saves s on s.audit_id=o.id where s.id=$1",
        [a.requestId, oid],
      );
      await query(
        "select person_private.audit_proof_clear('person_audit_operations')",
      );
      await query(
        "insert into person_private.recruiter_audit_operations select o.id,s.id,s.work_id,s.candidate_id,s.transaction_id,0,null,person_private.directory_operation_hash(o) from person_private.recruiter_saves s cross join public.person_audit_operations o where s.id=$1 and o.id=$2",
        [a.requestId, oid],
      );
      return query(original, args);
    }),
    /recruiter_audit_extra/,
  );
  await unchanged(a);
});
test("completed immutable receipt and primary resist raw changes while controller is off", async () => {
  const a = await fixture();
  await save(a);
  await phase(false);
  for (const sql of [
    "update person_recruiter_receipts set effective_contact='{}' where id=$1",
    "delete from person_recruiter_primary where receipt_id=$1",
  ])
    await assert.rejects(
      pool.query(sql, [a.requestId]),
      /recruiter_context|recruiter_write_frame/,
    );
  assert.equal((await save(a)).replayed, true);
});
async function mutateFixture(sql, args = []) {
  await use(async (c) => {
    await c.query("begin");
    await c.query(
      "update person_private.transition_control set enabled=false,phase='open'",
    );
    await c.query(sql, args);
    await c.query("update person_private.transition_control set enabled=true");
    await c.query("commit");
  });
}
for (const status of ["bounced", "shared", "never_primary", "invalid"])
  test(
    "new edit refuses " + status + " primary without changing source evidence",
    async () => {
      const a = await fixture("live");
      await save(a);
      const b = { ...a, requestId: randomUUID() };
      await mutateFixture(
        `update candidate_contacts set ${status === "never_primary" ? "never_primary=true" : `status='${status}'`},rank=null where candidate_id=$1 and kind='email'`,
        [a.candidateId],
      );
      const before = await row(a.candidateId);
      await assert.rejects(save(b), /email_unusable/);
      assert.deepEqual(await row(a.candidateId), before);
      assert.equal((await save(a)).replayed, true);
    },
  );
test("explicit null primaries and removed curated emails preserve original contact evidence", async () => {
  const a = await fixture("live");
  a.contact = {
    email: "selected@example.test",
    phone: "2025550110",
    otherEmails: ["kept@example.test"],
    github: "https://github.com/synthetic-contact",
  };
  await save(a);
  const b = {
    ...a,
    requestId: randomUUID(),
    contact: { email: null, phone: null, otherEmails: [], github: null },
  };
  const out = await save(b);
  assert.deepEqual(out.contact.otherEmails, []);
  assert.equal(out.contact.github, null);
  const primary = (
    await pool.query(
      "select chosen_value from person_recruiter_primary where candidate_id=$1",
      [a.candidateId],
    )
  ).rows;
  assert.deepEqual(
    primary.map((x) => x.chosen_value),
    [null, null],
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from candidate_contacts where candidate_id=$1 and value_normalized='kept@example.test'",
        [a.candidateId],
      )
    ).rows[0].n,
    1,
  );
});
test("legacy unique-email owner collision retains selected normalized primary and the incumbent field", async () => {
  const a = await fixture("live");
  await mutateFixture(
    "insert into candidates(id,email,linkedin_username,full_name) values(gen_random_uuid(),'collision@example.test','collision-'||gen_random_uuid()::text,'Synthetic Collision Owner')",
  );
  a.contact.email = "collision@example.test";
  const out = await save(a);
  assert.equal(out.contact.email, "collision@example.test");
  assert.equal((await row(a.candidateId)).email, a.before.email);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from identity_conflicts where kind='legacy_email_collision' and $1=any(candidate_ids)",
        [a.candidateId],
      )
    ).rows[0].n,
    1,
  );
});
test("source holds refuse new edits, but a completed retry remains read-only", async () => {
  const a = await fixture();
  await save(a);
  await use(async (c) => {
    await c.query("begin");
    await c.query("alter table person_source_holds disable trigger user");
    await c.query(
      "insert into person_source_holds(candidate_id,ledger_id,evidence_hash,reason,evidence) values($1,gen_random_uuid(),'synthetic','harvest_cache_date_unknown','{}')",
      [a.candidateId],
    );
    await c.query("alter table person_source_holds enable trigger user");
    await c.query("commit");
  });
  const before = await row(a.candidateId);
  assert.equal((await save(a)).replayed, true);
  await assert.rejects(
    save({ ...a, requestId: randomUUID() }),
    /person_recruiter_source_hold/,
  );
  assert.deepEqual(await row(a.candidateId), before);
});
test("unowned historical receipt cannot become certified work", async () => {
  const a = await fixture();
  process.env.PERSON_TRANSITION_SUPPORT = "off";
  await phase(false);
  await save(a);
  await phase();
  process.env.PERSON_TRANSITION_SUPPORT = "on";
  await assert.rejects(save(a), /recruiter_unowned_receipt/);
});
test("real candidate row wait rechecks the short lease", async () => {
  const a = await fixture();
  const b = await pool.connect();
  await b.query("begin");
  await b.query("select 1 from candidates where id=$1 for update", [
    a.candidateId,
  ]);
  try {
    await fault(
      "person_private.transition_work",
      "before insert",
      "if new.family='recruiter' then new.lease_until:=clock_timestamp()+interval '200 milliseconds';end if;return new;",
      async () => {
        const pending = save(a);
        pending.catch(() => {});
        await new Promise((r) => setTimeout(r, 350));
        await b.query("commit");
        await assert.rejects(pending, /recruiter_context/);
      },
    );
  } finally {
    await b.query("rollback");
    b.release();
  }
  await unchanged(a);
});
test("lease expiry during final work write aborts at the final proof", async () => {
  const a = await fixture();
  await save(a);
  const b = { ...a, requestId: randomUUID() };
  const before = await row(a.candidateId);
  await fault(
    "person_private.transition_work",
    "before insert",
    "if new.family='recruiter' then new.lease_until:=clock_timestamp()+interval '250 milliseconds';end if;return new;",
    () =>
      assert.rejects(
        intercept(b, "commit", async (query, sql, args) => {
          await query("select pg_sleep(0.3)");
          return query(sql, args);
        }),
        /recruiter_incomplete/,
      ),
  );
  assert.deepEqual(await row(a.candidateId), before);
});
async function refreshFor(a, mode = "shadow") {
  const queueId = randomUUID(),
    requestId = randomUUID(),
    token = randomUUID();
  await pool.query(
    "insert into refresh_queue(id,organization_id,candidate_id) values($1,$2,$3)",
    [queueId, org, a.candidateId],
  );
  const call = {
    organizationId: org,
    queueId,
    requestId,
    token,
    mode,
    dailyCap: 0,
    allowPaid: false,
  };
  assert.equal(
    (await use((c) => lib.claimCertifiedRefreshOnConnection(c, call))).status,
    "claimed",
  );
  return use((c) => lib.saveCertifiedRefreshOnConnection(c, call));
}
test("shadow refresh then live recruiter publishes current title; later refresh and audit remain valid", async () => {
  const a = await fixture("live");
  await mutateFixture(
    "insert into candidate_enrichments(id,candidate_id,organization_id,linkedin_username,raw_payload,created_at) values(gen_random_uuid(),$1,$2,$3,$4,clock_timestamp()-interval '1 day')",
    [
      a.candidateId,
      org,
      "recruiter-" + a.candidateId,
      {
        headline: "Synthetic staged title",
        publicIdentifier: "recruiter-" + a.candidateId,
        experience: [
          {
            position: "Staged Engineer",
            companyName: "Synthetic Staged Co",
            startDate: { year: 2021, month: 1 },
            isCurrent: true,
          },
        ],
      },
    ],
  );
  await refreshFor(a);
  assert.equal((await row(a.candidateId)).current_title, "Original Engineer");
  await save(a);
  assert.equal((await row(a.candidateId)).current_title, "Staged Engineer");
  assert.equal((await row(a.candidateId)).notes, a.before.notes);
  await refreshFor(a, "live");
  const { planAudit } = await import("../person-audit/postcutover.mjs");
  const snapshot = (
    await pool.query(
      "select person_postcutover_audit_inputs_with_witness($1::jsonb) r",
      [JSON.stringify([a.candidateId])],
    )
  ).rows[0].r[0];
  const audited = planAudit(snapshot, lib);
  assert.equal(audited.status, "verified", JSON.stringify(audited));
  assert.equal((await save({ ...a, mode: "shadow" })).replayed, true);
});
test("late primary trigger cannot erase requested secondary evidence before snapshot", async () => {
  const a = await fixture("live");
  a.contact.otherEmails = ["late-secondary@example.test"];
  await fault(
    "person_recruiter_primary",
    "after insert",
    "delete from public.candidate_contacts where candidate_id=new.candidate_id and value_normalized='late-secondary@example.test';return new;",
    () => assert.rejects(save(a), /recruiter_contacts_actual/),
  );
  await unchanged(a);
});
