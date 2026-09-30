// Local PostgreSQL only. Checked TT application edits on real processed
// applications (the shared application fixture runs its own suite first).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, TT, app, processApp, plan } from '../person-application-enrichment/test-tt-enrichment.mjs';

const edit = async (id, kind, patch, mirror = null) =>
  (await pool.query('select person_application_edit($1,$2,$3::jsonb,$4::jsonb) r', [id, kind, JSON.stringify(patch), mirror && JSON.stringify(mirror)])).rows[0].r;
const ready = async (id) => (await pool.query('select person_application_edit_ready($1) r', [id])).rows[0].r.status;
const row = async (table, id) => (await pool.query(`select * from ${table} where id=$1`, [id])).rows[0];
const control = async (action) => {
  const c = (await pool.query('select revision,generation from person_private.transition_control where singleton')).rows[0];
  await pool.query("select person_private.transition_set($1,$2,$3,'synthetic_test')", [action, c.revision, c.generation]);
};
async function processed() {
  const id = await app();
  const out = await processApp(id);
  assert.equal(out.status, 'processed', out.error?.message);
  const a = await row('website_applications', id);
  assert.ok(a.candidate_id);
  return { id, cid: a.candidate_id };
}
const frames = async () => Number((await pool.query('select (select count(*) from person_private.application_edit_frames)+(select count(*) from person_private.application_edit_mirror_frames) n')).rows[0].n);

test('linked drawer contact save uses the real live recruiter transaction and preserves submitted evidence', async () => {
  const { id, cid } = await processed(), actor = randomUUID(), requestId = randomUUID();
  const before = await row('website_applications', id);
  const priorFetch = globalThis.fetch;
  const { saveContact, candidateContact } = await import('./dist/contact.mjs');
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input));
    assert.equal(u.origin, 'http://local-only.invalid', 'outbound forbidden');
    assert.equal(init.method ?? 'GET', 'GET', 'all contact mutations must use the certified transaction');
    if (u.pathname.endsWith('/auth/v1/user')) return Response.json({ id: actor, email: 'synthetic@example.test' });
    if (u.pathname.endsWith('/org_members')) return Response.json([{ member_role: 'owner', organizations: { id: TT, slug: 'transformer-talent', name: 'Synthetic' } }]);
    assert.ok(u.pathname.endsWith('/website_applications'));
    assert.equal(u.searchParams.get('id'), `eq.${id}`);
    assert.equal(u.searchParams.get('organization_id'), `eq.${TT}`);
    return Response.json([await row('website_applications', id)]);
  };
  const contact = { email: 'recruiter-live@example.test', phone: '+12025550199', github: null, otherEmails: [] };
  const req = () => ({ headers: new Headers({ authorization: 'Bearer synthetic', 'idempotency-key': requestId }), json: async () => contact });
  const ctx = { params: Promise.resolve({ key: `app_${id}` }) };
  try {
    const response = await saveContact(req(), ctx);
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.deepEqual((await response.json()).contact, contact);
    assert.deepEqual((await row('website_applications', id)).contact, before.contact);
    assert.equal((await row('candidates', cid)).contact.email, 'recruiter-live@example.test');
    assert.equal((await candidateContact(TT, `app_${id}`)).email, 'recruiter-live@example.test');
    assert.equal((await plan(cid)).status, 'verified');
    assert.equal((await saveContact(req(), ctx)).status, 200);
    assert.equal((await pool.query('select count(*)::int n from person_recruiter_receipts where id=$1', [requestId])).rows[0].n, 1);
    await control('drain');
    const blocked = await saveContact({ headers: new Headers({ authorization: 'Bearer synthetic', 'idempotency-key': randomUUID() }), json: async () => ({ ...contact, email: 'blocked@example.test' }) }, ctx);
    assert.equal(blocked.status, 503);
    assert.equal((await row('candidates', cid)).contact.email, 'recruiter-live@example.test');
    assert.deepEqual((await row('website_applications', id)).contact, before.contact);
  } finally {
    globalThis.fetch = priorFetch;
    await pool.query("update person_private.transition_control set phase='open' where singleton");
  }
});

test('edit: a follow-up reschedule saves the application and pool person and stays audit neutral', async () => {
  const { id, cid } = await processed();
  const before = await plan(cid);
  assert.equal(before.status, 'verified', before.reason);
  await assert.rejects(pool.query("update website_applications set follow_up_at='2027-03-01' where id=$1", [id]), /application_source_fence/);
  await assert.rejects(pool.query("update candidates set follow_up_at='2027-03-01' where id=$1", [cid]), /candidate_mutation_frame|projection_frame/);
  assert.deepEqual(await edit(id, 'followup_date', { follow_up_at: '2027-03-01' }, { follow_up_at: '2027-03-01' }), { status: 'saved', changed: true, mirrored: true });
  assert.equal((await row('website_applications', id)).follow_up_at.toISOString().slice(0, 10), '2027-03-01');
  assert.equal((await row('candidates', cid)).follow_up_at.toISOString().slice(0, 10), '2027-03-01');
  const after = await plan(cid);
  assert.equal(after.status, 'verified', JSON.stringify(after));
  assert.equal(after.reason, before.reason);
  assert.equal(await frames(), 0);
  assert.deepEqual(await edit(id, 'followup_date', { follow_up_at: '2027-03-01' }, { follow_up_at: '2027-03-01' }), { status: 'saved', changed: false, mirrored: false });
});

