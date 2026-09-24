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

const isAcronym = (key: string) => /^[A-Z][A-Z0-9.&-]{1,9}$/.test(key.trim());

/** One list, indexed: exact keys for equality, and the entries whose
 *  multi-word (or acronym) key could sit inside a longer name, by the key's
 *  first word. Built once per list. */
interface ListIndex {
  exact: Map<string, ListEntry[]>;
  byFirstWord: Map<string, { key: string; entry: ListEntry }[]>;
}
const indexes = new WeakMap<ListEntry[], ListIndex>();
function indexOf(entries: ListEntry[]): ListIndex {
  let idx = indexes.get(entries);
  if (idx) return idx;
  idx = { exact: new Map(), byFirstWord: new Map() };
  for (const entry of entries) {
    for (const raw of [entry.name, ...(entry.aliases || [])]) {
      const k = normalise(raw);
      if (!k) continue;
      const list = idx.exact.get(k) || [];
      list.push(entry);
      idx.exact.set(k, list);
      // A single ordinary word stands for the whole name, never a part of one.
      // Judged on the normalised key: "X Corp" is the one word "x" once the
      // legal suffix is gone.
      if (k.includes(" ") || (isAcronym(raw) && !entry.wholeName)) {
        const first = k.split(" ")[0];
        const list = idx.byFirstWord.get(first) || [];
        list.push({ key: k, entry });
        idx.byFirstWord.set(first, list);
      }
    }
  }
  indexes.set(entries, idx);
  return idx;
}

const better = (a: TopMatch | null, e: ListEntry): TopMatch | null => (!a || e.tier < a.tier ? { name: e.name, tier: e.tier } : a);

/** The best entry a name matches, tier 1 before tier 2, or null. A name
 *  matches an entry when, normalised, it equals the entry's name or an
 *  alias (a company also with its tail words dropped: "Uber Technologies"
 *  is Uber), or contains a multi-word name or an acronym as whole words. */
export function matchEntry(text: string, entries: ListEntry[], company = false): TopMatch | null {
  const t = normalise(text);
  if (!t) return null;
  const idx = indexOf(entries);
  let best: TopMatch | null = null;
  for (const e of idx.exact.get(t) || []) best = better(best, e);
  if (company && best?.tier !== 1) {
    const stripped = t.replace(COMPANY_TAIL, "");
    if (stripped !== t) for (const e of idx.exact.get(stripped) || []) best = better(best, e);
  }
  if (best?.tier === 1) return best;
  const words = t.split(" ");
  for (let i = 0; i < words.length; i++) {
    const candidates = idx.byFirstWord.get(words[i]);
    if (!candidates) continue;
    for (const { key, entry } of candidates) {
      if (best && entry.tier >= best.tier) continue;
      // Whole words from this position: the key, then a space or the end.
      const from = words.slice(i).join(" ");
      if (from === key || from.startsWith(key + " ")) best = better(best, entry);
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
