import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';

Object.assign(process.env, {
  PERSON_TRANSITION_SUPPORT: 'on', PERSON_WRITE_MODE: 'shadow',
  SUPABASE_URL: 'http://contact.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic',
});
for (const key of ['OPENAI_API_KEY', 'HARVEST_API_KEY', 'RESEND_API_KEY']) delete process.env[key];
const TT = '801865a7-6533-41d2-9c45-e4a90e6ad51a';
const TENANT = 'dc000000-0000-4000-8000-000000000001';
const APP = 'dc000000-0000-4000-8000-000000000002';
const PERSON = 'dc000000-0000-4000-8000-000000000003';
let linked, org, poolResponse, poolReads;
beforeEach(() => {
  linked = true; org = TT; poolResponse = 'current'; poolReads = 0;
  process.env.PERSON_TRANSITION_SUPPORT = 'on';
});
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(String(input));
  assert.equal(u.origin, 'http://contact.invalid', 'external traffic forbidden');
  assert.equal(init.method ?? 'GET', 'GET', 'recipient selection must not write');
  if (u.pathname.endsWith('/auth/v1/user')) return Response.json({ id: PERSON, email: 'synthetic@example.test' });
  if (u.pathname.endsWith('/org_members')) return Response.json([{ member_role: 'owner', organizations: { id: org, slug: org === TT ? 'transformer-talent' : 'tenant', name: 'Synthetic' } }]);
  if (u.pathname.endsWith('/website_applications')) {
    assert.ok([null, `eq.${APP}`, `in.("${APP}")`].includes(u.searchParams.get('id')));
    if (u.searchParams.has('organization_id')) assert.equal(u.searchParams.get('organization_id'), `eq.${org}`);
    return Response.json([{ id: APP, name: 'Synthetic', email: 'submitted@example.test',
      source: 'apply', status: 'processed', created_at: '2026-09-01T00:00:00Z',
      role_ids: [], role_titles: [], matched_role_ids: [], linkedin_username: null,
      contact: { email: 'application@example.test' }, candidate_id: linked ? PERSON : null }]);
  }
  if (['candidate_emails', 'candidate_emails_v2'].includes(u.pathname.split('/').at(-1))) {
    assert.equal(u.searchParams.get('candidate_id'), `in.("${PERSON}")`);
    if (poolResponse === 'verification-unavailable') return Response.json({}, { status: 503 });
    return Response.json(poolResponse === 'verified' && u.pathname.endsWith('/candidate_emails')
      ? [{ candidate_id: PERSON, email: 'verified@example.test', email_type: 'personal', is_primary: true, quality: 'good', result: 'ok' },
        { candidate_id: PERSON, email: 'secondary@example.test', email_type: 'personal', is_primary: false, quality: 'good', result: 'ok' },
        { candidate_id: PERSON, email: 'invalid@example.test', email_type: 'personal', is_primary: false, quality: 'bad', result: 'invalid' }]
      : []);
  }
  if (!u.pathname.endsWith('/candidates')) return Response.json([]);
  assert.ok(u.pathname.endsWith('/candidates'));
  assert.equal(u.searchParams.get('id'), `in.("${PERSON}")`);
  poolReads++;
  if (poolResponse === 'network-error') throw Error('synthetic transport failure');
  if (poolResponse === 'unavailable') return Response.json({}, { status: 503 });
  if (poolResponse === 'missing') return Response.json([]);
  return Response.json([{ id: PERSON, email: null, phone: null,
    contact: { email: poolResponse === 'current' ? 'pool@example.test' : null } }]);
};
const { candidateContact, unifiedCandidateDetail, listUnifiedCandidates, readDetail } = await import('./dist/contact.mjs');
test('linked TT mail uses the current pool recipient', async () => {
  assert.deepEqual(await candidateContact(TT, `app_${APP}`), { name: 'Synthetic', email: 'pool@example.test' });
});
for (const state of ['empty', 'missing', 'unavailable', 'network-error']) {
  test(`linked TT mail never revives a submitted address when the pool contact is ${state}`, async () => {
    poolResponse = state;
    assert.deepEqual(await candidateContact(TT, `app_${APP}`), { name: 'Synthetic', email: null });
  });
}
for (const state of ['unlinked', 'tenant', 'support-off']) {
  test(`${state} mail retains application contact without a pool read`, async () => {
    if (state === 'unlinked') linked = false;
    if (state === 'tenant') org = TENANT;
    if (state === 'support-off') process.env.PERSON_TRANSITION_SUPPORT = 'off';
    assert.deepEqual(await candidateContact(org, `app_${APP}`), { name: 'Synthetic', email: 'application@example.test' });
    assert.equal(poolReads, 0);
  });
}
for (const state of ['missing', 'unavailable', 'network-error', 'verification-unavailable']) {
  test(`linked drawer refuses editable data when the pool is ${state}, while the list remains empty`, async () => {
    poolResponse = state;
    await assert.rejects(unifiedCandidateDetail(TT, `app_${APP}`), /pool_contact_unavailable/);
    const r = await readDetail({ headers: new Headers({ authorization: 'Bearer synthetic' }) }, { params: Promise.resolve({ key: `app_${APP}` }) });
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: 'temporarily_unavailable' });
    assert.equal((await listUnifiedCandidates({ orgId: TT })).items[0].contact.email, null);
  });
}
test('unpublished linked contact uses the same verified primary and secondary emails as the pool drawer', async () => {
  poolResponse = 'verified';
  const detail = await unifiedCandidateDetail(TT, `app_${APP}`);
  assert.equal(detail.contact.email, 'verified@example.test');
  assert.deepEqual(detail.contact.otherEmails, ['secondary@example.test']);
  assert.equal((await candidateContact(TT, `app_${APP}`)).email, 'verified@example.test');
  assert.equal((await listUnifiedCandidates({ orgId: TT })).items[0].contact.email, 'verified@example.test');
});
