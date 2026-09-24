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

/** How well one person fits a role's rules, on top of their embedding similarity. */
export function assess(rules: RoleRules, p: PersonForShortlist, similarity: number): Assessment {
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
  const bestTier = Math.min(p.top_university_tier || 9, p.top_employer_tier || 9);
  const score =
    similarity +
    Math.min(0.2, 0.04 * hit.length) +
    (engaged ? 0.05 : 0) +
    (bestTier === 1 ? 0.03 : bestTier === 2 ? 0.015 : 0) +
    (checks.years === true ? 0.02 : 0);
  return { keep, score: Math.round(score * 10000) / 10000, keyword_hits: hit.length, checks, reasons };
}
