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
import { armForSweep, disarmAfterSweep } from './armed.mjs';
import { transitionStatus } from '../person-transition.mjs';

const url = process.env.LOCAL_DATABASE_URL;
if (!url || new URL(url).hostname !== '127.0.0.1' || !/person_[a-z_]+_test$/.test(new URL(url).pathname)) throw Error('local fixture required');
const pool = new pg.Pool({ connectionString: url, max: 4 });
const TT = '801865a7-6533-41d2-9c45-e4a90e6ad51a';
const runId = randomUUID().slice(0, 8);
const ids = [randomUUID(), randomUUID(), randomUUID()];
test.after(() => pool.end());

test('fixture-style seeding while disabled', async () => {
  assert.equal((await transitionStatus(pool)).enabled, false);
  for (const [i, id] of ids.entries())
    await pool.query(`insert into candidates(id,full_name,linkedin_username,linkedin_url,email,current_title,current_company,source,notes,contact,created_at)
      values($1,$2,$3::text,'https://www.linkedin.com/in/'||$3::text,$3::text||'@example.com','Engineer','Example Corp','leaktest','synthetic',$4::jsonb,'2025-01-01')`,
      [id, `Leak Test Person ${i}`, `zzlk${runId}s-li${i}`, JSON.stringify({ email: `zzlk${runId}s-li${i}@example.com` })]);
  assert.equal((await pool.query('select count(*)::int n from person_change_queue where candidate_id=any($1::uuid[])', [ids])).rows[0].n, 3);
});

test('armForSweep: reconciled, anchored, armed and open', async () => {
  const r = await armForSweep({ runId, candidateIds: ids }, { ...process.env, LOCAL_DATABASE_URL: url });
  assert.equal(r.reconciled, 3);
  assert.ok(r.anchored >= 3, JSON.stringify(r));
  assert.equal(r.controller.enabled, true); assert.equal(r.controller.phase, 'open');
  for (const id of ids) {
    assert.equal((await pool.query('select count(*)::int n from candidate_profile_state where candidate_id=$1', [id])).rows[0].n, 1, 'normalized');
    assert.equal((await pool.query('select count(*)::int n from person_audit_anchors where candidate_id=$1', [id])).rows[0].n, 1, 'anchored');
  }
  await assert.rejects(armForSweep({ runId, candidateIds: ids }, { ...process.env, LOCAL_DATABASE_URL: url }), /tenancy_armed_precondition:controller_enabled/);
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

test('disarmAfterSweep: drained, sealed, disabled; normalized fixture people are retained evidence', async () => {
  const d = await disarmAfterSweep({ ...process.env, LOCAL_DATABASE_URL: url });
  assert.equal(d.skipped, false); assert.equal(d.controller.enabled, false);
  // Once normalized and anchored, a pool person cannot be deleted: anchors and audit
  // operations are immutable by design and normalized facts reference the row. The
  // fixture's raw teardown therefore retains these three synthetic people, which is
  // why the armed sweep belongs in a disposable database only.
  await assert.rejects(pool.query('delete from candidates where id=any($1::uuid[])', [ids]), /violates foreign key constraint/);
  assert.equal((await pool.query('select count(*)::int n from candidates where id=any($1::uuid[])', [ids])).rows[0].n, 3);
  // Anchor deletes are suppressed (immutable evidence), so the people stay referenced.
  await pool.query('delete from person_audit_anchors where candidate_id=any($1::uuid[])', [ids]);
  assert.equal((await pool.query('select count(*)::int n from person_audit_anchors where candidate_id=any($1::uuid[])', [ids])).rows[0].n, 3);
  const again = await disarmAfterSweep({ ...process.env, LOCAL_DATABASE_URL: url });
  assert.equal(again.skipped, true);
});
