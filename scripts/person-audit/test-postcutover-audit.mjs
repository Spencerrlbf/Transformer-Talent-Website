// Local PostgreSQL only. The post-cutover auditor on real writer paths:
// anchored people verify; an audited publish stays verified; unattributed,
// auxiliary, held and unanchored people are review; a boundary that moves
// between snapshot and record is stored as pending; a shared lookup change
// after a record makes finalization report it; unbounded or repeatable-read
// callers and client roles are refused; resume never double counts.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import * as lib from "../dist/worker-lib.mjs";
import { prepareAuditFixture } from "./local-fixture.mjs";
import { planAudit } from "./postcutover.mjs";
import { runAudit, SPEC } from "../person-postcutover-audit.mjs";
import { finalizeAudit, SPEC as FINALIZE_SPEC } from "../person-postcutover-finalize.mjs";
import { parseOptions, databaseConfig } from "../person-publish/lib.mjs";

const url = process.env.LOCAL_DATABASE_URL;
if (!url || new URL(url).pathname !== "/person_postcutover_audit_test" || !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
  throw Error("audit_test_database");
const pool = new pg.Pool(databaseConfig({ LOCAL_DATABASE_URL: url }, "tt-postcutover-audit-test"));
const quiet = () => {};
const id = (n) => `ea000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = lib.TT_ORG_ID;
const opts = (argv) => parseOptions(argv, SPEC);
async function timed(sql, values, seconds = 15) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local statement_timeout='${seconds}s'`);
    const r = await c.query(sql, values);
    await c.query("commit");
    return r;
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
}
async function seed(n, { anchor = true, title = "Engineer" } = {}) {
  await pool.query(
    `insert into candidates(id,full_name,linkedin_username,linkedin_url,current_title,current_company,email,source,status,work_experience,created_at)
     values($1,$2,$3,$4,$5,'Synthetic Co',$6,'directory','Engaged',$7,'2025-01-01T00:00:00Z')`,
    [id(n), `Synthetic Audit ${n}`, `synthetic-audit-${n}`, `https://www.linkedin.com/in/synthetic-audit-${n}`, title, `audit-${n}@example.com`,
      JSON.stringify([{ title, company: "Synthetic Co", is_current: true, start_date: { year: 2020, month: "Jan" } }])],
  );
  if (anchor) await prepareAuditFixture(id(n));
  return id(n);
}
const snapshotOf = async (cid) => (await timed("select public.person_postcutover_audit_inputs_with_witness($1::jsonb) r", [JSON.stringify([cid])])).rows[0].r[0];
const planOf = async (cid) => planAudit(await snapshotOf(cid), lib);
const A = id(1), B = id(2), C = id(3), D = id(4), E = id(5);
test.before(async () => {
  for (const n of [1, 2, 3, 4]) await seed(n);
  await seed(5, { anchor: false });
});
test.after(async () => { await pool.end(); });

test("an anchored, untouched person plans verified with a boundary and lookup ids", async () => {
  const plan = await planOf(A);
  assert.equal(plan.status, "verified", JSON.stringify(plan.checks));
  assert.equal(plan.reason, null);
  assert.equal(typeof plan.boundary.anchor_hash, "string");
  assert.equal(typeof plan.boundary.lookup_witness, "string");
  assert.ok(plan.lookup_ids.some((l) => l.startsWith("companies:")), "the fixture job links a company");
  assert.equal(plan.checks.integrity.failed.length, 0);
  assert.equal(plan.checks.published, "unpublished");
});

test("an unanchored person is review: anchor_required", async () => {
  const plan = await planOf(E);
  assert.equal(plan.status, "review");
  assert.equal(plan.reason, "anchor_required");
});

test("an audited publish stays verified, including the published profile boundary", async () => {
  const c = await pool.connect();
  try {
    const r = await lib.publishPersonProjectionOnConnection(c, A, { runId: "audit-pub", dryRun: false });
    assert.equal(r.status, "projected");
  } finally { c.release(); }
  const plan = await planOf(A);
  assert.equal(plan.status, "verified", JSON.stringify(plan));
  assert.equal(plan.checks.candidate_events.attributed, 1);
  assert.deepEqual(plan.checks.published, { revision_matches: true, profile_hash_matches: true });
});

