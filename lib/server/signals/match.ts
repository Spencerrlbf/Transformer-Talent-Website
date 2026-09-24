// Matching a school or an employer on a profile against the lists, by code.
// A name matches an entry when, after normalising both, it equals the
// entry's name or an alias, or contains a multi-word name or an acronym as
// whole words. A single ordinary word ("Apple", "Brown") matches only the
// whole name, so "Apple Bank" and "Brown & Root" do not count.
import { TOP_EMPLOYERS, TOP_UNIVERSITIES, type ListEntry } from "./lists";

export interface TopMatch {
  name: string;
  tier: 1 | 2;
}

const LEGAL = /\b(inc|llc|ltd|limited|corp|corporation|plc|gmbh|pvt|pte|nv|bv|co)\b/g;
/** Trailing words that add nothing to which company it is. */
const COMPANY_TAIL = /\s+(technologies|technology|labs|lab|group|holdings|research|software|systems|company|studio|studios|global|international|worldwide|inc|llc|ltd)$/;

/** Lower case, no accents, no punctuation, no legal suffix, no leading "the". */
export function normalise(s: string): string {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(LEGAL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the\s+/, "");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isAcronym = (key: string) => /^[A-Z][A-Z0-9.&-]{1,9}$/.test(key.trim());

function keyMatches(text: string, key: string, company: boolean): boolean {
  const t = normalise(text);
  const k = normalise(key);
  if (!t || !k) return false;
  if (t === k) return true;
  // "Uber Technologies" is Uber; "Google Research" is Google.
  if (company && t.replace(COMPANY_TAIL, "") === k) return true;
  // A single ordinary word stands for the whole name, never a part of one.
  // Judged on the normalised key: "X Corp" is the one word "x" once the
  // legal suffix is gone.
  if (!k.includes(" ") && !isAcronym(key)) return false;
  return new RegExp(`(^| )${escapeRe(k)}( |$)`).test(t);
}

/** The best entry a name matches, tier 1 before tier 2, or null. */
export function matchEntry(text: string, entries: ListEntry[], company = false): TopMatch | null {
  let best: TopMatch | null = null;
  for (const e of entries) {
    if (best && best.tier <= e.tier) continue;
    for (const key of [e.name, ...(e.aliases || [])]) {
      if (keyMatches(text, key, company)) {
        best = { name: e.name, tier: e.tier };
        break;
      }
    }
    if (best?.tier === 1) break;
  }
  return best;
}

const bestOf = (names: (string | null | undefined)[], entries: ListEntry[], company: boolean): TopMatch | null => {
  let best: TopMatch | null = null;
  for (const n of names) {
    if (!n) continue;
    const m = matchEntry(n, entries, company);
    if (m && (!best || m.tier < best.tier)) best = m;
    if (best?.tier === 1) break;
  }
  return best;
};

/** The top university among the schools on a profile, or null. */
export const topUniversityOf = (schools: (string | null | undefined)[]): TopMatch | null => bestOf(schools, TOP_UNIVERSITIES, false);
/** The top employer among the companies on a profile, or null. */
export const topEmployerOf = (companies: (string | null | undefined)[]): TopMatch | null => bestOf(companies, TOP_EMPLOYERS, true);

export type TitleFamily = "engineering" | "data" | "product" | "design" | "management" | "other";

/** The families a title belongs to, from its words alone; "other" when none. */
export function titleFamilyOf(title: string | null | undefined): TitleFamily[] {
  const t = ` ${normalise(title || "")} `;
  const out: TitleFamily[] = [];
  if (/ (engineer|engineering|developer|programmer|swe|sde|architect|devops|sre|site reliability|full stack|fullstack|backend|back end|frontend|front end|mobile|ios|android|software|platform|infrastructure|systems|technical staff|mts) /.test(t)) out.push("engineering");
  if (/ (data|machine learning|ml|ai|analytics|analyst|scientist|statistician|nlp|deep learning|research) /.test(t)) out.push("data");
  if (/ (product manager|product owner|product lead|product) /.test(t) && !/ product (engineer|designer) /.test(t)) out.push("product");
  if (/ (designer|design|ux|ui) /.test(t)) out.push("design");
  if (/ (manager|director|head|vp|vice president|chief|cto|ceo|coo|cio|founder|co founder|lead|leader|principal) /.test(t)) out.push("management");
  return out.length ? out : ["other"];
}
