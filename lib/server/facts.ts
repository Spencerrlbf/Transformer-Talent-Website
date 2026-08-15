// Deterministic fact engine: answers the countable screening questions
// ("3+ years of Python?", "used Kubernetes in current role?") straight from
// the structured candidate_experiences rows — free, exact, and impossible to
// hallucinate. The LLM only handles judgment questions.
//
// Career rules (agreed 2026-08-15):
//  1. Positions are classified by TITLE first (intern/co-op/clinic/fellow/
//     research- or teaching-assistant), employment type second — providers
//     mislabel internships as "Full-time".
//  2. Graduation anchor: with a known undergrad end date, anything that ends
//     before it is pre-career even if the title looks professional; a job
//     spanning graduation counts from graduation. No degree data -> rule 1 only.
//  3. Both numbers are reported: career years AND what was excluded.
//  4. Per-skill years count career time only; internship exposure is noted,
//     never silently blended in.
//  5. This is the single source of years — gates and facts can't disagree.

import { sbRest } from "./supabase";

export interface ExperienceRow {
  title: string | null;
  company_name: string | null;
  employment_type?: string | null;
  start_month: number | null;
  start_year: number | null;
  end_month: number | null;
  end_year: number | null;
  is_current: boolean | null;
  duration_text: string | null;
  skills: string[] | null;
  description: string | null;
  sort_order: number;
}

export interface SkillFact {
  skill: string;
  years: number; // career years only (0 when internship-only or listed-only)
  usedInCurrentRole: boolean;
  positions: string[]; // "Title at Company" citations
  usedInInternships?: boolean;
  listedOnly?: boolean; // on their profile, but no dated position evidence
}

export interface SkillCoOccurrence {
  skills: string[]; // role-relevant skills used in the SAME position
  position: string; // "Title at Company"
  span: string; // "2024–2026" | "2024–now"
  career: boolean; // false = internship/clinic position
}

export interface CandidateFacts {
  careerYears: number | null; // post-graduation, non-internship
  careerSince: string | null; // e.g. "Aug 2022"
  excludedCount: number; // internships/clinics/pre-graduation positions
  excludedYears: number; // merged years of the excluded positions
  currentTitle: string | null;
  currentCompany: string | null;
  skills: SkillFact[];
  // Deterministic basis lines for the screener's inferred signals: which
  // role-relevant skills co-occur within a single position.
  coOccurrences: SkillCoOccurrence[];
}

const NON_CAREER_TITLE =
  /\bintern(ship)?\b|co-?op\b|\bclinic\b|\bfellow(ship)?\b|research assistant|teaching assistant|\bapprentice\b/i;
const NON_CAREER_TYPE = /intern|part-?time|apprentice/i;

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const norm = (s: string) =>
  s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9+#. ]/g, " ").replace(/\s+/g, " ").trim();

function skillMatches(skill: string, candidateSkill: string): boolean {
  const a = norm(skill);
  const b = norm(candidateSkill);
  if (!a || !b) return false;
  if (a === b) return true;
  // Containment only for multi-char terms, to keep "go" from matching "django".
  if (a.length >= 3 && b.includes(a)) return true;
  if (b.length >= 3 && a.includes(b)) return true;
  return false;
}

function usedSkill(row: ExperienceRow, skill: string): boolean {
  if ((row.skills || []).some((s) => skillMatches(skill, s))) return true;
  if (row.description) {
    const escaped = norm(skill).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (escaped.length >= 2 && new RegExp(`\\b${escaped}\\b`, "i").test(row.description)) return true;
  }
  return false;
}

// [startMonths, endMonths] since year 0, for interval math.
function interval(row: ExperienceRow, nowY: number, nowM: number): [number, number] | null {
  if (!row.start_year) return null;
  const start = row.start_year * 12 + (row.start_month ?? 6);
  const end = row.is_current || !row.end_year ? nowY * 12 + nowM : row.end_year * 12 + (row.end_month ?? 6);
  return end > start ? [start, end] : null;
}

