import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { sbRest, sbRpc } from '../supabase';
import { TT_ORG_ID } from '../person/normalize';
import { personWriteMode } from '../person/intake';
import { transitionUuid, withTransitionWork, type TransitionAdmission } from './context';
import type { ApplicantPipelineInput } from '../applicant-pipeline';

type Outcome = 'processed' | 'queued' | 'failed';
type Snapshot = Record<string, unknown> & { id: string; organization_id: string };
export type ApplicationResult = {
  version: 1; matched_role_ids: string[]; screening: unknown;
  name?: string; harvest_profile?: unknown; parsed_profile?: unknown; resume_text?: string | null;
  resume_contacts?: { phone: string | null; emails: string[] };
};
type Runtime = { admission: TransitionAdmission; snapshot: Snapshot; started: boolean; result?: ApplicationResult };
const processing = new AsyncLocalStorage<Runtime>();
const MAX_RESUME = 8 * 1024 * 1024;
class AlreadyStarted extends Error {}
class InputReview extends Error { constructor(readonly reason: 'resume_content_mismatch' | 'resume_input_invalid') { super(reason); } }
export const applicationProcessing = () => Boolean(processing.getStore());
/** Computation is staged once; only the final checked RPC may persist it. */
export function stageApplicationResult(result: ApplicationResult): void {
  const runtime = processing.getStore();
  if (!runtime?.started || runtime.result) throw Error('application_result_stage');
  runtime.result = JSON.parse(JSON.stringify(result)) as ApplicationResult;
}
export function acceptedApplicationInput(applicationId: string, organizationId: string): Snapshot | null {
  const s = processing.getStore()?.snapshot;
  if (!s) return null;
  if (s.id !== applicationId || s.organization_id !== organizationId) throw Error('application_scope');
  return s;
}
/** Source helpers may derive authority from context only for this accepted identity. */
export function assertApplicationIdentity(organizationId: string, username: string): void {
  const s = processing.getStore()?.snapshot;
  if (!s || s.organization_id !== organizationId || s.linkedin_username !== username) throw Error('application_scope');
}
/** Freeze the tenant verdict identity before any candidate-keyed side effects. */
export async function bindTenantApplicationPerson(orgId: string, username: string | null, applicationId: string): Promise<string> {
  const runtime = processing.getStore();
  if (!runtime || !runtime.started || orgId === TT_ORG_ID || runtime.snapshot.organization_id !== orgId ||
      runtime.snapshot.id !== applicationId || (runtime.snapshot.linkedin_username || null) !== username) throw Error('application_scope');
  const result = await sbRpc<Record<string, unknown>>('person_application_tenant_bind', {});
  if (!result || result.work_id !== runtime.admission.workId || result.application_id !== applicationId ||
      result.organization_id !== orgId || !transitionUuid(result.person_key)) throw Error('tenant_binding_response');
  return result.person_key;
}
async function lifecycle(fn: string, runtime: Runtime, args: Record<string, unknown> = {}) {
  let result: Record<string, unknown>;
  try { result = await sbRpc(fn, { p_id: runtime.admission.workId, p_token: runtime.admission.token, ...args }); }
  catch { throw Error('application_work_unavailable'); }
  if (!result || result.work_id !== runtime.admission.workId) throw Error('application_work_response');
  return result;
}
/** Called at the first effectful pipeline boundary, after read-only setup. */
export async function startApplicationEffects(): Promise<void> {
  const runtime = processing.getStore();
  if (!runtime || runtime.started) return;
  const result = await lifecycle('person_application_work_start', runtime);
  if (result.status === 'already_started') throw new AlreadyStarted();
  if (result.status !== 'started') throw Error('application_work_response');
  runtime.started = true;
}
export async function renewApplicationWork(): Promise<void> {
  const runtime = processing.getStore();
  if (!runtime) return;
  if (!runtime.started) throw Error('application_effects_required');
  const result = await lifecycle('person_transition_renew', runtime, { p_lease: 900 });
  if (result.status !== 'admitted' || typeof result.lease_until !== 'string' || !Number.isFinite(Date.parse(result.lease_until))) throw Error('application_work_response');
}
function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw Error('application_input');
  return value;
}
function strings(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some(x => typeof x !== 'string')) throw Error('application_input');
  return [...value];
}
async function resumeBytes(s: Snapshot, p: ApplicantPipelineInput): Promise<Buffer | null> {
  const path = stringValue(s.resume_path), hash = stringValue(s.person_resume_sha256);
  if (!path && !hash) return null;
  if (!path || !/^[a-f0-9]{64}$/.test(hash) || path.split('/').some(x => !x || x === '.' || x === '..')) throw new InputReview('resume_input_invalid');
  let bytes = p.resumePath === path ? p.resumeBuf : null;
  if (!bytes) {
    const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !key) throw Error('application_resume_unavailable');
    const response = await fetch(`${base}/storage/v1/object/resumes/${path.split('/').map(encodeURIComponent).join('/')}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || !response.body) throw Error('application_resume_unavailable');
    if (Number(response.headers.get('content-length') || 0) > MAX_RESUME) { await response.body.cancel().catch(() => {}); throw new InputReview('resume_content_mismatch'); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength;
        if (length > MAX_RESUME) throw new InputReview('resume_content_mismatch'); chunks.push(chunk.value); }
      bytes = Buffer.concat(chunks, length);
    } finally { await reader.cancel().catch(() => {}); }
  }
  if (bytes.length > MAX_RESUME || createHash('sha256').update(bytes).digest('hex') !== hash) throw new InputReview('resume_content_mismatch');
  return bytes;
}
async function retainedInput(s: Snapshot, p: ApplicantPipelineInput): Promise<ApplicantPipelineInput> {
  const resumeBuf = await resumeBytes(s, p), roleIds = strings(s.role_ids), source = stringValue(s.source);
  const referral = source.startsWith('referral:'), future = source === 'future';
  let boardOrg: ApplicantPipelineInput['boardOrg'] = null;
  if (s.organization_id !== TT_ORG_ID) {
    const response = await sbRest(`organizations?id=eq.${s.organization_id}&select=id,slug,name`);
    if (!response.ok) throw Error('application_organization_unavailable');
    const [row] = await response.json();
    if (!row || row.id !== s.organization_id || typeof row.slug !== 'string' || typeof row.name !== 'string') throw Error('application_organization_unavailable');
    boardOrg = { id: row.id, slug: row.slug, name: row.name };
  }
  const speculative = !referral && (future || source.startsWith('speculative') || !roleIds.length);
  return { submissionId: s.id, orgId: s.organization_id, boardOrg, name: stringValue(s.name), email: stringValue(s.email),
    linkedin: stringValue(s.linkedin_url), visa: stringValue(s.visa_status), preferredLocations: strings(s.preferred_locations),
    roleIds, speculative, applicationType: referral ? 'Referral' : speculative ? 'Speculative' : 'Applied',
    resumeBuf, resumePath: stringValue(s.resume_path) || null, resumeSafeName: (stringValue(s.resume_path).split('/').at(-1) || 'resume.pdf'),
    followUpAt: future ? stringValue(s.follow_up_at) || null : null, preferredRoles: future ? strings(s.preferred_roles) : [],
    preferredWorkplace: future ? strings(s.preferred_workplace) : [], salaryFloor: future ? stringValue(s.comp_expectation) || null : null,
    // Reservation comes exclusively from the RPC above. This flag only prevents
    // the legacy internal budget/notification path from repeating those actions.
    fromQueue: true };
}
/** Shared by public callbacks and queue workers. No effect precedes admission. */
export async function runApplicationWork(p: ApplicantPipelineInput, process: (input: ApplicantPipelineInput) => Promise<Outcome>): Promise<Outcome> {
  let runtime: Runtime | undefined;
  try {
    const org = p.boardOrg?.id ?? p.orgId ?? TT_ORG_ID;
    if (!transitionUuid(org) || !transitionUuid(p.submissionId)) throw Error('application_input');
    if (org === TT_ORG_ID && personWriteMode() === 'legacy') throw Error('application_writer_configuration');
    const token = randomUUID();
    const result = await sbRpc<Record<string, unknown>>('person_application_work_claim', { p_application: p.submissionId, p_org: org, p_token: token, p_lease: 900 });
    if (!result || typeof result !== 'object') throw Error('application_work_response');
    if (['held','draining','budget','input_review','ineligible'].includes(String(result.status))) return 'queued';
    if (['busy','unresolved','completed'].includes(String(result.status))) {
      if (!transitionUuid(result.work_id)) throw Error('application_work_response');
      return result.status === 'completed' ? 'processed' : 'queued';
    }
    const s = result.snapshot as Snapshot;
    if (result.status !== 'admitted' || !transitionUuid(result.work_id) || result.review_reserved !== true ||
        typeof result.input_hash !== 'string' || !/^[a-f0-9]{64}$/.test(result.input_hash) ||
        typeof result.generation !== 'number' || !Number.isSafeInteger(result.generation) || result.generation < 0 ||
        typeof result.lease_until !== 'string' || !Number.isFinite(Date.parse(result.lease_until)) ||
        !s || s.id !== p.submissionId || s.organization_id !== org || s.input_version !== 1) throw Error('application_work_response');
    runtime = { admission: { status: 'admitted', workId: result.work_id, token, generation: result.generation, leaseUntil: result.lease_until }, snapshot: s, started: false };
    const active = runtime;
    return await withTransitionWork(active.admission, () => processing.run(active, async (): Promise<Outcome> => {
      const retained = await retainedInput(active.snapshot, p);
      const outcome = await process(retained);
      if (outcome !== 'processed' || !active.started || !active.result) throw Error('application_processing_incomplete');
      await renewApplicationWork();
      const completed = await sbRpc<Record<string, unknown>>('person_application_work_complete', { p_result: active.result });
      if (!completed || completed.status !== 'completed' || completed.work_id !== active.admission.workId) throw Error('application_work_response');
      return 'processed';
    }));
  } catch (error) {
    if (error instanceof AlreadyStarted) return 'queued';
    // Operators need the reason; only identifier-like codes are logged, never values.
    {
      const e = error as { message?: unknown; code?: unknown; name?: unknown };
      const safe = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_:.\-]{1,100}$/.test(v) ? v : null);
      console.error(JSON.stringify({ phase: 'application_work_stopped', started: runtime?.started ?? false,
        reason: safe(e?.message) ?? safe(e?.code) ?? 'unlabelled', code: safe(e?.code), name: safe(e?.name) }));
    }
    if (runtime) {
      try {
        if (runtime.started) await lifecycle('person_application_work_finish', runtime, { p_outcome: 'uncertain' });
        else if (error instanceof InputReview) await lifecycle('person_application_work_review', runtime, { p_reason: error.reason });
        else await lifecycle('person_application_work_defer', runtime, { p_delay: 60 });
      } catch { /* Expired/lost-start work stays unresolved; never replay effects. */ }
      return runtime.started ? 'failed' : 'queued';
    }
    return 'failed';
  }
}
