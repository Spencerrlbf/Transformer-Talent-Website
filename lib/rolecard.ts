// The role scorecard: a three-tier checklist a role is judged against, and
// the fixed rules that turn a judged checklist into the action label. Pure
// and shared: the server drafts, judges and stores with these types; the
// client renders and edits with them.

import { shortRequirement, type VerdictLabel, type VerdictView } from "./verdict-view";

export type Tier = "exceptional" | "required" | "bonus";
export const TIERS: Tier[] = ["exceptional", "required", "bonus"];
export const TIER_LABEL: Record<Tier, string> = {
  exceptional: "Exceptional",
  required: "Required",
  bonus: "Bonus",
};

export interface Criterion {
  id: string;
  label: string;
  tier: Tier;
  /** What good looks like, in the hiring manager's words. Optional. */
  good?: string;
}

export interface Scorecard {
  v: 1;
  criteria: Criterion[];
  draftedBy: "ai" | "user";
  draftedAt: string;
  editedBy?: string;
  editedAt?: string;
}

export type RowStatus = "yes" | "equivalent" | "unknown" | "no";
export const ROW_STATUSES: RowStatus[] = ["yes", "equivalent", "unknown", "no"];
export const ROW_MARK: Record<RowStatus, string> = { yes: "✓", equivalent: "≈", unknown: "?", no: "×" };
export const ROW_WORD: Record<RowStatus, string> = {
  yes: "Yes",
  equivalent: "Equivalent",
  unknown: "Not shown",
  no: "No",
};

export interface CardRow {
  id: string;
  label: string;
  tier: Tier;
  /** The status in force: the recruiter's when confirmed, else the judge's. */
  status: RowStatus;
  evidence: string;
  /** What the judge said, kept when a recruiter overrules it. */
  ai: RowStatus;
  confirmed?: { by: string; at: string; note?: string } | null;
  /** The row as a chip ("4+ years", "TypeScript"), set when the view is built. */
  short?: string;
}

export interface VerdictCardData {
  rows: CardRow[];
  /** The label from the judge's own rows, before any overrule. */
  aiLabel: VerdictLabel;
  /** The technology gaps as judged, so an overrule can be taken back. */
  aiGaps?: string[];
  /** Why the label is held below what the rows alone would give (the years rail). */
  railNote?: string | null;
  wrongRole?: { by: string; at: string } | null;
}

/** What a recruiter said about one row of one person's card. */
export interface RowOverride {
  criterionId: string;
  /** The row's wording when it was confirmed; a row since reworded is skipped. */
  label?: string | null;
  status: RowStatus;
  note?: string | null;
  by: string;
  at: string;
}

export const MAX_CRITERIA = 14;
export const MAX_LABEL = 110;
export const MAX_GOOD = 220;

export const isScorecard = (x: unknown): x is Scorecard =>
  !!x && typeof x === "object" && (x as { v?: unknown }).v === 1 && Array.isArray((x as { criteria?: unknown }).criteria);

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);

/** Anything a client sends becomes a valid scorecard or null. Ids are kept
 *  when present (overrules point at them) and minted when not. */