test('edit: a full preferences edit and a clear change exactly their columns', async () => {
  const { id, cid } = await processed();
  const a0 = await row('website_applications', id), c0 = await row('candidates', cid);
  const prefs = { follow_up_at: '2027-04-01', preferred_roles: ['Engineering', 'Product'], preferred_locations: ['Remote'], preferred_workplace: ['Remote'], comp_expectation: null, visa_status: null, location: null };
  const mirror = { follow_up_at: '2027-04-01', role_preferences: { roles: prefs.preferred_roles, locations: prefs.preferred_locations, workplace: prefs.preferred_workplace, salary: null }, visa_status: null };
  assert.equal((await edit(id, 'followup', prefs, mirror)).status, 'saved');
  const a1 = await row('website_applications', id), c1 = await row('candidates', cid);
  assert.deepEqual(a1.preferred_roles, ['Engineering', 'Product']);
  assert.deepEqual(c1.role_preferences.roles, ['Engineering', 'Product']);
  for (const k of Object.keys(a0)) if (!Object.hasOwn(prefs, k)) assert.deepEqual(a1[k], a0[k], `application ${k} unchanged`);
  for (const k of Object.keys(c0)) if (!Object.hasOwn(mirror, k) && k !== 'updated_at') assert.deepEqual(c1[k], c0[k], `candidate ${k} unchanged`);
  assert.equal((await edit(id, 'followup_clear', { follow_up_at: null }, { follow_up_at: null })).status, 'saved');
  assert.equal((await row('website_applications', id)).follow_up_at, null);
  assert.equal((await row('candidates', cid)).follow_up_at, null);
});

test('edit: columns outside the kind, contact and name are refused', async () => {
  const { id } = await processed();
  for (const [kind, patch, mirror] of [
    ['followup_date', { contact: { email: 'x@example.test' } }, null],
    ['followup_date', { name: 'Changed' }, null],
    ['followup_date', { follow_up_at: '2027-05-01', role_ids: ['1'] }, null],
    ['followup_date', { follow_up_at: '2027-05-01' }, { headline: 'Changed' }],
    ['resume', { resume_path: 'x.pdf' }, { follow_up_at: null }],
    ['contact', { name: 'x' }, null], // contact kind admits only the contact column
    ['followup_date', {}, null],
    // Value shapes
    ['followup', { preferred_roles: [1] }, null],
    ['followup', { comp_expectation: { x: 1 } }, null],
    ['followup_date', { follow_up_at: 'soon' }, null],
    ['roles', { role_ids: '17', role_titles: [] }, null],
    ['resume', { resume_path: '../../outside.pdf', person_resume_sha256: 'a'.repeat(64) }, null],
    ['resume', { resume_path: `2026-09-28/${randomUUID()}-x.pdf` }, null],
    ['followup_date', { follow_up_at: '2027-05-01' }, { follow_up_at: 5 }],
    ['followup', { follow_up_at: '2027-05-01' }, { role_preferences: { roles: [1] } }],
    ['followup', { follow_up_at: '2027-05-01' }, { role_preferences: { other: [] } }],
  ]) await assert.rejects(edit(id, kind, patch, mirror), /application_edit_input/, JSON.stringify([kind, patch, mirror]));
});

test('edit: an application waits until its processing has completed', async () => {
  const id = await app();
  assert.equal(await ready(id), 'processing');
  assert.deepEqual(await edit(id, 'followup_date', { follow_up_at: '2027-06-01' }), { status: 'processing' });
  assert.equal((await row('website_applications', id)).follow_up_at.toISOString().slice(0, 10), '2027-01-01');
  assert.equal((await processApp(id)).status, 'processed');
  assert.equal(await ready(id), 'ready');
  assert.equal((await edit(id, 'followup_date', { follow_up_at: '2027-06-01' })).status, 'saved');
});

test('edit: while draining (or held: the same not-open rule) nothing is written', async () => {
  const { id } = await processed();
  await control('drain');
  assert.equal(await ready(id), 'unavailable');
  assert.deepEqual(await edit(id, 'followup_date', { follow_up_at: '2027-07-01' }), { status: 'unavailable' });
  // The shared fixture leaves unrelated unresolved work, so restore open as its own hook does.
  await pool.query("update person_private.transition_control set phase='open' where singleton");
  assert.equal((await row('website_applications', id)).follow_up_at.toISOString().slice(0, 10), '2027-01-01');
  assert.equal((await edit(id, 'followup_date', { follow_up_at: '2027-07-01' })).status, 'saved');
});

test('edit: the resume pointer and suggested roles', async () => {
  const { id } = await processed();
  const path = `2026-09-28/${randomUUID()}-recruiter-upload.pdf`;
  assert.equal((await edit(id, 'resume', { resume_path: path, person_resume_sha256: 'a'.repeat(64) })).status, 'saved');
  const r = await row('website_applications', id);
  assert.equal(r.resume_path, path);
  assert.equal(r.person_resume_sha256, 'a'.repeat(64));
  assert.equal((await edit(id, 'roles', { role_ids: ['9001'], role_titles: ['Synthetic Role (#9001)'] })).status, 'saved');
  const a = await row('website_applications', id);
  assert.deepEqual(a.role_ids, ['9001']);
  assert.deepEqual(a.role_titles, ['Synthetic Role (#9001)']);
});

test('edit: tenant rows and unknown applications are not admitted', async () => {
  const org = (await pool.query("insert into organizations(id,slug) values(gen_random_uuid(),'synthetic-tenant-'||substr(md5(random()::text),1,8)) returning id")).rows[0].id;
  const tenant = (await pool.query("insert into website_applications(organization_id,name,email,source,status) values($1,'Synthetic','t@example.test','apply','processed') returning id", [org])).rows[0].id;
  assert.deepEqual(await edit(tenant, 'followup_date', { follow_up_at: '2027-08-01' }), { status: 'not_found' });
  assert.deepEqual(await edit(randomUUID(), 'followup_date', { follow_up_at: '2027-08-01' }), { status: 'not_found' });
});

