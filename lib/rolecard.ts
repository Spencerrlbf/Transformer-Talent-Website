// The role scorecard: a three-tier checklist a role is judged against, and
// the fixed rules that turn a judged checklist into the action label. Pure
// and shared: the server drafts, judges and stores with these types; the
// client renders and edits with them.
//
// Three kinds of row, resolved by rowKind() from the label (with one stored
// override): a years row is arithmetic on dated positions; a tech row is
// decided from job tags and descriptions on a fixed ladder; a judgment row
// is read on the role's own ladder by a judge that answers in
// probabilities. Code decides wherever it can, and no judge ever writes a
// "no": only the years rule or a recruiter can make someone a Pass.

import { shortRequirement, type VerdictLabel, type VerdictView } from "./verdict-view";
import { technologiesNamed } from "./tech-terms";

export type Tier = "exceptional" | "required" | "bonus";
export const TIERS: Tier[] = ["exceptional", "required", "bonus"];
export const TIER_LABEL: Record<Tier, string> = {
  exceptional: "Exceptional",
  required: "Required",
  bonus: "Bonus",
};

/** How a row is decided. Never stored except as the one override below. */
export type RowKind = "years" | "tech" | "judgment";

export interface Criterion {
  id: string;
  label: string;
  tier: Tier;
  /** What good looks like, in the hiring manager's words. Optional; it seeds
   *  a judgment row's default ladder when no ladder is stored. */
  good?: string;
  /** Required rows only: profiles rarely say this, so it is confirmed on a
   *  call. While it reads "not shown" it does not hold the label back; the
   *  label says what is still to confirm ("Contact now · confirm TypeScript"). */
  confirmOnCall?: boolean;
  /** Stored ONLY as an override: "judgment" on a row whose label names a
   *  technology, to have it read on a ladder instead of decided from job
   *  tags. rowKind() resolves the kind; nothing else reads this. */
  kind?: RowKind;
  /** Judgment rows: rungs 2 to 5, weakest first, each at most MAX_RUNG
   *  characters. Rung 1 is FLOOR and is never stored. */
  ladder?: string[];
  /** The rung from which the row counts as met. Judgment rows: 2 to the
   *  ladder's length (default 2 on a two-rung ladder, else 3). Tech rows: an
   *  index in techLadder (default the accepted rung when the row accepts a
   *  stand-in, else the named rung). */
  metAt?: number;
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

/** Rung 1 of every ladder: never stored, always shown. */
export const FLOOR = "Nothing on the profile or resume shows this";
export const MAX_CRITERIA = 10;
export const MAX_RUNGS = 5;
export const MAX_RUNG = 140;
export const MAX_LABEL = 110;
export const MAX_GOOD = 220;

/** "short" is written by code only, on a years row whose dated years are
 *  within a year under the bar. It is never a button: a recruiter confirms
 *  yes, equivalent, not shown or no. */
export type RowStatus = "yes" | "equivalent" | "unknown" | "no" | "short";
/** The four a recruiter can press. */
export const ROW_STATUSES: RowStatus[] = ["yes", "equivalent", "unknown", "no"];
export const ROW_MARK: Record<RowStatus, string> = { yes: "✓", equivalent: "≈", unknown: "?", no: "×", short: "△" };
export const ROW_WORD: Record<RowStatus, string> = {
  yes: "Yes",
  equivalent: "Equivalent",
  unknown: "Not shown",
  no: "No",
  short: "Short",
};

/** How far a tech row's technology reaches on the material, weakest first. */
export type TechReach = "none" | "profile" | "accepted" | "named" | "current";

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
  /** The words from the person's own profile that decide a yes or equivalent. */
  quote?: string;
  /** Where the answer was found ("Work history · Software Engineer II at
   *  Addepar", "Resume", "Skills list"). Worked out in code from where the
   *  quote or the technology sits; never written by the model. */
  source?: string;
  /** Laid on from the role's scorecard: a Required row confirmed on a call. */
  call?: boolean;
  /** How the row was decided, as resolved when it was judged. */
  kind?: RowKind;
  /** The rung reached, 1-based, of `levels`. A judgment row carries the
   *  judge's spread too: p[k] is the probability of rung k+1 (2 dp), with the
   *  judge's confidence. A tech row takes level and levels from techLadder.
   *  A years row has none. */
  level?: number;
  levels?: number;
  p?: number[];
  confidence?: number;
  /** Years rows: the years found against the bar. */
  numbers?: { have: number; bar: number };
  judgedBy?: "code" | "jev";
  /** Tech rows: the reach as judged, so a changed "met from" re-labels the
   *  stored row without a re-judge. */
  techReach?: TechReach;
}

