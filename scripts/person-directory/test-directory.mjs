import { prepareAuditFixture } from "../person-audit/local-fixture.mjs";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import pg from "pg";
import * as lib from "../dist/worker-lib.mjs";
const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw Error("local database required");
const pool = new pg.Pool({ connectionString: url, max: 4 });
const id = (n) => `d1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = lib.TT_ORG_ID,
  workspaceId = id(9999);
const use = async (fn) => {
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
};
const snap = (n, extra = {}) => ({
  board: {
    contact_id: id(n + 1000),
    name: "Synthetic Directory",
    linkedin_url: `https://www.linkedin.com/in/directory-${n}`,
    primary_email: `directory-${n}@example.test`,
    email_status: "Verified",
    status: "Replied",
    updated_at: "2026-09-25",
    ...extra,
  },
  harvest: {
    fetched_at: "2026-08-01",
    public_identifier: `directory-${n}`,
    current_title: "Staff Engineer",
    current_company: "Synthetic Co",
  },
  exps: [
    {
      title: "Staff Engineer",
      company_name: "Synthetic Co",
      start_year: 2020,
      is_current: true,
    },
  ],
  edus: [],
  emails: [
    {
      normalized: `directory-${n}@example.test`,
      verification: {
        status: "Verified",
        primary: true,
        checked_at: "2026-07-01",
      },
    },
  ],
  phones: [],
  facts: [],
  identifiers: [],
});
let lease;
const stage = async (snapshot) =>
  use((c) =>
    lib.stageDirectoryOnConnection(c, {
      organizationId: org,
      workspaceId,
      token: lease.token,
      snapshot,
    }),
  );
const save = (receiptId, mode = "live", organizationId = org) =>
  use((c) =>
    lib.saveDirectoryOnConnection(c, { organizationId, receiptId, mode }),
  );
async function fixture(n, { normalized = true, baseline = false } = {}) {
  await pool.query(
    `insert into candidates(id,full_name,linkedin_username,linkedin_url,current_title,created_at) values($1,'Synthetic Existing',$2,$3,'Original','2020-01-01')`,
    [id(n), `directory-${n}`, `https://www.linkedin.com/in/directory-${n}`],
  );
  if (normalized)
    await prepareAuditFixture(id(n), { directory: baseline ? snap(n) : null });
}

after(() => pool.end());
await test("directory intake has durable staging and atomic saving contracts", () => {
  for (const k of [
    "claimDirectoryScanOnConnection",
    "stageDirectoryOnConnection",
    "saveDirectoryOnConnection",
    "checkpointDirectoryScanOnConnection",
  ])
    assert.equal(typeof lib[k], "function", k);
});
if (!lib.claimDirectoryScanOnConnection)
  throw Error("directory_intake_missing");