test('edit: with the controller disabled the same writes apply', async () => {
  const { id, cid } = await processed();
  await pool.query("update person_private.transition_control set enabled=false,phase='open' where singleton");
  assert.equal((await edit(id, 'followup_date', { follow_up_at: '2027-09-01' }, { follow_up_at: '2027-09-01' })).status, 'saved');
  assert.equal((await row('candidates', cid)).follow_up_at.toISOString().slice(0, 10), '2027-09-01');
});

test('edit: only the service role can execute the edit functions', async () => {
  for (const [role, expected] of [['service_role', true], ['anon', false], ['authenticated', false]]) {
    const r = (await pool.query("select has_function_privilege($1,'public.person_application_edit(uuid,text,jsonb,jsonb)','execute') e, has_function_privilege($1,'public.person_application_edit_ready(uuid)','execute') r", [role])).rows[0];
    assert.equal(r.e, expected, role); assert.equal(r.r, expected, role);
  }
  const helpers = (await pool.query("select count(*)::int n from pg_proc where pronamespace='person_private'::regnamespace and proname like 'application_edit_%' and has_function_privilege('service_role',oid,'execute')")).rows[0].n;
  assert.equal(helpers, 0);
});

test('edit: every kind keeps the person audit verified', async () => {
  const { id, cid } = await processed();
  assert.equal((await plan(cid)).status, 'verified');
  const prefs = { follow_up_at: '2027-10-01', preferred_roles: ['Design'], preferred_locations: ['NYC'], preferred_workplace: ['Hybrid'], comp_expectation: null, visa_status: null, location: null };
  assert.equal((await edit(id, 'followup', prefs, { follow_up_at: '2027-10-01', role_preferences: { roles: ['Design'], locations: ['NYC'], workplace: ['Hybrid'], salary: null }, visa_status: null })).mirrored, true);
  assert.equal((await plan(cid)).status, 'verified');
  assert.equal((await edit(id, 'resume', { resume_path: `2026-09-28/${randomUUID()}-r.pdf`, person_resume_sha256: 'b'.repeat(64) })).status, 'saved');
  assert.equal((await edit(id, 'roles', { role_ids: ['9002'], role_titles: ['Synthetic (#9002)'] })).status, 'saved');
  const after = await plan(cid);
  assert.equal(after.status, 'verified', JSON.stringify(after));
});

test('edit: only the latest future application updates the pool person', async () => {
  const username = `synthetic-edit-latest-${randomUUID()}`;
  const older = await app({ preferred_roles: ['Older'] }, username);
  assert.equal((await processApp(older)).status, 'processed');
  const newer = await app({ preferred_roles: ['Newer'], follow_up_at: '2027-02-01' }, username);
  assert.equal((await processApp(newer)).status, 'processed');
  const cid = (await row('website_applications', newer)).candidate_id;
  assert.equal((await row('website_applications', older)).candidate_id, cid);
  const before = await row('candidates', cid);
  const r = await edit(older, 'followup', { follow_up_at: '2027-11-01', preferred_roles: ['Edited older'], preferred_locations: [], preferred_workplace: [], comp_expectation: null, visa_status: null, location: null },
    { follow_up_at: '2027-11-01', role_preferences: { roles: ['Edited older'], locations: [], workplace: [], salary: null }, visa_status: null });
  assert.deepEqual(r, { status: 'saved', changed: true, mirrored: false });
  assert.deepEqual((await row('website_applications', older)).preferred_roles, ['Edited older']);
  const after = await row('candidates', cid);
  assert.deepEqual(after.role_preferences, before.role_preferences);
  assert.deepEqual(after.follow_up_at, before.follow_up_at);
  const n = await edit(newer, 'followup_date', { follow_up_at: '2027-12-01' }, { follow_up_at: '2027-12-01' });
  assert.equal(n.mirrored, true);
  assert.equal((await row('candidates', cid)).follow_up_at.toISOString().slice(0, 10), '2027-12-01');
});

test('edit: contact belongs to the pool person when linked; an unlinked application edits its own copy', async () => {
  const contact = { email: 'edited@example.test', phone: '+12025550199', github: null, otherEmails: ['other@example.test'] };
  const { id } = await processed();
  const before = (await row('website_applications', id)).contact;
  assert.deepEqual(await edit(id, 'contact', { contact }), { status: 'linked' });
  assert.deepEqual((await row('website_applications', id)).contact, before);
  await pool.query("update person_private.transition_control set enabled=false where singleton");
  const unlinked = (await pool.query("insert into website_applications(organization_id,name,email,source,status,contact) values($1,'Synthetic Unlinked','unlinked@example.test','apply','processed','{}') returning id", [TT])).rows[0].id;
  await pool.query("update person_private.transition_control set enabled=true,phase='open' where singleton");
  await assert.rejects(pool.query("update website_applications set contact=$2 where id=$1", [unlinked, JSON.stringify(contact)]), /application_source_fence|application_result_frame|application_intake|candidate_mutation/);
  assert.equal((await edit(unlinked, 'contact', { contact })).status, 'saved');
  assert.deepEqual((await row('website_applications', unlinked)).contact, contact);
  for (const bad of [{ name: 'x' }, { email: 5 }, { otherEmails: Array.from({ length: 9 }, (_, i) => `o${i}@example.test`) }, 'text'])
    await assert.rejects(edit(unlinked, 'contact', { contact: bad }), /application_edit_input/, JSON.stringify(bad));
  assert.equal(await frames(), 0);
});

const fill = async (id, phone, emails) => (await pool.query('select person_application_contact_fill($1,$2,$3::jsonb) r', [id, phone, JSON.stringify(emails)])).rows[0].r;
async function unlinkedRow(username = null) {
  await pool.query("update person_private.transition_control set enabled=false where singleton");
  try {
    return (await pool.query("insert into website_applications(organization_id,name,email,source,status,contact,linkedin_username) values($1,'Synthetic Unlinked','unlinked-fill@example.test','apply','processed',$2,$3) returning id",
      [TT, JSON.stringify({ email: 'typed@example.test', phone: null, github: null, otherEmails: [] }), username])).rows[0].id;
  } finally { await pool.query("update person_private.transition_control set enabled=true,phase='open' where singleton"); }
}

