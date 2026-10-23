import assert from "node:assert/strict";
import { test, after } from "node:test";
import pg from "pg";
import { prepareAuditFixture } from "./local-fixture.mjs";
const url = process.env.LOCAL_DATABASE_URL;
if (
  !url ||
  new URL(url).pathname !== "/person_postcutover_test" ||
  !["127.0.0.1", "localhost"].includes(new URL(url).hostname)
)
  throw Error("snapshot_test_database");
const db = new pg.Pool({
  connectionString: url,
  max: 4,
  statement_timeout: 15000,
});
after(() => db.end());
const id = (n) => `da000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function seed(n, anchor = true) {
  await db.query(
    "insert into candidates(id,full_name,linkedin_username,current_title,created_at) values($1,'Synthetic Snapshot',$2,'Engineer','2020-01-01')",
    [id(n), `snapshot-${n}`],
  );
  if (anchor) await prepareAuditFixture(id(n));
  return id(n);
}
async function snapshot(cid, client = db) {
  return (
    await client.query("select person_postcutover_audit_inputs($1::jsonb) r", [
      JSON.stringify([cid]),
    ])
  ).rows[0].r[0];
}
test("bounded snapshot interface is installed", async () => {
  assert.equal(
    (
      await db.query(
        "select to_regprocedure('public.person_postcutover_audit_inputs(jsonb)') is not null present",
      )
    ).rows[0].present,
    true,
  );
});
test("verified legacy anchor is returned without calling it a verified live audit", async () => {
  await seed(1);
  const s = await snapshot(id(1));
  assert.equal(s.status, "ready");
  assert.equal(s.candidate_id, id(1));
  assert.equal(s.anchor_hash_valid, true);
  assert.equal(s.boundary.anchor_hash, s.anchor.anchor_hash);
  assert.equal(s.anchor_contract_hash, s.candidate_contract_hash);
  assert.equal(s.auxiliary.n, 0);
  assert.equal(s.normalized.sources.length, 1);
  assert.equal(s.normalized.state.candidate_id, id(1));
  assert.equal(s.events.length, 0);
  assert.equal(typeof s.boundary.capture, "string");
  assert.equal(typeof s.boundary.revision, "string");
  assert.equal(typeof s.boundary.candidate_epoch, "string");
});
test("missing anchor and missing candidate have explicit review outcomes", async () => {
  await seed(2, false);
  assert.equal((await snapshot(id(2))).reason, "anchor_required");
  assert.equal((await snapshot(id(999))).reason, "candidate_missing");
});
test("unattributed profile change and ephemeral raw email INSERT DELETE remain visible", async () => {
  await db.query(
    "update candidates set current_title='Unexplained title' where id=$1",
    [id(1)],
  );
  const email = (
    await db.query(
      "insert into candidate_emails(candidate_id,email_address) values($1,'snapshot-only@example.test') returning id",
      [id(1)],
    )
  ).rows[0].id;
  await db.query("delete from candidate_emails where id=$1", [email]);
  const s = await snapshot(id(1));
  assert.notEqual(s.anchor_contract_hash, s.candidate_contract_hash);
  assert.equal(s.events.length, 3);
  assert.deepEqual(
    s.events
      .filter((e) => e.source_table === "candidate_emails")
      .map((e) => e.operation),
    ["INSERT", "DELETE"],
  );
  assert.ok(
    s.events.every(
      (e) =>
        typeof e.id === "string" && /^[a-f0-9]{32}$/.test(e.actual_event_hash),
    ),
  );
  assert.equal(
    s.events
      .find((e) => e.source_table === "candidates")
      .actual_changed_fields.includes("current_title"),
    true,
  );
});
test("current auxiliary proof changes even when change occurred before audit starts", async () => {
  await seed(3);
  await db.query(
    "insert into candidate_emails_v2(candidate_id,email_raw,email_normalized) values($1,'aux-only@example.test','aux-only@example.test')",
    [id(3)],
  );
  const s = await snapshot(id(3));
  assert.notEqual(s.auxiliary.proof.v2_hash, s.anchor.external_proof.v2_hash);
});
test("snapshot is read only and timezone invariant", async () => {
  const client = await db.connect();
  try {
    await client.query("begin read only");
    await client.query("set local timezone='Asia/Tokyo'");
    const a = await snapshot(id(1), client);
    await client.query("set local timezone='America/New_York'");
    const b = await snapshot(id(1), client);
    assert.deepEqual(a, b);
    await client.query("commit");
  } finally {
    await client.query("rollback");
    client.release();
  }
});
test("batch, timeout and caller role gates reject unbounded or unauthorized requests", async () => {
  for (const ids of [
    [],
    [id(1), id(1)],
    [id(1), id(1).toUpperCase()],
    Array.from({ length: 21 }, (_, n) => id(n + 100)),
  ])
    await assert.rejects(
      db.query("select person_postcutover_audit_inputs($1::jsonb)", [
        JSON.stringify(ids),
      ]),
      /audit_batch/,
    );
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query("set local statement_timeout='0'");
    await assert.rejects(snapshot(id(1), c), /audit_statement_timeout/);
    await c.query("rollback");
    for (const role of ["anon", "authenticated"]) {
      await c.query("begin");
      await c.query(`set local role ${role}`);
      await assert.rejects(snapshot(id(1), c), /permission denied/);
      await c.query("rollback");
    }
  } finally {
    await c.query("rollback");
    c.release();
  }
});
test("201 events fail closed without returning truncated evidence", async () => {
  await seed(4);
  await db.query(
    "do $$ begin for i in 1..201 loop update candidates set current_title=i::text where id='da000000-0000-4000-8000-000000000004';end loop;end $$",
  );
  const s = await snapshot(id(4));
  assert.equal(s.status, "review");
  assert.equal(s.reason, "event_limit");
  assert.equal(s.events, undefined);
});
test("committed epoch counts include a lower transaction that commits later", async () => {
  await seed(5);
  const baseline = BigInt((await snapshot(id(5))).boundary.candidate_epoch);
  const a = await db.connect(),
    b = await db.connect();
  try {
    await a.query("begin");
    await a.query("select pg_current_xact_id()");
    await b.query("begin");
    const sql =
      "insert into person_audit_operations(id,candidate_id,writer,receipt_ref) values(gen_random_uuid(),$1,'projection','synthetic')";
    await b.query(sql, [id(5)]);
    await b.query("commit");
    assert.equal(
      BigInt((await snapshot(id(5))).boundary.candidate_epoch),
      baseline + 1n,
    );
    await a.query(sql, [id(5)]);
    await a.query("commit");
    assert.equal(
      BigInt((await snapshot(id(5))).boundary.candidate_epoch),
      baseline + 2n,
    );
  } finally {
    await a.query("rollback");
    await b.query("rollback");
    a.release();
    b.release();
  }
});
test("directory receipt-only staging is fenced before a person is assigned", async () => {
  const cid = await seed(6),
    contact = id(606),
    workspace = id(666);
  await db.query("update candidates set directory_contact_id=$2 where id=$1", [
    cid,
    contact,
  ]);
  await db.query(
    "insert into person_directory_scans(workspace_id) values($1)",
    [workspace],
  );
  const before = await snapshot(cid);
  const receipt = (
    await db.query(
      "insert into person_directory_receipts(workspace_id,contact_id,snapshot_hash,snapshot) values($1,$2,'synthetic','{}') returning id",
      [workspace, contact],
    )
  ).rows[0].id;
  await db.query(
    "insert into person_directory_state(workspace_id,contact_id,latest_receipt_id,seen_cycle) values($1,$2,$3,1)",
    [workspace, contact, receipt],
  );
  const after = await snapshot(cid);
  assert.equal(before.directory_receipts.length, 0);
  assert.equal(after.directory_receipts[0].candidate_id, null);
  assert.equal(after.directory_state[0].latest_receipt_id, String(receipt));
  assert.ok(
    BigInt(after.boundary.directory_epochs[0].epoch) >
      BigInt(before.boundary.directory_epochs[0].epoch),
  );
});
test("all source events stay visible without exposing outreach body or notes", async () => {
  const cid = await seed(7);
  await db.query(
    "insert into candidate_communications(recruiter_id,candidate_id,communication_type,status,message_content,notes) values(1,$1,'email','bounced','PRIVATE BODY','PRIVATE NOTE')",
    [cid],
  );
  const s = await snapshot(cid);
  assert.equal(s.events[0].source_table, "candidate_communications");
  assert.equal(s.events[0].payload.status, "bounced");
  assert.equal(JSON.stringify(s).includes("PRIVATE BODY"), false);
  assert.equal(JSON.stringify(s).includes("PRIVATE NOTE"), false);
});
test("source and receipt reads exclude tenant applications and omit resume text", async () => {
  const cid = await seed(8);
  const tt = "801865a7-6533-41d2-9c45-e4a90e6ad51a";
  await db.query(
    "insert into organizations(id) values($1) on conflict(id) do nothing",
    [tt],
  );
  const app = (
    await db.query(
      "insert into website_applications(organization_id,candidate_id,name,email,linkedin_username,resume_text) values($1,$2,'Synthetic','snapshot@example.test','snapshot-8','PRIVATE RESUME') returning id",
      [tt, cid],
    )
  ).rows[0].id;
  await db.query(
    'insert into person_application_receipts(application_id,candidate_id,created_person,application_snapshot,documents) values($1,$2,false,\'{"name":"Synthetic","resume_text":"PRIVATE RESUME"}\',\'[]\')',
    [app, cid],
  );
  await db.query(
    "insert into website_applications(organization_id,candidate_id,name,email,resume_text) values($1,$2,'Tenant Synthetic','tenant@example.test','PRIVATE TENANT')",
    [id(808), cid],
  );
  const s = await snapshot(cid);
  assert.equal(JSON.stringify(s).includes("PRIVATE TENANT"), false);
  assert.equal(s.application_receipts.length, 1);
  assert.equal(s.applications.length, 1);
  assert.equal(
    s.application_receipts[0].application_snapshot.resume_text,
    undefined,
  );
  assert.match(
    s.application_receipts[0].application_snapshot_hash,
    /^[a-f0-9]{32}$/,
  );
  assert.equal(JSON.stringify(s).includes("PRIVATE RESUME"), false);
});
test("1001 auxiliary rows and 10001 epoch markers fail closed", async () => {
  const cid = await seed(9);
  await db.query(
    "insert into candidate_emails_v2(candidate_id,email_raw,email_normalized) select $1,'aux'||n||'@example.test','aux'||n||'@example.test' from generate_series(1,1001)n",
    [cid],
  );
  assert.equal((await snapshot(cid)).reason, "auxiliary_limit");
  const epoch = await seed(10);
  await db.query(
    "insert into person_audit_epochs(scope_kind,scope_key,transaction_id) select 'candidate',$1,(n+10000000)::text::xid8 from generate_series(1,10001)n",
    [epoch],
  );
  assert.equal((await snapshot(epoch)).reason, "epoch_limit");
});
test("oversized evidence returns review without a partial result", async () => {
  const cid = await seed(11);
  await db.query(
    "update candidates set linkedin_data=jsonb_build_object('oversized',repeat('x',8000001)) where id=$1",
    [cid],
  );
  const s = await snapshot(cid);
  assert.equal(s.status, "review");
  assert.equal(s.reason, "snapshot_size_limit");
  assert.equal(s.candidate, undefined);
});
test("shared company enrichment is excluded from candidate evidence size", async () => {
  const cid = id(12);
  await db.query(
    "insert into candidates(id,full_name,linkedin_username,created_at,work_experience) values($1,'Synthetic Company Snapshot','snapshot-company-12','2020-01-01',$2::jsonb)",
    [
      cid,
      JSON.stringify([
        {
          title: "Engineer",
          companyName: "Synthetic Snapshot Co",
          companyId: "snapshot-co-12",
          start: { year: 2020 },
        },
      ]),
    ],
  );
  await prepareAuditFixture(cid);
  const before = await snapshot(cid);
  assert.equal(before.status, "ready");
  assert.equal(before.normalized.companies.length, 1);
  await db.query(
    "update companies set linkedin_data=jsonb_build_object('unrelated',repeat('x',8100000)) where id in(select company_id from candidate_experiences where candidate_id=$1)",
    [cid],
  );
  const after = await snapshot(cid);
  assert.equal(after.status, "ready");
  assert.equal(after.normalized.companies[0].linkedin_data, undefined);
});
test("normalized conflict evidence remains available to the stored-integrity checker", async () => {
  const cid = await seed(13);
  await db.query(
    "insert into identity_conflicts(kind,candidate_ids,evidence_hash,incoming) values('missing_employer',array[$1::uuid],'snapshot-conflict-13','{}')",
    [cid],
  );
  const s = await snapshot(cid);
  assert.equal(s.normalized.conflicts.length, 1);
  assert.equal(s.normalized.conflicts[0].kind, "missing_employer");
});
test("oversized auxiliary evidence is refused before aggregate proof materialization", async () => {
  const cid = await seed(14);
  await db.query(
    "insert into candidate_emails(candidate_id,email_address,raw_response) values($1,'oversized@example.test',jsonb_build_object('unused',repeat('x',8100000)))",
    [cid],
  );
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query(
      "create or replace function person_private.audit_auxiliary_proof(p_candidate uuid) returns jsonb language plpgsql stable set search_path='' as $$ begin raise exception 'proof_should_not_materialize'; end $$",
    );
    const s = await snapshot(cid, c);
    assert.equal(s.status, "review");
    assert.equal(s.reason, "snapshot_size_limit");
  } finally {
    await c.query("rollback");
    c.release();
  }
});

test("service role can read the bounded evidence without privileged definer code", async () => {
  const c = await db.connect();
  try {
    await c.query("begin read only");
    await c.query("set local role service_role");
    assert.equal((await snapshot(id(1), c)).status, "ready");
    await c.query("rollback");
    const defs = (
      await db.query(
        "select prosecdef,provolatile from pg_proc where oid in ('person_private.postcutover_snapshot(uuid)'::regprocedure,'public.person_postcutover_audit_inputs(jsonb)'::regprocedure)",
      )
    ).rows;
    assert.equal(defs.length, 2);
    assert.ok(defs.every((x) => !x.prosecdef && x.provolatile === "s"));
  } finally {
    await c.query("rollback");
    c.release();
  }
});
test("large skill IDs retain exact identity across the JSON boundary", async () => {
  const cid = await seed(15);
  await db.query(
    "insert into skills(id,name,key) values(9007199254740993,'Synthetic Exact Skill','synthetic-exact-skill')",
  );
  await db.query(
    "insert into candidate_skills(candidate_id,skill_id) values($1,9007199254740993)",
    [cid],
  );
  const s = await snapshot(cid);
  assert.equal(s.normalized.skills[0].skill_id, "9007199254740993");
  assert.equal(s.normalized.skill_lookup[0].id, "9007199254740993");
});
