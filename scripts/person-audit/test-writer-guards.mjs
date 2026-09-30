import assert from "node:assert/strict";
import { test, after } from "node:test";
import pg from "pg";
import * as lib from "../dist/worker-lib.mjs";
import { prepareAuditFixture } from "./local-fixture.mjs";
const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw Error("local_database_required");
const db = new pg.Pool({ connectionString: url, max: 4 });
after(() => db.end());
const id = (n) => `d9000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = lib.TT_ORG_ID;
async function use(fn) {
  const c = await db.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}
async function prepare(n, writer, anchored) {
  const username = `writer-guard-${n}`;
  await db.query(
    "insert into candidates(id,full_name,linkedin_username,linkedin_url,current_title,created_at) values($1,'Synthetic Guard',$2,$3,'Original','2020-01-01')",
    [id(n), username, `https://www.linkedin.com/in/${username}`],
  );
  if (anchored) await prepareAuditFixture(id(n));
  else
    await db.query("select save_person($1)", [
      lib.fromLegacyImport(
        (
          await db.query("select to_jsonb(c) r from candidates c where id=$1", [
            id(n),
          ])
        ).rows[0].r,
      ),
    ]);
  if (writer === "application") {
    await db.query(
      "insert into website_applications(id,organization_id,name,email,linkedin_username) values($1,$2,'Synthetic Guard','guard@example.test',$3)",
      [id(n + 1000), org, username],
    );
    return () =>
      use((c) =>
        lib.saveApplicationPersonOnConnection(c, {
          organizationId: org,
          applicationId: id(n + 1000),
          linkedinUsername: username,
          name: "Synthetic Guard",
          parsed: { current_title: "Incoming" },
          resumeText: null,
          mode: "shadow",
        }),
      );
  }
  if (writer === "recruiter")
    return () =>
      use((c) =>
        lib.saveRecruiterContactOnConnection(c, {
          organizationId: org,
          candidateId: id(n),
          actorId: id(9000),
          requestId: id(n + 1000),
          contact: { email: "new@example.test" },
          mode: "shadow",
        }),
      );
  if (writer === "refresh") {
    await db.query(
      "insert into refresh_queue(id,candidate_id,organization_id) values($1,$2,$3)",
      [id(n + 1000), id(n), org],
    );
    await db.query(
      "insert into candidate_enrichments(id,candidate_id,organization_id,linkedin_username,raw_payload) values($1,$2,$3,$4,$5)",
      [id(n + 2000), id(n), org, username, { headline: "Incoming" }],
    );
    const claim = await use((c) =>
      lib.claimRefreshOnConnection(c, {
        organizationId: org,
        queueId: id(n + 1000),
        dailyCap: 0,
        allowPaid: false,
      }),
    );
    assert.equal(claim.status, "claimed");
    assert.equal(claim.needsHarvest, false);
    return () =>
      use((c) =>
        lib.saveRefreshOnConnection(c, {
          organizationId: org,
          queueId: id(n + 1000),
          token: claim.token,
          mode: "shadow",
        }),
      );
  }
  const workspaceId = id(n + 3000),
    claim = await use((c) =>
      lib.claimDirectoryScanOnConnection(c, {
        organizationId: org,
        workspaceId,
      }),
    );
  const staged = await use((c) =>
    lib.stageDirectoryOnConnection(c, {
      organizationId: org,
      workspaceId,
      token: claim.token,
      snapshot: {
        board: {
          contact_id: id(n + 1000),
          name: "Synthetic Guard",
          linkedin_url: `https://www.linkedin.com/in/${username}`,
          updated_at: "2026-09-26",
        },
        harvest: null,
        exps: [],
        edus: [],
        emails: [],
        phones: [],
        facts: [],
        identifiers: [],
      },
    }),
  );
  return () =>
    use((c) =>
      lib.saveDirectoryOnConnection(c, {
        organizationId: org,
        receiptId: staged.receiptId,
        mode: "shadow",
      }),
    );
}
for (const [i, writer] of [
  "application",
  "refresh",
  "directory",
  "recruiter",
].entries()) {
  test(`${writer} shadow admission requires an anchor and leaves no partial facts`, async () => {
    const n = 100 + i,
      save = await prepare(n, writer, false);
    await assert.rejects(save(), /audit_anchor_required/);
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from candidate_sources where candidate_id=$1",
          [id(n)],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from person_audit_operations where candidate_id=$1",
          [id(n)],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await db.query("select current_title from candidates where id=$1", [
          id(n),
        ])
      ).rows[0].current_title,
      "Original",
    );
  });
  test(`${writer} cannot legitimize an unexplained candidate edit`, async () => {
    const n = 200 + i,
      save = await prepare(n, writer, true);
    await db.query(
      "update candidates set current_title='Unexplained' where id=$1",
      [id(n)],
    );
    await assert.rejects(save(), /audit_unattributed_change/);
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from person_audit_operations where candidate_id=$1",
          [id(n)],
        )
      ).rows[0].n,
      0,
    );
  });
}
test("actual writer suites retain exact profile, metadata, contact, application and creation links", async () => {
  const rows = (
    await db.query(
      `select distinct o.writer,a.scope from person_change_attributions a join person_audit_operations o on o.id=a.operation_id`,
    )
  ).rows.map((r) => `${r.writer}:${r.scope}`);
  for (const pair of [
    "application:creation",
    "application:profile",
    "application:application_finalize",
    "directory:creation",
    "directory:profile",
    "directory:directory_metadata",
    "refresh:profile",
    "refresh:refresh_metadata",
    "recruiter:profile",
    "recruiter:recruiter_contact",
  ])
    assert.ok(rows.includes(pair), pair);
  const invalid = (
    await db.query(
      `select count(*)::int n from person_change_attributions a join person_audit_operations o on o.id=a.operation_id join person_change_events e on e.id=a.event_id where o.evidence?'guard' and (a.candidate_id<>o.candidate_id or e.candidate_id<>o.candidate_id or e.transaction_id is distinct from o.transaction_id or e.source_table='candidate_enrichments')`,
    )
  ).rows[0].n;
  assert.equal(invalid, 0);
});
test("new shadow application and directory writers retain receipt-created anchors", async () => {
  const rows = (
    await db.query(
      "select a.kind,a.legacy_doc,a.creator_ref from person_audit_anchors a join candidates c on c.id=a.candidate_id where c.linkedin_username in ('synthetic-shadow','directory-1')",
    )
  ).rows;
  assert.equal(rows.length, 2);
  assert.ok(
    rows.every((r) => r.kind === "receipt_created" && r.legacy_doc === null),
  );
});