test('fill: an unlinked application fills only an empty phone and one unknown email, atomically', async () => {
  const id = await unlinkedRow();
  const r = await fill(id, '+1 202 555 0147', ['typed@example.test', 'UNLINKED-FILL@example.test', 'new@example.test']);
  assert.equal(r.status, 'saved', JSON.stringify(r));
  assert.deepEqual(r.filled, { phone: '+1 202 555 0147', otherEmails: ['new@example.test'] });
  const c = (await row('website_applications', id)).contact;
  assert.equal(c.phone, '+1 202 555 0147'); assert.deepEqual(c.otherEmails, ['new@example.test']); assert.equal(c.email, 'typed@example.test');
  assert.deepEqual(await fill(id, '+1 202 555 0199', ['new@example.test']), { status: 'unchanged' });
  assert.equal((await row('website_applications', id)).contact.phone, '+1 202 555 0147');
  for (const [phone, emails] of [['not a phone', []], [null, ['not-an-email']], [null, 'x']])
    await assert.rejects(fill(id, phone, emails), /application_edit_input/);
});

test('fill: a phone on the sourced record wins, and linked applications are never filled', async () => {
  const username = `synthetic-fill-${randomUUID()}`;
  await pool.query("insert into sourced_candidates(organization_id,linkedin_username,contact) values($1,$2,$3)", [TT, username, JSON.stringify({ phone: '+1 202 555 0100', email: 'sourced@example.test' })]);
  const id = await unlinkedRow(username);
  const r = await fill(id, '+1 202 555 0147', ['sourced@example.test']);
  assert.deepEqual(r, { status: 'unchanged' });
  const { id: linked } = await processed();
  assert.deepEqual(await fill(linked, '+1 202 555 0147', ['x@example.test']), { status: 'linked' });
});

test('unlinked resume fill preserves a normalized phone extension and the extracted email', async () => {
  const id = await unlinkedRow();
  const r = await fill(id, '+1 202 555 0147 ext 123', ['extension@example.test']);
  assert.equal(r.status, 'saved');
  assert.deepEqual(r.filled, { phone: '+1 202 555 0147 ext 123', otherEmails: ['extension@example.test'] });
  assert.equal((await row('website_applications', id)).contact.phone, '+1 202 555 0147 ext 123');
});

test('contact edit on an unlinked application with completed processing passes the result guard', async () => {
  const id = await unlinkedRow();
  // A completed processing record behind the row, so the result guard evaluates the edit frame.
  await pool.query("update person_private.transition_control set enabled=false where singleton");
  try {
    const w = (await pool.query("insert into person_private.transition_work(organization_id,scope,family,resource_key,input_hash,token_hash,generation,lease_until,status,finished_at) values($1,'tt_person','application','application:'||$2::text,repeat('e',64),md5('x'),(select generation from person_private.transition_control),now()+interval '1 hour','completed',now()) returning id", [TT, id])).rows[0].id;
    await pool.query("insert into person_private.application_work(work_id,application_id,organization_id,input_hash,input_snapshot,review_event_id) values($1,$2::uuid,$3::uuid,repeat('e',64),jsonb_build_object('id',$2::text,'organization_id',$3::text),(900000000000+floor(random()*1e9))::bigint)", [w, id, TT]);
  } finally { await pool.query("update person_private.transition_control set enabled=true,phase='open' where singleton"); }
  await assert.rejects(pool.query("update website_applications set contact=$2 where id=$1", [id, JSON.stringify({ email: 'raw@example.test' })]), /application_result_frame|application_source_fence|candidate_mutation/);
  const contact = { email: 'unlinked-edited@example.test', phone: null, github: null, otherEmails: [] };
  assert.equal((await edit(id, 'contact', { contact })).status, 'saved');
  assert.deepEqual((await row('website_applications', id)).contact, contact);
});

// A Send row built from the pool person's own record, as network.ts does.
async function sendRow(cid, job, extra = {}) {
  const c = (await pool.query('select * from candidates where id=$1', [cid])).rows[0] ?? {};
  const t = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const canonical=(await (await import('./dist/contact.mjs')).publishedPoolContactsOnConnection(pool,[cid])).get(cid);
  const email=canonical?canonical.contact.email:t(c.contact?.email)??t(c.email),phone=canonical?canonical.contact.phone:t(c.contact?.phone)??t(c.phone);
  return { organization_id: TT, name: c.full_name || 'Candidate', email: email??'', linkedin_url: c.linkedin_url ?? null, linkedin_username: c.linkedin_username ?? null,
    role_ids: [job], role_titles: [`Synthetic Role (#${job})`], status: 'processed', source: 'transformer_talent', candidate_id: cid,
    parsed_profile: { current_title: t(c.current_title), current_company: t(c.current_company), location: t(c.location) }, harvest_profile: null, screening: null,
    contact: canonical||email||phone?{email:email??null,phone:phone??null}:null, ...extra };
}
const send = async (row) => (await pool.query('select person_network_send($1::jsonb) r', [JSON.stringify(row)])).rows[0].r;

test('send: a checked Send into the TT pipeline is witnessed and leaves the person audit verified', async () => {
  const { cid } = await processed();
  assert.equal((await plan(cid)).status, 'verified');
  await assert.rejects(pool.query("insert into website_applications(organization_id,name,email,source,status,candidate_id,role_ids) values($1,'Raw','raw@example.test','transformer_talent','processed',$2,array['777'])", [TT, cid]), /application_source_fence/);
  const r = await send(await sendRow(cid, '777'));
  assert.equal(r.status, 'sent');
  const a = await row('website_applications', r.applicationId);
  assert.equal(a.candidate_id, cid); assert.equal(a.source, 'transformer_talent'); assert.deepEqual(a.role_ids, ['777']);
  assert.equal(Number((await pool.query('select count(*) n from person_private.application_send_witnesses where application_id=$1 and candidate_id=$2', [r.applicationId, cid])).rows[0].n), 1);
  const p = await plan(cid);
  assert.equal(p.status, 'verified', JSON.stringify(p));
  assert.deepEqual(await send(await sendRow(cid, '777')), { status: 'already_sent' });
  assert.equal(Number((await pool.query('select count(*) n from person_private.application_send_frames')).rows[0].n), 0);
});

