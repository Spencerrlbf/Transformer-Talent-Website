import { createHash } from 'node:crypto';
import { sbRest } from '../supabase';

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
export async function insertFutureIntent(row: Record<string, unknown>): Promise<{ id: string } | null> {
  const response = await sbRest('website_applications?on_conflict=organization_id,linkedin_username,person_intent_hash', {
    method: 'POST', body: JSON.stringify({ ...row, person_intent_hash: futureIntentHash(row) }),
    prefer: 'return=representation,resolution=ignore-duplicates',
  });
  if (!response.ok) throw Error('application_storage_unavailable');
  const rows = await response.json();
  if (!Array.isArray(rows)) throw Error('application_storage_response');
  return rows[0] ?? null;
}
