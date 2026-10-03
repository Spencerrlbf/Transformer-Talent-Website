// Local PostgreSQL only. Recovery cases the release review listed as not yet
// executed (section 7), on the real tools and the full chain, after test-rehearsal:
//  5. actual connection loss at COMMIT during publication, then resume versus control;
//  6. maintenance close and expiry during an admitted publication;
//  7. undo after a legitimate checked recruiter contact edit, and after an unrelated
//     dashboard note, versus an untouched control.
// Runs on the same database as test-rehearsal.mjs (controller armed and open).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import * as lib from '../dist/worker-lib.mjs';
import { pathToFileURL } from 'node:url';
const pinned = process.env.PINNED_RUNNER_DIR;
const from = (rel) => pinned ? import(pathToFileURL(`${pinned}/scripts/${rel}`).href) : import(`../${rel}`);
const { pgSite } = await from('person-trial.mjs');
const { reconcilePage } = await from('person-reconcile.mjs');
const runnerLib = await from('dist/worker-lib.mjs');
import { openAnchorDatabase } from '../person-audit/database.mjs';
import { prepareAnchors } from '../person-audit-anchors.mjs';
import { runPublish, SPEC as PUBLISH } from '../person-publish.mjs';
import { runUndo, SPEC as UNDO } from '../person-publish-undo.mjs';
import { parseOptions, openDatabase, safeReason } from '../person-publish/lib.mjs';
import { planAudit } from '../person-audit/postcutover.mjs';
import { transitionStatus, setTransition, openWindow, closeWindow, waitDrained } from '../person-transition.mjs';