test("an unattributed profile edit after the anchor is review: unattributed_change", async () => {
  await pool.query("update candidates set headline='Legacy edit' where id=$1", [B]);
  const plan = await planOf(B);
  assert.equal(plan.status, "review");
  assert.equal(plan.reason, "unattributed_change");
});

test("a legacy email row added after the anchor is review through the auxiliary proof", async () => {
  await pool.query("insert into candidate_emails(candidate_id,email_address) values($1,'audit-extra@example.com')", [C]);
  const plan = await planOf(C);
  assert.equal(plan.status, "review");
  assert.ok(["auxiliary_changed", "legacy_source_edited"].includes(plan.reason), plan.reason);
});

test("an unresolved source hold is review: source_hold", async () => {
  await pool.query("insert into person_source_holds(candidate_id,ledger_id,evidence_hash,reason,evidence) values($1,gen_random_uuid(),'audit-hold','harvest_cache_date_unknown','{}'::jsonb)", [D]);
  const plan = await planOf(D);
  assert.equal(plan.status, "review");
  assert.equal(plan.reason, "source_hold");
  await pool.query("update person_source_holds set resolved_at=clock_timestamp(),resolution='{\"test\":true}'::jsonb where candidate_id=$1", [D]);
});

test("a dry run over the pool counts every outcome and writes nothing", async () => {
  const summary = await runAudit({ pool, lib, options: opts(["--run-id=audit-dry", "--limit=100", "--batch-size=3"]), onProgress: quiet });
  assert.equal(summary.processed, 5);
  assert.equal(summary.verified, 2, JSON.stringify(summary));
  assert.equal(summary.review, 3);
  assert.equal((await pool.query("select count(*)::int n from person_postcutover_audit_runs")).rows[0].n, 0);
});

test("record stores outcomes after rechecking the boundary; finalize reports review_required while reviews exist", async () => {
  const summary = await runAudit({ pool, lib, options: opts(["--run-id=audit-1", "--record", "--limit=100", "--batch-size=2"]), onProgress: quiet });
  assert.equal(summary.processed, 5);
  assert.equal(summary.boundary_moved, 0);
  const rows = (await pool.query("select status,count(*)::int n from person_postcutover_audit_results where run_id='audit-1' group by status order by status")).rows;
  assert.deepEqual(rows, [{ status: "review", n: 3 }, { status: "verified", n: 2 }]);
  const fin = await finalizeAudit({ pool, options: parseOptions(["--run-id=audit-1", "--external-stable=true"], FINALIZE_SPEC), onProgress: quiet });
  assert.equal(fin.status, "review_required");
  assert.equal(fin.eligible, 5);
  assert.equal(fin.unresolved_review, 3);
  assert.equal(fin.unverified, 3);
});

test("a boundary that moves between snapshot and record is stored as pending: boundary_moved", async () => {
  await timed("select public.person_postcutover_audit_start($1,$2,$3,$4,$5)", ["audit-2", "test", "all", 10, false]);
  const plan = await planOf(D);
  assert.equal(plan.status, "verified");
  await pool.query("update candidates set headline='Moved after snapshot' where id=$1", [D]);
  const out = (await timed("select public.person_postcutover_audit_record_many($1,$2::jsonb) r", ["audit-2", JSON.stringify([plan])])).rows[0].r;
  assert.equal(out[0].status, "pending");
  assert.equal(out[0].reason, "boundary_moved");
  const stored = (await pool.query("select status,reason from person_postcutover_audit_results where run_id='audit-2' and candidate_id=$1", [D])).rows[0];
  assert.deepEqual(stored, { status: "pending", reason: "boundary_moved" });
});

test("a shared lookup change after a verified record makes finalize report lookup_stale", async () => {
  await timed("select public.person_postcutover_audit_start($1,$2,$3,$4,$5)", ["audit-3", "test", "all", 10, false]);
  const plan = await planOf(A);
  assert.equal(plan.status, "verified");
  const out = (await timed("select public.person_postcutover_audit_record_many($1,$2::jsonb) r", ["audit-3", JSON.stringify([plan])])).rows[0].r;
  assert.equal(out[0].status, "verified");
  const companyId = plan.lookup_ids.find((l) => l.startsWith("companies:")).split(":")[1];
  await pool.query("update companies set name=name||' (renamed)' where id=$1", [companyId]);
  assert.ok((await pool.query("select count(*)::int n from person_postcutover_lookup_epochs where table_name='companies' and row_id=$1", [companyId])).rows[0].n >= 2, "creation and rename markers");
  const fin = await finalizeAudit({ pool, options: parseOptions(["--run-id=audit-3", "--external-stable=true"], FINALIZE_SPEC), onProgress: quiet });
  assert.equal(fin.status, "catchup_pending");
  assert.equal(fin.lookup_stale, 1);
  const again = await planOf(A);
  assert.notEqual(again.boundary.lookup_witness, plan.boundary.lookup_witness, "the witness moved with the lookup row");
});