function mergedYears(intervals: [number, number][]): number {
  if (!intervals.length) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let months = 0;
  let [curS, curE] = sorted[0];
  for (const [s, e] of sorted.slice(1)) {
    if (s <= curE) curE = Math.max(curE, e);
    else {
      months += curE - curS;
      [curS, curE] = [s, e];
    }
  }
  months += curE - curS;
  return Math.round((months / 12) * 10) / 10;
}

// Final undergrad graduation year from a Harvest education list. Bachelor
// degrees only — masters/PhD must not push the career anchor later.
export function undergradEndYear(education: unknown): number | null {
  if (!Array.isArray(education)) return null;
  let latest: number | null = null;
  for (const ed of education as Record<string, any>[]) {
    const degree = String(ed?.degree || "");
    if (!/\bbachelor|\bb\.?\s?s\b|\bb\.?\s?a\b|\bb\.?\s?eng\b|\bbsc\b|undergrad/i.test(degree)) continue;
    let year: number | null = ed?.endDate?.year ?? null;
    if (!year && typeof ed?.period === "string") {
      const m = ed.period.match(/(\d{4})\s*$/);
      if (m) year = parseInt(m[1], 10);
    }
    if (year && (!latest || year > latest)) latest = year;
  }
  return latest;
}

interface ClassifiedRow {
  row: ExperienceRow;
  career: boolean;
  // interval clamped to post-graduation for career rows
  iv: [number, number] | null;
}

function classify(rows: ExperienceRow[], gradYear: number | null, nowY: number, nowM: number): ClassifiedRow[] {
  const gradM = gradYear ? gradYear * 12 + 6 : null; // graduation assumed mid-year
  return rows.map((row) => {
    const iv = interval(row, nowY, nowM);
    const titleSaysNo = NON_CAREER_TITLE.test(row.title || "");
    const typeSaysNo = NON_CAREER_TYPE.test(row.employment_type || "");
    let career = !titleSaysNo && !typeSaysNo;
    let clamped = iv;
    if (career && gradM && iv) {
      if (iv[1] <= gradM) career = false; // ended before graduation: pre-career
      else if (iv[0] < gradM) clamped = [gradM, iv[1]]; // spans graduation: count from it
    }
    return { row, career, iv: career ? clamped : iv };
  });
}

