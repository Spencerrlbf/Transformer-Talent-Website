// A company as the report card shows it on hover: the public facts from its
// LinkedIn page, fetched once for everyone and kept in company_context. Pure
// and client-safe: the API route maps a cached row to this shape, and the
// card matches a snapshot to a job by the company's name.

export interface CompanySnapshot {
  /** linkedin.com/company/<slug> */
  slug: string;
  linkedinUrl: string;
  name: string;
  industry: string | null;
  /** The head count as the page states it: "~183 employees" or "51-200 employees". */
  employeeRange: string | null;
  /** The head count as one integer; a range reads as its upper bound. */
  employees: number | null;
  founded: number | null;
  /** The page's tagline, else the start of its description. */
  tagline: string | null;
  /** The headquarters as the page states it: "San Francisco, California, United States". */
  hq: string | null;
  website: string | null;
  /** "Privately Held", "Public Company", ... as LinkedIn words it. */
  companyType: string | null;
  fetchedAt: string | null;
}

/** What the card knows about each company on a person's profile, keyed by
 *  companyKey(name): the snapshot when its page is on file, and the page's
 *  address when the profile carried one. */
export type CompanyLookup = Record<string, { snapshot: CompanySnapshot | null; linkedinUrl: string | null }>;

/** "VIVA AI", "Viva AI, Inc." and "viva ai" are one key. */
export function companyKey(name: string | null | undefined): string {
  return String(name || "")
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|plc|pty|sa|ag)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The slug of linkedin.com/company/<slug>, or null for anything else. */
export function companySlug(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = String(url).match(/linkedin\.com\/company\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase().replace(/\/$/, "") : null;
}

/** "startup" under 200 people, "large company" over 2,000, else nothing: the
 *  rule the facts block already applies to the current employer. */
export function sizeWord(employees: number | null | undefined): "startup" | "large company" | "" {
  if (employees == null) return "";
  return employees < 200 ? "startup" : employees > 2000 ? "large company" : "";
}

/** The most companies one request asks about. Each unknown one costs a
 *  Harvest lookup ($0.004, once ever, shared by every tenant). */
export const MAX_COMPANY_SLUGS = 12;

/** The distinct slugs to ask about, in the order given, at most `max`. */
export function slugsToAsk(urls: (string | null | undefined)[], max = MAX_COMPANY_SLUGS): string[] {
  const out: string[] = [];
  for (const u of urls) {
    const s = companySlug(u);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}
