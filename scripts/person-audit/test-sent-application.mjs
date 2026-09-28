// The audit rule for witnessed Network Send rows, on synthetic snapshots (no database).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sentApplication } from './evidence.mjs';
const lib = { TT_ORG_ID: '801865a7-6533-41d2-9c45-e4a90e6ad51a' };
const cid = 'aa000000-0000-4000-8000-000000000001', app = 'aa000000-0000-4000-8000-0000000000a1';
const row = { id: app, candidate_id: cid, organization_id: lib.TT_ORG_ID, source: 'transformer_talent', status: 'processed' };
const snap = (w = { application_id: app, candidate_id: cid, transaction_id: '900' }) => ({ candidate_id: cid, application_sends: w ? [w] : [] });
const event = { transaction_id: '900' };
test('a witnessed Send row from its own insert is a pipeline entry', () => assert.equal(sentApplication(snap(), row, lib, event), true));
test('no witness, or a witness from another transaction, is not', () => {
  assert.equal(sentApplication(snap(null), row, lib, event), false);
  assert.equal(sentApplication(snap(), row, lib, { transaction_id: '901' }), false);
});
test('a witness for another person, or a row moved to another person, is not', () => {
  assert.equal(sentApplication(snap({ application_id: app, candidate_id: 'aa000000-0000-4000-8000-000000000002', transaction_id: '900' }), row, lib, event), false);
  assert.equal(sentApplication(snap(), { ...row, candidate_id: 'aa000000-0000-4000-8000-000000000002' }, lib, event), false);
});
test('a changed status, source or organization is not', () => {
  for (const change of [{ status: 'queued' }, { source: 'apply' }, { organization_id: 'aa000000-0000-4000-8000-0000000000ff' }])
    assert.equal(sentApplication(snap(), { ...row, ...change }, lib, event), false, JSON.stringify(change));
});
