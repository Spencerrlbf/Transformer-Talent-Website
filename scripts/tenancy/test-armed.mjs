// Local PostgreSQL only (full release chain, controller disabled at start). The
// armed-mode orchestration of the leak test (scripts/tenancy/armed.mjs): fixture-style
// raw pool people seeded while disabled are reconciled, anchored and the controller
// armed; while armed a raw candidate write is refused but a supported write path is
// admitted; disarming admits the fixture's raw teardown again. The HTTP probes
// themselves need a deployment with Auth and REST and are not run here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { preflightArmedSweep, armForSweep, disarmAfterSweep, recoverArmOwnership, operatorPool, sweepReason } from './armed.mjs';
import { transitionStatus } from '../person-transition.mjs';

const url = process.env.LOCAL_DATABASE_URL;
if (!url || new URL(url).hostname !== '127.0.0.1' || !/person_[a-z_]+_test$/.test(new URL(url).pathname)) throw Error('local fixture required');
const pool = new pg.Pool({ connectionString: url, max: 4 });
const TT = '801865a7-6533-41d2-9c45-e4a90e6ad51a';
const runId = randomUUID().slice(0, 8);
const ids = [randomUUID(), randomUUID(), randomUUID()];
const env = { ...process.env, LOCAL_DATABASE_URL: url, PERSON_TARGET_PROJECT_REF: 'local' };
const control = async () => (await pool.query('select enabled,phase,revision::text revision,generation::text generation from person_private.transition_control where singleton')).rows[0];
let ownership = null;
test.after(() => pool.end());

test('preflight: target proved through PostgreSQL, controller disabled, nothing unresolved', async () => {
  const p = await preflightArmedSweep(env);
  assert.equal(p.local, true); assert.equal(p.rest_checked, false);
  assert.equal(p.system_identifier, (await pool.query('select system_identifier::text v from pg_control_system()')).rows[0].v);
  assert.deepEqual(p.controller, { ...(await control()) });
  assert.equal(p.controller.enabled, false);
});

test('fixture-style seeding while disabled', async () => {
  assert.equal((await transitionStatus(pool)).enabled, false);
  for (const [i, id] of ids.entries())
    await pool.query(`insert into candidates(id,full_name,linkedin_username,linkedin_url,email,current_title,current_company,source,notes,contact,created_at)
      values($1,$2,$3::text,'https://www.linkedin.com/in/'||$3::text,$3::text||'@example.com','Engineer','Example Corp','leaktest','synthetic',$4::jsonb,'2025-01-01')`,
      [id, `Leak Test Person ${i}`, `zzlk${runId}s-li${i}`, JSON.stringify({ email: `zzlk${runId}s-li${i}@example.com` })]);
  assert.equal((await pool.query('select count(*)::int n from person_change_queue where candidate_id=any($1::uuid[])', [ids])).rows[0].n, 3);
});

test('armForSweep: reconciled, anchored, armed and open; ownership is the exact revision/generation it produced', async () => {
  const before = await control();
  const preflight = await preflightArmedSweep(env);
  const handed = [];
  const r = await armForSweep({ runId, candidateIds: ids, preflight, onOwnership: (o) => handed.push(o) }, env);
  assert.equal(r.reconciled, 3);
  assert.ok(r.anchored >= 3, JSON.stringify(r));
  assert.equal(r.controller.enabled, true); assert.equal(r.controller.phase, 'open');
  for (const id of ids) {
    assert.equal((await pool.query('select count(*)::int n from candidate_profile_state where candidate_id=$1', [id])).rows[0].n, 1, 'normalized');
    assert.equal((await pool.query('select count(*)::int n from person_audit_anchors where candidate_id=$1', [id])).rows[0].n, 1, 'anchored');
  }
  const after = await control();
  assert.equal(handed.length, 1); ownership = handed[0];
  assert.deepEqual(ownership, { database: preflight.system_identifier, run: runId, revision: after.revision, generation: after.generation, phase: 'open', last_action: 'arm' });
  assert.equal(BigInt(after.revision), BigInt(before.revision) + 1n); assert.equal(BigInt(after.generation), BigInt(before.generation) + 1n);
  // the durable event this sweep wrote is the only evidence a lost acknowledgement may use
  assert.deepEqual(await recoverArmOwnership({ runId, database: preflight.system_identifier }, env), ownership);
  assert.equal(await recoverArmOwnership({ runId: 'neverarmed1' }, env), null);
  assert.equal((await pool.query('select count(*)::int n from person_private.transition_events where reason_code=$1', [sweepReason('arm', runId)])).rows[0].n, 1);
  // an enabled controller is a precondition failure for a second sweep: no transition
  await assert.rejects(armForSweep({ runId: 'other001', candidateIds: ids }, env), /tenancy_armed_precondition:controller_enabled/);
  await assert.rejects(preflightArmedSweep(env), /tenancy_armed_precondition:controller_enabled/);
  assert.deepEqual(await control(), after);
});

