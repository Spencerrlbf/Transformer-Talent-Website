// The role scorecard: a three-tier checklist a role is judged against, and
// the fixed rules that turn a judged checklist into the action label. Pure
// and shared: the server drafts, judges and stores with these types; the
// client renders and edits with them.

import { shortRequirement, type VerdictLabel, type VerdictView } from "./verdict-view";
import { technologiesNamed } from "./tech-terms";

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
  /** Required rows only: profiles rarely say this, so it is confirmed on a
   *  call. While it reads "not shown" it does not hold the label back; the
   *  label says what is still to confirm ("Contact now · confirm TypeScript"). */
  confirmOnCall?: boolean;
}

export interface Scorecard {
  v: 1;
  criteria: Criterion[];
  draftedBy: "ai" | "user";
  draftedAt: string;
  editedBy?: string;
  editedAt?: string;
  /** What the drafter did (first draft's problems, each repair round). Never shown. */
  draftNotes?: string[];
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
  /** "? likely": the material does not show it, but the person's role at an
   *  employer whose business is exactly this makes it probable (a founding
   *  engineer at an AI-agents company, for an agents row). Still "not shown":
   *  it never counts as met for the label. It ranks the person higher, gives
   *  the recruiter a question to ask, and becomes a yes when they check it
   *  off. Only ever true on an unconfirmed "unknown" row. */
  likely?: boolean;
  /** `likely` as judged, kept so taking an overrule back restores it. */
  aiLikely?: boolean;
  confirmed?: { by: string; at: string; note?: string } | null;
  /** The row as a chip ("4+ years", "TypeScript"), set when the view is built. */
  short?: string;
  /** The words from the person's own profile that decide a yes or equivalent. */
  quote?: string;
  /** Laid on from the role's scorecard: a Required row confirmed on a call. */
  call?: boolean;
  /** A tick the code removed, as the judge gave it. Never shown: kept so a
   *  wrongly removed tick can be found and the guard tuned. */
  dropped?: { status: string; quote: string; evidence: string; why: string };
}

export interface VerdictCardData {
  rows: CardRow[];
  /** The label from the judge's own rows, before any overrule. */
  aiLabel: VerdictLabel;
  /** The technology gaps as judged, so an overrule can be taken back. */
  aiGaps?: string[];
  /** Why the label is held below what the rows alone would give (the years rail). */
  railNote?: string | null;
  /** How strongly the rows are met, for ordering people inside one label. */
  strength?: number;
  /** Required rows still to confirm on a call, as chips, when that is all that stands between the person and the label. */
  confirm?: string[];
  /** Facts about the person, written by code from dated positions (never by a model). */
  facts?: string[];
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
    const confirmOnCall = tier === "required" && (c as Criterion)?.confirmOnCall === true;
    criteria.push({ id, label, tier, ...(good ? { good } : {}), ...(confirmOnCall ? { confirmOnCall } : {}) });
  });
  if (!criteria.length) return null;
  return {
    v: 1,
    criteria,
    draftedBy: prev?.draftedBy ?? draftedBy,
    draftedAt: prev?.draftedAt ?? new Date().toISOString(),
    ...(prev?.draftNotes ? { draftNotes: prev.draftNotes } : {}),
  };
}

/** The label by fixed rules. A required row that is "no" is a pass; every
 *  required row yes or equivalent is contact; anything else is worth a
 *  message. "Not shown" never pushes to pass. A required row the role marks
 *  "confirm on a call" does not hold the label back while it is not shown
 *  (profiles rarely say it), but at least one required row must actually be
 *  met: nobody reaches contact on silence alone. With no required rows there
 *  is nothing to rule on, so the judge's own label stands. */
export function labelFromRows(rows: (Pick<CardRow, "tier" | "status" | "call"> & { label?: string })[], fallback: VerdictLabel): VerdictLabel {
  const required = rows.filter((r) => r.tier === "required");
  if (!required.length) return fallback;
  if (required.some((r) => r.status === "no")) return "pass";
  const isMet = (r: Pick<CardRow, "status">) => r.status === "yes" || r.status === "equivalent";
  const deciding = required.filter((r) => !(r.call && r.status === "unknown"));
  if (!deciding.length || !deciding.every(isMet)) return "message";
  // Years alone are not a reason to contact someone: when the card has
  // Required rows about the work itself, at least one of them must be met.
  const aboutTheWork = required.filter((r) => !("label" in r) || !isCareerYearsRow((r as { label: string }).label));
  return aboutTheWork.length && !aboutTheWork.some(isMet) ? "message" : "contact";
}

