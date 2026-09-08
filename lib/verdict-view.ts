// The verdict as the product shows it: an action label, one paragraph, and a
// technologies strip. Shared by server (writes it) and client (renders it).
// Stored as jsonb with v: 2 so older rows keep rendering the old way.

export type VerdictLabel = "contact" | "message" | "pass";

export const VERDICT_LABEL: Record<VerdictLabel, string> = {
  contact: "Contact now",
  message: "Worth a message",
  pass: "Pass",
};

/** dash-tag class per label. */
export const VERDICT_CLASS: Record<VerdictLabel, string> = {
  contact: "t-contact",
  message: "t-message",
  pass: "t-pass",
};

export type ChipStatus = "met" | "equivalent" | "plain" | "gap";

export interface TechChip {
  name: string;
  /** Dated career years with this technology, when the positions say. */
  years: number | null;
  status: ChipStatus;
  /** What decided the status, for the tooltip ("pgvector", "Ruby, 6y at Stripe"). */
  evidence?: string;
}

export interface RequirementRead {
  requirement: string;
  status: "met" | "equivalent" | "missing";
  evidence: string;
}

export interface VerdictView {
  v: 2;
  label: VerdictLabel;
  paragraph: string;
  missing: string[];
  ask: string[];
  betterSuited: string;
  requirements: RequirementRead[];
  tech: {
    now: TechChip[];
    before: TechChip[];
    /** Requirements with no evidence on the profile or resume. */
    gaps: string[];
    nowPosition?: string | null;
  };
  model: string;
  at: string;
}

export const isVerdictView = (x: unknown): x is VerdictView =>
  !!x && typeof x === "object" && (x as { v?: unknown }).v === 2 && typeof (x as { paragraph?: unknown }).paragraph === "string";

/** Sentences of the paragraph. A boundary is . ! or ? followed by whitespace
 *  or the end, so "4.1 years" and "e.g." never split a sentence in two. */
// Abbreviations that never end a sentence in recruiter prose.
const ABBR_ALWAYS = /(^|[^a-z])(sr|jr|dr|mr|mrs|ms|st|ph\.d|b\.s|m\.s|b\.sc|m\.sc|u\.s|u\.k|e\.g|i\.e|vs|approx)\.$/i;
// Abbreviations that may end a sentence: split only when a capital follows.
const ABBR_SOFT = /(^|[^a-z])(etc|inc|ltd|co|corp)\.$/i;
// "Sherman L." and "M.S." style initials.
const INITIAL = /(^|[\s(])(?:[A-Z]\.|(?:[A-Za-z]\.){2,})$/;

export function sentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ch === "." || ch === "!" || ch === "?") && (i + 1 >= text.length || /\s/.test(text[i + 1]))) {
      const before = text.slice(start, i + 1).trim();
      const next = text.slice(i + 1).trimStart()[0] || "";
      if (ch === "." && (ABBR_ALWAYS.test(before) || INITIAL.test(before))) continue;
      if (ch === "." && ABBR_SOFT.test(before) && !/[A-Z]/.test(next)) continue;
      if (before) out.push(before);
      start = i + 1;
    }
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/** The first N sentences of the paragraph, for a table row. */
export function firstSentences(text: string, n = 2): string {
  return sentences(text).slice(0, n).join(" ").trim();
}

/** A requirement as a chip label: at most a few words, never the sentence
 *  from the job description. Prefers a role skill named in the text. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A role skill named in the text, on token boundaries, longest first. */
export function skillIn(text: string, roleSkills: string[]): string | null {
  const sorted = [...roleSkills].filter((s) => s.trim().length >= 2).sort((a, b) => b.length - a.length);
  for (const s of sorted) {
    const name = s.trim();
    // Two- and three-letter skills (Go, AI, ML, C#) must match their own
    // case, or "go beyond" and "email" would light them up.
    const short = name.length <= 3;
    const re = new RegExp(`(^|[^A-Za-z0-9+#])${escapeRe(short ? name : name.toLowerCase())}(?=$|[^A-Za-z0-9+#])`, short ? "" : "i");
    if (re.test(short ? text : text.toLowerCase())) return name;
  }
  return null;
}

export function shortRequirement(text: string, roleSkills: string[] = []): string {
  const t = text.trim();
  if (!t) return "";
  const hit = skillIn(t, roleSkills);
  if (hit) return hit;
  if (t.length <= 28) return t;
  const stripped = t
    .replace(/\(.*?\)/g, "")
    .replace(/^(a\s+|an\s+)?(minimum\s+(of\s+)?|at least\s+)?\d+\+?\s*years?'?\s+(of\s+)?/i, "")
    .replace(/^(strong|proven|solid|deep|demonstrated|hands[- ]on|working|extensive|significant)\s+/i, "")
    .replace(/^(experience|expertise|background|comfort|familiarity|proficiency|track record)\s+(with|in|at|of|building|using|across)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = stripped.split(" ").filter(Boolean);
  if (!words.length) return t.length <= 40 ? t : `${t.slice(0, 38)}…`;
  return words.length <= 4 ? stripped : `${words.slice(0, 4).join(" ")}…`;
}

/** Up to `max` chips for a row: matches first, then equivalents, then the first gap. */
export function rowChips(view: VerdictView, max = 5): TechChip[] {
  const all = [...view.tech.now, ...view.tech.before];
  const seen = new Set<string>();
  const uniq = all.filter((c) => {
    const k = c.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const met = uniq.filter((c) => c.status === "met");
  const eq = uniq.filter((c) => c.status === "equivalent");
  const gap = view.tech.gaps.length ? shortRequirement(view.tech.gaps[0]) : "";
  const out: TechChip[] = [...met, ...eq].slice(0, max - (gap ? 1 : 0));
  if (gap) out.push({ name: gap, years: null, status: "gap", evidence: `Required by the role; no evidence on the profile or resume: ${view.tech.gaps[0]}` });
  return out.slice(0, max);
}
