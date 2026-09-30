import { applicationProcessing } from './application';
import type { PersonConnection } from '../person/save';
import { attributeAuditMutation, type AuditOperation } from '../person/audit';
import type { ApplicationSnapshot } from '../person/intake';

/** Caller retains the username lock from input admission through COMMIT. */
export async function applyApplicationPreferences(client: PersonConnection, audit: AuditOperation, snapshot: ApplicationSnapshot) {
  if (applicationProcessing()) {
    await client.query('select public.person_application_preferences($1)', [audit.id]);
    return;
  }
  if (snapshot.source !== 'future' || !snapshot.person_intent_hash || !snapshot.follow_up_at) return;
  const latest = (await client.query('select person_private.application_future_latest($1) latest', [snapshot.id])).rows[0].latest;
  if (!latest) return;
  await attributeAuditMutation(client, audit, { scope: 'application_preferences', table: 'candidates', rowId: audit.candidateId }, () => client.query(
    `update public.candidates set follow_up_at=$2,role_preferences=$3,visa_status=coalesce(nullif($4,''),visa_status) where id=$1 returning id`,
    [audit.candidateId, snapshot.follow_up_at, { roles: snapshot.preferred_roles ?? [], locations: snapshot.preferred_locations ?? [], workplace: snapshot.preferred_workplace ?? [], salary: snapshot.comp_expectation ?? null }, snapshot.visa_status ?? null],
  ));
}
