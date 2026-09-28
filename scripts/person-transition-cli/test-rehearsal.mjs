// Local PostgreSQL only. The cutover sequence rehearsed end to end with the real
// tools: the transition CLI, the historical reconcile runner, the anchor CLI, the
// publish and undo runners and the post-cutover planner. Public applications must
// be accepted durably in every phase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import * as lib from '../dist/worker-lib.mjs';
import { pathToFileURL } from 'node:url';
// PINNED_RUNNER_DIR: the frozen c4d0e4e checkout with its worker lib built; the
// catch-up then runs that exact runner, as in production.
const pinned = process.env.PINNED_RUNNER_DIR;
const from = (rel) => pinned ? import(pathToFileURL(`${pinned}/scripts/${rel}`).href) : import(`../${rel}`);
const { pgSite } = await from('person-trial.mjs');
const { reconcilePage } = await from('person-reconcile.mjs');
const runnerLib = await from('dist/worker-lib.mjs');
import { openAnchorDatabase } from '../person-audit/database.mjs';
import { prepareAnchors } from '../person-audit-anchors.mjs';
import { runPublish, SPEC as PUBLISH } from '../person-publish.mjs';
import { runUndo, SPEC as UNDO } from '../person-publish-undo.mjs';
import { parseOptions } from '../person-publish/lib.mjs';
import { planAudit } from '../person-audit/postcutover.mjs';
import { main, transitionStatus, setTransition, openWindow, closeWindow, waitDrained, reasonOf } from '../person-transition.mjs';

const url = process.env.LOCAL_DATABASE_URL;
if (!url || new URL(url).pathname !== '/person_transition_rehearsal_test' || new URL(url).hostname !== '127.0.0.1') throw Error('rehearsal_database');
const pool = new pg.Pool({ connectionString: url, max: 4 });
const site = await pgSite(url);
const TT = lib.TT_ORG_ID, PIN = 'c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc', quiet = () => {};
const id = (n) => `ae000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = id(1), B = id(2), LATE = id(3);
const n = async (sql, args = []) => Number((await pool.query(sql, args)).rows[0].n);
const phase = async () => (await transitionStatus(pool)).phase;
const job = (t, company) => ({ title: t, company, is_current: true, start_date: { year: 2020, month: 'Jan' } });
async function person(cid, k, created = '2025-01-01') {
  await pool.query(`insert into candidates(id,full_name,linkedin_username,linkedin_url,current_title,current_company,email,created_at,work_experience)
   values($1::uuid,'Synthetic Rehearsal '||$2::text,'synthetic-rehearsal-'||$2::text,'https://www.linkedin.com/in/synthetic-rehearsal-'||$2::text,'Engineer','Synthetic Co','rehearsal-'||$2::text||'@example.com',$3::timestamptz,$4::jsonb)`,
    [cid, String(k), created, JSON.stringify([job('Engineer', 'Synthetic Co')])]);
}
// A public future-interest submission, exactly as the site accepts it with support on.
async function submit(label) {
  const username = `synthetic-applicant-${label}-${randomUUID().slice(0, 8)}`;
  const r = (await pool.query("select person_application_accept('future',$1::jsonb) r", [JSON.stringify({ organization_id: TT, name: 'Synthetic Applicant', email: `${username}@example.test`,
    linkedin_username: username, linkedin_url: `https://www.linkedin.com/in/${username}`, preferred_locations: [], role_ids: [], role_titles: [], source: 'future',
    follow_up_at: '2027-01-01', preferred_roles: ['Engineering'], preferred_workplace: [], comp_expectation: null })])).rows[0].r;
  assert.equal(r.inserted, true, `accepted while ${await phase()}`);
  return r.id;
}
const reconcile = async (run, scope) => {
  await site.rpc('person_reconcile_start', { p_run: run, p_commit: PIN, p_limit: 100, p_batch: 100, p_resume: false, p_scope: scope, p_external_hash: '1'.repeat(32) });
  return reconcilePage({ site, lib: runnerLib, config: { run, dry: false }, page: await site.rpc('person_reconcile_page', { p_run: run, p_size: 100 }) });
};
const anchors = async () => {
  const db = await openAnchorDatabase({ LOCAL_DATABASE_URL: url });
  try { return await prepareAnchors({ site: db, prepare: lib.prepareLegacyAuditAnchor, options: { save: true, limit: 100, batch: 20, after: null, maxSeconds: 60, maxBytes: 1e12 }, onProgress: quiet }); }
  finally { await db.end(); }
};
async function plan(cid) {
  const c = await pool.connect();
  try { await c.query('begin read only'); await c.query("set local statement_timeout='15s'");
    return planAudit((await c.query('select person_postcutover_audit_inputs_with_witness($1) r', [JSON.stringify([cid])])).rows[0].r[0], lib, { complete: true, rows: new Map() }); }
  finally { await c.query('rollback'); c.release(); }
}
test.after(async () => { await site.end?.(); await pool.end(); });

