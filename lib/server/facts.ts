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
  location?: string | null;
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
  /** Post-graduation, non-internship years in ENGINEERING titles. What a
   *  "4+ years software engineering" row is about: a trader's or a
   *  consultant's years are a career, not engineering. */
  engineeringYears: number | null;
  /** Career years under titles that say neither (R&D, Founder, Forward
   *  Deployed Engineer). Never enough on their own for a yes, but they stop a
   *  "no": an unusual title must not make a senior person a Pass. */
  unclassifiedYears: number;
  /** Career years in work that is clearly not engineering, with what it was. */
  otherYears: number;
  otherWork: string[];
  /** The latest-starting current career role, and how long they have held it. */
  currentSince: string | null;
  currentTenureYears: number | null;
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

// Student-era and side roles: not a career position at all. The first list
// is reliable wherever it appears in a title. The second is only trusted as
// the ROLE itself, at the head of the title: "Student Tutor" is not a job,
// "Software Engineer, Student Loans" is. ("President of" was tried and cut a
// Vice President of Engineering's whole tenure.)
const NON_CAREER_TITLE =
  /\bintern(ship)?\b|co-?op\b|\bclinic\b|\bfellow(ship)?\b|research assistant|teaching assistant|learning assistant|\bapprentice\b/i;
const NON_CAREER_HEAD = /^(undergraduate|student|volunteer|tutor)\b/i;
const NON_CAREER_TYPE = /intern|part-?time|apprentice/i;
const INTERN_TITLE = /\bintern(ship)?\b|co-?op\b/i;
const isNonCareerTitle = (title: string) => {
  const head = title.split(/\s*[,(–—|@]\s*|\s+-\s+/)[0] || "";
  return NON_CAREER_TITLE.test(title) || NON_CAREER_HEAD.test(head.trim());
};

// What kind of work a career position was. The years row can make someone a
// Pass, so the buckets are built to fail safe:
//   engineering   counts toward a software-engineering bar
//   other         a clear non-engineering FUNCTION (sales, trading, consulting
//                 strategy, product management): the only bucket that lets a
//                 "no" through
//   unclassified  everything else, including ladder words that say nothing
//                 about the work (Analyst, Associate, Consultant, Research
//                 Scientist, Data Scientist): cannot give a yes, blocks a no
// A title is only ever read toward "other" when nothing in the row's own
// description or skills says engineering.
const NOT_ENGINEERING_FUNCTION =
  /\b(sales|marketing|recruit\w*|talent|trader|trading|portfolio|investment|banker|banking|actuar\w*|accountant|auditor|product (manager|owner|marketing)|program manager|project manager|strateg\w*|economist|data scientist|statistic\w*|teacher|professor|lecturer|editor|writer|journalist|musician|bassist|counsel|paralegal|nurse|physician|chief of staff)\b/i;
const MISLEADING_ENGINEER = /\b(sales|solutions?|support|customer|field|pre-?sales) engineer/i;
// Engineers of other things: real engineering, not software. Never a yes for
// a software bar, never a reason for a no.
const OTHER_DISCIPLINE =
  /\b(mechanical|civil|chemical|structural|industrial|process|petroleum|aerospace|biomedical|manufacturing|quality|electrical|hardware|audio|sound|building|landscape)\b/i;
const SOFTWARE_TITLE =
  /\b(software|developer|programmer|swe|sde|mts|member of (the )?technical staff|sre|devops|full[- ]?stack|back[- ]?end|front[- ]?end|firmware|embedded|applied scientist|machine learning|ml|data engineer|platform engineer|infrastructure engineer|security engineer|site reliability|cto|chief technology)\b/i;
const ENGINEER_WORD = /\b(engineer|engineering|architect|tech(nical)? lead)\b/i;
// A row under a non-engineering title is lifted out of "other" only when its
// own text says engineering work was done: two or more distinct signs. One
// language tag is not one (a quantitative trader tags Python; so does every
// analyst), and would have stopped a trader's years reading as a "no".
const ENGINEERING_SIGNS =
  /\b(software|backend|back-end|frontend|front-end|full[- ]?stack|apis?|microservices?|kubernetes|docker|terraform|aws|gcp|azure|distributed systems?|infrastructure|codebase|deployed|shipped|ci\/cd|pipelines?|services)\b/gi;
const saysEngineering = (text: string) => new Set((text.match(ENGINEERING_SIGNS) || []).map((m) => m.toLowerCase())).size >= 2;

export type WorkKind = "engineering" | "other" | "unclassified";
export function workKind(title: string | null | undefined, rowText = ""): WorkKind {
  const t = title || "";
  const lift = (k: WorkKind): WorkKind => (k === "other" && saysEngineering(rowText) ? "unclassified" : k);
  if (MISLEADING_ENGINEER.test(t)) return lift("other");
  if (/forward[- ]deployed/i.test(t)) return "unclassified";
  // A clear non-engineering function wins over a stray "engineering" in the
  // title ("Engineering Recruiter", "Software Sales"), unless the title is
  // itself an engineer's ("Software Engineer, Trading Systems").
  const isEngineerTitle = SOFTWARE_TITLE.test(t) || ENGINEER_WORD.test(t);
  if (NOT_ENGINEERING_FUNCTION.test(t) && !/\b(engineer|developer|programmer|architect)\b/i.test(t)) return lift("other");
  if (SOFTWARE_TITLE.test(t)) return "engineering";
  if (ENGINEER_WORD.test(t)) return OTHER_DISCIPLINE.test(t) ? "unclassified" : "engineering";
  return isEngineerTitle ? "engineering" : "unclassified";
}

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
// Months are counted the way LinkedIn shows them: inclusive of the last one.
// "Sep 2023 – Dec 2024" is 16 months, and a current role counts this month.
// (Counting to the START of the end month lost a month per position: three
// jobs over exactly three years read as 2.8.) A year-only date has no month
// to include, so it stays a mid-year estimate.
function interval(row: ExperienceRow, nowY: number, nowM: number): [number, number] | null {
  if (!row.start_year) return null;
  const start = row.start_year * 12 + (row.start_month ?? 6);
  const end =
    row.is_current || !row.end_year
      ? nowY * 12 + nowM + 1
      : row.end_year * 12 + (row.end_month != null ? row.end_month + 1 : 6);
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
    if (!/\bbachelor|\bb\.?\s?s\b|\bb\.?\s?a\b|\bb\.?\s?eng\b|\bb\.?\s?sc\b|\bb\.?\s?tech\b|\bb\.e\.|^\s*be\b|\bba\.?sc\b|\ba\.b\.|\bbcs\b|\bbba\b|\bb\.?\s?com\b|undergrad/i.test(degree)) continue;
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
  const eligible = (r: ExperienceRow) => !isNonCareerTitle(r.title || "") && !NON_CAREER_TYPE.test(r.employment_type || "");
  const all = rows.map((r) => ({ r, iv: interval(r, nowY, nowM) }));

  // No graduation year on the profile. Student jobs ("Web Developer", 2021,
  // full-time, no degree date) then read as career years, and someone two
  // years out of school shows 4+. The way a recruiter counts it: the career
  // starts when the last internship ended. This is an INFERENCE, so it is
  // held to be strictly weaker than a real graduation year:
  //  - only internships with a real end date count (one left "Present" would
  //    put the start of the career at today);
  //  - if the person held a real job for a year or more BEFORE their first
  //    internship, they went back to school or changed career: no inference;
  //  - it only removes short rows (under a year) that ended before it, never
  //    clamps a job that spans it;
  //  - if it would leave no career at all, it is dropped.
  let inferredStart: number | null = null;
  if (gradM == null) {
    const interns = all.filter((x) => x.iv && INTERN_TITLE.test(x.r.title || "") && !x.r.is_current && x.r.end_year);
    if (interns.length) {
      const firstInternStart = Math.min(...interns.map((x) => (x.iv as [number, number])[0]));
      const lastInternEnd = Math.max(...interns.map((x) => (x.iv as [number, number])[1]));
      const months = (x: { r: ExperienceRow; iv: [number, number] | null }) => (x.iv ? x.iv[1] - x.iv[0] : 0);
      const yearOnly = (r: ExperienceRow) => r.start_month == null || (!r.is_current && r.end_month == null);
      // A real job before the first internship: a year or more with months
      // given, or a year and a half when only years are given ("2021 - 2022"
      // is twelve months on paper and could be two).
      const workedBefore = all.some((x) => x.iv && eligible(x.r) && x.iv[0] < firstInternStart && months(x) >= (yearOnly(x.r) ? 18 : 12));
      if (!workedBefore) inferredStart = lastInternEnd;
    }
  }
  const build = (start: number | null) =>
    all.map(({ r: row, iv }) => {
      let career = eligible(row);
      let clamped = iv;
      if (career && iv) {
        if (gradM) {
          if (iv[1] <= gradM) career = false; // ended before graduation: pre-career
          else if (iv[0] < gradM) clamped = [gradM, iv[1]]; // spans graduation: count from it
        } else if (start && iv[1] <= start && iv[1] - iv[0] <= (row.start_month == null || row.end_month == null ? 12 : 11)) career = false; // a short student-era job
      }
      return { row, career, iv: career ? clamped : iv };
    });
  const out = build(inferredStart);
  return inferredStart && !out.some((c) => c.career) && all.some((x) => eligible(x.r)) ? build(null) : out;
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

  // Work kind per career position, read from the whole row.
  const rowText = (r: ExperienceRow) => [(r.skills || []).join(", "), r.description].filter(Boolean).join("\n");
  const kinds = careerRows.map((c) => ({ c, kind: workKind(c.row.title, rowText(c.row)) }));
  // The current role: among the rows still "Present", an engineering one
  // before anything else (an advisor seat or a side project started later is
  // not the day job), then the latest to start (an old job never closed on
  // LinkedIn is not the current one).
  const rankKind = (k: WorkKind) => (k === "engineering" ? 0 : k === "unclassified" ? 1 : 2);
  const currentCareer = kinds
    .filter((k) => k.c.row.is_current && k.c.iv)
    .sort((a, b) => rankKind(a.kind) - rankKind(b.kind) || (b.c.iv as [number, number])[0] - (a.c.iv as [number, number])[0])[0]?.c;
  const current = currentCareer?.row || careerRows.find((c) => c.row.is_current)?.row || rows.find((r) => r.is_current) || rows[0] || null;
  const currentIv = currentCareer?.iv || null;

  const engIvs = kinds.filter((k) => k.kind === "engineering").map((k) => k.c.iv).filter((i): i is [number, number] => !!i);
  const unclIvs = kinds.filter((k) => k.kind === "unclassified").map((k) => k.c.iv).filter((i): i is [number, number] => !!i);
  // Positions with no dates at all say nothing about years: null, never 0.
  const anyDated = classified.some((c) => c.iv);
  const engineeringYears = !anyDated ? null : careerIvs.length ? mergedYears(engIvs) : 0;
  const engOrUncl = mergedYears([...engIvs, ...unclIvs]);
  const careerTotal = careerIvs.length ? mergedYears(careerIvs) : 0;
  const otherWork = kinds
    .filter((k) => k.kind === "other" && k.c.iv)
    .map((k) => `${k.c.row.title}${k.c.row.company_name ? ` at ${k.c.row.company_name}` : ""} ${mergedYears([k.c.iv as [number, number]])}y`)
    .slice(0, 3);

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
    engineeringYears,
    unclassifiedYears: Math.max(0, Math.round((engOrUncl - (engineeringYears || 0)) * 10) / 10),
    otherYears: Math.max(0, Math.round((careerTotal - engOrUncl) * 10) / 10),
    otherWork,
    currentSince: currentIv ? `${MONTH_NAMES[(currentIv[0] % 12 || 12) - 1]} ${Math.floor((currentIv[0] - 1) / 12)}` : null,
    currentTenureYears: currentIv ? mergedYears([currentIv]) : null,
    careerYears: !anyDated ? null : careerIvs.length ? mergedYears(careerIvs) : 0,
    careerSince,
    excludedCount: excludedRows.length,
    excludedYears: mergedYears(excludedIvs),
    currentTitle: current?.title ?? null,
    currentCompany: current?.company_name ?? null,
    skills,
    coOccurrences: coOccurrences.slice(0, 4),
  };
}