test("record and finalize refuse unbounded or repeatable-read callers; client roles cannot execute", async () => {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await assert.rejects(c.query("select public.person_postcutover_audit_record_many('audit-3','[]'::jsonb)"), /audit_statement_timeout/);
    await c.query("rollback");
    await c.query("begin isolation level repeatable read");
    await c.query("set local statement_timeout='5s'");
    await assert.rejects(c.query("select public.person_postcutover_audit_record_many('audit-3','[]'::jsonb)"), /audit_isolation/);
    await c.query("rollback");
    await c.query("begin");
    await c.query("set local statement_timeout='20s'");
    await assert.rejects(c.query("select public.person_postcutover_audit_finalize('audit-3',true)"), /audit_statement_timeout/);
    await c.query("rollback");
  } finally { c.release(); }
  const grants = (await pool.query(`select has_function_privilege('anon','public.person_postcutover_audit_record_many(text,jsonb)','execute') anon_record,
    has_function_privilege('authenticated','public.person_postcutover_audit_finalize(text,boolean)','execute') auth_finalize,
    has_function_privilege('service_role','public.person_postcutover_audit_record_many(text,jsonb)','execute') service_record,
    has_table_privilege('anon','public.person_postcutover_audit_results','select') anon_results`)).rows[0];
  assert.deepEqual(grants, { anon_record: false, auth_finalize: false, service_record: true, anon_results: false });
  await assert.rejects(pool.query("delete from person_postcutover_lookup_epochs"), /audit_evidence_immutable/);
});

test("a paused run resumes from its cursor and counts each person once", async () => {
  const first = await runAudit({ pool, lib, options: opts(["--run-id=audit-4", "--record", "--limit=2", "--batch-size=1"]), onProgress: quiet });
  assert.equal(first.phase, "audit_scan_paused");
  assert.equal(first.processed, 2);
  await assert.rejects(runAudit({ pool, lib, options: opts(["--run-id=audit-4", "--record", "--resume", "--limit=100", "--batch-size=5"]), onProgress: quiet }), /audit_run_config_differs/);
  const rest = await runAudit({ pool, lib, options: opts(["--run-id=audit-4", "--record", "--resume", "--limit=100", "--batch-size=1"]), onProgress: quiet });
  assert.equal(rest.processed, 3);
  const run = (await pool.query("select status,counts,last_id from person_postcutover_audit_runs where run_id='audit-4'")).rows[0];
  assert.equal(run.status, "paused");
  assert.equal(run.last_id, E);
  const total = Object.values(run.counts).reduce((a, b) => a + Number(b), 0);
  assert.equal(total, 5);
  const pendingPass = await runAudit({ pool, lib, options: opts(["--run-id=audit-4", "--record", "--resume", "--scope=all", "--limit=100", "--batch-size=1"]), onProgress: quiet });
  assert.equal(pendingPass.processed, 0, "the cursor is at the end; nothing is re-read");
});

test("a receipt-created application person is verified from its receipt and creation event", async () => {
  const appId = id(1001), username = "synthetic-audit-app";
  await pool.query("insert into website_applications(id,organization_id,name,email,linkedin_username) values($1,$2,'Synthetic Audit App','audit-app@example.test',$3)", [appId, org, username]);
  const c = await pool.connect();
  let saved;
  try {
    saved = await lib.saveApplicationPersonOnConnection(c, { organizationId: org, applicationId: appId, linkedinUsername: username, name: "Synthetic Audit App", parsed: { current_title: "Incoming" }, resumeText: null, mode: "shadow" });
  } finally { c.release(); }
  assert.ok(saved.candidateId);
  const plan = await planOf(saved.candidateId);
  assert.equal(plan.status, "verified", JSON.stringify(plan));
  assert.equal(plan.checks.creation_event, true);
});