export function computeFacts(
  experiences: ExperienceRow[],
  skillTerms: string[],
  profileSkills: string[] = [],
  education: unknown = null
): CandidateFacts {
  const now = new Date();
  const nowY = now.getUTCFullYear();
  const nowM = now.getUTCMonth() + 1;
  const rows = [...experiences].sort((a, b) => a.sort_order - b.sort_order);
  const gradYear = undergradEndYear(education);
  const classified = classify(rows, gradYear, nowY, nowM);

  const careerRows = classified.filter((c) => c.career);
  const excludedRows = classified.filter((c) => !c.career);
  const careerIvs = careerRows.map((c) => c.iv).filter((i): i is [number, number] => !!i);
  const excludedIvs = excludedRows.map((c) => c.iv).filter((i): i is [number, number] => !!i);

  const firstStart = careerIvs.length ? Math.min(...careerIvs.map((i) => i[0])) : null;
  const careerSince = firstStart
    ? `${MONTH_NAMES[(firstStart % 12 || 12) - 1]} ${Math.floor((firstStart - 1) / 12)}`
    : null;

  const current = careerRows.find((c) => c.row.is_current)?.row || rows.find((r) => r.is_current) || rows[0] || null;

  const skills: SkillFact[] = [];
  for (const skill of [...new Set(skillTerms.map((s) => s.trim()).filter(Boolean))].slice(0, 20)) {
    const usingCareer = careerRows.filter((c) => usedSkill(c.row, skill));
    const usingExcluded = excludedRows.filter((c) => usedSkill(c.row, skill));
    if (!usingCareer.length && !usingExcluded.length) {
      // Harvest often leaves per-position skills empty — a profile-level
      // listing is still a fact, just a weaker one.
      if (profileSkills.some((s) => skillMatches(skill, s))) {
        skills.push({ skill, years: 0, usedInCurrentRole: false, positions: [], listedOnly: true });
      }
      continue;
    }
    skills.push({
      skill,
      years: mergedYears(usingCareer.map((c) => c.iv).filter((i): i is [number, number] => !!i)),
      usedInCurrentRole: !!current && usingCareer.some((c) => c.row === current),
      positions: usingCareer
        .slice(0, 4)
        .map((c) => [c.row.title, c.row.company_name && `at ${c.row.company_name}`].filter(Boolean).join(" "))
        .filter(Boolean),
      ...(usingExcluded.length ? { usedInInternships: true } : {}),
    });
  }

  // Per-position skill co-occurrence: which of the role-relevant terms were
  // used together in one job. Deterministic basis for inferred signals.
  const terms = [...new Set(skillTerms.map((s) => s.trim()).filter(Boolean))].slice(0, 20);
  const coOccurrences: SkillCoOccurrence[] = [];
  for (const c of classified) {
    const used = terms.filter((t) => usedSkill(c.row, t));
    if (used.length < 2) continue;
    const startY = c.row.start_year;
    const endY = c.row.is_current ? "now" : c.row.end_year || "?";
    coOccurrences.push({
      skills: used.slice(0, 5),
      position: [c.row.title, c.row.company_name && `at ${c.row.company_name}`].filter(Boolean).join(" "),
      span: startY ? `${startY}–${endY}` : "undated",
      career: c.career,
    });
  }
  coOccurrences.sort((a, b) => Number(b.career) - Number(a.career) || b.skills.length - a.skills.length);

  return {
    careerYears: careerIvs.length ? mergedYears(careerIvs) : rows.length ? 0 : null,
    careerSince,
    excludedCount: excludedRows.length,
    excludedYears: mergedYears(excludedIvs),
    currentTitle: current?.title ?? null,
    currentCompany: current?.company_name ?? null,
    skills,
    coOccurrences: coOccurrences.slice(0, 4),
  };
}

export async function fetchExperiences(candidateId: string): Promise<ExperienceRow[]> {
  try {
    const res = await sbRest(
      `candidate_experiences?candidate_id=eq.${candidateId}&select=title,company_name,employment_type,start_month,start_year,end_month,end_year,is_current,duration_text,skills,description,sort_order&order=sort_order.asc`
    );
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

// Compact evidence block for prompts and recommendation cards.
export function formatFacts(facts: CandidateFacts): string {
  const lines: string[] = [];
  if (facts.careerYears !== null) {
    const excl = facts.excludedCount
      ? `; excludes ${facts.excludedCount} internship/clinic position${facts.excludedCount > 1 ? "s" : ""} totaling ${facts.excludedYears}y`
      : "";
    if (facts.careerYears === 0 && facts.excludedYears > 0) {
      lines.push(`Career experience: 0 years — new grad with ${facts.excludedYears}y of internships`);
    } else {
      lines.push(
        `Career experience: ${facts.careerYears} years${facts.careerSince ? ` (since ${facts.careerSince}${excl})` : ""}`
      );
    }
  }
  if (facts.currentTitle) {
    lines.push(`Current role: ${facts.currentTitle}${facts.currentCompany ? ` at ${facts.currentCompany}` : ""}`);
  }
  for (const co of facts.coOccurrences) {
    lines.push(
      `Co-occurrence: ${co.skills.join(" + ")} used in the same position (${co.position}, ${co.span}${co.career ? "" : "; internship/clinic"})`
    );
  }
  for (const s of facts.skills) {
    if (s.listedOnly) {
      lines.push(`${s.skill}: listed on profile, no dated position evidence`);
    } else if (s.years === 0 && s.usedInInternships) {
      lines.push(`${s.skill}: used during internships only`);
    } else {
      lines.push(
        `${s.skill}: ${s.years}y career${s.usedInCurrentRole ? ", incl. current role" : ""} (${s.positions[0] || "prior role"})${s.usedInInternships ? "; also used in internships" : ""}`
      );
    }
  }
  return lines.join("\n");
}