test('armed: the fixture\'s raw writes are refused, a supported public write path is admitted', async () => {
  await assert.rejects(pool.query("insert into candidates(full_name,linkedin_username,source) values('Raw While Armed','zzlk-raw-armed','leaktest')"), /candidate_mutation_frame/);
  await assert.rejects(pool.query('delete from candidates where id=$1', [ids[0]]), /candidate_mutation_delete/);
  const username = `zzlk${runId}-applicant`;
  const r = (await pool.query("select person_application_accept('future',$1::jsonb) r", [JSON.stringify({ organization_id: TT, name: 'Synthetic Applicant', email: `${username}@example.test`,
    linkedin_username: username, linkedin_url: `https://www.linkedin.com/in/${username}`, preferred_locations: [], role_ids: [], role_titles: [], source: 'future',
    follow_up_at: '2027-01-01', preferred_roles: ['Engineering'], preferred_workplace: [], comp_expectation: null })])).rows[0].r;
  assert.equal(r.inserted, true);
});

test('transport loss during orchestration: an idle or checked-out session killed by the server is handled, never uncaught (R2-05)', async () => {
  const uncaught = []; const onUncaught = (e) => uncaught.push(e); process.on('uncaughtException', onUncaught);
  try {
    const db = await operatorPool(env);
    // idle loss: the pooled session sits idle (as during reconciliation/anchoring); the server drops it
    await db.query('select 1');
    const killed = (await pool.query("select count(pg_terminate_backend(pid))::int n from pg_stat_activity where application_name='tt-tenancy-armed' and pid<>pg_backend_pid()")).rows[0].n;
    assert.ok(killed >= 1, 'an idle operator session existed to kill');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await db.query('select 1 v')).rows[0].v, 1, 'a fresh session serves the next query');
    // checked-out loss: the session in use loses its backend mid-sequence
    const client = await db.connect();
    const pid = (await client.query('select pg_backend_pid() pid')).rows[0].pid;
    await pool.query('select pg_terminate_backend($1)', [pid]);
    await assert.rejects(client.query('select 1'), (e) => /^(57P01|08\d{3})$/.test(e.code ?? '') || /terminat|closed/i.test(e.message));
    await assert.rejects(client.query('select 1'), () => true, 'a broken session stays broken until released');
    client.release();
    assert.equal((await db.query('select 1 v')).rows[0].v, 1);
    await db.end();
    // the reconcile shim's pool (pgSite) sits idle between RPC pages during step 1:
    // an idle loss there must not be uncaught either (review of R2-05)
    const { pgSite } = await import('../person-trial.mjs');
    const site = await pgSite(url);
    const killedSite = (await pool.query("select count(pg_terminate_backend(pid))::int n from pg_stat_activity where application_name='tt-person-trial-local' and pid<>pg_backend_pid()")).rows[0].n;
    assert.ok(killedSite >= 1);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await site.select('candidates', { filters: [], order: 'created_at', limit: 1 })).length, 1, 'a fresh session serves the shim after the idle loss');
    await site.end?.();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(uncaught, []);
  } finally { process.off('uncaughtException', onUncaught); }
  // the controller was not touched by any of this
  assert.deepEqual(await control(), { enabled: true, phase: 'open', revision: ownership.revision, generation: ownership.generation });
});

