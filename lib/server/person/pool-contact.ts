// Server only. The pool person's current contact block, as the pool drawer shows
// it: the published view when there is one, else the candidate row's overlay.
//
// For an unpublished person the overlay may be empty for two different reasons:
// nobody has decided anything (then the verified history is a legitimate fallback)
// or a recruiter explicitly cleared the address (then it must stay cleared). The
// decision lives in person_recruiter_primary and is applied inside poolEmails(), the
// one ranking every surface uses, so the linked drawer, list and compose agree with
// the pool drawer, the Network list and Send.
import { publishedPoolProfiles } from "./profile-view";
import { sbRest } from "../supabase";
import { poolEmails, poolPhone, recruiterContactDecisions } from "../network";

export type PoolContact = { email: string | null; phone: string | null; github: string | null; otherEmails: string[] };
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function poolContacts(ids: string[]): Promise<Map<string, PoolContact>> {
  const out = new Map<string, PoolContact>();
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return out;
  const published = await publishedPoolProfiles(unique);
  for (const [id, p] of published) out.set(id, p.contact as PoolContact);
  const rest = unique.filter((id) => !out.has(id));
  if (rest.length) {
    const res = await sbRest(`candidates?id=in.(${rest.map((i) => `"${i}"`).join(",")})&select=id,email,phone,contact`);
    if (!res.ok) throw Error("pool_contact_unavailable");
    const rows = await res.json() as { id: string; email: string | null; phone: string | null; contact: Partial<PoolContact> | null }[];
    // Decision-aware ranking: a cleared person has no ranked emails, a chosen one leads.
    const ids = rows.map((p) => p.id);
    const [emails, decisions] = await Promise.all([
      poolEmails(ids, new Map(rows.map((p) => [p.id, p.contact?.email ?? p.email])), published, { requireComplete: true }),
      recruiterContactDecisions(ids, { requireComplete: true }),
    ]);
    for (const p of rows) {
      const ranked = emails.get(p.id) ?? [];
      // The overlay spelling leads only when the ranking admits that address.
      const overlay = str(p.contact?.email);
      const primary = overlay && ranked.some((e) => e.email.toLowerCase() === overlay.toLowerCase()) ? overlay : ranked[0]?.email ?? null;
      out.set(p.id, {
        email: primary,
        // The recruiter's phone decision, then the overlay, then the scalar.
        phone: poolPhone(decisions.get(p.id), p.contact?.phone, p.phone),
        github: str(p.contact?.github),
        otherEmails: Array.isArray(p.contact?.otherEmails) ? p.contact!.otherEmails! :
          ranked.map((e) => e.email).filter((e) => e.toLowerCase() !== (primary ?? "").toLowerCase()),
      });
    }
  }
  return out;
}
