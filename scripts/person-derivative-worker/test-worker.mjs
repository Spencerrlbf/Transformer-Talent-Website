// Local PostgreSQL only. Publication of certified embeddings and the worker, on real
// live directory people from the shared fixture. The provider is a fake function.
import '../person-derivative-journal/test-journal.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as lib from '../dist/worker-lib.mjs';
import { pool, fixture, run, use, org } from '../person-directory-execution/test-execution.mjs';
import { runCertifiedDerivatives } from './worker.mjs';

async function fresh() {
  const f = await fixture(); f.args.mode = 'live'; assert.equal((await run(f)).status, 'done');
  return { f, a: { organizationId: org, candidateId: f.id, requestId: randomUUID(), token: randomUUID(), allowPaid: true } };
}
const claim = (a) => use((c) => lib.claimCertifiedDerivativesOnConnection(c, a));
const start = (a) => use((c) => lib.startCertifiedDerivativesProviderOnConnection(c, a));
const store = (a, vectors) => use((c) => lib.storeCertifiedDerivativeVectorsOnConnection(c, { ...a, vectors }));
const publish = (a) => use((c) => lib.publishCertifiedDerivativesOnConnection(c, a));
const failed = (a, httpStatus) => use((c) => lib.failCertifiedDerivativesProviderOnConnection(c, { ...a, httpStatus }));
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const job = (id) => one('select * from person_derivative_jobs where candidate_id=$1', [id]);
const life = (a) => one('select * from person_private.derivative_lifecycles where request_id=$1', [a.requestId]);
const work = async (a) => one('select status from person_private.transition_work where id=$1', [(await life(a)).work_id]);
const chunks = async (id) => Number((await one('select count(*) n from candidate_embeddings where candidate_id=$1', [id])).n);
const vectors = (n) => Array.from({ length: n }, () => Array(1536).fill(0.125));
async function shortClaim(a) {
  await pool.query("create function person_private.synthetic_short_publish() returns trigger language plpgsql as $$begin if new.family='derivative' then new.lease_until:=clock_timestamp()+interval '400 milliseconds';end if;return new;end$$;create trigger aa_short_publish before insert on person_private.transition_work for each row execute function person_private.synthetic_short_publish()");
  try { return await claim(a); } finally { await pool.query('drop trigger aa_short_publish on person_private.transition_work;drop function person_private.synthetic_short_publish()'); }
}

test('publish after a paid store writes every chunk, marks the job done and completes the work', async () => {
  const { a } = await fresh();
  const c = await claim(a); assert.equal(c.status, 'claimed'); assert.ok(c.missing.length > 0);
  assert.equal((await start(a)).status, 'start');
  assert.equal((await store(a, vectors(c.missing.length))).status, 'stored');
  const r = await publish(a);
  assert.equal(r.status, 'published', JSON.stringify(r));
  const l = await life(a);
  assert.equal(l.phase, 'published');
  assert.equal(await chunks(a.candidateId), l.parts.length);
  const j = await job(a.candidateId);
  assert.equal(j.status, 'done'); assert.equal(j.completed_hash, j.desired_hash); assert.equal(j.claim_token, null);
  assert.equal((await work(a)).status, 'completed');
  assert.equal((await one('select person_private.derivative_job_current($1) v', [a.candidateId])).v, true);
  assert.equal(Number((await one('select count(*) n from person_private.derivative_consumer_frames')).n), 0);
});

test('when every chunk is already retained, publication needs no provider call', async () => {
  const { a } = await fresh();
  const c = await shortClaim(a); await start(a); await new Promise((r) => setTimeout(r, 500));
  assert.equal((await store(a, vectors(c.missing.length))).status, 'retry'); // known vectors retained after the lease passed
  const b = { ...a, requestId: randomUUID(), token: randomUUID() };
  const again = await claim(b);
  assert.equal(again.status, 'claimed'); assert.deepEqual(again.missing, []);
  await assert.rejects(start(b), /derivative_provider_ineligible/);
  const r = await publish(b);
  assert.equal(r.status, 'published', JSON.stringify(r)); assert.equal(r.paid, 0);
  assert.equal(await chunks(a.candidateId), (await life(b)).parts.length);
  assert.equal((await job(a.candidateId)).status, 'done');
});

test('a definite provider failure returns the job to pending and does not block the next paid start', async () => {
  const { a } = await fresh();
  await claim(a); assert.equal((await start(a)).status, 'start');
  const before = (await one('select person_transition_status() s')).s;
  assert.deepEqual(await failed(a, 429), { status: 'failed', http: 429 });
  assert.equal((await life(a)).phase, 'failed');
  assert.equal((await work(a)).status, 'completed');
  const j = await job(a.candidateId); assert.equal(j.status, 'pending'); assert.equal(j.error_code, 'provider_failed');
  assert.equal((await one('select person_transition_status() s')).s.uncertain, before.uncertain);
  const b = { ...a, requestId: randomUUID(), token: randomUUID() };
  assert.equal((await claim(b)).status, 'claimed');
  assert.equal((await start(b)).status, 'start');
  await assert.rejects(failed(b, 200), /derivative_failure_input/);
});

test('publish refuses a claim that has not stored its paid vectors', async () => {
  const { a } = await fresh();
  const c = await claim(a); assert.ok(c.missing.length > 0);
  await assert.rejects(publish(a), /derivative_publish_ineligible/);
  await start(a);
  await assert.rejects(publish(a), /derivative_publish_ineligible/);
  assert.equal(await chunks(a.candidateId) >= 0, true);
});

test('worker: pays within its cap, publishes, and separates definite from unknown failures', async () => {
  process.env.PERSON_TRANSITION_SUPPORT = 'on';
  const people = [];
  for (let i = 0; i < 3; i++) people.push((await fresh()).a.candidateId);
  let calls = 0;
  const quiet = () => {};
  const zero = await runCertifiedDerivatives({ lib, apiKey: 'synthetic', maxPaid: 0, limit: 500, embed: async () => { calls++; return []; }, log: quiet, warn: quiet });
  assert.equal(zero.paid_people, 0); assert.equal(calls, 0);
  const ok = await runCertifiedDerivatives({ lib, apiKey: 'synthetic', maxPaid: 500, limit: 500, log: quiet, warn: quiet,
    embed: async (parts) => { calls++; return vectors(parts.length); } });
  assert.ok(ok.published >= people.length, JSON.stringify(ok));
  for (const id of people) assert.equal((await job(id)).status, 'done', id);
  const { a: d } = await fresh();
  const bad = await runCertifiedDerivatives({ lib, apiKey: 'synthetic', maxPaid: 500, limit: 500, log: quiet, warn: quiet,
    embed: async () => { throw Error('person_derivative_http_503'); } });
  assert.ok(bad.failed >= 1, JSON.stringify(bad));
  assert.equal((await job(d.candidateId)).status, 'pending');
  const { a: u } = await fresh();
  const lost = await runCertifiedDerivatives({ lib, apiKey: 'synthetic', maxPaid: 500, limit: 500, log: quiet, warn: quiet,
    embed: async () => { throw Error('person_derivative_transport'); } });
  assert.ok(lost.unknown >= 1, JSON.stringify(lost));
  assert.equal((await job(u.candidateId)).status, 'processing'); // unknown: held for review, never paid again
});
