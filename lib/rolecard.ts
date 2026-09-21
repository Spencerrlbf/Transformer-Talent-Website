// The role scorecard: a three-tier checklist a role is judged against, and
// the fixed rules that turn a judged checklist into the action label. Pure
// and shared: the server drafts, judges and stores with these types; the
// client renders and edits with them.

import type { VerdictLabel } from "./verdict-view";

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
}

export interface VerdictCardData {
  rows: CardRow[];
  /** The label from the judge's own rows, before any overrule. */
  aiLabel: VerdictLabel;
  wrongRole?: { by: string; at: string } | null;
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
  const seen = new Set<string>();
  const criteria: Criterion[] = [];
  for (const c of raw.slice(0, MAX_CRITERIA * 2)) {
    const label = String((c as Criterion)?.label ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
    if (!label) continue;
    const tier: Tier = TIERS.includes((c as Criterion)?.tier) ? (c as Criterion).tier : "required";
    const good = String((c as Criterion)?.good ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_GOOD);
    let id = String((c as Criterion)?.id ?? "").replace(/[^a-z0-9-]/gi, "").slice(0, 40);
    if (!id || seen.has(id)) {
      const base = slug(label) || "row";
      id = base;
      for (let n = 2; seen.has(id); n++) id = `${base}-${n}`;
    }
    seen.add(id);
    criteria.push(good ? { id, label, tier, good } : { id, label, tier });
    if (criteria.length >= MAX_CRITERIA) break;
  }
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
  const m = label.match(/(\d{1,2})\s*\+?\s*(?:or more\s+)?(?:years|yrs)\b/i);
  return m ? parseInt(m[1], 10) : null;
};

export const tally = (rows: Pick<CardRow, "tier" | "status">[], tier: Tier) => {
  const of = rows.filter((r) => r.tier === tier);
  return { met: of.filter((r) => r.status === "yes" || r.status === "equivalent").length, of: of.length };
};
