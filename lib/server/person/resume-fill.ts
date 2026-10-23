import { createHash } from 'node:crypto';
import { beginPersonTransaction, withPersonConnection, type PersonConnection } from './save';
import { normalizePhone as extractedPhone } from '../contact-extract';
import { normalizeEmail, stableStringify, TT_ORG_ID } from './normalize';
import { transitionSupport } from '../person-transition/context';
import { finishCertifiedContact, currentContact } from './recruiter';
import { resumeFillDocument, resumeFillPlan } from './resume-fill-evidence';
export interface LinkedResumeFillInput {
  organizationId: string; applicationId: string; candidateId: string; actorId: string; requestId: string;
  path: string; sha256: string; phone?: string | null; emails: string[]; mode: 'live' | 'shadow';
}
export async function fillLinkedResumeContactOnConnection(c: PersonConnection, a: LinkedResumeFillInput) {
  if (!transitionSupport() || a.organizationId !== TT_ORG_ID) throw Error('resume_fill_scope');
  const extracted = { phone: extractedPhone(a.phone), emails: [...new Set(a.emails.map(normalizeEmail).filter((x): x is string => !!x && x.length <= 160))].slice(0, 10) };
  const input = { applicationId: a.applicationId, candidateId: a.candidateId, actorId: a.actorId, path: a.path, sha256: a.sha256, extracted };
  const hash = createHash('sha256').update(stableStringify(input)).digest('hex');
  try {
    await beginPersonTransaction(c);
    const locked = (await c.query('select person_private.resume_fill_snapshot($1,$2,$3,$4,$5,$6) r', [a.organizationId, a.requestId, a.applicationId, a.candidateId, a.path, a.sha256])).rows[0].r;
    if (locked.status !== 'ready') { await c.query('rollback'); return null; }
    const old = (await c.query('select evidence from person_private.resume_contact_fills where id=$1', [a.requestId])).rows[0];
    if (old) {
      if (old.evidence.mode !== a.mode || stableStringify(old.evidence.input) !== stableStringify(input)) throw Error('resume_fill_replay_conflict');
      await c.query('select person_private.recruiter_begin($1,$2,$3,$4,$5,$6,$7)', [a.organizationId, a.requestId, a.candidateId, a.actorId, hash, old.evidence.requested, a.mode]);
      await c.query('commit'); return null; // A replay made no new visible changes.

    }
    const snapshot = locked.snapshot, planned = resumeFillPlan(snapshot, extracted);
    if (!planned.phone && !planned.email) { await c.query('rollback'); return null; }
    const before = (await currentContact(c, a.candidateId, a.mode)) ?? {};
    const admission = (await c.query('select person_private.resume_fill_begin($1,$2,$3,$4,$5,$6,$7,$8,$9) r', [a.organizationId, a.requestId, a.actorId, input, hash, snapshot, planned.contact, a.mode, extracted])).rows[0].r;
    if (admission.status !== 'admitted') throw Error('resume_fill_admission');
    const doc = resumeFillDocument(a.candidateId, a.requestId, new Date(admission.editedAt).toISOString(), snapshot, extracted);
    await c.query('select person_private.recruiter_seal($1,$2,$3,$4)', [a.requestId, doc, {}, JSON.stringify(doc.contacts.map(x => ({ kind: x.kind, value_normalized: x.value_normalized, existed: false, never_primary: null })))]);
    const contact = await finishCertifiedContact(c, a.requestId, a.candidateId, a.mode);
    const result = visibleFill(planned, before, contact);
    await c.query('commit'); return result;
  } catch (error) { await c.query('rollback').catch(() => {}); throw error; }
}
export const fillLinkedResumeContact = (a: LinkedResumeFillInput) => withPersonConnection(c => fillLinkedResumeContactOnConnection(c, a));

function visibleFill(planned: { phone: string | null; email: string | null }, before: any, contact: any) {
  const filled: { email?: string | null; phone?: string | null; otherEmails?: string[] } = {};
  if (planned.phone && contact.phone !== before.phone) filled.phone = contact.phone;
  if (planned.email && contact.email !== before.email) filled.email = contact.email;
  if (planned.email && stableStringify(contact.otherEmails) !== stableStringify(before.otherEmails)) filled.otherEmails = contact.otherEmails ?? [];
  return Object.keys(filled).length ? filled : null;
}
