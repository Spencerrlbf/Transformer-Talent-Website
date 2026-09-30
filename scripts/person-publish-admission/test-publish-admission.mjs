// Local PostgreSQL only. Profile publication with the controller armed and OPEN,
// through the real publish runner (person-publish.mjs) and an operator window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import * as lib from '../dist/worker-lib.mjs';
import { prepareAuditFixture } from '../person-audit/local-fixture.mjs';
import { planAudit } from '../person-audit/postcutover.mjs';
import { runPublish, SPEC } from '../person-publish.mjs';
import { parseOptions, databaseConfig } from '../person-publish/lib.mjs';
import { runUndo, SPEC as UNDO_SPEC } from '../person-publish-undo.mjs';

const url = process.env.LOCAL_DATABASE_URL;
if (!url || new URL(url).pathname !== '/person_publish_admission_test' || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw Error('publish_admission_test_database');
const pool = new pg.Pool(databaseConfig({ LOCAL_DATABASE_URL: url }, 'tt-publish-admission-test'));
const quiet = () => {};
const opts = (argv) => parseOptions(argv, SPEC);
const id = (n) => `ad000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = id(1), B = id(2), C = id(3), U = id(4); // U has no anchor.
const D = id(5), R = id(6); // D's primary email belongs to R.
const E = id(7); // Published armed, then rolled back.
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const status = async () => (await one('select person_transition_status() r')).r;
const act = async (a) => { const s = await status(); return (await one("select person_private.transition_set($1,$2,$3,'synthetic_test') r", [a, s.revision, s.generation])).r; };
const openWindow = async (step, run, minutes = 30) => { const s = await status(); return (await one("select person_private.maintenance_open($1,$2,$3,$4,$5,'synthetic_test') r", [step, run, minutes, s.revision, s.generation])).r; };
const closeWindow = async (w) => (await one("select person_private.maintenance_close($1,'synthetic_test') r", [w])).r;
const publish = (run, ids, resume = false) => runPublish({ pool, lib, options: opts([`--run-id=${run}`, '--mode=publish', `--ids=${ids.join(',')}`, '--review=publish', '--max-seconds=60', ...(resume ? ['--resume'] : [])]), onProgress: quiet });
const n = async (sql, args = []) => Number((await one(sql, args)).n);
async function seed(cid, n, anchor = true) {
  await pool.query(`insert into candidates(id,full_name,linkedin_username,linkedin_url,current_title,current_company,email,source,status,work_experience,created_at)
   values($1::uuid,'Synthetic Publish '||$2::text,'synthetic-pubadm-'||$2::text,'https://www.linkedin.com/in/synthetic-pubadm-'||$2::text,'Engineer','Synthetic Co','pubadm-'||$2::text||'@example.com','directory','Engaged',$3::jsonb,'2025-01-01')`,
    [cid, String(n), JSON.stringify([{ title: 'Engineer', company: 'Synthetic Co', is_current: true, start_date: { year: 2020, month: 'Jan' } }])]);
  if (anchor) await prepareAuditFixture(cid);
  else { // Normalized (a real legacy save) but never anchored.
    const row = (await pool.query('select to_jsonb(c) r from candidates c where id=$1', [cid])).rows[0].r;
    await pool.query('select save_person($1::jsonb)', [JSON.stringify(lib.fromLegacyImport(row, [], [], []))]);
  }
}
async function plan(cid) {
  const c = await pool.connect();
  try {
    await c.query('begin read only'); await c.query("set local statement_timeout='15s'");
    const s = (await c.query('select person_postcutover_audit_inputs_with_witness($1) r', [JSON.stringify([cid])])).rows[0].r[0];
    return planAudit(s, lib, { complete: true, rows: new Map() });
  } finally { await c.query('rollback'); c.release(); }
}
test.after(async () => { await pool.end(); });

test('setup: anchored people while disabled, then arm', async () => {
  for (const [cid, k, anchored] of [[A, 1, true], [B, 2, true], [C, 3, true], [U, 4, false], [E, 7, true]]) await seed(cid, k, anchored);
  // D's legacy primary email is already another candidate's address.
  await pool.query("insert into candidates(id,full_name,linkedin_username,email) values($1,'Synthetic Owner','synthetic-pubadm-owner','taken-pubadm@example.com')", [R]);
  await pool.query(`insert into candidates(id,full_name,linkedin_username,linkedin_url,current_title,current_company,email,source,status,work_experience,created_at)
   values($1,'Synthetic Publish 5','synthetic-pubadm-5','https://www.linkedin.com/in/synthetic-pubadm-5','Engineer','Synthetic Co',null,'directory','Engaged',$2::jsonb,'2025-01-01')`,
    [D, JSON.stringify([{ title: 'Engineer', company: 'Synthetic Co', is_current: true, start_date: { year: 2020, month: 'Jan' } }])]);
  await pool.query("insert into candidate_emails(candidate_id,email_address,is_primary) values($1,'taken-pubadm@example.com',true)", [D]);
  await prepareAuditFixture(D);
  assert.equal((await act('arm')).enabled, true);
  assert.equal((await status()).phase, 'open');
});

test('armed without a window: the run stops before writing anything', async () => {
  await assert.rejects(publish('pub-nowin', [A]), /maintenance_admission/);
  assert.equal(await n('select count(*) n from person_projection_history where candidate_id=$1', [A]), 0);
  assert.equal(await n("select count(*) n from person_audit_operations where candidate_id=$1 and writer='projection'", [A]), 0);
});

test('a window for another run admits nothing', async () => {
  const w = await openWindow('publish', 'pub-other');
  try { await assert.rejects(publish('pub-1', [A, U]), /maintenance_admission/); } finally { await closeWindow(w.work_id); }
  assert.equal(await n('select count(*) n from person_projection_history where candidate_id=$1', [A]), 0);
});

test('the window admits its run while the controller stays open for other writers', async () => {
  const w = await openWindow('publish', 'pub-1');
  try {
    // Another family is still admitted while publication runs.
    const claim = (await one("select person_transition_claim('tt_person',$1,'refresh','refresh:synthetic-open',repeat('d',64),gen_random_uuid(),60) r", [lib.TT_ORG_ID]).catch((e) => ({ r: { status: e.message } }))).r;
    assert.notEqual(claim.status, 'held');
    assert.notEqual(claim.status, 'draining');
    // The refused attempt above left pub-1 failed; the operator resumes the same run.
    const summary = await publish('pub-1', [A, U], true);
    assert.equal(summary.projected, 1, JSON.stringify(summary));
    assert.equal(summary.audit_blocked, 1, JSON.stringify(summary));
  } finally { await closeWindow(w.work_id); }
  const h = await one('select run_id,revision from person_projection_history where candidate_id=$1', [A]);
  assert.equal(h.run_id, 'pub-1');
  const op = await one("select id,writer,receipt_ref,evidence from person_audit_operations where candidate_id=$1 and writer='projection'", [A]);
  assert.match(op.receipt_ref, /^projection:publish:pub-1:/);
  assert.equal(op.evidence.mode, 'publish'); assert.equal(op.evidence.run_id, 'pub-1'); assert.equal(op.evidence.guard.version, 'candidate-audit-1');
  assert.equal(await n('select count(*) n from person_private.certified_audit_operations where operation_id=$1', [op.id]), 1);
  assert.equal(await n("select count(*) n from person_change_attributions where operation_id=$1 and scope='profile'", [op.id]), 1);
  assert.equal(await n('select count(*) n from person_projection_state where candidate_id=$1', [A]), 1);
  const r = await one("select status from person_publish_results where run_id='pub-1' and candidate_id=$1", [U]);
  assert.equal(r.status, 'audit_blocked');
  for (const t of ['maintenance_frames', 'publish_projection_frames', 'application_projection_frames', 'audit_proof_frames'])
    assert.equal(await n(`select count(*) n from person_private.${t}`), 0, t);
});

test('the published person verifies in the post-cutover audit', async () => {
  const p = await plan(A);
  assert.equal(p.status, 'verified', JSON.stringify(p));
});

test('a second publish of the same person is unchanged and the chain stays valid', async () => {
  const w = await openWindow('publish', 'pub-2');
  try {
    const summary = await publish('pub-2', [A, B]);
    assert.equal(summary.unchanged, 1, JSON.stringify(summary));
    assert.equal(summary.projected, 1, JSON.stringify(summary));
  } finally { await closeWindow(w.work_id); }
  assert.equal((await plan(A)).status, 'verified');
  assert.equal((await plan(B)).status, 'verified');
});

test('draining refuses publication; seal waits for the window to close', async () => {
  const w = await openWindow('publish', 'pub-3');
  await act('drain');
  try {
    await assert.rejects(publish('pub-3', [C]), /maintenance_requires_open/);
    await assert.rejects(act('seal'), /transition_unresolved/);
  } finally { await closeWindow(w.work_id); }
  assert.equal(await n('select count(*) n from person_projection_history where candidate_id=$1', [C]), 0);
  await act('seal');
  await assert.rejects(openWindow('publish', 'pub-3'), /maintenance_requires_open/);
  await act('reopen');
});

test('only a direct operator session can publish or open windows', async () => {
  const c = await pool.connect();
  try {
    for (const sql of ["select person_publish_project('pub-x',$1,1,'{}'::jsonb)", "select person_private.maintenance_open('publish','pub-x',30,1,1,'synthetic_test')",
      'select person_private.publish_audit_begin($1)']) {
      await c.query('begin'); await c.query('set local role service_role');
      await assert.rejects(c.query(sql, sql.includes('$1') ? [A] : []), /permission denied/, sql);
      await c.query('rollback');
    }
  } finally { c.release(); }
  const s = await status();
  await assert.rejects(pool.query("select person_private.maintenance_open('publish','pub-x',721,$1,$2,'synthetic_test')", [s.revision, s.generation]), /maintenance_input/);
});

test('disabled: publication uses the existing path unchanged', async () => {
  for (const a of ['drain', 'seal', 'disarm']) await act(a);
  const summary = await publish('pub-disabled', [C]);
  assert.equal(summary.projected, 1, JSON.stringify(summary));
  assert.equal((await one('select run_id from person_projection_history where candidate_id=$1', [C])).run_id, 'pub-disabled');
  assert.equal(await n("select count(*) n from person_private.publish_audit_operations where candidate_id=$1", [C]), 0);
});

test('an email collision keeps the old address and records the review conflict, like the disabled path', async () => {
  if (!(await status()).enabled) await act('arm');
  const w = await openWindow('publish', 'pub-collision');
  let summary;
  try { summary = await publish('pub-collision', [D]); } finally { await closeWindow(w.work_id); }
  assert.equal(summary.projected + summary.unchanged, 1, JSON.stringify(summary));
  assert.equal(summary.email_collision, 1, JSON.stringify(summary));
  assert.equal((await one("select email_collision from person_publish_results where run_id='pub-collision' and candidate_id=$1", [D])).email_collision, true);
  assert.equal(await n("select count(*) n from identity_conflicts where kind='legacy_email_collision' and $1=any(candidate_ids) and status='open'", [D]), 1);
  assert.equal((await one('select email from candidates where id=$1', [D])).email, null);
  assert.equal((await one('select email from candidates where id=$1', [R])).email, 'taken-pubadm@example.com');
});

test('rollback: undo is refused while armed and restores after drain, seal and disarm', async () => {
  if (!(await status()).enabled) await act('arm');
  const original = (await one('select to_jsonb(c) r from candidates c where id=$1', [E])).r;
  const w = await openWindow('publish', 'pub-rollback');
  try { assert.equal((await publish('pub-rollback', [E])).projected, 1); } finally { await closeWindow(w.work_id); }
  const undo = (argv) => runUndo({ pool, lib, options: parseOptions(argv, UNDO_SPEC), onProgress: quiet });
  let armed;
  try { armed = await undo(['--run-id=pub-rollback', '--apply']); } catch (e) { armed = { error: e.message }; }
  assert.notEqual(armed.restored, 1, JSON.stringify(armed));
  assert.equal(await n('select count(*) n from person_projection_history where candidate_id=$1 and restored_at is not null', [E]), 0);
  for (const a of ['drain', 'seal', 'disarm']) await act(a);
  const applied = await undo(['--run-id=pub-rollback', '--apply']);
  assert.equal(applied.restored, 1, JSON.stringify(applied));
  const restored = (await one('select to_jsonb(c) r from candidates c where id=$1', [E])).r;
  for (const k of lib.PROFILE_FIELDS) assert.deepEqual(restored[k] ?? null, original[k] ?? null, k);
  const p = await plan(E);
  assert.equal(p.status, 'verified', JSON.stringify(p));
  assert.equal((await act('arm')).enabled, true);
});
