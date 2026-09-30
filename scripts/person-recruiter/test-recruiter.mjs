import { prepareAuditFixture } from "../person-audit/local-fixture.mjs";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import pg from "pg";
import * as lib from "../dist/worker-lib.mjs";
const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw Error("local database required");
const pool = new pg.Pool({ connectionString: url, max: 4 });
after(() => pool.end());
const id = (n) => `d2000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = lib.TT_ORG_ID,
  actor = id(9000);
const use = async (fn) => {
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
};
const input = (n, edit, contact = {}, mode = "live") => ({
  organizationId: org,
  candidateId: id(n),
  actorId: actor,
  requestId: id(1000 + edit),
  mode,
  contact: {
    email: null,
    phone: null,
    github: null,
    otherEmails: [],
    ...contact,
  },
});
const save = (a) => use((c) => lib.saveRecruiterContactOnConnection(c, a));
async function fixture(n, { normalized = true, contact = null } = {}) {
  const row = {
    id: id(n),
    full_name: "Synthetic Recruiter",
    linkedin_username: `recruiter-${n}`,
    email: `old-${n}@example.test`,
    current_title: "Original",
    created_at: "2020-01-01",
    contact,
  };
  await pool.query(
    "insert into candidates(id,full_name,linkedin_username,email,current_title,created_at,contact) values($1,$2,$3,$4,$5,$6,$7)",
    [
      row.id,
      row.full_name,
      row.linkedin_username,
      row.email,
      row.current_title,
      row.created_at,
      contact,
    ],
  );
  if (normalized) await prepareAuditFixture(id(n));
}
const chosen = async (n) =>
  (
    await pool.query(
      "select value_normalized from candidate_contacts where candidate_id=$1 and kind='email' and rank=1",
      [id(n)],
    )
  ).rows[0]?.value_normalized ?? null;
await test("recruiter saves and published-contact reads have transactional interfaces", () => {
  assert.equal(typeof lib.saveRecruiterContactOnConnection, "function");
  assert.equal(typeof lib.publishedPoolContactsOnConnection, "function");
});
if (!lib.saveRecruiterContactOnConnection)
  throw Error("recruiter_intake_missing");
await test("source, authority, overlay and projection roll back together", async () => {
  await fixture(1);
  await pool.query(
    `create function reject_recruiter() returns trigger language plpgsql as $$begin if new.id='${id(1)}' and new.contact is distinct from old.contact then raise exception 'injected';end if;return new;end$$;create trigger reject_recruiter before update on candidates for each row execute function reject_recruiter()`,
  );
  await assert.rejects(
    save(input(1, 1, { email: "manual-1@example.test" })),
    /injected/,
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from candidate_sources where candidate_id=$1",
        [id(1)],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query("select count(*)::int n from person_recruiter_receipts"))
      .rows[0].n,
    0,
  );
  assert.equal(
    (await pool.query("select count(*)::int n from person_recruiter_primary"))
      .rows[0].n,
    0,
  );
  assert.equal(
    (await pool.query("select contact from candidates where id=$1", [id(1)]))
      .rows[0].contact,
    null,
  );
  await pool.query(
    "drop trigger reject_recruiter on candidates;drop function reject_recruiter()",
  );
  const r = await save(
    input(1, 1, {
      email: "manual-1@example.test",
      phone: "2025550133",
      otherEmails: ["other-1@example.test"],
    }),
  );
  assert.equal(r.contact.email, "manual-1@example.test");
  assert.equal(r.contact.phone, "+12025550133");
  assert.equal(await chosen(1), "manual-1@example.test");
  assert.equal(
    (
      await pool.query("select current_title from candidates where id=$1", [
        id(1),
      ])
    ).rows[0].current_title,
    "Original",
  );
});
await test("A then B then retry A leaves B in force and binds actor/payload", async () => {
  await fixture(2);
  const a = input(2, 2, { email: "first@example.test" }),
    b = input(2, 3, { email: "second@example.test" });
  await save(a);
  await save(b);
  const count = (
    await pool.query(
      "select count(*)::int n from candidate_sources where candidate_id=$1",
      [id(2)],
    )
  ).rows[0].n;
  const retry = await save(a);
  assert.equal(retry.contact.email, "second@example.test");
  assert.equal(await chosen(2), "second@example.test");
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from candidate_sources where candidate_id=$1",
        [id(2)],
      )
    ).rows[0].n,
    count,
  );
  await assert.rejects(
    save({ ...a, contact: { ...a.contact, email: "tampered@example.test" } }),
    /receipt_conflict/,
  );
  await assert.rejects(save({ ...a, actorId: id(9001) }), /receipt_conflict/);
});
await test("concurrent identical requests produce one edit and one source", async () => {
  await fixture(3);
  const a = input(3, 4, { email: "concurrent@example.test" });
  const r = await Promise.all([save(a), save(a)]);
  assert.equal(r[0].contact.email, r[1].contact.email);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from person_recruiter_receipts where candidate_id=$1",
        [id(3)],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from candidate_sources where candidate_id=$1 and source='recruiter'",
        [id(3)],
      )
    ).rows[0].n,
    1,
  );
});
await test("clearing all fields withdraws historical manual preference without deleting contacts", async () => {
  await fixture(4, { contact: { email: "old-4@example.test" } });
  const d = lib.fromDirectory(
    {
      contact_id: id(4004),
      primary_email: "directory-4@example.test",
      updated_at: "2026-09-01",
    },
    null,
    [],
    [],
    [
      {
        normalized: "directory-4@example.test",
        verification: {
          status: "Verified",
          primary: true,
          checked_at: "2026-09-01",
        },
      },
    ],
    [],
    id(4),
  );
  await use((c) => lib.savePersonOnConnection(c, d, { mode: "live" }));
  await save(input(4, 5, { email: "manual-4@example.test" }));
  assert.equal(await chosen(4), "manual-4@example.test");
  const clear = await save(input(4, 6));
  assert.equal(clear.contact.email, "directory-4@example.test");
  assert.equal(await chosen(4), "directory-4@example.test");
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from candidate_contacts where candidate_id=$1",
        [id(4)],
      )
    ).rows[0].n,
    3,
  );
  await use((c) => lib.savePersonOnConnection(c, d, { mode: "live" }));
  assert.equal(await chosen(4), "directory-4@example.test");
});
await test("negative evidence cannot be made usable by a manual primary choice", async () => {
  await fixture(5);
  const d = lib.fromDirectory(
    { contact_id: id(4005) },
    null,
    [],
    [],
    [
      {
        normalized: "dead@example.test",
        verification: { status: "Failed", checked_at: "2026-09-01" },
      },
    ],
    [],
    id(5),
  );
  await pool.query("select save_person($1)", [d]);
  await assert.rejects(
    save(input(5, 7, { email: "dead@example.test" })),
    /email_unusable/,
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from person_recruiter_receipts where candidate_id=$1",
        [id(5)],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "select rank from candidate_contacts where candidate_id=$1 and value_normalized='dead@example.test'",
        [id(5)],
      )
    ).rows[0].rank,
    null,
  );
});
await test("curation hides an alternate while keeping its normalized evidence", async () => {
  await fixture(6);
  await save(
    input(6, 8, {
      email: "manual-6@example.test",
      otherEmails: ["added@example.test"],
    }),
  );
  const added = (
    await pool.query(
      "select id from candidate_contacts where candidate_id=$1 and value_normalized='added@example.test'",
      [id(6)],
    )
  ).rows[0].id;
  const r = await save(
    input(6, 9, { email: "manual-6@example.test", otherEmails: [] }),
  );
  assert.deepEqual(r.contact.otherEmails, []);
  assert.equal(
    (await pool.query("select id from candidate_contacts where id=$1", [added]))
      .rows[0].id,
    added,
  );
  const view = await use((c) =>
    lib.publishedPoolContactsOnConnection(c, [id(6)]),
  );
  assert.deepEqual(view.get(id(6)).contact.otherEmails, []);
  assert.equal(view.get(id(6)).emails.length, 1);
});
await test("shadow saves the permitted overlay but no compatibility profile fields", async () => {
  await fixture(7);
  const before = (
    await pool.query("select email,current_title from candidates where id=$1", [
      id(7),
    ])
  ).rows[0];
  const r = await save(
    input(7, 10, { email: "shadow@example.test" }, "shadow"),
  );
  assert.equal(r.contact.email, "shadow@example.test");
  const after = (
    await pool.query(
      "select email,current_title,contact from candidates where id=$1",
      [id(7)],
    )
  ).rows[0];
  assert.equal(after.email, before.email);
  assert.equal(after.current_title, before.current_title);
  assert.equal(after.contact.email, "shadow@example.test");
  assert.equal(
    (await use((c) => lib.publishedPoolContactsOnConnection(c, [id(7)]))).has(
      id(7),
    ),
    false,
  );
});
await test("direct helper refuses tenants, unmigrated people and malformed contacts", async () => {
  await fixture(8, { normalized: false });
  await assert.rejects(
    save(input(8, 11, { email: "x@example.test" })),
    /not_migrated/,
  );
  await assert.rejects(
    save({ ...input(1, 12), organizationId: id(99) }),
    /tenant/,
  );
  await assert.rejects(save(input(1, 13, { phone: "123" })), /invalid_phone/);
  await assert.rejects(
    save(input(1, 14, { email: "not-an-email" })),
    /invalid_email/,
  );
});
await test("legacy email uniqueness never merges people or overrides normalized choice", async () => {
  await fixture(9);
  await fixture(10);
  const r = await save(input(9, 15, { email: "old-10@example.test" }));
  assert.equal(r.contact.email, "old-10@example.test");
  assert.equal(
    (await pool.query("select email from candidates where id=$1", [id(9)]))
      .rows[0].email,
    "old-9@example.test",
  );
  const view = await use((c) =>
    lib.publishedPoolContactsOnConnection(c, [id(9)]),
  );
  assert.equal(view.get(id(9)).contact.email, "old-10@example.test");
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from candidates where id=any($1::uuid[])",
        [[id(9), id(10)]],
      )
    ).rows[0].n,
    2,
  );
});
await test("held sources and browser roles cannot bypass recruiter receipts", async () => {
  await fixture(11);
  await pool.query(
    "insert into person_source_holds(candidate_id,ledger_id,evidence_hash,reason,evidence) values($1,$2,'synthetic','harvest_cache_date_unknown','{}')",
    [id(11), id(8011)],
  );
  await assert.rejects(
    save(input(11, 21, { email: "held@example.test" })),
    /source_hold/,
  );
  for (const role of ["anon", "authenticated"])
    for (const table of [
      "person_recruiter_receipts",
      "person_recruiter_primary",
    ])
      assert.equal(
        (
          await pool.query("select has_table_privilege($1,$2,$3) allowed", [
            role,
            `public.${table}`,
            "SELECT",
          ])
        ).rows[0].allowed,
        false,
      );
});
await test("different concurrent edits leave one complete choice and overlay", async () => {
  await fixture(12);
  const inputs = [
    input(12, 22, { email: "race-a@example.test", phone: "2025550171" }),
    input(12, 23, { email: "race-b@example.test", phone: "2025550172" }),
  ];
  await Promise.all(inputs.map(save));
  const row = (
    await pool.query("select contact,email,phone from candidates where id=$1", [
      id(12),
    ])
  ).rows[0];
  assert.equal(await chosen(12), row.contact.email);
  assert.equal(row.email, row.contact.email);
  assert.equal(row.phone, lib.normalizePhone(row.contact.phone));
});
await test("bounced/shared/never-primary choices remain blocked and unrelated evidence stays intact", async () => {
  await fixture(13);
  const seed = lib.fromLegacyImport({
    id: id(13),
    email: "seed@example.test",
    phone: "2025550173",
    created_at: "2026-01-01",
  });
  await pool.query("select save_person($1)", [seed]);
  for (const status of ["bounced", "shared", "do_not_use", "removed"]) {
    await pool.query(
      "update candidate_contacts set status=$2,rank=null where candidate_id=$1 and value_normalized='seed@example.test'",
      [id(13), status],
    );
    await assert.rejects(
      save(input(13, 24, { email: "seed@example.test" })),
      /email_unusable/,
    );
  }
  await pool.query(
    "update candidate_contacts set status='active',never_primary=true where candidate_id=$1 and value_normalized='seed@example.test'",
    [id(13)],
  );
  await assert.rejects(
    save(input(13, 24, { email: "seed@example.test" })),
    /email_unusable/,
  );
  await pool.query(
    "update candidate_contacts set status='bounced',rank=null where candidate_id=$1 and kind='phone'",
    [id(13)],
  );
  await assert.rejects(
    save(input(13, 25, { phone: "2025550173" })),
    /phone_unusable/,
  );
  await save(
    input(13, 26, {
      email: "safe@example.test",
      otherEmails: ["seed@example.test"],
    }),
  );
  const hidden = (
    await pool.query(
      "select never_primary,rank from candidate_contacts where candidate_id=$1 and value_normalized='seed@example.test'",
      [id(13)],
    )
  ).rows[0];
  assert.equal(hidden.never_primary, true);
  assert.equal(hidden.rank, null);
});
