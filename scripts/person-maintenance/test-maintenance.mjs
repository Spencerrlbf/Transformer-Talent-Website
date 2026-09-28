// Local PostgreSQL only. Operator maintenance windows on the real runner paths:
// the historical reconcile runner (person-reconcile.mjs) and the anchor CLI
// (person-audit-anchors.mjs), with the controller armed and held.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { openAnchorDatabase } from '../person-audit/database.mjs';
import { prepareAnchors } from '../person-audit-anchors.mjs';
import * as lib from '../dist/worker-lib.mjs';
// PINNED_RUNNER_DIR: a checkout of the frozen historical runtime (c4d0e4e) with its
// worker lib built. The catch-up then runs that exact runner code, as in production.
const pinned = process.env.PINNED_RUNNER_DIR;
const from = (rel) => pinned ? import(pathToFileURL(`${pinned}/scripts/${rel}`).href) : import(`../${rel}`);
const { pgSite } = await from('person-trial.mjs');
const { reconcilePage } = await from('person-reconcile.mjs');
const runnerLib = await from('dist/worker-lib.mjs');

const url = process.env.LOCAL_DATABASE_URL;
if (!url || new URL(url).pathname !== '/person_maintenance_test' || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw Error('maintenance_test_database');
const pool = new pg.Pool({ connectionString: url, max: 4 });
const site = await pgSite(url);
const PIN = 'c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc';
const id = (n) => `ab000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = id(1), B = id(2), N = id(3); // N has a job without an employer.
const C = id(4), M = id(5), D = id(6); // Later arrivals; M has no employer.
const TT = lib.TT_ORG_ID;

const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const status = async () => (await one('select person_transition_status() r')).r;
const act = async (action) => { const s = await status(); return (await one("select person_private.transition_set($1,$2,$3,'synthetic_test') r", [action, s.revision, s.generation])).r; };
const openWindow = async (step, run, minutes = 30) => { const s = await status(); return (await one("select person_private.maintenance_open($1,$2,$3,$4,$5,'synthetic_test') r", [step, run, minutes, s.revision, s.generation])).r; };
const closeWindow = async (work) => (await one("select person_private.maintenance_close($1,'synthetic_test') r", [work])).r;
const start = (run, scope = 'all') => site.rpc('person_reconcile_start', { p_run: run, p_commit: PIN, p_limit: 100, p_batch: 100, p_resume: false, p_scope: scope, p_external_hash: '1'.repeat(32) });
const reconcile = async (run) => reconcilePage({ site, lib: runnerLib, config: { run, dry: false }, page: await site.rpc('person_reconcile_page', { p_run: run, p_size: 100 }) });
const n = async (sql, args = []) => Number((await one(sql, args)).n);
const queued = () => n('select count(*) n from person_change_queue');
const anchors = async (save = true) => {
  const db = await openAnchorDatabase({ LOCAL_DATABASE_URL: url });
  try { return await prepareAnchors({ site: db, prepare: lib.prepareLegacyAuditAnchor, options: { save, limit: 100, batch: 20, after: null, maxSeconds: 60, maxBytes: 1e12 }, onProgress: () => {} }); }
  finally { await db.end(); }
};
const arrive = async (cid, u, jobs) => pool.query(`insert into candidates(id,full_name,linkedin_username,linkedin_url,current_title,email,created_at,work_experience)
  values($1,'Synthetic Maintenance',$2::text,'https://www.linkedin.com/in/'||$2::text,'Engineer',$2::text||'@example.com','2025-02-01',$3::jsonb)`, [cid, u, JSON.stringify(jobs)]);
const job = (title, company) => ({ title, ...(company ? { company } : {}), is_current: true, start_date: { year: 2020, month: 'Jan' } });

test.after(async () => { await site.end?.(); await pool.end(); });

test('disabled: the historical catch-up RPCs behave as before and open no window', async () => {
  await pool.query(`insert into candidates(id,full_name,linkedin_username,linkedin_url,current_title,current_company,email,created_at,work_experience)
   select x.id,'Synthetic Maintenance',x.u,'https://www.linkedin.com/in/'||x.u,'Engineer','Synthetic Co',x.u||'@example.com','2025-01-01',x.w
   from (values ($1::uuid,'synthetic-maint-1',$4::jsonb),($2::uuid,'synthetic-maint-2',$4::jsonb),($3::uuid,'synthetic-maint-3',$5::jsonb)) x(id,u,w)`,
    [A, B, N, JSON.stringify([job('Engineer', 'Synthetic Co')]), JSON.stringify([job('Engineer', null)])]);
  await start('maint-baseline');
  await reconcile('maint-baseline');
  assert.equal(await n("select count(*) n from person_reconcile_people where run_id='maint-baseline' and status='verified'"), 3);
  assert.equal(await queued(), 0);
  assert.equal(await n("select count(*) n from identity_conflicts where kind='missing_employer' and $1=any(candidate_ids)", [N]), 1);
  assert.equal(await n('select count(*) n from person_private.maintenance_events'), 0);
  assert.equal(await n("select count(*) n from person_private.transition_work where family='maintenance'"), 0);
});

test('held without a window: the pinned catch-up is refused and writes nothing', async () => {
  // New arrivals after the baseline, captured for catch-up; M has a job with no employer.
  await arrive(C, 'synthetic-maint-4', [job('Engineer', 'Synthetic Co')]);
  await arrive(M, 'synthetic-maint-5', [job('Architect', null)]);
  assert.equal(await queued(), 2);
  for (const a of ['arm', 'drain', 'seal']) await act(a);
  assert.equal((await status()).phase, 'held');
  await start('maint-catchup', 'queue');
  await assert.rejects(reconcile('maint-catchup'), /maintenance_admission/);
  assert.equal(await queued(), 2);
  assert.equal(await n("select count(*) n from person_reconcile_people where run_id='maint-catchup'"), 0);
});

test('a window for another run does not admit this run', async () => {
  const w = await openWindow('catchup', 'maint-other');
  try { await assert.rejects(reconcile('maint-catchup'), /maintenance_admission/); assert.equal(await queued(), 2); }
  finally { await closeWindow(w.work_id); }
});

test('maintenance work cannot be created or changed outside open/close, and API roles cannot open windows', async () => {
  await assert.rejects(pool.query("insert into person_private.transition_work(organization_id,scope,family,resource_key,input_hash,token_hash,generation,lease_until) values($1,'tt_person','maintenance','maintenance:catchup:forged:1',repeat('a',64),md5('x'),(select generation from person_private.transition_control),now()+interval '1 hour')", [TT]), /maintenance_admission_required/);
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query('set local role service_role');
    await assert.rejects(c.query("select person_private.maintenance_open('catchup','maint-catchup',30,1,1,'synthetic_test')"), /permission denied/);
    await c.query('rollback');
    await c.query('begin'); await c.query('set local role service_role');
    const claim = (await c.query("select person_transition_claim('tt_person',$1,'maintenance','maintenance:catchup:maint-catchup:1',repeat('b',64),gen_random_uuid(),300) r", [TT])).rows[0].r;
    assert.equal(claim.status, 'held');
    await c.query('rollback');
  } finally { c.release(); }
  const s = await status();
  await assert.rejects(pool.query("select person_private.maintenance_open('publish','maint-x',30,$1,$2,'synthetic_test')", [s.revision, s.generation]), /maintenance_input/);
  await assert.rejects(pool.query("select person_private.maintenance_open('catchup','bad.run',30,$1,$2,'synthetic_test')", [s.revision, s.generation]), /maintenance_input/);
  await assert.rejects(pool.query("select person_private.maintenance_open('catchup','maint-x',30,$1,$2,'synthetic_test')", [s.revision - 1, s.generation]), /transition_stale/);
});

test('the window admits exactly the named run; raw writes, other families and reopening stay refused', async () => {
  const w = await openWindow('catchup', 'maint-catchup');
  try {
    await assert.rejects(openWindow('anchors', 'maint-anchors'), /transition_unresolved/); // one window at a time
    await assert.rejects(act('reopen'), /transition_unresolved/);
    await assert.rejects(pool.query('update person_source_holds set resolved_at=resolved_at where false'), /audit_proof_maintenance/);
    await assert.rejects(pool.query('update person_change_events set reconciled_at=reconciled_at where false'), /audit_proof_maintenance/);
    await assert.rejects(pool.query("update candidates set headline='raw' where id=$1", [B]), /candidate_mutation_frame|projection_frame/);
    await assert.rejects(pool.query("insert into identity_conflicts(kind,candidate_ids,incoming,evidence_hash) values('missing_employer',array[$1::uuid],'{}',md5('forged'))", [B]), /conflict_evidence_frame/);
    // Other families gain nothing from the window: applications must use their own admission.
    await assert.rejects(one("select person_transition_claim('tt_person',$1,'application','application:forged',repeat('c',64),gen_random_uuid(),300) r", [TT]), /application_work_required/);
    const refresh = (await one("select person_transition_claim('tt_person',$1,'refresh','refresh:forged',repeat('c',64),gen_random_uuid(),300) r", [TT]).catch((e) => ({ r: { status: e.message } }))).r;
    assert.notEqual(refresh.status, 'admitted');
    await reconcile('maint-catchup');
    assert.equal(await queued(), 0);
    assert.equal(await n("select count(*) n from person_reconcile_people where run_id='maint-catchup' and status='verified'"), 2);
    assert.equal(await n("select count(*) n from identity_conflicts where kind='missing_employer' and $1=any(candidate_ids)", [M]), 1);
    assert.equal(await n("select count(*) n from candidate_sources where candidate_id=any($1::uuid[])", [[C, M]]), 2);
    assert.equal(await n('select count(*) n from person_change_events where reconciled_at is null'), 0);
    assert.equal(await n('select count(*) n from person_private.maintenance_frames'), 0);
    assert.equal(await n('select count(*) n from person_private.maintenance_normalization_frames'), 0);
    assert.equal(await n('select count(*) n from person_private.conflict_frames'), 0);
  } finally { await closeWindow(w.work_id); }
  assert.equal((await closeWindow(w.work_id)).status, 'closed'); // idempotent
  // The gate precedes the RPC's own validation, so even an empty batch is refused.
  await assert.rejects(pool.query("select person_reconcile_record_many('maint-catchup','[]'::jsonb)"), /maintenance_admission/);
  await assert.rejects(pool.query("select person_backfill_save('maint-catchup',$1::uuid,'[]'::jsonb,0)", [A]), /maintenance_admission/);
});

test('anchors need their own window; a catch-up window does not admit them', async () => {
  await assert.rejects(anchors(), /maintenance_admission/);
  const c = await openWindow('catchup', 'maint-catchup');
  try { await assert.rejects(anchors(), /maintenance_admission/); } finally { await closeWindow(c.work_id); }
  const w = await openWindow('anchors', 'maint-anchors');
  let result;
  try { result = await anchors(); } finally { await closeWindow(w.work_id); }
  assert.equal(result.status, 'scan_complete');
  assert.equal(result.created, 5, JSON.stringify(result));
  assert.equal(await n('select count(*) n from person_audit_anchors where candidate_id=any($1::uuid[])', [[A, B, N, C, M]]), 5);
  await assert.rejects(pool.query("select person_audit_anchor_commit('[]'::jsonb)"), /maintenance_admission/);
});

test('an expired window admits nothing and still blocks reopening until closed', async () => {
  await pool.query("create function person_private.synthetic_short_maintenance() returns trigger language plpgsql as $$begin if new.family='maintenance' then new.lease_until:=clock_timestamp()+interval '300 milliseconds';end if;return new;end$$;create trigger aa_short_maintenance before insert on person_private.transition_work for each row execute function person_private.synthetic_short_maintenance()");
  let w;
  try { w = await openWindow('catchup', 'maint-expired'); }
  finally { await pool.query('drop trigger aa_short_maintenance on person_private.transition_work;drop function person_private.synthetic_short_maintenance()'); }
  await new Promise((r) => setTimeout(r, 450));
  await pool.query("update candidates set headline='Changed while held' where id=$1", [B]).catch(() => {}); // refused anyway
  await start('maint-expired', 'all');
  await assert.rejects(reconcile('maint-expired'), /maintenance_admission/);
  assert.equal((await status()).expired, 1);
  await assert.rejects(act('reopen'), /transition_unresolved/);
  await closeWindow(w.work_id);
  assert.equal((await act('reopen')).phase, 'open');
});

test('once reopened, the historical runner and anchor commits are refused', async () => {
  assert.equal((await status()).enabled, true);
  await start('maint-after-open', 'all');
  await assert.rejects(pool.query("select person_reconcile_record_many('maint-after-open','[]'::jsonb)"), /maintenance_requires_held/);
  await assert.rejects(pool.query("select person_backfill_audit_many('maint-after-open','[]'::jsonb)"), /maintenance_requires_held/);
  await assert.rejects(pool.query("select person_audit_anchor_commit('[]'::jsonb)"), /maintenance_requires_held/);
  await assert.rejects(openWindow('catchup', 'maint-after-open'), /maintenance_requires_held/);
});

test('operator history is append-only and records every open and close', async () => {
  const events = (await pool.query('select action,step,run_id from person_private.maintenance_events order by id')).rows;
  assert.equal(events.filter((e) => e.action === 'open').length, 5);
  assert.equal(events.filter((e) => e.action === 'close').length, 5);
  await assert.rejects(pool.query("update person_private.maintenance_events set reason_code='x'"), /maintenance_events_immutable/);
  await assert.rejects(pool.query('delete from person_private.maintenance_events'), /maintenance_events_immutable/);
});

test('disarming restores the unchanged disabled behavior', async () => {
  for (const a of ['drain', 'seal', 'disarm']) await act(a);
  assert.equal((await status()).enabled, false);
  await arrive(D, 'synthetic-maint-6', [job('Engineer', 'Synthetic Co')]);
  await start('maint-disarmed', 'queue');
  await reconcile('maint-disarmed');
  assert.equal(await queued(), 0);
  assert.equal(await n("select count(*) n from person_reconcile_people where run_id='maint-disarmed' and status='verified'"), 1);
});