/** Facts about the person, computed by CODE on the server for the report card. */
export interface ProfileFacts {
  engineeringYears: number | null;
  careerYears: number | null;
  careerSince: string | null;
  avgTenureYears: number | null;
  careerJobs: number;
  /** tag: under 200 employees is a startup, over 2,000 is large, else none. */
  current: { title: string | null; company: string | null; months: number | null; employees: number | null; founded: number | null; tag: "startup" | "large" | null } | null;
  /** In profile order, current first; at most 8. */
  companies: { name: string; title: string; from: string | null; to: string | null; years: number | null; career: boolean }[];
  /** The latest bachelor's if any, else the latest education entry. */
  school: { name: string; degree: string | null; field: string | null; year: number | null } | null;
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
  profile?: ProfileFacts;
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

export const isScorecard = (x: unknown): x is Scorecard =>
  !!x && typeof x === "object" && (x as { v?: unknown }).v === 1 && Array.isArray((x as { criteria?: unknown }).criteria);

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);

const met = (s: RowStatus) => s === "yes" || s === "equivalent";
/** Not met and not against: the label treats "short" exactly as "not shown". */
const notShown = (s: RowStatus) => s === "unknown" || s === "short";

// ---------- what kind of row, and its ladder ----------

/** The label without its examples: what sits in brackets, and anything after
 *  "e.g.", "such as", "like", "or similar" or "including". */
export const stripExamples = (label: string) =>
  label.replace(/\(.*?\)/g, " ").replace(/(\be\.g\.|\bsuch as\b|\blike\b|\bor similar\b|\bincluding\b).*$/i, " ");
/** What else the row itself accepts: only what its brackets name. The "what
 *  good looks like" note is NOT a list of substitutes (it may well name
 *  Kubernetes as evidence of backend work on a TypeScript row). */
export const bracketed = (label: string) => (label.match(/\(([^)]*)\)/g) || []).join(" ");

/** What deciding a row needs of its criterion. */
type RowSpec = Pick<Criterion, "label"> & Partial<Pick<Criterion, "kind" | "ladder" | "good" | "metAt">>;

export function rowKind(c: Pick<Criterion, "label" | "kind">): RowKind {
  if (isCareerYearsRow(c.label)) return "years";
  if (c.kind === "judgment") return "judgment";
  return technologiesNamed(stripExamples(c.label)).length ? "tech" : "judgment";
}

/** The technologies a tech row asks for, and what else it accepts: its
 *  brackets plus any alternates the role declared for that skill. Each as
 *  its list of spellings, the first being the display name. */
export function techSpec(c: Pick<Criterion, "label">, declaredAlternates: string[] = []): { names: string[][]; accepted: string[][] } {
  const names = technologiesNamed(stripExamples(c.label));
  const accepted = technologiesNamed(`${bracketed(c.label)} ${declaredAlternates.join(", ")}`).filter((g) => !names.some((n) => n[0] === g[0]));
  return { names, accepted };
}

const orList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);

/** The fixed ladder a tech row is decided on, by display name. With a
 *  stand-in accepted it has five rungs; without, the accepted rung is not
 *  there and it has four. */
export function techLadder(names: string[], accepted: string[]): string[] {
  const name = names[0] || "The technology";
  return [
    "Not named on the profile or resume",
    "On the profile (skills list, summary or an internship), not on a career job",
    ...(accepted.length ? [`${orList(accepted)} on a career job or in the resume`] : []),
    `${name} on a career job or in the resume`,
    `${name} on the current job`,
  ];
}

/** The 1-based rung of techLadder a reach lands on. With no accepted rung
 *  an "accepted" reach cannot happen; it counts as the profile rung. */
export function techLevel(reach: TechReach, hasAccepted: boolean): number {
  switch (reach) {
    case "none": return 1;
    case "profile": return 2;
    case "accepted": return hasAccepted ? 3 : 2;
    case "named": return hasAccepted ? 4 : 3;
    default: return hasAccepted ? 5 : 4;
  }
}

