import { sbRpc } from '../supabase';
import { transitionSupport, transitionUuid, type TransitionAdmission } from './context';

type WorkInput = {
  scope: 'tt_person' | 'tenant_application';
  organizationId: string;
  family: 'application' | 'refresh' | 'directory' | 'derivative' | 'recruiter' | 'maintenance';
  resourceKey: string;
  inputHash: string;
  /** Keep the same server-generated UUID when retrying a lost claim response. */
  token: string;
  leaseSeconds?: number;
};
type ClaimResult = TransitionAdmission | { status: 'disabled' | 'draining' | 'held' } |
  { status: 'busy' | 'unresolved' | 'completed'; workId: string };

/** Foundation only. No production route opts in yet. A successful admission is
 * not a paid-work reservation: application integration must reserve atomically. */
export async function claimTransitionWork(input: WorkInput): Promise<ClaimResult> {
  if (!transitionSupport()) return { status: 'disabled' };
  const lease = input.leaseSeconds ?? 300;
  if (!transitionUuid(input.organizationId) || !transitionUuid(input.token) ||
      !/^[a-f0-9]{64}$/.test(input.inputHash) || !/^[a-zA-Z0-9:_-]{1,160}$/.test(input.resourceKey) ||
      !Number.isInteger(lease) || lease < 1 || lease > 900) throw Error('transition_input');
  let result: Record<string, unknown>;
  try {
    result = await sbRpc('person_transition_claim', {
      p_scope: input.scope, p_org: input.organizationId, p_family: input.family,
      p_resource: input.resourceKey, p_hash: input.inputHash, p_token: input.token, p_lease: lease,
    });
  } catch {
    // Database errors may include request material; do not surface raw responses.
    throw Error('transition_unavailable');
  }
  if (!result || typeof result !== 'object') throw Error('transition_response');
  if (result.status === 'draining' || result.status === 'held') return { status: result.status };
  if (!transitionUuid(result.work_id)) throw Error('transition_response');
  if (result.status === 'busy' || result.status === 'unresolved' || result.status === 'completed')
    return { status: result.status, workId: result.work_id };
  if (result.status !== 'admitted' || typeof result.generation !== 'number' ||
      !Number.isSafeInteger(result.generation) || result.generation < 0 ||
      typeof result.lease_until !== 'string' || !Number.isFinite(Date.parse(result.lease_until))) throw Error('transition_response');
  return { status: 'admitted', workId: result.work_id, token: input.token,
    generation: result.generation, leaseUntil: result.lease_until };
}