await test("a concurrent scanner is refused and a capped scan resumes its cursor", async () => {
  lease = await use((c) =>
    lib.claimDirectoryScanOnConnection(c, { organizationId: org, workspaceId }),
  );
  assert.equal(
    (
      await use((c) =>
        lib.claimDirectoryScanOnConnection(c, {
          organizationId: org,
          workspaceId,
        }),
      )
    ).status,
    "busy",
  );
  await use((c) =>
    lib.checkpointDirectoryScanOnConnection(c, {
      organizationId: org,
      workspaceId,
      token: lease.token,
      cursor: id(1),
      release: true,
    }),
  );
  lease = await use((c) =>
    lib.claimDirectoryScanOnConnection(c, { organizationId: org, workspaceId }),
  );
  assert.equal(lease.cursor, id(1));
});
await test("immutable receipt survives failed profile transaction; retry creates exactly one person", async () => {
  const s = snap(1),
    r = await stage(s);
  s.board.name = "Changed caller object";
  await pool.query(
    `create function reject_directory() returns trigger language plpgsql as $$begin if new.linkedin_username='directory-1' then raise exception 'injected';end if;return new;end $$;create trigger reject_directory before update on candidates for each row execute function reject_directory()`,
  );
  await assert.rejects(save(r.receiptId), /injected/);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from candidates where linkedin_username=$1",
        ["directory-1"],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "select snapshot from person_directory_receipts where id=$1",
        [r.receiptId],
      )
    ).rows[0].snapshot.board.name,
    "Synthetic Directory",
  );
  await pool.query(
    "drop trigger reject_directory on candidates;drop function reject_directory()",
  );
  const done = await save(r.receiptId);
  assert.equal(done.status, "done");
  assert.equal(done.created, true);
  assert.equal((await save(r.receiptId)).candidateId, done.candidateId);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from candidates where linkedin_username=$1",
        ["directory-1"],
      )
    ).rows[0].n,
    1,
  );
});
await test("identity admission never merges by email and conflicting strong aliases require review", async () => {
  await fixture(2);
  await pool.query("update candidates set email=$2 where id=$1", [
    id(2),
    "directory-3@example.test",
  ]);
  const r = await stage(snap(3));
  const saved = await save(r.receiptId);
  assert.notEqual(saved.candidateId, id(2));
  await fixture(4);
  const s = snap(2);
  s.harvest.public_identifier = "directory-4";
  const conflict = await save((await stage(s)).receiptId);
  assert.equal(conflict.status, "review");
  assert.equal(conflict.reason, "directory_identity_conflict");
});
await test("existing unmigrated DNC is suppressed; new DNC creates no pool person", async () => {
  await fixture(5, { normalized: false });
  const r = await save(
    (await stage(snap(5, { do_not_contact: true }))).receiptId,
  );
  assert.equal(r.status, "suppressed");
  assert.equal(
    (await pool.query("select status from candidates where id=$1", [id(5)]))
      .rows[0].status,
    "Do Not Contact",
  );
  assert.equal(
    (await save((await stage(snap(6, { do_not_contact: true }))).receiptId))
      .status,
    "suppressed",
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from candidates where linkedin_username=$1",
        ["directory-6"],
      )
    ).rows[0].n,
    0,
  );
});
await test("older durable receipt cannot reverse a later suppression or success hash", async () => {
  await fixture(7);
  const older = await stage(snap(7));
  await save(older.receiptId);
  const newer = await stage(snap(7, { do_not_contact: true }));
  await save(newer.receiptId);
  assert.equal((await save(older.receiptId)).status, "superseded");
  assert.equal(
    (await pool.query("select status from candidates where id=$1", [id(7)]))
      .rows[0].status,
    "Do Not Contact",
  );
});
await test("primary has independent authority; later phone does not block primary changes; manual remains first", async () => {
  await fixture(8);
  const a = snap(8);
  a.phones = [{ value: "2025550123", recorded_at: "2026-09-20" }];
  a.emails.push({
    normalized: "alternate@example.test",
    verification: { status: "Verified", checked_at: "2026-06-01" },
  });
  await save((await stage(a)).receiptId);
  const b = structuredClone(a);
  b.board.primary_email = "alternate@example.test";
  b.emails[0].verification.primary = false;
  b.emails[1].verification.primary = true;
  await save((await stage(b)).receiptId);
  assert.equal(
    (await pool.query("select email from candidates where id=$1", [id(8)]))
      .rows[0].email,
    "alternate@example.test",
  );
  assert.equal(
    (
      await pool.query(
        "select verified_at from candidate_contacts where candidate_id=$1 and value_normalized='alternate@example.test'",
        [id(8)],
      )
    ).rows[0].verified_at.toISOString(),
    "2026-06-01T00:00:00.000Z",
  );
  const d = lib.fromApplication(
    {
      id: id(8008),
      organization_id: org,
      created_at: "2026-10-01",
      name: "Synthetic",
      email: "manual@example.test",
    },
    true,
    id(8),
  );
  d.source.source = "recruiter";
  d.source.payload_hash += "manual";
  d.contacts[0].is_manual = true;
  await pool.query("select save_person($1)", [d]);
  assert.equal(
    (
      await pool.query(
        "select value_normalized from candidate_contacts where candidate_id=$1 and kind='email' and rank=1",
        [id(8)],
      )
    ).rows[0].value_normalized,
    "manual@example.test",
  );
});
await test("exact baseline transition retains historical owners and all row IDs", async () => {
  await fixture(9, { baseline: true });
  const before = (
    await pool.query(
      "select jobs_source_id,header from candidate_profile_state where candidate_id=$1",
      [id(9)],
    )
  ).rows[0];
  const jobs = (
    await pool.query(
      "select id from candidate_experiences where candidate_id=$1 and source='person' order by id",
      [id(9)],
    )
  ).rows;
  await save((await stage(snap(9))).receiptId);
  const after = (
    await pool.query(
      "select jobs_source_id,header from candidate_profile_state where candidate_id=$1",
      [id(9)],
    )
  ).rows[0];
  assert.deepEqual(after, before);
  assert.deepEqual(
    (
      await pool.query(
        "select id from candidate_experiences where candidate_id=$1 and source='person' order by id",
        [id(9)],
      )
    ).rows,
    jobs,
  );
});
await test("same receipt in shadow can be projected on live replay", async () => {
  await fixture(10);
  const r = await stage(snap(10));
  await save(r.receiptId, "shadow");
  assert.equal(
    (
      await pool.query("select current_title from candidates where id=$1", [
        id(10),
      ])
    ).rows[0].current_title,
    "Original",
  );
  assert.equal(
    (
      await pool.query(
        "select 1 from person_derivative_jobs where candidate_id=$1",
        [id(10)],
      )
    ).rows.length,
    0,
  );
  await save(r.receiptId, "live");
  const job = (
    await pool.query(
      "select sources from person_derivative_jobs where candidate_id=$1",
      [id(10)],
    )
  ).rows[0];
  assert.match(job.sources.linkedin_profile, /Staff Engineer/);
  assert.deepEqual(Object.keys(job.sources).sort(), [
    "linkedin_profile",
    "resume",
    "summary",
  ]);
  assert.equal(
    (
      await pool.query("select current_title from candidates where id=$1", [
        id(10),
      ])
    ).rows[0].current_title,
    "Staff Engineer",
  );
});
await test("workflow-only board update cannot outrank newer Harvest title", async () => {
  await fixture(11);
  const a = snap(11, { title: "Old Board Title" });
  await save((await stage(a)).receiptId);
  const h = lib.fromHarvest(
    {
      headline: "New",
      experience: [
        {
          position: "Principal Engineer",
          companyName: "New Co",
          startDate: { year: 2025 },
        },
      ],
    },
    {
      id: id(3011),
      candidate_id: id(11),
      organization_id: org,
      provider: "harvest",
      status: "ok",
      cache_status: "miss",
      created_at: "2026-09-01",
    },
    id(11),
  );
  await use((c) => lib.savePersonOnConnection(c, h, { mode: "live" }));
  const b = structuredClone(a);
  b.board.updated_at = "2026-10-01";
  b.board.status = "Follow Up";
  await save((await stage(b)).receiptId);
  assert.equal(
    (
      await pool.query("select current_title from candidates where id=$1", [
        id(11),
      ])
    ).rows[0].current_title,
    "Principal Engineer",
  );
});
await test("tenant cannot stage or save directory input", async () => {
  await assert.rejects(
    use((c) =>
      lib.stageDirectoryOnConnection(c, {
        organizationId: id(999),
        workspaceId,
        token: lease.token,
        snapshot: snap(12),
      }),
    ),
    /tenant/,
  );
  await assert.rejects(save(1, "live", id(999)), /tenant/);
});
await test("expired scanner cannot commit an old in-flight observation", async () => {
  const old = lease;
  await pool.query(
    "update person_directory_scans set lease_until=now()-interval '1 minute' where workspace_id=$1",
    [workspaceId],
  );
  lease = await use((c) =>
    lib.claimDirectoryScanOnConnection(c, { organizationId: org, workspaceId }),
  );
  await assert.rejects(
    use((c) =>
      lib.stageDirectoryOnConnection(c, {
        organizationId: org,
        workspaceId,
        token: old.token,
        snapshot: snap(20),
      }),
    ),
    /lease/,
  );
});
await test("late embedding cannot overwrite a newer board-only profile revision", async () => {
  assert.equal(typeof lib.claimDirectoryEmbeddingOnConnection, "function");
  assert.equal(typeof lib.saveDirectoryEmbeddingOnConnection, "function");
  await fixture(21);
  const a = snap(21);
  const r = await stage(a);
  await save(r.receiptId);
  const claim = await use((c) =>
    lib.claimDirectoryEmbeddingOnConnection(c, {
      organizationId: org,
      receiptId: r.receiptId,
    }),
  );
  assert.equal(claim.status, "claimed");
  const b = structuredClone(a);
  b.board.title = "New Board Title";
  b.facts = [
    {
      id: "f21",
      field: "title",
      value: "New Board Title",
      recorded_at: "2026-10-01",
      provenance: "manual",
    },
  ];
  await save((await stage(b)).receiptId);
  const result = await use((c) =>
    lib.saveDirectoryEmbeddingOnConnection(c, {
      organizationId: org,
      receiptId: r.receiptId,
      token: claim.token,
      vector: Array(1536).fill(0.1),
    }),
  );
  assert.equal(result.status, "stale");
  assert.equal(
    (
      await pool.query(
        "select matching_embedding from candidates where id=$1",
        [id(21)],
      )
    ).rows[0].matching_embedding,
    null,
  );
});
await test("current canonical embedding saves once and rejects invalid dimensions", async () => {
  await fixture(22);
  const r = await stage(snap(22));
  await save(r.receiptId);
  const claim = await use((c) =>
    lib.claimDirectoryEmbeddingOnConnection(c, {
      organizationId: org,
      receiptId: r.receiptId,
    }),
  );
  await assert.rejects(
    use((c) =>
      lib.saveDirectoryEmbeddingOnConnection(c, {
        organizationId: org,
        receiptId: r.receiptId,
        token: claim.token,
        vector: [1, 2],
      }),
    ),
    /vector/,
  );
  const result = await use((c) =>
    lib.saveDirectoryEmbeddingOnConnection(c, {
      organizationId: org,
      receiptId: r.receiptId,
      token: claim.token,
      vector: Array(1536).fill(0.1),
    }),
  );
  assert.equal(result.status, "saved");
  assert.equal(
    (
      await use((c) =>
        lib.claimDirectoryEmbeddingOnConnection(c, {
          organizationId: org,
          receiptId: r.receiptId,
        }),
      )
    ).status,
    "done",
  );
});
await test("workflow-only receipt inherits unfinished embedding work for the same canonical profile", async () => {
  await fixture(23);
  await pool.query(
    "update candidates set matching_embedding=$2::vector where id=$1",
    [id(23), JSON.stringify(Array(1536).fill(0.2))],
  );
  const a = snap(23);
  const original = await stage(a);
  await save(original.receiptId);
  const b = structuredClone(a);
  b.board.status = "Follow Up";
  const later = await stage(b);
  await save(later.receiptId);
  assert.equal(
    (
      await use((c) =>
        lib.claimDirectoryEmbeddingOnConnection(c, {
          organizationId: org,
          receiptId: later.receiptId,
        }),
      )
    ).status,
    "claimed",
  );
});
await test("undated current negative email is held out of the profile without fabricating verification time", async () => {
  await fixture(24);
  const a = snap(24);
  await save((await stage(a)).receiptId);
  a.emails[0].verification = { status: "Failed" };
  a.board.email_status = "Failed";
  const result = await save((await stage(a)).receiptId);
  assert.ok(result.reviewCount > 0);
  const row = (
    await pool.query(
      "select status,rank,verified_at from candidate_contacts where candidate_id=$1 and kind='email'",
      [id(24)],
    )
  ).rows[0];
  assert.equal(row.status, "do_not_use");
  assert.equal(row.rank, null);
  assert.equal(row.verified_at.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(
    (await pool.query("select email from candidates where id=$1", [id(24)]))
      .rows[0].email,
    null,
  );
});
await test("normalized alias arriving after directory lookup rolls back a new person and retains review receipt", async () => {
  await fixture(26);
  const r = await stage(snap(25));
  let raced = false;
  const result = await use((c) =>
    lib.saveDirectoryOnConnection(
      {
        query: async (sql, params) => {
          const rows = await c.query(sql, params);
          if (
            sql.startsWith("select id from public.candidates where lower") &&
            !raced
          ) {
            raced = true;
            await use((other) =>
              lib.savePersonOnConnection(
                other,
                lib.fromHarvest(
                  {
                    publicIdentifier: "directory-25",
                    headline: "Synthetic alias",
                  },
                  {
                    id: id(3026),
                    created_at: "2026-09-01",
                    provider: "harvest",
                    cache_status: "miss",
                    status: "ok",
                    organization_id: org,
                    candidate_id: id(26),
                  },
                  id(26),
                ),
                { mode: "live" },
              ),
            );
          }
          return rows;
        },
      },
      { organizationId: org, receiptId: r.receiptId, mode: "live" },
    ),
  );
  assert.equal(result.status, "review");
  assert.equal(result.reason, "directory_identity_conflict");
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from candidates where linkedin_username='directory-25'",
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "select phase from person_directory_receipts where id=$1",
        [r.receiptId],
      )
    ).rows[0].phase,
    "review",
  );
});
await test("historical later directory header requires scoped review for a changed earlier manual fact", async () => {
  await fixture(27);
  const a = snap(27, { title: "Old Board" });
  a.harvest = null;
  a.exps = [];
  await pool.query("select save_person($1)", [
    lib.fromDirectory(a.board, null, [], [], a.emails, [], id(27)),
  ]);
  const b = structuredClone(a);
  b.board.title = "Correct Earlier";
  b.facts = [
    {
      id: "f27",
      field: "title",
      value: "Correct Earlier",
      recorded_at: "2026-09-20",
      provenance: "manual",
    },
  ];
  const r = await stage(b);
  const result = await save(r.receiptId);
  assert.ok(result.reviewCount > 0);
  assert.equal(
    (
      await pool.query("select current_title from candidates where id=$1", [
        id(27),
      ])
    ).rows[0].current_title,
    "Old Board",
  );
});
await test("unresolved equal-date history review survives a later workflow-only receipt", async () => {
  await fixture(28, { baseline: true });
  const a = snap(28);
  a.exps[0].title = "Changed Same Date";
  const first = await save((await stage(a)).receiptId);
  assert.ok(first.reviewCount > 0);
  a.board.status = "Follow Up";
  const second = await save((await stage(a)).receiptId);
  assert.ok(second.reviewCount > 0);
  assert.equal(
    (
      await pool.query("select current_title from candidates where id=$1", [
        id(28),
      ])
    ).rows[0].current_title,
    "Staff Engineer",
  );
});
await test("new compatibility LinkedIn uses an explicit current identity while retaining older aliases", async () => {
  const a = snap(29, { linkedin_url: "https://www.linkedin.com/in/z-current" });
  a.harvest = null;
  a.exps = [];
  a.identifiers = [{ kind: "linkedin_username", value: "a-retired" }];
  const r = await save((await stage(a)).receiptId);
  assert.equal(
    (
      await pool.query("select linkedin_username from candidates where id=$1", [
        r.candidateId,
      ])
    ).rows[0].linkedin_username,
    "z-current",
  );
});
await test("a changed reread cannot replace a durably staged unsaved observation", async () => {
  const original = await stage(snap(30, { do_not_contact: true }));
  const changed = snap(30, { do_not_contact: false });
  const waiting = await stage(changed);
  assert.equal(waiting.receiptId, original.receiptId);
  assert.equal(waiting.pendingPrevious, true);
  assert.equal((await save(waiting.receiptId)).status, "suppressed");
  const next = await stage(changed);
  assert.notEqual(next.receiptId, original.receiptId);
  assert.equal(
    (
      await pool.query(
        "select phase from person_directory_receipts where id=$1",
        [original.receiptId],
      )
    ).rows[0].phase,
    "suppressed",
  );
});
await test("a collision on the replacement address never retains an explicitly held incumbent", async () => {
  await fixture(32);
  await fixture(33);
  await pool.query("update candidates set email=$2 where id=$1", [
    id(33),
    "already-owned@example.test",
  ]);
  const a = snap(32);
  await save((await stage(a)).receiptId);
  a.emails[0].verification = { status: "Failed" };
  a.emails.push({
    normalized: "already-owned@example.test",
    verification: {
      status: "Verified",
      primary: true,
      checked_at: "2026-09-01",
    },
  });
  a.board.primary_email = "already-owned@example.test";
  await save((await stage(a)).receiptId);
  assert.equal(
    (await pool.query("select email from candidates where id=$1", [id(32)]))
      .rows[0].email,
    null,
  );
});
await test("bounded unchanged-page inspection preserves receipts and reports unresolved reviews", async () => {
  assert.equal(typeof lib.inspectDirectoryPageOnConnection, "function");
  const snapshots = [snap(32), snap(33)];
  const r = await stage(snap(34));
  await fixture(34);
  await save(r.receiptId);
  snapshots.push(snap(34));
  const before = (
    await pool.query("select count(*)::int n from person_directory_receipts")
  ).rows[0].n;
  const rows = await use((c) =>
    lib.inspectDirectoryPageOnConnection(c, {
      organizationId: org,
      workspaceId,
      token: lease.token,
      snapshots,
    }),
  );
  const matched = rows.find((x) => x.contactId === id(1034));
  assert.ok(matched);
  assert.ok(matched.reviewCount > 0);
  assert.equal(
    rows.some((x) => x.contactId === id(1032)),
    false,
  );
  assert.equal(
    (await pool.query("select count(*)::int n from person_directory_receipts"))
      .rows[0].n,
    before,
  );
});
await test("directory metadata uses admitted historical evidence and canonical experience only", async () => {
  await fixture(36, { baseline: true });
  await pool.query(
    "update candidates set linkedin_enrichment_date=null,calculated_experience_years=99 where id=$1",
    [id(36)],
  );
  const s = snap(36);
  s.harvest.current_title = "Unprovable same-date change";
  s.exps[0].start_year = 1990;
  const first = await save((await stage(s)).receiptId);
  assert.ok(first.reviewCount > 0);
  const held = (
    await pool.query(
      "select linkedin_enrichment_date,calculated_experience_years from candidates where id=$1",
      [id(36)],
    )
  ).rows[0];
  assert.equal(held.linkedin_enrichment_date, null);
  assert.ok(
    held.calculated_experience_years >= 6 &&
      held.calculated_experience_years < 8,
  );
  s.harvest.fetched_at = "2026-09-01";
  s.exps[0].start_year = 2020;
  await save((await stage(s)).receiptId);
  assert.equal(
    (
      await pool.query(
        "select linkedin_enrichment_date from candidates where id=$1",
        [id(36)],
      )
    ).rows[0].linkedin_enrichment_date.toISOString(),
    "2026-09-01T00:00:00.000Z",
  );
  await fixture(37, { baseline: true });
  await save((await stage(snap(37))).receiptId);
  assert.equal(
    (
      await pool.query(
        "select linkedin_enrichment_date from candidates where id=$1",
        [id(37)],
      )
    ).rows[0].linkedin_enrichment_date.toISOString(),
    "2026-08-01T00:00:00.000Z",
  );
});
await test("actual recovery applies a saved suppression independently of external directory existence", async () => {
  await fixture(35);
  const r = await stage(snap(35, { do_not_contact: true }));
  await use((c) =>
    lib.checkpointDirectoryScanOnConnection(c, {
      organizationId: org,
      workspaceId,
      token: lease.token,
      cursor: id(1),
      release: true,
    }),
  );
  const { runDirectory } = await import("./worker.mjs");
  const actual = {
    TT_ORG_ID: org,
    claimDirectoryScan: (a) =>
      use((c) => lib.claimDirectoryScanOnConnection(c, a)),
    pendingDirectoryReceipts: (a) =>
      use((c) => lib.pendingDirectoryReceiptsOnConnection(c, a)),
    saveDirectory: (a) => use((c) => lib.saveDirectoryOnConnection(c, a)),
    checkpointDirectoryScan: (a) =>
      use((c) => lib.checkpointDirectoryScanOnConnection(c, a)),
  };
  const result = await runDirectory({
    lib: actual,
    reader: { page: async () => [], snapshots: async () => new Map() },
    workspaceId,
    mode: "live",
    limit: 100,
  });
  assert.ok(result.recovered > 0);
  assert.equal(
    (await pool.query("select status from candidates where id=$1", [id(35)]))
      .rows[0].status,
    "Do Not Contact",
  );
  assert.equal(
    (
      await pool.query(
        "select phase from person_directory_receipts where id=$1",
        [r.receiptId],
      )
    ).rows[0].phase,
    "suppressed",
  );
});