test('send: waits while draining; refuses tenants, other statuses and extra columns', async () => {
  const { cid } = await processed();
  await control('drain');
  assert.deepEqual(await send(await sendRow(cid, '778')), { status: 'unavailable' });
  await pool.query("update person_private.transition_control set phase='open' where singleton");
  for (const bad of [await sendRow(cid, '779', { organization_id: randomUUID() }), await sendRow(cid, '779', { status: 'queued' }), await sendRow(cid, '779', { resume_text: 'x' }),
    await sendRow(cid, '779', { role_ids: ['779', '780'] }), await sendRow(cid, '779', { source: 'apply' })])
    await assert.rejects(send(bad), /network_send_input/, JSON.stringify(bad));
  // Content must be the pool person's own record.
  for (const bad of [await sendRow(cid, '779', { name: 'Forged Name' }), await sendRow(cid, '779', { linkedin_username: 'someone-else' }),
    await sendRow(cid, '779', { parsed_profile: { current_title: 'CEO', current_company: null, location: null } })])
    await assert.rejects(send(bad), /network_send_profile/, JSON.stringify(bad));
  assert.deepEqual(await send(await sendRow(cid, '779', { email: 'forged@example.test' })), { status: 'contact_changed' });
  assert.deepEqual(await send(await sendRow(cid, '779', { contact: { email: 'forged@example.test', phone: '+19999999999' } })), { status: 'contact_changed' });
  assert.deepEqual(await send(await sendRow(randomUUID(), '779')), { status: 'candidate_not_found' });
  const priv = (await pool.query("select has_function_privilege('service_role','public.person_network_send(jsonb,text)','execute') s, has_function_privilege('anon','public.person_network_send(jsonb,text)','execute') a")).rows[0];
  assert.equal(priv.s, true); assert.equal(priv.a, false);
});

test('send: two concurrent Sends for the same person and role create one row', async () => {
  const cid = randomUUID();
  await pool.query("update person_private.transition_control set enabled=false where singleton");
  try { await pool.query("insert into candidates(id,full_name,linkedin_username) values($1,'Synthetic No Username',null)", [cid]).catch(async () => pool.query("insert into candidates(id,full_name,linkedin_username) values($1,'Synthetic No Username',$2)", [cid, `synthetic-nouser-${cid}`])); }
  finally { await pool.query("update person_private.transition_control set enabled=true,phase='open' where singleton"); }
  const row = await sendRow(cid, '881');
  const a = await pool.connect(), b = await pool.connect();
  try {
    await a.query('begin'); await b.query('begin');
    const first = (await a.query('select person_network_send($1::jsonb) r', [JSON.stringify(row)])).rows[0].r;
    const second = b.query('select person_network_send($1::jsonb) r', [JSON.stringify(row)]);
    await new Promise((r) => setTimeout(r, 150));
    await a.query('commit');
    const r2 = (await second).rows[0].r;
    await b.query('commit');
    assert.equal(first.status, 'sent'); assert.deepEqual(r2, { status: 'already_sent' });
  } finally { a.release(); b.release(); }
  assert.equal(Number((await pool.query("select count(*) n from website_applications where candidate_id=$1 and role_ids @> array['881']", [cid])).rows[0].n), 1);
});

test('linked resume fill is certified nonmanual evidence, preserves submitted contact, and replays once', async () => {
  const id = await app();
  assert.equal((await processApp(id, { contacts: {} })).status, 'processed');
  const before = await row('website_applications', id), cid = before.candidate_id;
  const path = `2026-09-30/${randomUUID()}-resume.pdf`, sha256 = 'a'.repeat(64);
  await edit(id, 'resume', { resume_path: path, person_resume_sha256: sha256 });
  const lib = await import('./dist/contact.mjs');
  assert.equal(typeof lib.fillLinkedResumeContact, 'function', 'linked fill service is required');
  const input = { organizationId: TT, applicationId: id, candidateId: cid, actorId: randomUUID(), requestId: randomUUID(), path, sha256, phone: '+12025550147', emails: ['resume-fill@example.test'], mode: 'live' };
  const filled = await lib.fillLinkedResumeContact(input);
  assert.equal(filled?.phone, '+12025550147');
  assert.deepEqual((await row('website_applications', id)).contact, before.contact);
  const source = (await pool.query("select * from candidate_contacts where candidate_id=$1 and kind='phone'", [cid])).rows[0];
  assert.equal(source.is_manual, false); assert.equal(source.source_detail, 'application_resume');
  assert.equal(await lib.fillLinkedResumeContact(input), null);
  assert.equal((await pool.query('select count(*)::int n from person_recruiter_receipts where id=$1', [input.requestId])).rows[0].n, 1);
  const audited = await plan(cid); assert.equal(audited.status, 'verified', JSON.stringify(audited));
});

async function resumeInput({ contacts = {}, username, applicationId } = {}) {
  const id = applicationId ?? await app({}, username);
  if (!applicationId) assert.equal((await processApp(id, { contacts })).status, 'processed');
  const cid = (await row('website_applications', id)).candidate_id;
  const input = { organizationId: TT, applicationId: id, candidateId: cid, actorId: randomUUID(), requestId: randomUUID(), path: `2026-09-30/${randomUUID()}-resume.pdf`, sha256: 'b'.repeat(64), phone: '+12025550149', emails: ['new-upload@example.test'], mode: 'live' };
  await edit(id, 'resume', { resume_path: input.path, person_resume_sha256: input.sha256 });
  return input;
}