/** The required rows still to confirm on a call, for a person the rows make a contact. */
export const toConfirm = (rows: Pick<CardRow, "tier" | "status" | "call" | "label" | "short">[]): string[] =>
  rows.filter((r) => r.tier === "required" && r.call && r.status === "unknown").map((r) => r.short || chipLabel(r.label));

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

export const tally = (rows: Pick<CardRow, "tier" | "status" | "likely">[], tier: Tier) => {
  const of = rows.filter((r) => r.tier === tier);
  return {
    met: of.filter((r) => r.status === "yes" || r.status === "equivalent").length,
    likely: of.filter((r) => r.status === "unknown" && r.likely).length,
    of: of.length,
  };
};

/** How strongly a card is met: orders people who share a label. Required
 *  rows weigh most. Only a Required "no" counts against: Exceptional and
 *  Bonus rows never count against anyone, as the scorecard promises. Where
 *  someone works is not in here: it is a fact shown once about the person,
 *  not a score pasted onto rows. */
const TIER_WEIGHT: Record<Tier, number> = { required: 3, exceptional: 2, bonus: 1 };
export function cardStrength(rows: Pick<CardRow, "tier" | "status">[]): number {
  let total = 0;
  for (const r of rows) {
    const f = r.status === "yes" ? 1 : r.status === "equivalent" ? 0.8 : r.status === "no" && r.tier === "required" ? -1 : 0;
    total += TIER_WEIGHT[r.tier] * f;
  }
  return Math.round(total * 10) / 10;
}

/** A row as a chip label: the years bar when it states one, else a few words. */
const GENERIC_YEARS = /(years|yrs)\s+(of\s+)?((professional|industry|relevant|total|overall|commercial|hands[- ]on)\s+)*((software|backend|frontend|full[- ]stack)\s+)?(engineering|development|experience|work)\b\s*(experience)?\s*$/i;

/** A row that states nothing but a career-years bar ("4+ years software
 *  engineering"). Code decides these from the dated history; no model does
 *  arithmetic. A years row with a subject ("5 years building distributed
 *  systems") needs reading, so the judge keeps it. */