export function sanitizeScorecard(input: unknown, draftedBy: "ai" | "user", prev?: Scorecard | null): Scorecard | null {
  const raw = (input as { criteria?: unknown })?.criteria;
  if (!Array.isArray(raw)) return null;
  const cleanId = (c: unknown) => String((c as Criterion)?.id ?? "").replace(/[^a-z0-9-]/gi, "").slice(0, 40);
  const list = raw.slice(0, MAX_CRITERIA * 2);
  // Ids a client sent are kept first (overrules point at them); rows without
  // one are minted around them, never the other way round.
  const reserved = new Set<string>();
  const before = new Map((prev?.criteria || []).map((c) => [c.id, c.label]));
  const kept = list.map((c) => {
    const id = cleanId(c);
    if (!id || reserved.has(id)) return "";
    // A reworded row is a new row: a confirmation made against the old
    // wording must not attach itself to the new meaning.
    const was = before.get(id);
    if (was !== undefined && !sameLabel(was, String((c as Criterion)?.label ?? ""))) return "";
    reserved.add(id);
    return id;
  });
  for (const id of before.keys()) reserved.add(id); // a retired id is never minted again
  const criteria: Criterion[] = [];
  list.forEach((c, i) => {
    if (criteria.length >= MAX_CRITERIA) return;
    const label = String((c as Criterion)?.label ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
    if (!label) return;
    const tier: Tier = TIERS.includes((c as Criterion)?.tier) ? (c as Criterion).tier : "required";
    const good = String((c as Criterion)?.good ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_GOOD);
    let id = kept[i];
    if (!id) {
      const base = slug(label) || "row";
      id = base;
      for (let n = 2; reserved.has(id); n++) id = `${base}-${n}`;
      reserved.add(id);
    }
    criteria.push(good ? { id, label, tier, good } : { id, label, tier });
  });
  if (!criteria.length) return null;
  return {
    v: 1,
    criteria,
    draftedBy: prev?.draftedBy ?? draftedBy,
    draftedAt: prev?.draftedAt ?? new Date().toISOString(),
  };
}

/** The label by fixed rules. A required row that is "no" is a pass; every
 *  required row yes or equivalent is contact; anything else is worth a
 *  message. "Not shown" never pushes to pass. With no required rows there is
 *  nothing to rule on, so the judge's own label stands. */
export function labelFromRows(rows: Pick<CardRow, "tier" | "status">[], fallback: VerdictLabel): VerdictLabel {
  const required = rows.filter((r) => r.tier === "required");
  if (!required.length) return fallback;
  if (required.some((r) => r.status === "no")) return "pass";
  if (required.every((r) => r.status === "yes" || r.status === "equivalent")) return "contact";
  return "message";
}

/** A criterion that states a years bar ("4+ years of software engineering"). */
export const yearsBar = (label: string): number | null => {
  // "3-5 years" and "3 to 5 years" state a bar of 3, not 5.
  const range = label.match(/(\d{1,2})\s*(?:-|–|—|to)\s*\d{1,2}\s*\+?\s*(?:years|yrs)\b/i);
  if (range) return parseInt(range[1], 10);
  const m = label.match(/(\d{1,2})\s*\+?\s*(?:or more\s+)?(?:years|yrs)\b/i);
  return m ? parseInt(m[1], 10) : null;
};

/** Two labels that say the same thing, give or take case and punctuation. */
export const sameLabel = (a: string, b: string) => {
  const n = (x: string) => x.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim();
  return n(a) === n(b);
};

export const tally = (rows: Pick<CardRow, "tier" | "status">[], tier: Tier) => {
  const of = rows.filter((r) => r.tier === tier);
  return { met: of.filter((r) => r.status === "yes" || r.status === "equivalent").length, of: of.length };
};

/** A row as a chip label: the years bar when it states one, else a few words. */
const GENERIC_YEARS = /(years|yrs)\s+(of\s+)?((professional|industry|relevant|total|overall|commercial|hands[- ]on)\s+)*((software|backend|frontend|full[- ]stack)\s+)?(engineering|development|experience|work)\b\s*(experience)?\s*$/i;

/** A row that states nothing but a career-years bar ("4+ years software
 *  engineering"). Code decides these from the dated history; no model does
 *  arithmetic. A years row with a subject ("5 years building distributed
 *  systems") needs reading, so the judge keeps it. */
export const isCareerYearsRow = (label: string): boolean =>
  yearsBar(label) != null && GENERIC_YEARS.test(label.replace(/\(.*?\)/g, "").trim());

/** The career-years row by rule. At or over the bar: yes. Within a year of
 *  it: not shown (dated histories are often partial, and close is worth a
 *  conversation). More than a year short: no. */
export function careerYearsStatus(careerYears: number | null, bar: number): { status: RowStatus; evidence: string } {
  if (careerYears == null) return { status: "unknown", evidence: "No dated positions on the profile." };
  const said = `${careerYears} years of dated career history against ${bar}+.`;
  if (careerYears >= bar) return { status: "yes", evidence: said };
  if (careerYears >= bar - 1) return { status: "unknown", evidence: `${said} Close; early roles may be missing.` };
  return { status: "no", evidence: said };
}

const YEARS_PHRASE = /(an?\s+)?(minimum\s+(of\s+)?|at least\s+)?(\d{1,2}\s*(-|–|—|to)\s*)?\d{1,2}\s*\+?\s*(or more\s+)?(years|yrs)'?\s*((of|in|with)\s+)?/i;
const tidyChip = (x: string) => x.replace(/…$/, "").replace(/[,;:.\s]+$/, "").replace(/\s+(in|of|with|and|or|for|on|at)$/i, "").trim();

export function chipLabel(label: string, roleSkills: string[] = []): string {
  const bar = yearsBar(label);
  if (bar == null) return shortRequirement(label, roleSkills);
  // "4+ years of software engineering" is just the bar.
  if (isCareerYearsRow(label)) return `${bar}+ years`;
  const rest = label.replace(YEARS_PHRASE, " ").replace(/\s+/g, " ").trim();
  const subject = tidyChip(tidyChip(shortRequirement(rest, roleSkills)).split(" ").slice(0, 4).join(" "));
  if (!subject) return `${bar}+ years`;
  // "5 years building distributed systems" leads with its bar; a skill row
  // that carries one ("TypeScript backend in production, 2+ years") leads
  // with the skill, and the row itself shows the bar.
  return new RegExp(`^\\s*${YEARS_PHRASE.source}`, "i").test(label) ? `${bar}+ yrs ${subject.split(" ").slice(0, 3).join(" ")}` : subject;
}

const met = (s: RowStatus) => s === "yes" || s === "equivalent";

/** The judged view with the recruiter's word laid over it. Rows they
 *  confirmed take their status; the label follows the rows by the fixed
 *  rules; a gap chip they closed goes, one they opened appears. Pure: the
 *  same judged view and the same overrules always give the same result, so
 *  judging again can never flip a confirmed row. */
export function applyOverrides(
  judged: VerdictView,
  overrides: RowOverride[],
  wrongRole: { by: string; at: string } | null = null
): VerdictView {
  const card = judged.card;
  if (!card?.rows.length) return judged;
  const byId = new Map(overrides.map((o) => [o.criterionId, o]));
  const rows: CardRow[] = card.rows.map((r) => {
    const hit = byId.get(r.id);
    const o = hit && (!hit.label || sameLabel(hit.label, r.label)) ? hit : undefined;
    return o
      ? { ...r, status: o.status, confirmed: { by: o.by, at: o.at, ...(o.note ? { note: o.note } : {}) } }
      : { ...r, status: r.ai, confirmed: null };
  });
  const touched = rows.some((r) => r.confirmed);
  // Untouched, the judged label stands (it carries the years rail). Touched,
  // the rows decide; the rail still holds unless a years row was confirmed.
  let label = card.aiLabel;
  if (touched) {
    label = labelFromRows(rows, card.aiLabel);
    const railed = card.aiLabel !== labelFromRows(card.rows.map((r) => ({ tier: r.tier, status: r.ai })), card.aiLabel);
    const yearsConfirmed = rows.some((r) => r.confirmed && met(r.status) && isCareerYearsRow(r.label));
    if (railed && label === "contact" && !yearsConfirmed) label = "message";
  }
  const baseGaps = card.aiGaps ?? judged.tech.gaps;
  const chipOf = (r: CardRow) => r.short || chipLabel(r.label);
  const closed = new Set(rows.filter((r) => r.confirmed && met(r.status)).map((r) => chipOf(r).toLowerCase()));
  // Two rows can share a chip ("TypeScript"): it closes only when no unmet
  // required row still carries it.
  const stillOpen = new Set(rows.filter((r) => r.tier === "required" && !met(r.status)).map((r) => chipOf(r).toLowerCase()));
  const opened = rows.filter((r) => r.confirmed && !met(r.status) && r.tier === "required").map(chipOf);
  const gaps = [...baseGaps.filter((g) => !closed.has(g.toLowerCase()) || stillOpen.has(g.toLowerCase()))];
  for (const g of opened) if (g && !gaps.some((x) => x.toLowerCase() === g.toLowerCase())) gaps.push(g);
  return {
    ...judged,
    label,
    tech: { ...judged.tech, gaps: gaps.slice(0, 6) },
    card: { ...card, rows, aiGaps: baseGaps, wrongRole },
  };
}

// ---------- a judge that answers in probabilities ----------

/** How a probability spread becomes a mark. A "no" on a Required row makes a
 *  person a Pass, so it must be confident; "met" needs a clear majority across
 *  yes and equivalent; anything else is "not shown", which never sinks anyone.
 *  First values, to be tuned against the recruiter's own check-offs. */
export const ROUTE = { noAtLeast: 0.7, metAtLeast: 0.6 } as const;

export function routeStatus(p: Partial<Record<RowStatus, number>>): RowStatus {
  const yes = p.yes || 0;
  const eq = p.equivalent || 0;
  if ((p.no || 0) >= ROUTE.noAtLeast) return "no";
  if (yes + eq >= ROUTE.metAtLeast) return yes >= eq ? "yes" : "equivalent";
  return "unknown";
}

/** What a mark means to the label rules: yes and equivalent are the same. */
export const labelClass = (s: RowStatus): "met" | "unknown" | "no" =>
  s === "yes" || s === "equivalent" ? "met" : s === "no" ? "no" : "unknown";
