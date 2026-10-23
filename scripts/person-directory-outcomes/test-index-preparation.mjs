// Real local PostgreSQL regression: a prepared index must not lock out writers,
// and a failed or incompatible prebuild must stop installation, never pass by name.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const url = process.env.LOCAL_DATABASE_URL;
if (!/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_directory_outcomes_test$/.test(url || ''))
  throw Error('local index fixture required');
const pool = new pg.Pool({ connectionString: url, max: 3, statement_timeout: 5000 });
after(() => pool.end());
const migration = readFileSync(new URL('../../supabase/migrations/20260927170000_person_directory_outcomes.sql', import.meta.url), 'utf8');
const runbook = readFileSync(new URL('../../docs/superpowers/plans/2026-09-26-cutover-runbook.md', import.meta.url), 'utf8');
const blocks = [...runbook.matchAll(/```sql\n([\s\S]*?)```/g)].map(m => m[1]).filter(s => s.includes('create index concurrently if not exists candidates_person_username_idx'));
assert.equal(blocks.length, 1, 'one executable index prebuild block');
const prepare = () => spawnSync(process.env.PSQL || 'psql', ['-X', '-d', url, '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: blocks[0], encoding: 'utf8', timeout: 15000 });
const clear = () => pool.query('drop index if exists public.candidates_person_username_idx');
const index = async () => (await pool.query("select indexrelid::text oid,indisvalid,indisready,indisunique from pg_index where indexrelid=to_regclass('public.candidates_person_username_idx')")).rows[0];
async function attemptMigration(check) {
  const client = await pool.connect();
  try { await client.query('begin'); await check(client); }
  finally { await client.query('rollback'); client.release(); }
}

test('valid concurrent prebuild survives retry and the migration without blocking candidate writes', async () => {
  await clear();
  assert.equal(prepare().status, 0);
  const before = await index();
  assert.equal(prepare().status, 0);
  await attemptMigration(async client => {
    await client.query(migration);
    const writer = await pool.connect();
    try {
      await writer.query('begin'); await writer.query("set local lock_timeout='250ms'");
      await writer.query('lock table public.candidates in row exclusive mode');
      assert.deepEqual(await index(), before);
    } finally { await writer.query('rollback'); writer.release(); }
  });
  await clear();
});

test('failed concurrent build is rejected by both the runbook retry and the migration', async () => {
  await clear();
  const writer = await pool.connect(), builder = await pool.connect();
  try {
    await writer.query('begin'); await writer.query('lock table public.candidates in row exclusive mode');
    const pid = (await builder.query('select pg_backend_pid() pid')).rows[0].pid;
    const building = builder.query('create index concurrently candidates_person_username_idx on public.candidates(lower(linkedin_username))').then(() => null, error => error);
    try {
      const deadline = Date.now() + 3000;
      while (!(await index()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(await index(), 'concurrent build created its catalog entry');
    } finally { await pool.query('select pg_cancel_backend($1)', [pid]); }
    assert.equal((await building)?.code, '57014', 'cancel this fixture build while it waits for the writer');
  } finally { await writer.query('rollback'); writer.release(); builder.release(); }
  try {
    assert.equal((await index()).indisvalid, false);
    assert.notEqual(prepare().status, 0, 'invalid prebuild must stop the operator');
    await attemptMigration(client => assert.rejects(client.query(migration), /candidate identity index is not ready/));
  } finally { await clear(); }
});

for (const [kind, ddl] of [
  ['wrong expression', 'create index candidates_person_username_idx on public.candidates(lower(full_name))'],
  ['unique', 'create unique index candidates_person_username_idx on public.candidates(lower(linkedin_username))'],
  ['partial', "create index candidates_person_username_idx on public.candidates(lower(linkedin_username)) where full_name='only this name'"],
]) test(`${kind} index cannot satisfy the installation prerequisite`, async () => {
  await clear(); await pool.query(ddl);
  try {
    assert.notEqual(prepare().status, 0, 'incompatible prebuild must stop the operator');
    await attemptMigration(client => assert.rejects(client.query(migration), /candidate identity index is not ready/));
  } finally { await clear(); }
});

test('fresh local installation still builds a valid nonunique index when none exists', async () => {
  await clear();
  await attemptMigration(async client => {
    await client.query(migration);
    const row = (await client.query("select indisvalid,indisready,indisunique from pg_index where indexrelid='public.candidates_person_username_idx'::regclass")).rows[0];
    assert.deepEqual(row, { indisvalid: true, indisready: true, indisunique: false });
  });
});