test('two operators: a foreign drain + reopen leaves the same phase with a new generation; the sweep\'s CAS is refused and nothing changes', async () => {
  const mine = await control();
  const other = async (action, expected) => {
    const c = await control(); assert.equal(c.phase, expected);
    await pool.query("select person_private.transition_set($1,$2::bigint,$3::bigint,'other_operator')", [action, c.revision, c.generation]);
  };
  await other('drain', 'open'); await other('reopen', 'draining');
  const moved = await control();
  assert.equal(moved.phase, 'open'); assert.equal(moved.enabled, true);
  assert.equal(BigInt(moved.revision), BigInt(mine.revision) + 2n); assert.equal(BigInt(moved.generation), BigInt(mine.generation) + 1n);
  await assert.rejects(disarmAfterSweep({ ownership }, env), new RegExp(`tenancy_armed_ownership:stale:open:${moved.revision}:${moved.generation}`));
  await assert.rejects(recoverArmOwnership({ runId, database: ownership.database }, env), /tenancy_armed_ownership:unresolved_arm/);
  await assert.rejects(disarmAfterSweep({}, env), /tenancy_armed_ownership:missing/);
  assert.deepEqual(await control(), moved, 'refusals changed nothing');
  // the real CAS: the sweep's stale values are refused by SQL itself, not only by the wrapper
  await assert.rejects(pool.query("select person_private.transition_set('drain',$1::bigint,$2::bigint,'stale_attempt')", [ownership.revision, ownership.generation]), /transition_stale/);
  // the other operator hands the controller back explicitly: ownership of the current state
  ownership = { ...ownership, revision: moved.revision, generation: moved.generation, last_action: 'reopen' };
});

test('disarmAfterSweep: owned drain, seal, disarm; normalized fixture people are retained evidence', async () => {
  const start = await control();
  const d = await disarmAfterSweep({ ownership }, env);
  assert.equal(d.skipped, false); assert.equal(d.controller.enabled, false);
  assert.deepEqual(d.steps, ['drain', 'seal', 'disarm']);
  const end = await control();
  assert.equal(BigInt(end.revision), BigInt(start.revision) + 3n); assert.equal(BigInt(end.generation), BigInt(start.generation) + 2n);
  assert.deepEqual(d.ownership, { ...ownership, revision: end.revision, generation: end.generation, phase: 'disabled', last_action: 'disarm' });
  assert.deepEqual((await pool.query("select action,reason_code from person_private.transition_events where reason_code like 'tenancy_sweep_%' order by revision")).rows,
    [{ action: 'arm', reason_code: sweepReason('arm', runId) }, { action: 'drain', reason_code: sweepReason('drain', runId) }, { action: 'seal', reason_code: sweepReason('seal', runId) }, { action: 'disarm', reason_code: sweepReason('disarm', runId) }]);
  // Once normalized and anchored, a pool person cannot be deleted: anchors and audit
  // operations are immutable by design and normalized facts reference the row. The
  // fixture's raw teardown therefore retains these three synthetic people, which is
  // why the armed sweep belongs in a disposable database only.
  await assert.rejects(pool.query('delete from candidates where id=any($1::uuid[])', [ids]), /violates foreign key constraint/);
  assert.equal((await pool.query('select count(*)::int n from candidates where id=any($1::uuid[])', [ids])).rows[0].n, 3);
  // Anchor deletes are suppressed (immutable evidence), so the people stay referenced.
  await pool.query('delete from person_audit_anchors where candidate_id=any($1::uuid[])', [ids]);
  assert.equal((await pool.query('select count(*)::int n from person_audit_anchors where candidate_id=any($1::uuid[])', [ids])).rows[0].n, 3);
  const again = await disarmAfterSweep({ ownership: d.ownership }, env);
  assert.equal(again.skipped, true);
  await assert.rejects(disarmAfterSweep({ ownership }, env), /tenancy_armed_ownership:stale/, 'the pre-disarm record is stale now');
});
