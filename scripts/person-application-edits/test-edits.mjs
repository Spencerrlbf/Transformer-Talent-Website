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