/** Each position as the text a technology can be found in (title, position
 *  skills, description), with whether it is a career position. A scorecard
 *  row that names a technology is met on a JOB, not on the profile's skills
 *  list and not on an internship alone. */
export interface JobText {
  title: string;
  company: string;
  career: boolean;
  current: boolean;
  text: string;
  /** Location and duration as the profile prints them beside the title: not
   *  evidence of anything, so not allowed to ground a quote. */
  noise: string;
}
export function jobTexts(experiences: ExperienceRow[], education: unknown = null): JobText[] {
  const now = new Date();
  const rows = [...experiences].sort((a, b) => a.sort_order - b.sort_order);
  return classify(rows, undergradEndYear(education), now.getUTCFullYear(), now.getUTCMonth() + 1).map((c) => ({
    title: c.row.title || "",
    company: c.row.company_name || "",
    career: c.career,
    current: !!c.row.is_current,
    text: [c.row.title, (c.row.skills || []).join(", "), c.row.description].filter(Boolean).join("\n"),
    noise: [c.row.location, c.row.duration_text].filter(Boolean).join(" "),
  }));
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
  if (facts.engineeringYears !== null && facts.careerYears !== null && (facts.otherYears > 0 || facts.unclassifiedYears > 0)) {
    lines.push(
      `Engineering experience: ${facts.engineeringYears} years in engineering titles` +
        (facts.otherYears > 0 ? `; ${facts.otherYears}y in other work${facts.otherWork.length ? ` (${facts.otherWork.join("; ")})` : ""}` : "") +
        (facts.unclassifiedYears > 0 ? `; ${facts.unclassifiedYears}y under titles that do not say` : "")
    );
  }
  if (facts.currentTitle) {
    lines.push(
      `Current role: ${facts.currentTitle}${facts.currentCompany ? ` at ${facts.currentCompany}` : ""}` +
        (facts.currentSince ? `, since ${facts.currentSince}${facts.currentTenureYears != null ? ` (${facts.currentTenureYears}y)` : ""}` : "")
    );
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
      lines.push(`${s.skill}: tagged on an internship only; other use not shown`);
    } else {
      lines.push(
        `${s.skill}: ${s.years}y career${s.usedInCurrentRole ? ", incl. current role" : ""} (${s.positions[0] || "prior role"})${s.usedInInternships ? "; also used in internships" : ""}`
      );
    }
  }
  return lines.join("\n");
}
