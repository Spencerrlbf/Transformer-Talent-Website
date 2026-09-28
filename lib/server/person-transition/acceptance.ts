import { createHash } from 'node:crypto';
import { sbInsert, sbRpc } from '../supabase';
import { transitionSupport, transitionUuid } from './context';
import { TT_ORG_ID } from '../person/normalize';

/** Semantic intent identity excludes generated IDs, clocks and object paths.
 * New preferences produce new evidence; identical retries share one intent. */
export function futureIntentHash(row: Record<string, unknown>): string {
  const intent: Record<string, unknown> = { version: 1, kind: 'future' };
  for (const key of ['organization_id','linkedin_username','email','follow_up_at','comp_expectation','visa_status','recruiter_profile_id','person_resume_sha256']) intent[key] = row[key] ?? null;
  for (const key of ['preferred_roles','preferred_locations','preferred_workplace']) {
    const values = row[key];
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw Error('application_intent_input');
    intent[key] = [...new Set(values)].sort();
  }
  return createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}
/** Compatibility wrapper: only the database creates processing authority. */
export async function acceptPublicApplication(kind: 'apply' | 'referral' | 'future', row: Record<string, unknown>): Promise<{ id: string } | null> {
  if (!transitionSupport()) return sbInsert<{ id: string }>('website_applications', row, true);
  const { status, resume_text, person_processing_version, ...input } = row;
  if (status !== 'queued' || resume_text !== null || person_processing_version !== 1) throw Error('application_accept_input');
  let response: { inserted?: unknown; id?: unknown };
  try { response = await sbRpc('person_application_accept', { p_kind: kind, p_input: input }); }
  catch { throw Error('application_storage_unavailable'); }
  if (response?.inserted === true && transitionUuid(response.id)) return { id: response.id };
  if (kind === 'future' && response?.inserted === false && response.id === null) return null;
  throw Error('application_storage_response');
}
export async function insertFutureIntent(row: Record<string, unknown>): Promise<{ id: string } | null> {
  return acceptPublicApplication('future', row);
}
/** Editor preflight only. The database still refuses a racing unchecked write.
 * Missing schema/status with support on is retryable; no storage/mirror follows. */
export async function applicationEditsPaused(orgId: string): Promise<boolean> {
  if (!transitionSupport() || orgId !== TT_ORG_ID) return false;
  try {
    const status = await sbRpc<{ enabled?: unknown }>('person_transition_status', {});
    return status?.enabled !== false;
  } catch { return true; }
}

export type ApplicationEditKind = 'followup' | 'followup_date' | 'followup_clear' | 'resume' | 'roles' | 'contact';
export type CheckedEditResult = { ok: true; mirrored: boolean } | { ok: false; error: 'temporarily_unavailable' | 'not_found' };
/** TT application rows are edited through the checked function whenever support is on. */
export function applicationEditsChecked(orgId: string): boolean {
  return transitionSupport() && orgId === TT_ORG_ID;
}
/** One atomic checked edit: the application columns for `kind`, and the pool
 * person's follow-up mirror when given. It waits while the application is still
 * processing or the transition is draining/held (retryable). */
export async function checkedApplicationEdit(applicationId: string, kind: ApplicationEditKind,
  patch: Record<string, unknown>, mirror: Record<string, unknown> | null = null): Promise<CheckedEditResult> {
  if (!transitionUuid(applicationId)) return { ok: false, error: 'not_found' };
  let r: { status?: unknown; mirrored?: unknown };
  // A missing function (support on before the migration) or a transient failure is retryable.
  try { r = await sbRpc('person_application_edit', { p_application: applicationId, p_kind: kind, p_patch: patch, p_mirror: mirror }); }
  catch (error) { console.error('checked application edit failed', (error as Error).message?.slice(0, 120)); return { ok: false, error: 'temporarily_unavailable' }; }
  if (r?.status === 'saved') return { ok: true, mirrored: r.mirrored === true };
  if (r?.status === 'not_found') return { ok: false, error: 'not_found' };
  return { ok: false, error: 'temporarily_unavailable' };
}
/** Preflight before side effects such as a storage upload. */
export async function applicationEditReady(applicationId: string): Promise<boolean> {
  if (!transitionUuid(applicationId)) return false;
  try { return (await sbRpc<{ status?: unknown }>('person_application_edit_ready', { p_application: applicationId }))?.status === 'ready'; }
  catch { return false; }
}