/** A tech row's status from its reach. The technology itself on a career
 *  job or in the resume is a yes; a stand-in is equivalent when the row
 *  counts from the accepted rung; anything less is not shown. Never "no". */
export function techStatus(reach: TechReach, metAt: number, hasAccepted: boolean): RowStatus {
  if (reach === "named" || reach === "current") return "yes";
  if (reach === "accepted") return techLevel(reach, hasAccepted) >= metAt ? "equivalent" : "unknown";
  return "unknown";
}

/** The ladder a row is read on, rung 1 first. A judgment row: FLOOR, then
 *  its stored rungs, or one rung seeded from its note (or its label) when
 *  none are stored. A tech row: the fixed ladder from its label. A years
 *  row has none. */
export function ladderOf(c: RowSpec): string[] {
  const kind = rowKind(c);
  if (kind === "years") return [];
  if (kind === "tech") {
    const { names, accepted } = techSpec(c);
    return techLadder(names.map((g) => g[0]), accepted.map((g) => g[0]));
  }
  const stored = (c.ladder || []).map((r) => String(r ?? "").trim().slice(0, MAX_RUNG).trim()).filter(Boolean).slice(0, MAX_RUNGS - 1);
  return [FLOOR, ...(stored.length ? stored : [(c.good || `${c.label}: named in a title, a team name, a job description or a resume line`).slice(0, MAX_RUNG).trim()])];
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The rung from which the row counts as met, clamped to its ladder. Tech
 *  rows count from rung 3 at the earliest: the accepted rung when the row
 *  accepts a stand-in, else the named rung. */
export function metAtOf(c: RowSpec): number {
  const kind = rowKind(c);
  if (kind === "years") return 1;
  const n = ladderOf(c).length;
  const given = typeof c.metAt === "number" && Number.isFinite(c.metAt) ? Math.round(c.metAt) : null;
  if (kind === "tech") return clamp(given ?? 3, 3, n);
  return clamp(given ?? (n <= 2 ? 2 : 3), 2, n);
}

// ---------- a judge that answers in probabilities ----------

/** How a probability spread over the rungs becomes a rung reached. "Met"
 *  needs a clear majority at or above the rung, and an answer the model is
 *  not shrugging at. A "no" is NEVER routed: on thin profiles such a judge
 *  leans to "ruled out", and a no can make someone a Pass. Pass is decided
 *  by code (the years rule) or by a recruiter. */
export const ROUTE = { metAtLeast: 0.55, confidenceAtLeast: 0.3 } as const;

/** p[k] is the probability of rung k+1. The rung reached is the highest L
 *  whose rungs L and above hold at least ROUTE.metAtLeast between them;
 *  rung 1 always qualifies. Below ROUTE.confidenceAtLeast nothing is read. */
export function routeLevel(p: number[], confidence: number): number {
  if (!(confidence >= ROUTE.confidenceAtLeast)) return 1;
  for (let level = p.length; level >= 2; level--) {
    if (certaintyAt(p, level) >= ROUTE.metAtLeast - 1e-9) return level;
  }
  return 1;
}

/** How sure the judge is of the rung reached: at rung 1 its own probability,
 *  above it the probability of that rung and every rung above. */
export function certaintyAt(p: number[], level: number): number {
  if (level <= 1) return Math.min(1, Math.max(0, p[0] || 0));
  let sum = 0;
  for (let k = level - 1; k < p.length; k++) sum += p[k] || 0;
  return Math.min(1, Math.max(0, sum));
}

/** A judgment row's status from the rung reached. NEVER "no". */
export function statusFromLevel(level: number, metAt: number): RowStatus {
  return level >= metAt ? "yes" : "unknown";
}

// ---------- the card as stored ----------

/** Anything a client sends becomes a valid scorecard or null. Ids are kept
 *  when present (overrules point at them) and minted when not. Sanitizing
 *  what it already produced changes nothing. */
export function sanitizeScorecard(input: unknown, draftedBy: "ai" | "user", prev?: Scorecard | null): Scorecard | null {
  const raw = (input as { criteria?: unknown })?.criteria;
  if (!Array.isArray(raw)) return null;
  const cleanId = (c: unknown) => String((c as Criterion)?.id ?? "").replace(/[^a-z0-9-]/gi, "").slice(0, 40);
  const text = (x: unknown, max: number) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max).trim();
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
    const sent = (c ?? {}) as Partial<Criterion>;
    const label = text(sent.label, MAX_LABEL);
    if (!label) return;
    const tier: Tier = TIERS.includes(sent.tier as Tier) ? (sent.tier as Tier) : "required";
    const good = text(sent.good, MAX_GOOD);
    let id = kept[i];
    if (!id) {
      const base = slug(label) || "row";
      id = base;
      for (let n = 2; reserved.has(id); n++) id = `${base}-${n}`;
      reserved.add(id);
    }
    const confirmOnCall = tier === "required" && sent.confirmOnCall === true;
    // The one stored override: a technology row read on a ladder. Anywhere
    // else it would change nothing, so it is not kept.
    const kind: RowKind | undefined = sent.kind === "judgment" && !isCareerYearsRow(label) && technologiesNamed(stripExamples(label)).length ? "judgment" : undefined;
    const spec: RowSpec = { label, ...(kind ? { kind } : {}), ...(good ? { good } : {}) };
    const resolved = rowKind(spec);
    const ladder = resolved === "judgment" && Array.isArray(sent.ladder) ? sent.ladder.map((r) => text(r, MAX_RUNG)).filter(Boolean).slice(0, MAX_RUNGS - 1) : [];
    const metSent = Number(sent.metAt);
    const metAt = resolved !== "years" && Number.isFinite(metSent) ? metAtOf({ ...spec, ladder, metAt: metSent }) : undefined;
    criteria.push({
      id, label, tier,
      ...(good ? { good } : {}),
      ...(confirmOnCall ? { confirmOnCall } : {}),
      ...(kind ? { kind } : {}),
      ...(ladder.length ? { ladder } : {}),
      ...(metAt != null ? { metAt } : {}),
    });
  });
  if (!criteria.length) return null;
  const sentAt = (input as { draftedAt?: unknown })?.draftedAt;
  return {
    v: 1,
    criteria,
    draftedBy: prev?.draftedBy ?? draftedBy,
    draftedAt: prev?.draftedAt ?? (typeof sentAt === "string" && !Number.isNaN(Date.parse(sentAt)) ? sentAt : new Date().toISOString()),
    ...(prev?.draftNotes ? { draftNotes: prev.draftNotes } : {}),
  };
}

