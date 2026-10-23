import { sbRpc } from '../supabase';
import { runApplicantPipeline } from '../applicant-pipeline';
import { transitionUuid } from './context';

type QueueSnapshot = { applications: { id: string; organization_id: string }[]; waiting: number; review_required: number };
export async function applicationQueueSnapshot(limit: number, organizations?: string[]): Promise<QueueSnapshot> {
  const result = await sbRpc<QueueSnapshot>('person_application_work_queue', { p_limit: limit, p_orgs: organizations?.length ? organizations : null });
  if (!result || !Array.isArray(result.applications) || result.applications.length > limit ||
      result.applications.some(a => !transitionUuid(a.id) || !transitionUuid(a.organization_id)) ||
      !Number.isSafeInteger(result.waiting) || result.waiting < 0 || !Number.isSafeInteger(result.review_required) || result.review_required < 0) throw Error('application_queue_response');
  return result;
}
export async function reviewApplicationWork(opts: { max: number; deadline: number; dryRun?: boolean; orgIds?: string[] }) {
  if (!Number.isInteger(opts.max) || opts.max < 1 || !Number.isFinite(opts.deadline) || opts.orgIds?.some(id => !transitionUuid(id))) throw Error('application_queue_input');
  const pending = await applicationQueueSnapshot(1000, opts.orgIds);
  let reviewed = 0, failed = 0;
  for (const application of pending.applications) {
    if (Date.now() > opts.deadline || reviewed + failed >= opts.max) break;
    if (opts.dryRun) { reviewed++; continue; }
    // Only IDs cross this boundary. The shared claim loads the retained inputs,
    // owns the allowance and verifies any resume before processing starts.
    const result = await runApplicantPipeline({ submissionId: application.id, orgId: application.organization_id,
      name: '', email: '', linkedin: '', visa: '', preferredLocations: [], roleIds: [], speculative: false,
      resumeBuf: null, resumePath: null, resumeSafeName: 'resume.pdf', boardOrg: null, applicationType: 'Applied', fromQueue: true });
    if (result === 'processed') reviewed++;
    else if (result === 'failed') failed++;
  }
  return { reviewed, failed, waiting: (await applicationQueueSnapshot(1, opts.orgIds)).waiting };
}
