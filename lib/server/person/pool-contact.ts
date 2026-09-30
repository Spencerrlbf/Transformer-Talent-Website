// Server only. The pool person's current contact block, as the pool drawer shows
// it: the published view when there is one, else the candidate row's overlay.
import { publishedPoolProfiles } from "./profile-view";
import { sbRest } from "../supabase";
import { poolEmails } from "../network";

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
    const emails = await poolEmails(rows.map((p) => p.id), new Map(rows.map((p) => [p.id, p.contact?.email ?? p.email])), published, { requireComplete: true });
    for (const p of rows) {
      const primary = str(p.contact?.email) ?? emails.get(p.id)?.[0]?.email ?? null;
      out.set(p.id, {
        email: primary,
        phone: str(p.contact?.phone) ?? str(p.phone),
        github: str(p.contact?.github),
        otherEmails: Array.isArray(p.contact?.otherEmails) ? p.contact!.otherEmails! :
          (emails.get(p.id) ?? []).map((e) => e.email).filter((e) => e.toLowerCase() !== (primary ?? "").toLowerCase()),
      });
    }
  }
  return out;
}