/** What a saved card changes for the people already judged against it.
 *  calls: a call flag came or went. metAts: a row counts from another rung.
 *  reask: judgment rows a judge has to read again (reworded, a rung
 *  changed, or new to the ladder), by id. */
export function cardChanges(prev: Scorecard | null, next: Scorecard): { calls: boolean; metAts: boolean; reask: number } {
  const before = new Map((prev?.criteria || []).map((c) => [c.id, c]));
  const callOf = (c?: Criterion) => !!(c && c.tier === "required" && c.confirmOnCall);
  let calls = false;
  let metAts = false;
  let reask = 0;
  for (const c of next.criteria) {
    const was = before.get(c.id);
    if (callOf(c) !== callOf(was)) calls = true;
    const kind = rowKind(c);
    if (kind === "years") continue;
    const sameKind = !!was && rowKind(was) === kind;
    if (kind === "judgment" && (!sameKind || !sameLabel(was!.label, c.label) || JSON.stringify(ladderOf(was!)) !== JSON.stringify(ladderOf(c)))) {
      reask++;
      continue;
    }
    if (sameKind && metAtOf(was!) !== metAtOf(c)) metAts = true;
  }
  for (const [id, was] of before) if (callOf(was) && !next.criteria.some((c) => c.id === id)) calls = true;
  return { calls, metAts, reask };
}

// ---------- the label rules ----------

/** The label by fixed rules. A required row that is "no" is a pass; every
 *  required row yes or equivalent is contact; anything else is worth a
 *  message. "Not shown" and "short" never push to pass. A required row the
 *  role marks "confirm on a call" does not hold the label back while it is
 *  not shown (profiles rarely say it), but at least one required row must
 *  actually be met: nobody reaches contact on silence alone. With no
 *  required rows there is nothing to rule on, so the judge's own label stands. */
