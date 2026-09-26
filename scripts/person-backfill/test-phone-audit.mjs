import assert from 'node:assert/strict';
import { test } from 'node:test';
import { phoneKey, knownPhones, Tally, checkStored, buildDocs } from '../person-trial.mjs';
import * as lib from '../dist/worker-lib.mjs';

test('structured non-phone text cannot become a phone by concatenating its digits', () => {
  const malformed = Array.from({ length: 23 }, (_, n) => `field: ${n % 10}`).join(', ');
  assert.equal(phoneKey(malformed), null);
  assert.equal(phoneKey('1234567890123456'), null);
  assert.equal(phoneKey('123'), null);
});

test('audit phone keys keep complete country codes and canonical formatting', () => {
  for (const value of ['(415) 555-0134', '415.555.0134 x22', '4155550134.0', '+1 415 555 0134', '0014155550134'])
    assert.equal(phoneKey(value), '+14155550134');
  assert.equal(phoneKey('+44 20 7946 0000 ext. 12'), '+442079460000');
  assert.equal(phoneKey('5550134'), '5550134');
  assert.notEqual(phoneKey('+44 1234567890'), phoneKey('+49 1234567890'));
});

test('every source phone uses the same complete key without concealing a different number', () => {
  const input = { row: { phone: '(415) 555-0134', contact: { phone: '+44 20 7946 0000' } },
    apps: [{ contact: { phone: '4155550134.0' } }],
    dir: { phones: [{ value_text: '+49 20 7946 0000' }, { number: '5550134 x9' }] } };
  assert.deepEqual([...knownPhones(input)].sort(), ['+14155550134', '+442079460000', '+492079460000', '5550134'].sort());
});

test('stored audit rejects a missing valid phone but accepts preserved invalid raw evidence', async () => {
  const id = '00000000-0000-4000-8000-00000000ff01';
  const input = { row: { id, full_name: 'Synthetic phone audit', created_at: '2020-01-01T00:00:00Z', phone: '(415) 555-0134' },
    apps: [], dir: null, ledger: [], legacy: [], v2: [], communications: [] };
  const t = { state: new Map(), sourceById: new Map(), jobs: new Map(), educations: new Map(), cskills: new Map(),
    skillById: new Map(), companyById: new Map(), contacts: new Map(), summary: new Map(), identities: new Map(), conflicts: [] };
  const inspect = async () => {
    const { docs, errors } = await buildDocs(lib, id, input);
    assert.deepEqual(errors, []);
    const tally = new Tally();
    // This focused fixture checks phone coverage, not unrelated list/state parity.
    checkStored(tally, id, input, docs, t, { project: () => ({}) });
    return { tally, docs };
  };
  assert.ok((await inspect()).tally.fail.has('phones_present'));
  t.contacts.set(id, [{ kind: 'phone', value_normalized: '+14155550134', status: 'active', rank: 1 }]);
  assert.equal((await inspect()).tally.fail.has('phones_present'), false);
  input.row.phone = Array.from({ length: 23 }, (_, n) => `field: ${n % 10}`).join(', ');
  t.contacts.set(id, []);
  const invalid = await inspect();
  assert.equal(invalid.tally.fail.has('phones_present'), false);
  assert.equal(invalid.docs[0].contacts.some(c => c.kind === 'phone'), false);
});
