import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromDirectory, fromLegacyImport, project } from '../dist/worker-lib.mjs';

const id = '00000000-0000-4000-8000-000000005001';
const board = { contact_id: '00000000-0000-4000-8000-000000005002', name: 'Synthetic Person', title: 'Staff Engineer', company: 'New Example', updated_at: '2026-09-20T00:00:00Z' };
const jobs = [{ title: 'Engineer', company_name: 'Old Example', is_current: true, start_year: 2020, sort_order: 0 }];
const input = {
  jobs, educations: [], skills: [], header: { current_title: 'Staff Engineer', current_company: 'New Example' },
  header_provenance: {
    current_title: { source: 'directory', at: '2026-09-20T00:00:00Z' },
    current_company: { source: 'directory', at: '2026-09-20T00:00:00Z' }
  }, jobs_source: { source: 'legacy_import', fetched_at: '2025-10-01T00:00:00Z' }
};
test('directory title is retained without a Harvest history and asserts no lists', () => {
  const d = fromDirectory(board, null, [], [], [], [], id);
  assert.equal(d.header.current_title, 'Staff Engineer');
  assert.equal(d.header.current_company, 'New Example');
  assert.equal(d.mode, 'replace_lists');
  assert.equal(d.jobs, undefined);
  assert.equal(d.educations, undefined);
  assert.equal(d.skills, undefined);
});
test('newer title and company beat an older job-list owner without rewriting the jobs', () => {
  const p = project(input);
  assert.equal(p.current_title, 'Staff Engineer');
  assert.equal(p.current_company, 'New Example');
  assert.equal(p.work_experience[0].title, 'Engineer');
});
test('an older header does not roll back a newer job list', () => {
  const p = project({ ...input, jobs_source: { source: 'harvest', fetched_at: '2026-09-21T00:00:00Z' } });
  assert.equal(p.current_title, 'Engineer');
  assert.equal(p.current_company, 'Old Example');
});
test('a recruiter title keeps priority over an automated job refresh', () => {
  const p = project({ ...input, jobs_source: { source: 'harvest', fetched_at: '2026-09-21T00:00:00Z' }, header_provenance: { current_title: { source: 'recruiter', at: '2026-09-01T00:00:00Z' } } });
  assert.equal(p.current_title, 'Staff Engineer');
});
test('an empty header cannot blank a job title', () => {
  assert.equal(project({ ...input, header: { current_title: '  ' } }).current_title, 'Engineer');
});
test('a header-only profile retains its title and company', () => {
  const p = project({ ...input, jobs: [] });
  assert.equal(p.current_title, 'Staff Engineer');
  assert.equal(p.current_company, 'New Example');
});
test('a recruiter choice does not revive a known invalid contact', () => {
  const d = fromLegacyImport({ id, created_at: '2025-10-01T00:00:00Z', contact: { email: 'bad@example.com' } }, [
    { id: '00000000-0000-4000-8000-000000005003', email_address: 'bad@example.com', quality: 'bad', result: 'invalid', verification_date: '2026-09-20T00:00:00Z' }
  ], []);
  assert.equal(d.contacts[0].status, 'invalid');
  assert.equal(project({ jobs: [], educations: [], skills: [], contacts: d.contacts }).email, null);
});