const url = process.env.LOCAL_DATABASE_URL;
if (!url || new URL(url).pathname !== '/person_transition_rehearsal_test' || new URL(url).hostname !== '127.0.0.1') throw Error('rehearsal_database');
const pool = new pg.Pool({ connectionString: url, max: 6 });
const site = await pgSite(url);
const TT = lib.TT_ORG_ID, PIN = 'c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc', quiet = () => {};
const id = (n) => `ae000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Fresh people for this file: a control, the socket-loss subject, two window subjects, two undo subjects.
const CONTROL = id(11), LOSS = id(12), CLOSE = id(13), EXPIRE = id(14), EDIT = id(15), NOTE = id(16);
const ALL = [CONTROL, LOSS, CLOSE, EXPIRE, EDIT, NOTE];
const n = async (sql, args = []) => Number((await pool.query(sql, args)).rows[0].n);
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const phase = async () => (await transitionStatus(pool)).phase;
const job = (t, company) => ({ title: t, company, is_current: true, start_date: { year: 2020, month: 'Jan' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function person(cid, k) {
  await pool.query(`insert into candidates(id,full_name,linkedin_username,linkedin_url,current_title,current_company,email,created_at,work_experience,notes)
   values($1::uuid,'Synthetic Recovery '||$2::text,'synthetic-recovery-'||$2::text,'https://www.linkedin.com/in/synthetic-recovery-'||$2::text,'Engineer','Synthetic Co','recovery-'||$2::text||'@example.com','2025-01-01',$3::jsonb,'original note')`,
    [cid, String(k), JSON.stringify([job('Engineer', 'Synthetic Co')])]);
}
const profile = async (cid) => (await one('select to_jsonb(c)-array[\'updated_at\'] row from candidates c where id=$1', [cid])).row;
const publishOptions = (run, ids, extra = []) => parseOptions([`--run-id=${run}`, '--mode=publish', `--ids=${ids.join(',')}`, '--review=publish', '--max-seconds=60', ...extra], PUBLISH);
async function plan(cid) {
  const c = await pool.connect();
  try { await c.query('begin read only'); await c.query("set local statement_timeout='15s'");
    return planAudit((await c.query('select person_postcutover_audit_inputs_with_witness($1) r', [JSON.stringify([cid])])).rows[0].r[0], lib, { complete: true, rows: new Map() }); }
  finally { await c.query('rollback'); c.release(); }
}
const histories = (cid) => n('select count(*) n from person_projection_history where candidate_id=$1', [cid]);
const uncaught = [];
const onUncaught = (e) => uncaught.push(e);
process.on('uncaughtException', onUncaught);
test.after(async () => { process.off('uncaughtException', onUncaught); await site.end?.(); await pool.end(); });

test('setup: six new people arrive while disarmed, then are reconciled and anchored through a held window', async () => {
  assert.equal(await phase(), 'open');
  // Raw legacy inserts are fenced while armed (candidate_mutation_frame): these people
  // arrive the way the pool did before the controller existed, with it disabled.
  for (const [a, from] of [['drain', 'open'], ['seal', 'draining'], ['disarm', 'held']]) await setTransition(pool, a, `recovery_setup_${a}`, from);
  for (const [i, cid] of ALL.entries()) await person(cid, 11 + i);
  await setTransition(pool, 'arm', 'recovery_setup_arm', 'disabled');
  assert.equal(await n('select count(*) n from person_change_queue where candidate_id=any($1::uuid[])', [ALL]), 6);
  await setTransition(pool, 'drain', 'recovery_drain', 'open');
  const drained = await waitDrained(pool, { maxSeconds: 5, sleep: async () => {} });
  assert.equal(drained.drained, true, JSON.stringify(drained.unresolved));
  await setTransition(pool, 'seal', 'recovery_seal', 'draining');
  const catchup = 'recovery-catchup';
  await site.rpc('person_reconcile_start', { p_run: catchup, p_commit: PIN, p_limit: 100, p_batch: 100, p_resume: false, p_scope: 'queue', p_external_hash: '1'.repeat(32) });
  const w = await openWindow(pool, 'catchup', catchup, 30, 'recovery_catchup', 'held');
  await reconcilePage({ site, lib: runnerLib, config: { run: catchup, dry: false }, page: await site.rpc('person_reconcile_page', { p_run: catchup, p_size: 100 }) });
  await closeWindow(pool, w.work_id, 'recovery_catchup_done');
  const a = await openWindow(pool, 'anchors', 'recovery-anchors', 30, 'recovery_anchors', 'held');
  const db = await openAnchorDatabase({ LOCAL_DATABASE_URL: url });
  try { await prepareAnchors({ site: db, prepare: lib.prepareLegacyAuditAnchor, options: { save: true, limit: 100, batch: 20, after: null, maxSeconds: 60, maxBytes: 1e12 }, onProgress: quiet }); }
  finally { await db.end(); }
  await closeWindow(pool, a.work_id, 'recovery_anchors_done');
  await setTransition(pool, 'reopen', 'recovery_reopen', 'held');
  assert.equal(await phase(), 'open');
  for (const cid of ALL) assert.equal(await n('select count(*) n from person_audit_anchors where candidate_id=$1', [cid]), 1, cid);
});

test('control: an uninterrupted publication of one person', async () => {
  const w = await openWindow(pool, 'publish', 'recovery-control', 60, 'control_publish', 'open');
  let s;
  try { s = await runPublish({ pool, lib, options: publishOptions('recovery-control', [CONTROL]), onProgress: quiet }); }
  finally { await closeWindow(pool, w.work_id, 'control_done'); }
  assert.equal(s.projected + s.unchanged, 1, JSON.stringify(s));
  assert.equal(await histories(CONTROL), 1);
  assert.equal((await plan(CONTROL)).status, 'verified');
});

test('5. actual connection loss at COMMIT: controlled failure, no partial state, resume equals the control', async () => {
  const run = 'recovery-loss';
  const w = await openWindow(pool, 'publish', run, 60, 'loss_publish', 'open');
  const db = await openDatabase({ LOCAL_DATABASE_URL: url }, 'tt-person-recovery-test'); // the CLI's own session handling
  let killed = 0;
  // Wrap the checked-out session: when this person's transaction reaches COMMIT, kill its
  // backend from another connection first, then send the COMMIT into the dead socket.
  const wrapped = {
    ...db,
    connect: async () => {
      const client = await db.connect();
      const pid = (await client.query('select pg_backend_pid() pid')).rows[0].pid;
      return {
        query: async (...args) => {
          const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
          if (text === 'commit' && killed === 0) {
            killed++;
            assert.equal((await pool.query('select pg_terminate_backend($1) ok', [pid])).rows[0].ok, true);
            await sleep(100);
          }
          return client.query(...args);
        },
        release: (e) => client.release(e),
      };
    },
  };
  let failure;
  try { await runPublish({ pool: wrapped, lib, options: publishOptions(run, [LOSS]), onProgress: quiet }); }
  catch (e) { failure = e; }
  finally { await db.end().catch(() => {}); }
  assert.ok(failure, 'the run must fail, not report success');
  assert.equal(killed, 1);
  assert.match(safeReason(failure), /^(publish_session_lock_lost|operation_failed:(57P01|unknown))$/, failure.message);
  await sleep(200);
  assert.equal(uncaught.length, 0, 'no unhandled connection error escaped');
  // The interrupted transaction left nothing: no history, no result, no frames.
  assert.equal(await histories(LOSS), 0);
  assert.equal(await n("select count(*) n from person_publish_results where run_id=$1", [run]), 0);
  assert.equal(await n('select count(*) n from person_private.publish_projection_frames'), 0);
  assert.equal(await n('select count(*) n from person_private.maintenance_frames'), 0);
  // Resume the same run on a fresh session: exactly one publication, same shape as the control.
  let s;
  try { s = await runPublish({ pool, lib, options: publishOptions(run, [LOSS], ['--resume']), onProgress: quiet }); }
  finally { await closeWindow(pool, w.work_id, 'loss_done'); }
  assert.equal(s.projected + s.unchanged, 1, JSON.stringify(s));
  assert.equal(await histories(LOSS), 1);
  assert.equal(await n("select count(*) n from person_publish_results where run_id=$1 and candidate_id=$2", [run, LOSS]), 1);
  assert.equal((await plan(LOSS)).status, 'verified');
  const control = await profile(CONTROL), loss = await profile(LOSS);
  for (const k of ['current_title', 'current_company', 'profile_hash', 'contact']) assert.deepEqual(loss[k], control[k], k);
});

test('6a. maintenance close during an admitted publication waits for the whole commit', async () => {
  const run = 'recovery-close';
  const w = await openWindow(pool, 'publish', run, 60, 'close_publish', 'open');
  let closing, closeResolvedBeforeCommit = null;
  const wrapped = {
    ...pool,
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (...args) => {
          const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
          const result = await client.query(...args);
          if (typeof text === 'string' && text.includes('person_publish_project') && !closing) {
            // Admitted, not yet committed: the operator closes the window now.
            let settled = false;
            closing = closeWindow(pool, w.work_id, 'close_during_publish').then((r) => { settled = true; return r; });
            await sleep(400);
            closeResolvedBeforeCommit = settled;
          }
          return result;
        },
        release: (e) => client.release(e),
      };
    },
    query: (...a) => pool.query(...a),
  };
  const s = await runPublish({ pool: wrapped, lib, options: publishOptions(run, [CLOSE]), onProgress: quiet });
  assert.equal(closeResolvedBeforeCommit, false, 'close must wait for the admitted transaction');
  const closed = await closing;
  assert.equal(closed.status, 'closed');
  assert.equal(s.projected + s.unchanged, 1, JSON.stringify(s));
  assert.equal(await histories(CLOSE), 1);
  assert.equal(await n('select count(*) n from person_private.publish_projection_frames'), 0);
  assert.equal((await plan(CLOSE)).status, 'verified');
});

test('6b. window expiry before admission aborts the publication wholly; the person is untouched', async () => {
  const run = 'recovery-expire';
  await pool.query(`create function person_private.synthetic_short_recovery_window() returns trigger language plpgsql as $$begin if new.family='maintenance' then new.lease_until:=clock_timestamp()+interval '300 milliseconds';end if;return new;end$$;
    create trigger aa_short_recovery_window before insert on person_private.transition_work for each row execute function person_private.synthetic_short_recovery_window()`);
  let w;
  try { w = await openWindow(pool, 'publish', run, 1, 'expire_publish', 'open'); }
  finally { await pool.query('drop trigger aa_short_recovery_window on person_private.transition_work;drop function person_private.synthetic_short_recovery_window()'); }
  const before = await profile(EXPIRE);
  const wrapped = {
    ...pool,
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (...args) => {
          const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
          if (typeof text === 'string' && text.includes('person_publish_project')) await sleep(500); // the window expires here
          return client.query(...args);
        },
        release: (e) => client.release(e),
      };
    },
    query: (...a) => pool.query(...a),
  };
  await assert.rejects(runPublish({ pool: wrapped, lib, options: publishOptions(run, [EXPIRE]), onProgress: quiet }), (e) => e.message === 'maintenance_admission');
  assert.equal(await histories(EXPIRE), 0);
  assert.equal(await n("select count(*) n from person_publish_results where run_id=$1", [run]), 0);
  assert.equal(await n('select count(*) n from person_private.publish_projection_frames'), 0);
  assert.equal(await n('select count(*) n from person_private.maintenance_frames'), 0);
  assert.deepEqual(await profile(EXPIRE), before);
  // The expired window still has to be closed explicitly; drain reports it until then.
  assert.equal((await closeWindow(pool, w.work_id, 'expire_close')).status, 'closed');
  assert.equal((await plan(EXPIRE)).status, 'verified');
});

test('7. undo after a legitimate checked contact edit conflicts and keeps the edit; an unrelated note edit survives undo', async () => {
  const run = 'recovery-undo';
  const w = await openWindow(pool, 'publish', run, 60, 'undo_publish', 'open');
  let s;
  try { s = await runPublish({ pool, lib, options: publishOptions(run, [EDIT, NOTE]), onProgress: quiet }); }
  finally { await closeWindow(pool, w.work_id, 'undo_publish_done'); }
  assert.equal(s.projected + s.unchanged, 2, JSON.stringify(s));
  // A real admitted recruiter contact edit on EDIT, through the certified live path.
  process.env.PERSON_TRANSITION_SUPPORT = 'on';
  const c = await pool.connect();
  let saved;
  try {
    saved = await lib.saveRecruiterContactOnConnection(c, { organizationId: TT, candidateId: EDIT, actorId: randomUUID(), requestId: randomUUID(), mode: 'live',
      contact: { email: 'recovery-edited@example.test', phone: '+1 202 555 0150', otherEmails: [] } });
  } finally { c.release(); delete process.env.PERSON_TRANSITION_SUPPORT; }
  assert.ok(saved);
  const edited = await profile(EDIT);
  assert.equal(edited.contact?.email, 'recovery-edited@example.test');
  // Dashboard notes live in the organization-owned candidate_notes table (lib/server/tasks.ts),
  // not on the pool row. A raw column write on the pool row is fenced while armed.
  await assert.rejects(pool.query("update candidates set notes='raw note while armed' where id=$1", [NOTE]), /candidate_mutation_frame/);
  await pool.query('create table if not exists candidate_notes(id uuid primary key default gen_random_uuid(),organization_id uuid not null,candidate_key text not null,kind text not null,body text not null,created_at timestamptz not null default now())');
  await pool.query("insert into candidate_notes(organization_id,candidate_key,kind,body) values($1,$2,'note','note written after publication')", [TT, NOTE]);
  const noted = await profile(NOTE);
  // Rollback sequence as the runbook prescribes: drain, seal, disarm, undo, arm again.
  for (const [a, from] of [['drain', 'open'], ['seal', 'draining'], ['disarm', 'held']]) await setTransition(pool, a, `recovery_${a}`, from);
  const undone = await runUndo({ pool, lib, options: parseOptions([`--run-id=${run}`, '--apply'], UNDO), onProgress: quiet });
  // EDIT: the newer legitimate edit wins; undo leaves it byte-for-byte. NOTE: restored profile, note kept.
  assert.equal(undone.conflict, 1, JSON.stringify(undone));
  assert.equal(undone.restored, 1, JSON.stringify(undone));
  assert.deepEqual(await profile(EDIT), edited);
  const restored = await profile(NOTE);
  assert.equal(await n("select count(*) n from candidate_notes where candidate_key=$1 and body='note written after publication'", [NOTE]), 1, 'the note survives the undo');
  assert.equal(restored.notes, noted.notes);
  assert.deepEqual(restored.contact, noted.contact);
  assert.equal(await n('select count(*) n from person_projection_history where candidate_id=$1 and restored_at is not null', [NOTE]), 1);
  assert.equal(await n('select count(*) n from person_projection_history where candidate_id=$1 and restored_at is not null', [EDIT]), 0);
  // Repeating the undo adds nothing.
  const again = await runUndo({ pool, lib, options: parseOptions([`--run-id=${run}`, '--apply'], UNDO), onProgress: quiet });
  assert.equal(again.restored, 1); assert.equal(again.conflict, 1);
  for (const cid of [EDIT, NOTE]) assert.equal((await plan(cid)).status, 'verified', cid);
  await setTransition(pool, 'arm', 'recovery_rearm', 'disabled');
  assert.equal(await phase(), 'open');
});