test('linked resume fill keeps recruiter choices and explicit phone clears, including absent primary rows', async () => {
  const lib = await import('./dist/contact.mjs');
  const a = await resumeInput();
  const c = await pool.connect();
  try {
    const save = await import('../dist/worker-lib.mjs');
    await save.saveRecruiterContactOnConnection(c, { organizationId: TT, candidateId: a.candidateId, actorId: a.actorId, requestId: randomUUID(), mode: 'live', contact: { email: 'preferred@example.test', phone: null, github: null, otherEmails: [] } });
  } finally { c.release(); }
  const choices = (await pool.query('select * from person_recruiter_primary where candidate_id=$1 order by kind', [a.candidateId])).rows;
  await lib.fillLinkedResumeContact(a);
  assert.deepEqual((await pool.query('select * from person_recruiter_primary where candidate_id=$1 order by kind', [a.candidateId])).rows, choices);
  assert.equal((await pool.query("select count(*)::int n from candidate_contacts where candidate_id=$1 and kind='phone'", [a.candidateId])).rows[0].n, 0);
  assert.equal((await row('candidates', a.candidateId)).contact.email, 'preferred@example.test');
  assert.equal((await plan(a.candidateId)).status, 'verified');
});

test('linked resume fill refuses replaced resumes, wrong linkage and tenant ownership; draining adds no receipt', async () => {
  const lib = await import('./dist/contact.mjs'), a = await resumeInput();
  for (const change of [{ sha256: 'c'.repeat(64) }, { path: `2026-09-30/${randomUUID()}-replacement.pdf` }, { candidateId: randomUUID() }]) assert.equal(await lib.fillLinkedResumeContact({ ...a, ...change }), null);
  const c = await pool.connect();
  try { await assert.rejects(lib.fillLinkedResumeContactOnConnection(c, { ...a, organizationId: randomUUID() }), /resume_fill_scope/); } finally { c.release(); }
  await control('drain');
  assert.equal(await lib.fillLinkedResumeContact(a), null);
  assert.equal((await pool.query('select count(*)::int n from person_recruiter_receipts where id=$1', [a.requestId])).rows[0].n, 0);
});

test('linked resume fill does not promote a claimed value from another public application', async () => {
  const username = `synthetic-resume-claimed-${randomUUID()}`;
  const first = await resumeInput({ username });
  const later = await app({ preferred_roles: ['Different'] }, username);
  assert.equal((await processApp(later, { contacts: { phone: '+12025550149' } })).status, 'processed');
  const a = await resumeInput({ applicationId: later });
  const lib = await import('./dist/contact.mjs');
  await lib.fillLinkedResumeContact({ ...a, emails: [] });
  const contacts = (await pool.query("select status,is_manual,rank from candidate_contacts where candidate_id=$1 and kind='phone'", [first.candidateId])).rows;
  assert.deepEqual(contacts, [{ status: 'claimed', is_manual: false, rank: null }]);
  assert.equal((await plan(first.candidateId)).status, 'verified');
});

test('linked resume fill rechecks concurrent recruiter saves under the candidate lock', async () => {
  const a = await resumeInput(), lib = await import('./dist/contact.mjs');
  const c = await pool.connect();
  let release, locked;
  const atLock = new Promise(r => { locked = r; }), releaseLock = new Promise(r => { release = r; });
  const save = await import('../dist/worker-lib.mjs');
  const saving = save.saveRecruiterContactOnConnection({ query: async (sql, args) => {
    const r = await c.query(sql, args);
    if (sql.includes('person_private.recruiter_begin')) { locked(); await releaseLock; }
    return r;
  } }, { organizationId: TT, candidateId: a.candidateId, actorId: a.actorId, requestId: randomUUID(), mode: 'live', contact: { email: 'concurrent@example.test', phone: '+12025550101', github: null, otherEmails: [] } });
  try {
    await atLock;
    const filling = lib.fillLinkedResumeContact({ ...a, emails: [] });
    release(); await saving;
    assert.equal(await filling, null);
    assert.equal((await row('candidates', a.candidateId)).contact.phone, '+12025550101');
    assert.equal((await plan(a.candidateId)).status, 'verified');
  } finally { release(); await saving.catch(() => {}); c.release(); }
});

test('linked resume binding is immutable and a forged manual document rolls back', async () => {
  const lib = await import('./dist/contact.mjs'), a = await resumeInput();
  const c = await pool.connect();
  try {
    for (const corrupt of [
      d => { d.contacts[0].is_manual = true; },
      d => { d.contacts[0].label = 'mobile'; },
      d => { d.contacts[0].invented_verification = true; },
      d => { delete d.contacts[0].quality; },
      d => { d.source.invented = true; },
    ]) await assert.rejects(lib.fillLinkedResumeContactOnConnection({ query: (sql, args) => {
      if (sql.includes('person_private.recruiter_seal')) { args = structuredClone(args); corrupt(args[1]); }
      return c.query(sql, args);
    } }, a), /resume_fill_contact|resume_fill_document/);
    assert.equal((await pool.query('select count(*)::int n from person_recruiter_receipts where id=$1', [a.requestId])).rows[0].n, 0);
    await lib.fillLinkedResumeContact(a);
    await assert.rejects(pool.query('delete from person_private.resume_contact_fills where id=$1', [a.requestId]), /resume_fill_immutable/);
    await assert.rejects(pool.query("update person_private.resume_contact_fills set evidence='{}' where id=$1", [a.requestId]), /resume_fill_immutable/);
    await assert.rejects(lib.fillLinkedResumeContactOnConnection(c, { ...a, phone: '+12025550111' }), /resume_fill_replay_conflict/);
    assert.equal((await plan(a.candidateId)).status, 'verified');
  } finally { c.release(); }
});

