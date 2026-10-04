// Server only. The pool person's current contact block, as the pool drawer shows
// it: the published view when there is one, else the candidate row's overlay.
//
// For an unpublished person the overlay may be empty for two different reasons:
// nobody has decided anything (then the verified history is a legitimate fallback)
// or a recruiter explicitly cleared the address (then it must stay cleared). The
// recruiter's decision lives in person_recruiter_primary: an absent row is "no
// preference", a row whose chosen_value is NULL is an explicit clear. Every linked
// read (drawer, list, compose) goes through here, so they agree.
import { publishedPoolProfiles } from "./profile-view";
import { sbRest } from "../supabase";
import { poolEmails } from "../network";

export type PoolContact = { email: string | null; phone: string | null; github: string | null; otherEmails: string[] };
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The recruiter's explicit email decisions for these people: present key = decided,
 * value null = cleared. A failed lookup is a failed read, never "no decision". */
async function recruiterEmailDecisions(ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).map((x) => `"${x}"`).join(",");
    const res = await sbRest(`person_recruiter_primary?candidate_id=in.(${chunk})&kind=eq.email&select=candidate_id,chosen_value`);
    if (!res.ok) throw Error("pool_contact_unavailable");
    for (const r of (await res.json()) as { candidate_id: string; chosen_value: string | null }[]) out.set(r.candidate_id, str(r.chosen_value));
  }
  return out;
}

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
    const decisions = await recruiterEmailDecisions(rows.map((p) => p.id));
    const emails = await poolEmails(rows.map((p) => p.id), new Map(rows.map((p) => [p.id, p.contact?.email ?? p.email])), published, { requireComplete: true });
    for (const p of rows) {
      const decided = decisions.has(p.id);
      const chosen = decisions.get(p.id) ?? null;
      // A decided person shows exactly the decision: the overlay's spelling of the
      // chosen address, or nothing at all. Only an undecided person falls back to
      // the scalar and the verified history.
      const primary = decided
        ? (chosen === null ? null : str(p.contact?.email) ?? chosen)
        : str(p.contact?.email) ?? emails.get(p.id)?.[0]?.email ?? null;
      const curated = Array.isArray(p.contact?.otherEmails) ? p.contact!.otherEmails! : null;
      out.set(p.id, {
        email: primary,
        phone: str(p.contact?.phone) ?? str(p.phone),
        github: str(p.contact?.github),
        otherEmails: curated ?? (decided ? [] :
          (emails.get(p.id) ?? []).map((e) => e.email).filter((e) => e.toLowerCase() !== (primary ?? "").toLowerCase())),
      });
    }
  }
  return out;
}
