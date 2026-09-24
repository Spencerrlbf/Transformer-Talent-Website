// A person in the pool (the candidates table) as the judge and the signals
// read them: the dated positions, the education, the skills and one profile
// text, all from what is already stored. Only 434 of 420,000 people have a
// Harvest payload; everyone else is read from the columns the old database
// import filled (work_experience, education, profile_summary, top_skills).
import crypto from "node:crypto";
import { computeFacts, seniorityOf, type ExperienceRow } from "../facts";
import { titleFamilyOf, topEmployerOf, topUniversityOf, type TitleFamily } from "../signals/match";

export interface PoolCandidate {
  id: string;
  full_name?: string | null;
  headline?: string | null;
  current_title?: string | null;
  current_company?: string | null;
  profile_summary?: string | null;
  location?: string | null;
  work_experience?: unknown;
  education?: string | null;
  education_schools?: string[] | null;
  top_skills?: string[] | null;
  all_skills_text?: string | null;
  calculated_experience_years?: number | null;
  total_experience_years?: number | null;
  updated_at?: string | null;
}

type PoolDate = { year?: number | null; month?: string | number | null; day?: number | null } | null;
/** Positions come in two shapes: most rows carry `company` with `start_date`
 *  and `end_date` (month names, an `is_current` flag); about one row in
 *  fifteen carries `companyName` with `start` and `end` (month numbers, and
 *  an end year of 0 for a position still held). */
type PoolPosition = {
  title?: string | null;
  company?: string | null;
  companyName?: string | null;
  duration?: string | null;
  location?: string | null;
  is_current?: boolean | null;
  description?: string | null;
  start_date?: PoolDate;
  end_date?: PoolDate;
  start?: PoolDate;
  end?: PoolDate;
  company_linkedin_url?: string | null;
};

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const monthNum = (m: string | number | null | undefined): number | null => {
  if (typeof m === "number") return m >= 1 && m <= 12 ? m : null;
  if (!m) return null;
  return MONTHS[String(m).trim().toLowerCase().slice(0, 4)] ?? MONTHS[String(m).trim().toLowerCase().slice(0, 3)] ?? null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const yearNum = (v: unknown): number | null => {
  const n = num(v);
  return n && n > 1900 ? n : null;
};
const companyOf = (p: PoolPosition): string | null => str(p.company) ?? str(p.companyName);
const startOf = (p: PoolPosition): PoolDate => p.start_date ?? p.start ?? null;
const endOf = (p: PoolPosition): PoolDate => p.end_date ?? p.end ?? null;

const positionsOf = (c: PoolCandidate): PoolPosition[] =>
  Array.isArray(c.work_experience) ? (c.work_experience as PoolPosition[]).filter((p) => p && typeof p === "object") : [];

/** The dated positions in the shape the facts code reads. */
export function poolExperiences(c: PoolCandidate): ExperienceRow[] {
  return positionsOf(c)
    .slice(0, 25)
    .map((p, i) => {
      const start = startOf(p);
      const end = endOf(p);
      const endYear = yearNum(end?.year);
      return {
        title: str(p.title),
        company_name: companyOf(p),
        employment_type: null,
        location: str(p.location),
        start_month: monthNum(start?.month),
        start_year: yearNum(start?.year),
        end_month: endYear ? monthNum(end?.month) : null,
        end_year: endYear,
        // Held now: flagged so, or no end on the first position, or the
        // second shape's explicit end year of 0.
        is_current: p.is_current === true || (endYear === null && (i === 0 || p.end?.year === 0)),
        duration_text: str(p.duration),
        skills: [],
        description: str(p.description)?.slice(0, 8000) ?? null,
        sort_order: i,
      };
    });
}

/** The education lines ("School - Degree in Field") in the shape the card's
 *  school code reads. Years are not stored for the old database's people. */
export function poolEducation(c: PoolCandidate): { schoolName: string; degree: string | null; fieldOfStudy: string | null; endDate: { year: number | null } }[] {
  const lines = String(c.education || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const fromLines = lines.map((line) => {
    const at = line.indexOf(" - ");
    const schoolName = (at > 0 ? line.slice(0, at) : line).trim();
    const rest = at > 0 ? line.slice(at + 3).trim() : "";
    const inAt = rest.search(/\s+in\s+/i);
    const degree = (inAt > 0 ? rest.slice(0, inAt) : rest).trim() || null;
    const fieldOfStudy = inAt > 0 ? rest.slice(inAt).replace(/^\s+in\s+/i, "").trim() || null : null;
    return { schoolName, degree, fieldOfStudy, endDate: { year: null } };
  });
  if (fromLines.length) return fromLines;
  return (c.education_schools || []).filter(Boolean).map((schoolName) => ({ schoolName, degree: null, fieldOfStudy: null, endDate: { year: null } }));
}

/** The skills list, from the tagged top skills and the free-text list. */
export function poolSkills(c: PoolCandidate): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim();
    const k = t.toLowerCase();
    if (t && t.length <= 60 && !seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  };
  for (const s of c.top_skills || []) if (typeof s === "string") add(s);
  for (const s of String(c.all_skills_text || "").split(/,|\n/)) add(s);
  return out.slice(0, 60);
}

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const when = (r: ExperienceRow): string => {
  const from = [r.start_month ? MONTH_NAMES[r.start_month] : null, r.start_year].filter(Boolean).join(" ");
  const to = r.is_current || !r.end_year ? "now" : [r.end_month ? MONTH_NAMES[r.end_month] : null, r.end_year].filter(Boolean).join(" ");
  return from ? `${from} to ${to}` : to !== "now" ? `to ${to}` : "";
};

/** The profile as one text, the way the judge reads a LinkedIn profile:
 *  headline, about, every position with its dates and description, the
 *  education and the skills. */
export function poolProfileText(c: PoolCandidate): string {
  const parts: string[] = [];
  const head = [str(c.headline), [str(c.current_title), str(c.current_company)].filter(Boolean).join(" at ") || null, str(c.location)].filter(Boolean);
  if (head.length) parts.push(head.join(". "));
  if (str(c.profile_summary)) parts.push(`About: ${c.profile_summary!.trim()}`);
  const rows = poolExperiences(c);
  if (rows.length) {
    parts.push("Experience:");
    for (const r of rows) {
      const line = [[r.title, r.company_name].filter(Boolean).join(" at "), when(r), r.location].filter(Boolean).join(" · ");
      parts.push(`- ${line}${r.description ? `\n  ${r.description.trim().replace(/\s*\n\s*/g, "\n  ")}` : ""}`);
    }
  }
  const edu = poolEducation(c);
  if (edu.length) parts.push(`Education:\n${edu.map((e) => `- ${[e.schoolName, e.degree, e.fieldOfStudy].filter(Boolean).join(" · ")}`).join("\n")}`);
  const skills = poolSkills(c);
  if (skills.length) parts.push(`Skills: ${skills.join(", ")}`);
  return parts.join("\n\n");
}

export interface PersonSignals {
  candidate_id: string;
  years: number | null;
  engineering_years: number | null;
  current_tenure_months: number | null;
  current_title: string | null;
  title_family: TitleFamily[];
  seniority: string | null;
  top_university_tier: 1 | 2 | null;
  top_university: string | null;
  top_employer_tier: 1 | 2 | null;
  top_employer: string | null;
  has_descriptions: boolean;
  positions: number;
  source_hash: string;
}

/** What the signals are computed from, hashed: unchanged inputs mean an unchanged row. */
export function poolSourceHash(c: PoolCandidate): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([c.current_title, c.current_company, c.headline, c.work_experience ?? null, c.education, c.education_schools, c.calculated_experience_years, c.total_experience_years, "v1"]))
    .digest("hex")
    .slice(0, 32);
}

