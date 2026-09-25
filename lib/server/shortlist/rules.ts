// Phase 2: who is worth judging for a role, decided by code from the card,
// the person's signals and the embedding match. No model runs here.
import { isCareerYearsRow, rowKind, techSpec, type Criterion, type Scorecard } from "@/lib/rolecard";
import { titleFamilyOf, type TitleFamily } from "@/lib/server/signals/match";

export interface RoleForShortlist {
  title: string;
  scorecard?: Scorecard | null;
  matching_profile?: { min_years?: number | null } | null;
}

export interface RoleRules {
  /** The years row's number, else the matching profile's minimum. */
  yearsRequired: number | null;
  /** The years row asks for engineering years ("as a software engineer"). */
  engineeringYears: boolean;
  /** Title families that fit the role; null when the title says nothing. */
  families: TitleFamily[] | null;
  /** A "top university" or "top employer" row on the card, and whether it is required. */
  topRow: { kind: "university" | "employer"; required: boolean } | null;
  /** Each tech row's spellings (display name first). */
  tech: string[][];
}

const yearsIn = (label: string): number | null => {
  const m = label.match(/(\d+)\s*\+?\s*(?:years?|yrs?)/i);
  return m ? Number(m[1]) : null;
};

export function rulesOf(role: RoleForShortlist): RoleRules {
  const criteria: Criterion[] = role.scorecard?.criteria ?? [];
  // The card's years row ("4+ years as a software engineer"), or any row that
  // opens with a number of years, as a product or design card's does.
  const yearsRow = criteria.find((c) => isCareerYearsRow(c.label) || /^\s*\d+\s*\+?\s*(years?|yrs?)\b/i.test(c.label));
  const fam = titleFamilyOf(role.title);
  // A product or design title names its own family; anything technical
  // accepts engineering and data people alike (an ML engineer is both).
  let families: TitleFamily[] | null = null;
  if (fam.includes("product")) families = ["product"];
  else if (fam.includes("design")) families = ["design"];
  else if (fam.includes("engineering") || fam.includes("data")) families = ["engineering", "data"];
  let topRow: RoleRules["topRow"] = null;
  for (const c of criteria) {
    if (/\btop[- ](universit|school|college)/i.test(c.label)) topRow = { kind: "university", required: c.tier === "required" };
    else if (/\btop[- ](employer|compan|tech compan)/i.test(c.label)) topRow = { kind: "employer", required: c.tier === "required" };
  }
  const tech = criteria.filter((c) => rowKind(c) === "tech").map((c) => techSpec(c).names.flat()).filter((names) => names.length);
  return {
    yearsRequired: (yearsRow && yearsIn(yearsRow.label)) ?? role.matching_profile?.min_years ?? null,
    engineeringYears: !!yearsRow && /engineer|developer|software|programm/i.test(yearsRow.label),
    families,
    topRow,
    tech,
  };
}

export interface PersonForShortlist {
  years?: number | null;
  engineering_years?: number | null;
  title_family?: string[] | null;
  top_university_tier?: number | null;
  top_university?: string | null;
  top_employer_tier?: number | null;
  top_employer?: string | null;
  status?: string | null;
  source?: string | null;
  /** Skills, headline and summary as one text. */
  text: string;
}

export interface Assessment {
  keep: boolean;
  score: number;
  keyword_hits: number;
  checks: { years: boolean | null; family: boolean | null; top: boolean | null; location?: boolean | null };
  reasons: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ENGAGED = new Set(["directory", "airtable_sync", "website_applicant"]);

/** What a top employer and a top university add to a person's score, as
 *  [tier 1, tier 2]. With `bestOnly` only the better of the two counts.
 *  Shortlist scores run about 0.64 to 0.76 from the 10th to the 90th
 *  percentile of a role (median spread 0.12), and keyword hits can add up
 *  to 0.20; the presets are sized against those. "today" is the weight in
 *  use; "medium" and "strong" are what Spencer compares it with on the
 *  blind preview (COMPARE_QUALITY=1 in scripts/build-shortlists.mjs). */
export interface QualityWeights {
  employer: [number, number];
  university: [number, number];
  bestOnly: boolean;
}
export const QUALITY_WEIGHTS: Record<"today" | "medium" | "strong", QualityWeights> = {
  today: { employer: [0.03, 0.015], university: [0.03, 0.015], bestOnly: true },
  medium: { employer: [0.08, 0.04], university: [0.05, 0.025], bestOnly: false },
  strong: { employer: [0.16, 0.08], university: [0.1, 0.05], bestOnly: false },
};

const tierPoints = (tier: number | null | undefined, w: [number, number]) => (tier === 1 ? w[0] : tier === 2 ? w[1] : 0);

/** The quality part of the score under the given weights. */
export function qualityScore(p: Pick<PersonForShortlist, "top_employer_tier" | "top_university_tier">, w: QualityWeights = QUALITY_WEIGHTS.today): number {
  const employer = tierPoints(p.top_employer_tier, w.employer);
  const university = tierPoints(p.top_university_tier, w.university);
  return w.bestOnly ? Math.max(employer, university) : employer + university;
}

/** How well one person fits a role's rules, on top of their embedding similarity. */
export function assess(rules: RoleRules, p: PersonForShortlist, similarity: number, quality: QualityWeights = QUALITY_WEIGHTS.today): Assessment {
  const reasons: string[] = [];
  const checks: Assessment["checks"] = { years: null, family: null, top: null };
  let keep = true;
  if (p.status && /do not contact|not interested/i.test(p.status)) keep = false;

  if (rules.yearsRequired != null) {
    const value = rules.engineeringYears ? (p.engineering_years ?? p.years ?? null) : (p.years ?? null);
    if (value != null) {
      checks.years = value >= rules.yearsRequired;
      if (!checks.years) keep = false;
      else reasons.push(`${Math.round(value)} years${rules.engineeringYears ? " as an engineer" : ""} (needs ${rules.yearsRequired}+)`);
    }
  }
  if (rules.families) {
    const fam = (p.title_family || []).filter(Boolean);
    if (fam.length) {
      checks.family = fam.some((f) => rules.families!.includes(f as TitleFamily));
      if (!checks.family) keep = false;
      else reasons.push(`${fam[0]} title`);
    }
  }
  if (rules.topRow) {
    const tier = rules.topRow.kind === "university" ? p.top_university_tier : p.top_employer_tier;
    const name = rules.topRow.kind === "university" ? p.top_university : p.top_employer;
    checks.top = !!tier;
    if (!tier && rules.topRow.required) keep = false;
    if (tier) reasons.push(`top ${rules.topRow.kind}: ${name} (tier ${tier})`);
  }

  const text = ` ${p.text.toLowerCase()} `;
  const hit: string[] = [];
  for (const spellings of rules.tech) {
    if (spellings.some((s) => new RegExp(`(^|[^a-z0-9+#.])${escapeRe(s.toLowerCase())}(?![a-z0-9+#])`).test(text))) hit.push(spellings[0]);
  }
  if (rules.tech.length) reasons.push(hit.length ? `${hit.length} of ${rules.tech.length} technologies on the profile: ${hit.join(", ")}` : `none of ${rules.tech.length} technologies on the profile`);

  const engaged = !!p.source && ENGAGED.has(p.source);
  if (engaged) reasons.push("engaged");
  const score =
    similarity +
    Math.min(0.2, 0.04 * hit.length) +
    (engaged ? 0.05 : 0) +
    qualityScore(p, quality) +
    (checks.years === true ? 0.02 : 0);
  return { keep, score: Math.round(score * 10000) / 10000, keyword_hits: hit.length, checks, reasons };
}