test('1. before arming: baseline reconciliation on the pinned runtime; a late arrival is captured', async () => {
  await person(A, 1); await person(B, 2);
  await reconcile('rehearsal-baseline', 'all');
  assert.equal(await n("select count(*) n from person_reconcile_people where run_id='rehearsal-baseline' and status='verified'"), 2);
  await person(LATE, 3, '2025-02-01'); // arrives after the baseline, before the drain
  assert.equal(await n('select count(*) n from person_change_queue'), 1);
  assert.equal(await phase(), 'open'); await submit('disabled');
});

test('2. arm: the CLI reports the state; applications keep arriving', async () => {
  const lines = [];
  await main(['--arm', '--reason=rehearsal_arm'], { env: { LOCAL_DATABASE_URL: url }, out: (x) => lines.push(x) });
  assert.equal(lines[0].action, 'transition_arm'); assert.equal(lines[0].enabled, true); assert.equal(lines[0].phase, 'open');
  await submit('armed');
  await assert.rejects(main(['--arm'], { env: { LOCAL_DATABASE_URL: url }, out: quiet }), /transition_option_required:reason/);
  await assert.rejects(setTransition(pool, 'arm', 'rehearsal_again'), (e) => reasonOf(e) === 'transition_state');
});

test('3. drain then seal: accepted work drains, submissions stay durable while held', async () => {
  await setTransition(pool, 'drain', 'rehearsal_drain');
  await submit('draining');
  const drained = await waitDrained(pool, { maxSeconds: 5, sleep: async () => {} });
  assert.equal(drained.drained, true, JSON.stringify(drained.unresolved));
  await setTransition(pool, 'seal', 'rehearsal_seal');
  assert.equal(await phase(), 'held');
  const held = await submit('held');
  assert.equal((await pool.query('select status from website_applications where id=$1', [held])).rows[0].status, 'queued');
});

test('4. held maintenance: pinned catch-up, then anchors, then reopen', async () => {
  const catchup = 'rehearsal-catchup';
  await site.rpc('person_reconcile_start', { p_run: catchup, p_commit: PIN, p_limit: 100, p_batch: 100, p_resume: false, p_scope: 'queue', p_external_hash: '1'.repeat(32) });
  const w = await openWindow(pool, 'catchup', catchup, 30, 'final_catchup');
  await submit('catchup_window');
  await reconcilePage({ site, lib: runnerLib, config: { run: catchup, dry: false }, page: await site.rpc('person_reconcile_page', { p_run: catchup, p_size: 100 }) });
  assert.equal(await n('select count(*) n from person_change_queue'), 0);
  await assert.rejects(setTransition(pool, 'reopen', 'too_early'), (e) => reasonOf(e) === 'transition_unresolved');
  await closeWindow(pool, w.work_id, 'catchup_done');
  const a = await openWindow(pool, 'anchors', 'rehearsal-anchors', 30, 'prepare_anchors');
  const result = await anchors();
  await closeWindow(pool, a.work_id, 'anchors_done');
  assert.equal(result.created, 3, JSON.stringify(result));
  assert.equal((await transitionStatus(pool)).windows.length, 0);
  await setTransition(pool, 'reopen', 'rehearsal_reopen');
  assert.equal(await phase(), 'open');
  await submit('reopened');
});

test('5. publish while open, bound to its run; the audit verifies the published people', async () => {
  const run = 'rehearsal-publish';
  const w = await openWindow(pool, 'publish', run, 60, 'publish_all');
  let summary;
  try { summary = await runPublish({ pool, lib, options: parseOptions([`--run-id=${run}`, '--mode=publish', `--ids=${[A, B, LATE].join(',')}`, '--review=publish', '--max-seconds=60'], PUBLISH), onProgress: quiet }); }
  finally { await closeWindow(pool, w.work_id, 'publish_done'); }
  assert.equal(summary.projected + summary.unchanged, 3, JSON.stringify(summary));
  await submit('after_publish');
  for (const cid of [A, B, LATE]) assert.equal((await plan(cid)).status, 'verified', cid);
});

test('6. rollback: drain, seal, disarm, undo the run, arm again', async () => {
  const before = (await pool.query("select count(*)::int n from person_projection_history where run_id='rehearsal-publish' and restored_at is null")).rows[0].n;
  assert.ok(before > 0);
  for (const a of ['drain', 'seal', 'disarm']) await setTransition(pool, a, `rehearsal_${a}`);
  await submit('disarmed');
  const undone = await runUndo({ pool, lib, options: parseOptions(['--run-id=rehearsal-publish', '--apply'], UNDO), onProgress: quiet });
  assert.equal(undone.restored, before, JSON.stringify(undone));
  for (const cid of [A, B, LATE]) assert.equal((await plan(cid)).status, 'verified', `after undo ${cid}`);
  await setTransition(pool, 'arm', 'rehearsal_rearm');
  assert.equal((await transitionStatus(pool)).enabled, true);
  // Every submission in every phase is still there, none lost.
  assert.equal(await n("select count(*) n from website_applications where source='future' and name='Synthetic Applicant'"), 8);
});
