// The emails Transformer Talent already holds for a pool person. A public
// form can't prove who is typing, so a submission joins an existing pool
// record only when the email typed is one of these (promoteToCandidatePool
// in applicants.ts). Read-only. candidate_emails and candidate_emails_v2
// belong to other systems: a read that fails there counts as no match, so a
// failure can only keep a submission apart, never link it.
import { sbRest } from "./supabase";

/** An email as compared here: trimmed, lowercased; "" for anything else. */
export const normalEmail = (e: unknown): string => (typeof e === "string" ? e.trim().toLowerCase() : "");

/** Every address in a contact block ({ email, otherEmails: [...] }, the
 *  shape the dashboard's contact editor saves). */
export function contactEmails(contact: unknown): string[] {
  if (!contact || typeof contact !== "object" || Array.isArray(contact)) return [];
  const c = contact as { email?: unknown; otherEmails?: unknown };
  return [c.email, ...(Array.isArray(c.otherEmails) ? c.otherEmails : [])].map(normalEmail).filter(Boolean);
}

/** True when the typed email is one of the known ones (trimmed, any case). */
export function emailIsKnown(typed: string, known: unknown[]): boolean {
  const t = normalEmail(typed);
  return Boolean(t) && known.some((k) => normalEmail(k) === t);
}

async function emailsFrom(path: string): Promise<string[]> {
  try {
    const res = await sbRest(path);
    if (!res.ok) return [];
    return ((await res.json()) as { email: unknown }[]).map((r) => normalEmail(r.email)).filter(Boolean);
  } catch {
    return [];
  }
}

/** Whether `typed` is an email TT holds for pool person `candidateId`:
 *  candidates.email, any address in candidates.contact, or one of the
 *  person's rows in candidate_emails / candidate_emails_v2. `row` is the
 *  person's candidates row when the caller already read email and contact. */
export async function poolPersonHasEmail(
  candidateId: string,
  typed: string,
  row?: { email?: unknown; contact?: unknown }
): Promise<boolean> {
  if (!normalEmail(typed)) return false;
  let own = row;
  if (!own) {
    const res = await sbRest(`candidates?id=eq.${candidateId}&select=email,contact`).catch(() => null);
    [own] = res?.ok ? ((await res.json()) as { email: unknown; contact: unknown }[]) : [];
  }
  if (own && emailIsKnown(typed, [own.email, ...contactEmails(own.contact)])) return true;
  const [a, b] = await Promise.all([
    emailsFrom(`candidate_emails?candidate_id=eq.${candidateId}&select=email:email_address`),
    emailsFrom(`candidate_emails_v2?candidate_id=eq.${candidateId}&select=email:email_normalized`),
  ]);
  return emailIsKnown(typed, [...a, ...b]);
}