export function labelFromRows(rows: (Pick<CardRow, "tier" | "status" | "call"> & { label?: string })[], fallback: VerdictLabel): VerdictLabel {
  const required = rows.filter((r) => r.tier === "required");
  if (!required.length) return fallback;
  if (required.some((r) => r.status === "no")) return "pass";
  const isMet = (r: Pick<CardRow, "status">) => met(r.status);
  const deciding = required.filter((r) => !(r.call && notShown(r.status)));
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

export const tally = (rows: Pick<CardRow, "tier" | "status">[], tier: Tier) => {
  const of = rows.filter((r) => r.tier === tier);
  return {
    met: of.filter((r) => met(r.status)).length,
    of: of.length,
  };
};

/** How strongly a card is met: orders people who share a label. Required
 *  rows weigh most. Only a Required "no" counts against: Exceptional and
 *  Bonus rows never count against anyone, as the scorecard promises, and
 *  "short" counts for nothing either way. A row the judge read above the
 *  rung it counts from earns a little more (a tenth per rung, at most two
 *  tenths) while it is unconfirmed; a confirmed row counts by its status
 *  alone. Where someone works is not in here: it is a fact shown once about
 *  the person, not a score pasted onto rows. */
const TIER_WEIGHT: Record<Tier, number> = { required: 3, exceptional: 2, bonus: 1 };
export function cardStrength(
  rows: (Pick<CardRow, "tier" | "status"> & Partial<Pick<CardRow, "id" | "level" | "confirmed">>)[],
  criteria?: (Pick<Criterion, "id"> & RowSpec)[]
): number {
  const metAts = new Map((criteria || []).map((c) => [c.id, metAtOf(c)]));
  let total = 0;
  for (const r of rows) {
    const f = r.status === "yes" ? 1 : r.status === "equivalent" ? 0.8 : r.status === "no" && r.tier === "required" ? -1 : 0;
    const from = r.id != null ? metAts.get(r.id) : undefined;
    const above = f > 0 && !r.confirmed && r.level != null && from != null ? Math.min(0.2, 0.1 * Math.max(0, r.level - from)) : 0;
    total += TIER_WEIGHT[r.tier] * (f + above);
  }
  return Math.round(total * 10) / 10;
}

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
 *  bar: yes. Within a year under it: short, with the numbers, never a pass
 *  and never a yes. "No" needs even engineering + unclassified years (titles
 *  the lists do not recognise) to fall more than a year short, so an unusual
 *  title can never make a senior person a Pass. Anything between is "not
 *  shown": the years exist but sit under titles that do not say what the
 *  work was. */
export function careerYearsStatus(
  f: YearsFacts | null,
  bar: number,
  basis: "engineering" | "career" = "engineering"
): { status: RowStatus; evidence: string; have?: number; bar: number } {
  if (!f || f.engineeringYears == null) return { status: "unknown", evidence: "No dated positions on the profile.", bar };
  const y = (n: number) => `${n} ${n === 1 ? "year" : "years"}`;
  if (basis === "career") {
    // A role that is not an engineering role (data science, product,
    // research): its years bar is about the career, as it always was.
    const c = f.careerYears ?? 0;
    const line = `${y(c)} of career against ${bar}+.`;
    if (c >= bar) return { status: "yes", evidence: line, have: c, bar };
    if (c >= bar - 1) return { status: "short", evidence: `${line} A year short of the bar.`, have: c, bar };
    return { status: "no", evidence: line, have: c, bar };
  }
  const eng = f.engineeringYears;
  const career = f.careerYears ?? eng;
  const said = career - eng >= 0.5 ? `${y(eng)} in engineering roles (${y(career)} of career in all) against ${bar}+.` : `${y(eng)} in engineering roles against ${bar}+.`;
  if (eng >= bar) return { status: "yes", evidence: said, have: eng, bar };
  if (eng + f.unclassifiedYears < bar - 1) return { status: "no", evidence: said, have: eng, bar };
  if (eng >= bar - 1) return { status: "short", evidence: `${said} A year short of the bar.`, have: eng, bar };
  return { status: "unknown", evidence: `${said} ${y(f.unclassifiedYears)} more are under titles that do not say what the work was.`, have: eng, bar };
}

const YEARS_PHRASE = /(an?\s+)?(minimum\s+(of\s+)?|at least\s+)?(\d{1,2}\s*(-|–|—|to)\s*)?\d{1,2}\s*\+?\s*(or more\s+)?(years|yrs)'?\s*((of|in|with)\s+)?/i;
const tidyChip = (x: string) => x.replace(/…$/, "").replace(/[,;:.\s]+$/, "").replace(/\s+(in|of|with|and|or|for|on|at)$/i, "").trim();

/** A row as a chip label: the years bar when it states one, else a few words. */
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

/** The card in one line, for a table row: every Required row in card order,
 *  then the Exceptional and Bonus rows that are met, each as its mark and
 *  chip. A short years row shows its numbers. At most ten items. */
export function rowSummary(rows: CardRow[]): string {
  const item = (r: CardRow) => {
    const text = r.status === "short" && r.numbers ? `${r.numbers.have} of ${r.numbers.bar}+ years` : r.short || chipLabel(r.label);
    return `${ROW_MARK[r.status]} ${text}`;
  };
  const required = rows.filter((r) => r.tier === "required");
  const metOf = (t: Tier) => rows.filter((r) => r.tier === t && met(r.status));
  return [...required, ...metOf("exceptional"), ...metOf("bonus")].slice(0, 10).map(item).join(" · ");
}

/** What laying the role's card over a stored verdict needs of a criterion:
 *  its call flag always; how it is decided when the whole criterion is given. */
export type RelabelCriterion = Pick<Criterion, "id" | "confirmOnCall"> & Partial<RowSpec>;

/** The judged view with the recruiter's word laid over it. Rows they
 *  confirmed take their status; the label follows the rows by the fixed
 *  rules; a gap chip they closed goes, one they opened appears. Pure: the
 *  same judged view and the same overrules always give the same result, so
 *  judging again can never flip a confirmed row. */
export function applyOverrides(
  judged: VerdictView,
  overrides: RowOverride[],
  wrongRole: { by: string; at: string } | null = null,
  /** The role's scorecard as it stands now. "Confirm on a call" and the rung
   *  a row counts from are settings of the role, not of the verdict: laid on
   *  here, a saved verdict follows the role's current settings without being
   *  judged again. Omitted, the flags and statuses already on the rows stand. */
  criteria?: RelabelCriterion[]
): VerdictView {
  const card = judged.card;
  if (!card?.rows.length) return judged;
  const byId = new Map(overrides.map((o) => [o.criterionId, o]));
  const callIds = criteria ? new Set(criteria.filter((c) => c.confirmOnCall).map((c) => c.id)) : null;
  // Whole criteria only: a row judged on a ladder is re-labelled from the
  // rung it reached and the rung the role now counts from.
  const whole = (criteria || []).filter((c): c is RelabelCriterion & { label: string } => typeof c.label === "string");
  const decided = new Map(whole.map((c) => [c.id, c]));
  const judgedAs = (r: CardRow): RowStatus => {
    const c = decided.get(r.id);
    if (!c || r.level == null) return r.ai;
    const kind = r.kind ?? rowKind(c);
    if (rowKind(c) !== kind) return r.ai;
    if (kind === "judgment") return statusFromLevel(r.level, metAtOf(c));
    if (kind === "tech" && r.techReach) return techStatus(r.techReach, metAtOf(c), r.levels != null ? r.levels >= 5 : techSpec(c).accepted.length > 0);
    return r.ai;
  };
  const rows: CardRow[] = card.rows.map((r) => {
    const hit = byId.get(r.id);
    const o = hit && (!hit.label || sameLabel(hit.label, r.label)) ? hit : undefined;
    const call = r.tier === "required" && (callIds ? callIds.has(r.id) : !!r.call);
    if (o) return { ...r, call, status: o.status, confirmed: { by: o.by, at: o.at, ...(o.note ? { note: o.note } : {}) } };
    const ai = judgedAs(r);
    return { ...r, call, ai, status: ai, confirmed: null };
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
    card: { ...card, rows, aiLabel, aiGaps: baseGaps, wrongRole, strength: cardStrength(rows, whole), confirm: label === "contact" ? toConfirm(rows) : [] },
  };
}