test('live resume upload route writes only certified pool contact with parser provenance', async () => {
  const a = await resumeInput(), before = await row('website_applications', a.applicationId);
  const priorFetch = globalThis.fetch, storage = [];
  const { uploadResume } = await import('./dist/contact.mjs');
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input)), method = init.method ?? 'GET';
    assert.equal(u.origin, 'http://local-only.invalid', 'outbound forbidden');
    if (u.pathname.endsWith('/auth/v1/user')) return Response.json({ id: a.actorId });
    if (u.pathname.endsWith('/org_members')) return Response.json([{ member_role: 'owner', organizations: { id: TT, slug: 'transformer-talent', name: 'Synthetic' } }]);
    if (u.pathname.endsWith('/website_applications')) {
      assert.equal(method, 'GET'); assert.equal(u.searchParams.get('id'), `eq.${a.applicationId}`); assert.equal(u.searchParams.get('organization_id'), `eq.${TT}`);
      return Response.json([await row('website_applications', a.applicationId)]);
    }
    if (u.pathname.endsWith('/person_application_edit_ready')) return Response.json({ status: await ready(a.applicationId) });
    if (u.pathname.endsWith('/person_application_edit')) {
      const b = JSON.parse(init.body); assert.equal(b.p_kind, 'resume');
      return Response.json(await edit(b.p_application, b.p_kind, b.p_patch));
    }
    if (u.pathname.startsWith('/storage/v1/object/sign/resumes/')) return Response.json({ signedURL: '/synthetic-resume' });
    if (u.pathname.startsWith('/storage/v1/object/resumes/')) { assert.equal(method, 'POST'); storage.push(u.pathname); return Response.json({}); }
    assert.fail(`unexpected sealed route: ${u.pathname}`);
  };
  try {
    const form = new FormData(); form.set('file', new File(['Synthetic Resume\nPhone: +1 202 555 0187\nnew-route@example.test'], 'resume.pdf', { type: 'application/pdf' }));
    const r = await uploadResume({ headers: new Headers({ authorization: 'Bearer synthetic' }), formData: async () => form }, { params: Promise.resolve({ key: `app_${a.applicationId}` }) });
    assert.equal(r.status, 200); const body = await r.json();
    assert.equal(body.filled?.phone, '+12025550187'); assert.equal(storage.length, 1);
    const saved = await row('website_applications', a.applicationId); assert.deepEqual(saved.contact, before.contact);
    const receipt = (await pool.query("select o.evidence->'resume_fill' e from person_audit_operations o where candidate_id=$1 and evidence ? 'resume_fill'", [a.candidateId])).rows[0].e;
    assert.equal(receipt.input.sha256, saved.person_resume_sha256); assert.equal(receipt.input.path, saved.resume_path); assert.equal(receipt.actor_id, a.actorId);
    assert.equal((await plan(a.candidateId)).status, 'verified');
  } finally { globalThis.fetch = priorFetch; }
});

async function existingResumeInput({ mode = 'shadow', contact = null, emails = [], blocked = null } = {}) {
  const cid = randomUUID(), username = `synthetic-resume-existing-${cid}`;
  await pool.query('update person_private.transition_control set enabled=false where singleton');
  try {
    await pool.query("insert into candidates(id,full_name,linkedin_username,created_at,contact) values($1,'Synthetic Existing',$2,'2020-01-01',$3)", [cid, username, contact]);
    if (blocked === 'never_primary') await pool.query("update candidates set profile_summary='Synthetic profile: blocked@example.test' where id=$1", [cid]);
    if (blocked === 'invalid') await pool.query("insert into candidate_emails(candidate_id,email_address,email_source,quality,result,created_at) values($1,'blocked@example.test','secondary','bad','invalid','2020-01-01')", [cid]);
    for (const email of emails) await pool.query("insert into candidate_emails(candidate_id,email_address,email_source,created_at) values($1,$2,'secondary','2020-01-01')", [cid, email]);
    const { prepareAuditFixture } = await import('../person-audit/local-fixture.mjs');
    await prepareAuditFixture(cid);
  } finally { await pool.query('update person_private.transition_control set enabled=true where singleton'); }
  const id = await app({}, username);
  const out = await processApp(id, { contacts: {}, mode }); assert.equal(out.status, 'processed', out.error?.message);
  const a = await resumeInput({ applicationId: id }); a.mode = mode;
  return a;
}
for (const mode of ['shadow', 'live']) test(`linked resume fills a null contact before-image in ${mode} mode`, async () => {
  const a = await existingResumeInput(), lib = await import('./dist/contact.mjs');
  assert.equal((await row('candidates', a.candidateId)).contact, null);
  const c = await pool.connect();
  let r; try { r = await lib.fillLinkedResumeContactOnConnection(c, { ...a, mode, emails: [] }); } finally { c.release(); }
  assert.equal(r?.phone, '+12025550149');
  assert.equal((await plan(a.candidateId)).status, 'verified');
});
test('linked resume preserves derived secondary emails when there is no curated overlay', async () => {
  const a = await existingResumeInput({ mode: 'live', emails: ['first@example.test', 'second@example.test'] }), lib = await import('./dist/contact.mjs');
  assert.equal((await row('candidates', a.candidateId)).contact?.otherEmails, undefined);
  const r = await lib.fillLinkedResumeContact({ ...a, phone: null, emails: ['third@example.test'] });
  assert.deepEqual(r?.otherEmails, ['second@example.test', 'third@example.test']);
  assert.equal((await plan(a.candidateId)).status, 'verified');
});
test('linked resume preserves the previous primary when a new personal address ranks first', async () => {
  const a = await existingResumeInput({ mode: 'live', emails: ['first@example.test', 'second@example.test'] }), lib = await import('./dist/contact.mjs');
  const r = await lib.fillLinkedResumeContact({ ...a, phone: null, emails: ['synthetic-resume@gmail.com'] });
  assert.equal(r?.email, 'synthetic-resume@gmail.com');
  assert.deepEqual(r?.otherEmails, ['first@example.test', 'second@example.test']);
  assert.equal((await plan(a.candidateId)).status, 'verified');
});

