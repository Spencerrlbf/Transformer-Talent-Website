// Pure authenticated recruiter-upload policy, shared by writer and auditor.
// Only new values fill gaps. Existing claimed/negative values are never promoted;
// new values are active but nonmanual and unverified. Normal ranking still applies.
import { assembleDoc, emailContact, phoneContact, makeHeader, mergeContacts, normalizeEmail, normalizePhone } from './normalize';
import { effectivePoolContact, eligiblePoolContact, type PoolContact } from './contacts';
export interface ResumeFillSnapshot {
  application: { id: string; organization_id: string; candidate_id: string; resume_path: string; person_resume_sha256: string; email: string | null };
  contact: PoolContact | null;
  contacts: any[];
  choices: { kind: string; chosen_value: string | null }[];
}
export interface ResumeExtraction { phone: string | null; emails: string[] }
export function resumeFillPlan(snapshot: ResumeFillSnapshot, extracted: ResumeExtraction) {
  const before = snapshot.contact ?? {}, contact = { ...before };
  const known = new Set([normalizeEmail(snapshot.application.email), normalizeEmail(before.email), ...(before.otherEmails ?? []).map(normalizeEmail), ...snapshot.contacts.filter(x => x.kind === 'email').map(x => x.value_normalized)]);
  const phoneKey = normalizePhone(extracted.phone);
  const phone = phoneKey && !before.phone?.trim() && !snapshot.choices.some(x => x.kind === 'phone') && !snapshot.contacts.some(x => x.kind === 'phone' && (eligiblePoolContact(x) || x.value_normalized === phoneKey)) ? extracted.phone : null;
  const others = Array.isArray(before.otherEmails) ? before.otherEmails : effectivePoolContact(snapshot.contacts, before).contact.otherEmails ?? [];
  const email = others.length < 8 ? extracted.emails.find(e => !known.has(normalizeEmail(e))) ?? null : null;
  if (phone) contact.phone = phone;
  // Absence means all eligible normalized secondaries. Preserve that policy
  // across ranking changes instead of materializing a stale selection.
  if (email && Array.isArray(before.otherEmails)) contact.otherEmails = [...others, email];
  return { contact, phone, email };
}
export function resumeFillDocument(candidateId: string, requestId: string, at: string, snapshot: ResumeFillSnapshot, extracted: ResumeExtraction) {
  const plan = resumeFillPlan(snapshot, extracted);
  const fields = { status: 'active' as const, source_detail: 'application_resume' };
  return assembleDoc({ candidate_id: candidateId, mode: 'contacts_only', source: { source: 'application', provider: 'website-resume-upload', source_ref: requestId, fetched_at: at, raw_in: 'inline', enrichment_id: null }, identities: [], header: makeHeader({}), contacts: mergeContacts([phoneContact(plan.phone, fields), emailContact(plan.email, fields)]) });
}