export const isCareerYearsRow = (label: string): boolean => {
  if (yearsBar(label) == null) return false;
  // What is left once the years phrase is taken out must be nothing but a
  // generic word for the career: "4+ years software engineering", "4+ years
  // as a software engineer", "3-5 years of backend development experience".
  const rest = label.replace(/\(.*?\)/g, " ").replace(YEARS_PHRASE, " ").replace(/[.,;:]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return /^((as an?|in|of)\s+)?((professional|industry|relevant|total|overall|commercial|hands[- ]on|working)\s+)*((software|backend|back-end|frontend|front-end|full[- ]?stack)\s+)?(engineers?|engineering|developers?|development|experience|work)(\s+(experience|roles?|work))?$/.test(rest);
};

/** What the years row is decided from (a subset of the server's CandidateFacts). */
export interface YearsFacts {
  engineeringYears: number | null;
  unclassifiedYears: number;
  careerYears: number | null;
}

/** The career-years row by rule, on ENGINEERING years: a trader's or a
 *  consultant's years are a career, not software engineering. At or over the
 *  bar: yes. "No" needs even engineering + unclassified years (titles the
 *  lists do not recognise) to fall more than a year short, so an unusual
 *  title can never make a senior person a Pass. Anything between is "not
 *  shown": close is worth a conversation. */
export function careerYearsStatus(f: YearsFacts | null, bar: number, basis: "engineering" | "career" = "engineering"): { status: RowStatus; evidence: string } {
  if (!f || f.engineeringYears == null) return { status: "unknown", evidence: "No dated positions on the profile." };
  if (basis === "career") {
    // A role that is not an engineering role (data science, product,
    // research): its years bar is about the career, as it always was.
    const c = f.careerYears ?? 0;
    const line = `${c} ${c === 1 ? "year" : "years"} of career against ${bar}+.`;
    return c >= bar ? { status: "yes", evidence: line } : c >= bar - 1 ? { status: "unknown", evidence: `${line} Close to the bar.` } : { status: "no", evidence: line };
  }
  const eng = f.engineeringYears;
  const career = f.careerYears ?? eng;
  const y = (n: number) => `${n} ${n === 1 ? "year" : "years"}`;
  const said = career - eng >= 0.5 ? `${y(eng)} in engineering roles (${y(career)} of career in all) against ${bar}+.` : `${y(eng)} in engineering roles against ${bar}+.`;
  if (eng >= bar) return { status: "yes", evidence: said };
  if (eng + f.unclassifiedYears < bar - 1) return { status: "no", evidence: said };
  // Within a year of the bar is close. Otherwise the years exist but sit
  // under titles that do not say what the work was: a question, not a no.
  return { status: "unknown", evidence: eng >= bar - 1 ? `${said} Close to the bar.` : `${said} ${y(f.unclassifiedYears)} more are under titles that do not say what the work was.` };
}

const YEARS_PHRASE = /(an?\s+)?(minimum\s+(of\s+)?|at least\s+)?(\d{1,2}\s*(-|–|—|to)\s*)?\d{1,2}\s*\+?\s*(or more\s+)?(years|yrs)'?\s*((of|in|with)\s+)?/i;
const tidyChip = (x: string) => x.replace(/…$/, "").replace(/[,;:.\s]+$/, "").replace(/\s+(in|of|with|and|or|for|on|at)$/i, "").trim();

export function chipLabel(label: string, roleSkills: string[] = []): string {
  const bar = yearsBar(label);
  if (bar == null) {
    // A row that names its technology reads as that technology:
    // "Backend in TypeScript/Node.js (Go, Java accepted)" is "TypeScript/Node.js".
    // The brackets hold what ELSE is accepted, never the requirement itself.
    const core = label.replace(/\(.*?\)/g, " ");
    const named = technologiesNamed(core).map((g) => g[0]);
    return named.length ? named.slice(0, 2).join("/") : shortRequirement(core, roleSkills);
  }
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
  wrongRole: { by: string; at: string } | null = null,
  /** The role's scorecard as it stands now. "Confirm on a call" is a setting
   *  of the role, not of the verdict: laid on here, a saved verdict follows
   *  the role's current setting without being judged again. Omitted, the
   *  flags already on the rows stand. */
  criteria?: Pick<Criterion, "id" | "confirmOnCall">[]
): VerdictView {
  const card = judged.card;
  if (!card?.rows.length) return judged;
  const byId = new Map(overrides.map((o) => [o.criterionId, o]));
  const callIds = criteria ? new Set(criteria.filter((c) => c.confirmOnCall).map((c) => c.id)) : null;
  const rows: CardRow[] = card.rows.map((r) => {
    const hit = byId.get(r.id);
    const o = hit && (!hit.label || sameLabel(hit.label, r.label)) ? hit : undefined;
    const call = r.tier === "required" && (callIds ? callIds.has(r.id) : !!r.call);
    return o
      ? { ...r, call, status: o.status, likely: false, confirmed: { by: o.by, at: o.at, ...(o.note ? { note: o.note } : {}) } }
      : { ...r, call, status: r.ai, likely: false, confirmed: null };
  });
  // The label always follows the rows by the fixed rules. The years rail
  // (dated engineering history more than a year under the role's minimum)
  // still holds a contact at message unless a years row was confirmed.
  const railed = !!card.railNote;
  const rail = (l: VerdictLabel, confirmedYears: boolean) => (railed && l === "contact" && !confirmedYears ? "message" : l);
  const aiRows = rows.map((r) => ({ tier: r.tier, status: r.ai, call: r.call, label: r.label }));
  const aiLabel = rail(labelFromRows(aiRows, card.aiLabel), false);
  const yearsConfirmed = rows.some((r) => r.confirmed && met(r.status) && isCareerYearsRow(r.label));
  const label = rail(labelFromRows(rows, card.aiLabel), yearsConfirmed);
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
    card: { ...card, rows, aiLabel, aiGaps: baseGaps, wrongRole, strength: cardStrength(rows), confirm: label === "contact" ? toConfirm(rows) : [] },
  };
}

// ---------- a judge that answers in probabilities ----------

/** How a probability spread becomes a mark, for a judge that answers in
 *  probabilities. "Met" needs three things: a clear majority across yes and
 *  equivalent, a met class that beats "not shown" on its own, and an answer
 *  the model is not shrugging at. A "no" is NEVER routed: on thin profiles
 *  such a judge leans to "ruled out" (a data scientist now at an agents
 *  startup read 0.72 to 0.85 on five rows), and a no can make someone a
 *  Pass. Pass is decided by code (the years rule) or by a recruiter.
 *  Fitted on one run of 17 people; to be refitted on recruiter check-offs. */
export const ROUTE = { metAtLeast: 0.55, confidenceAtLeast: 0.3 } as const;

export function routeStatus(p: Partial<Record<RowStatus, number>>, confidence = 1): RowStatus {
  const yes = p.yes || 0;
  const eq = p.equivalent || 0;
  const met = yes + eq >= ROUTE.metAtLeast && Math.max(yes, eq) > (p.unknown || 0) && confidence >= ROUTE.confidenceAtLeast;
  return met ? (yes >= eq ? "yes" : "equivalent") : "unknown";
}

/** What a mark means to the label rules: yes and equivalent are the same. */
export const labelClass = (s: RowStatus): "met" | "unknown" | "no" =>
  s === "yes" || s === "equivalent" ? "met" : s === "no" ? "no" : "unknown";
