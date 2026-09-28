// No database. The hourly entry point's configuration and skip rules, and the real
// CLI run with every network call refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { derivativeDailyCap, main } from '../derivative-worker.mjs';

const quiet = () => {};
const never = async () => { throw Error('lib_must_not_load'); };

test('the daily cap defaults to 200 and accepts integers 0..10000 only', () => {
  assert.equal(derivativeDailyCap(undefined), 200);
  assert.equal(derivativeDailyCap(''), 200);
  assert.equal(derivativeDailyCap('0'), 0);
  assert.equal(derivativeDailyCap('10000'), 10000);
  for (const bad of ['5x', '-1', '10001', '1.5', ' 7', '1e3']) assert.throws(() => derivativeDailyCap(bad), /derivative_worker_configuration:DERIVATIVE_DAILY_CAP/, bad);
});

test('off, shadow or legacy exits without loading the library or the worker', async () => {
  for (const env of [{}, { PERSON_TRANSITION_SUPPORT: 'off', PERSON_WRITE_MODE: 'live' }, { PERSON_TRANSITION_SUPPORT: 'on', PERSON_WRITE_MODE: 'shadow' }, { PERSON_TRANSITION_SUPPORT: 'on', PERSON_WRITE_MODE: 'legacy' }])
    assert.equal(await main({ ...env, OPENAI_API_KEY: 'synthetic' }, { importLib: never, log: quiet }), null, JSON.stringify(env));
});

test('a bad cap fails even when the new path is off', async () => {
  await assert.rejects(main({ DERIVATIVE_DAILY_CAP: '5x' }, { importLib: never, log: quiet }), /DERIVATIVE_DAILY_CAP/);
});

test('live with support on and no OpenAI key fails before loading the library', async () => {
  await assert.rejects(main({ PERSON_TRANSITION_SUPPORT: 'on', PERSON_WRITE_MODE: 'live' }, { importLib: never, log: quiet }), /OPENAI_API_KEY/);
});

const cli = (env) => spawnSync(process.execPath, ['--import', './scripts/person-directory-input/no-network.mjs', 'scripts/derivative-worker.mjs'], { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, ...env } });

test('the real CLI rejects a malformed cap with no network effect', () => {
  const out = cli({ PERSON_TRANSITION_SUPPORT: 'on', PERSON_WRITE_MODE: 'live', OPENAI_API_KEY: 'synthetic', DERIVATIVE_DAILY_CAP: '2x' });
  assert.equal(out.status, 1); assert.match(out.stderr, /derivative_worker_configuration/); assert.doesNotMatch(out.stderr + out.stdout, /unexpected_network_effect/);
});

test('the real CLI skips cleanly while the repository is on the old path', () => {
  const out = cli({ PERSON_TRANSITION_SUPPORT: 'off', PERSON_WRITE_MODE: 'legacy' });
  assert.equal(out.status, 0, out.stderr); assert.match(out.stdout, /derivative_worker_skipped/); assert.doesNotMatch(out.stderr + out.stdout, /unexpected_network_effect/);
});