/** The signals for one person, by code, from the stored data and the lists. */
export function poolSignals(c: PoolCandidate): PersonSignals {
  const rows = poolExperiences(c);
  const education = poolEducation(c);
  const facts = computeFacts(rows, [], poolSkills(c), education);
  const currentTitle = facts.currentTitle || str(c.current_title);
  const companies = [facts.currentCompany, str(c.current_company), ...rows.map((r) => r.company_name)];
  const schools = education.map((e) => e.schoolName);
  const uni = topUniversityOf(schools);
  const employer = topEmployerOf(companies);
  const years = facts.careerYears ?? c.calculated_experience_years ?? c.total_experience_years ?? null;
  return {
    candidate_id: c.id,
    years: years != null ? Math.round(years * 10) / 10 : null,
    engineering_years: facts.engineeringYears != null ? Math.round(facts.engineeringYears * 10) / 10 : null,
    current_tenure_months: facts.currentTenureYears != null ? Math.max(0, Math.round(facts.currentTenureYears * 12)) : null,
    current_title: currentTitle,
    title_family: titleFamilyOf(currentTitle),
    seniority: seniorityOf(currentTitle).level,
    top_university_tier: uni?.tier ?? null,
    top_university: uni?.name ?? null,
    top_employer_tier: employer?.tier ?? null,
    top_employer: employer?.name ?? null,
    has_descriptions: rows.some((r) => !!r.description),
    positions: rows.length,
    source_hash: poolSourceHash(c),
  };
}