test('linked resume leaves invalid and never-primary evidence unchanged while admitting a new value', async () => {
  const lib = await import('./dist/contact.mjs');
  for (const blocked of ['invalid', 'never_primary']) {
    const a = await existingResumeInput({ blocked });
    const query = "select status,never_primary,is_manual,rank from candidate_contacts where candidate_id=$1 and value_normalized='blocked@example.test'";
    const before = (await pool.query(query, [a.candidateId])).rows;
    assert.equal(before.length, 1); assert.equal(before[0].rank, null);
    await lib.fillLinkedResumeContact({ ...a, mode: 'live', phone: null, emails: ['blocked@example.test', 'fresh@example.test'] });
    assert.deepEqual((await pool.query(query, [a.candidateId])).rows, before);
    assert.equal((await plan(a.candidateId)).status, 'verified');
  }
});

for (const action of ['suppress', 'alter']) test(`send witness ${action} rolls back instead of reporting sent`, async () => {
 const {cid}=await processed(), c=await pool.connect();
 try { await c.query('begin');
  await c.query(`create function pg_temp.break_send_witness() returns trigger language plpgsql as $$begin ${action==='suppress'?'return null;':"new.row_hash := 'forged'; return new;"} end$$`);
  await c.query('create trigger synthetic_send_witness before insert on person_private.application_send_witnesses for each row execute function pg_temp.break_send_witness()');
  await assert.rejects(c.query('select person_network_send($1::jsonb)',[JSON.stringify(await sendRow(cid,'995'))]), /network_send_witness/);
 } finally { await c.query('rollback'); c.release(); }
 assert.equal((await pool.query("select count(*)::int n from website_applications where candidate_id=$1 and role_ids @> array['995']",[cid])).rows[0].n,0);
});
test('send admits an unpublished verification-only address with the normal pool policy', async () => {
 const cid=randomUUID(); await pool.query('update person_private.transition_control set enabled=false where singleton');
 try {await pool.query("insert into candidates(id,full_name,linkedin_username) values($1,'Synthetic',$2)",[cid,`synthetic-send-${cid}`]);
  await pool.query("insert into candidate_emails(candidate_id,email_address,email_type,quality,result) values($1,'verified-only@example.test','personal','good','ok')",[cid]);
 }finally {await pool.query('update person_private.transition_control set enabled=true where singleton');}
 const r=await send(await sendRow(cid,'996',{email:'verified-only@example.test',contact:{email:'verified-only@example.test',phone:null}}));
 assert.equal(r.status,'sent');assert.equal((await row('website_applications',r.applicationId)).email,'verified-only@example.test');
});
test('send refuses a stale contact snapshot after a certified recruiter save', async () => {
 const {cid}=await processed();
 const old=await sendRow(cid,'997',{email:'synthetic@example.test',contact:{email:'synthetic@example.test',phone:'+12025550123'}});
 const recruiter=await import('../dist/worker-lib.mjs');
 await recruiter.saveRecruiterContact({organizationId:TT,candidateId:cid,actorId:randomUUID(),requestId:randomUUID(),mode:'live',contact:{email:'now@example.test',phone:'+12025550199',github:null,otherEmails:[]}});
 assert.deepEqual(await send(old),{status:'contact_changed'});
 assert.equal((await pool.query("select count(*)::int n from website_applications where candidate_id=$1 and role_ids @> array['997']",[cid])).rows[0].n,0);
});

test('Send waits for a racing recruiter commit and rejects its old contact snapshot',async()=>{
 const {cid}=await processed(), old=await sendRow(cid,'998'), lib=await import('../dist/worker-lib.mjs'), c=await pool.connect();
 let reached,release;const readyToCommit=new Promise(r=>reached=r),canCommit=new Promise(r=>release=r);
 const wrapped={query:async(sql,values)=>{if(sql==='commit'){reached();await canCommit;}return c.query(sql,values);}};
 const saving=lib.saveRecruiterContactOnConnection(wrapped,{organizationId:TT,candidateId:cid,actorId:randomUUID(),requestId:randomUUID(),mode:'live',contact:{email:'racing@example.test',phone:'+12025550198',github:null,otherEmails:[]}});
 let pending;
 try {await readyToCommit;let settled=false;pending=send(old).finally(()=>settled=true);await new Promise(r=>setTimeout(r,70));assert.equal(settled,false);release();await saving;assert.deepEqual(await pending,{status:'contact_changed'});}
 finally {release();await saving.catch(()=>{});if(pending)await pending.catch(()=>{});c.release();}
 assert.equal((await send(await sendRow(cid,'998'))).status,'sent');
});
test('a witnessed Send stays audit verified after a checked resume edit and linked contact fill',async()=>{
 const {cid}=await processed(),sent=await send(await sendRow(cid,'999'));
 const path=`2026-09-30/${randomUUID()}-sent.pdf`,sha256='d'.repeat(64);
 assert.equal((await edit(sent.applicationId,'resume',{resume_path:path,person_resume_sha256:sha256})).status,'saved');
 const lib=await import('./dist/contact.mjs');
 await lib.fillLinkedResumeContact({organizationId:TT,applicationId:sent.applicationId,candidateId:cid,actorId:randomUUID(),requestId:randomUUID(),path,sha256,mode:'live',phone:null,emails:['sent-fill@example.test']});
 const audit=await plan(cid);assert.equal(audit.status,'verified',JSON.stringify(audit));
});
