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
import { topEmployerOf, topUniversityOf } from "./signals/match";
import type { ProfileFacts } from "@/lib/rolecard";

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
const MANAGES_PEOPLE = /\b(manager|director|head of|vp|vice president|svp|evp)\b/i;
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
  // Managing engineers is not engineering ("Engineering Manager", "Director
  // of Engineering", "Head of Platform"): such years cannot meet a software
  // engineering bar, and cannot make anyone a Pass either. A CTO's stay
  // engineering (at most companies that hire from this pool they build).
  if (MANAGES_PEOPLE.test(t) && !/\b(cto|chief technology)\b/i.test(t)) return "unclassified";
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

// A bachelor's degree, as people write it.
const BACHELOR = /\bbachelor|\bb\.?\s?s\b|\bb\.?\s?a\b|\bb\.?\s?eng\b|\bb\.?\s?sc\b|\bb\.?\s?tech\b|\bb\.e\.|^\s*be\b|\bba\.?sc\b|\ba\.b\.|\bbcs\b|\bbba\b|\bb\.?\s?com\b|undergrad/i;

// Final undergrad graduation year from a Harvest education list. Bachelor
// degrees only — masters/PhD must not push the career anchor later.
export function undergradEndYear(education: unknown): number | null {
  if (!Array.isArray(education)) return null;
  let latest: number | null = null;
  for (const ed of education as Record<string, any>[]) {
    const degree = String(ed?.degree || "");
    if (!BACHELOR.test(degree)) continue;
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
  /** The position's skill tags as written, so a technology found on a job
   *  can be quoted as the tag itself. */
  tags: string[];
  /** The dates as the profile gives them ("Aug 2022", "2020", "Present") and
   *  the position's own length in years, for the report card. Null when the
   *  position is undated. */
  from: string | null;
  to: string | null;
  years: number | null;
  /** The position's own span in months since year 0 (see interval), so the
   *  years of a skill tagged on several jobs can be merged without counting
   *  an overlap twice. Null when the position is undated. */
  span?: [number, number] | null;
  /** The span as the career counts it: a career position that spans
   *  graduation starts at graduation here, so a skill's years agree with the
   *  facts. Null on a position that is not a career one, or is undated. */
  careerSpan?: [number, number] | null;
}
const monthYear = (month: number | null, year: number | null): string | null =>
  year ? `${month ? `${MONTH_NAMES[month - 1]} ` : ""}${year}` : null;
export function jobTexts(experiences: ExperienceRow[], education: unknown = null): JobText[] {
  const now = new Date();
  const nowY = now.getUTCFullYear();
  const nowM = now.getUTCMonth() + 1;
  const rows = [...experiences].sort((a, b) => a.sort_order - b.sort_order);
  return classify(rows, undergradEndYear(education), nowY, nowM).map((c) => {
    // The position's own span, as written: the report card shows the dates
    // beside it, so its years must agree with them (the career years clamp a
    // job that spans graduation; this does not).
    const own = interval(c.row, nowY, nowM);
    return {
      title: c.row.title || "",
      company: c.row.company_name || "",
      career: c.career,
      current: !!c.row.is_current,
      text: [c.row.title, (c.row.skills || []).join(", "), c.row.description].filter(Boolean).join("\n"),
      noise: [c.row.location, c.row.duration_text].filter(Boolean).join(" "),
      tags: (c.row.skills || []).filter(Boolean),
      from: monthYear(c.row.start_month, c.row.start_year),
      to: c.row.is_current ? "Present" : monthYear(c.row.end_month, c.row.end_year),
      years: own ? mergedYears([own]) : null,
      span: own,
      careerSpan: c.career ? c.iv : null,
    };
  });
}

const companyKey = (name: string) =>
  name.toLowerCase().replace(/[.,]/g, " ").replace(/\b(inc|llc|lp|ltd|plc|corp|corporation|co|company|investments?|technologies|labs?|ai|the)\b/g, " ").replace(/\s+/g, " ").trim();
/** "Two Sigma" is "Two Sigma Investments, LP"; "Meta" is not "Metaphor". */
export const sameCompany = (a: string, b: string) => {
  const x = companyKey(a), y = companyKey(b);
  return !!x && !!y && (x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `));
};

// A postgraduate degree, as people write it: a master's, an MBA, a doctorate.
const POSTGRAD = /\bmaster|\bm\.?\s?s\.?(?:c|e)?\b|\bm\.?\s?eng\b|\bm\.?\s?tech\b|\bm\.?\s?phil\b|\bm\.?\s?a\b|\bm\.?\s?f\.?\s?a\b|\bmba\b|\bmres\b|\bmpa\b|\bmpp\b|\bllm\b|\bj\.?\s?d\b|\bm\.?\s?d\b|\bph\.?\s?d\b|\bd\.?\s?phil\b|\bdoctor|\bpostgrad|\bgraduate\b/i;

type School = NonNullable<ProfileFacts["school"]>;

/** The education list as the card reads it: one entry per named school. */
/** Every school named on the profile, for the top-university list. */
export function schoolNamesOf(education: unknown): string[] {
  return schoolEntries(education).map((e) => e.name).filter(Boolean);
}

function schoolEntries(education: unknown): School[] {
  if (!Array.isArray(education)) return [];
  return (education as Record<string, any>[])
    .map((ed) => {
      const name = String(ed?.schoolName || ed?.school || "").trim();
      let year: number | null = typeof ed?.endDate?.year === "number" ? ed.endDate.year : null;
      if (!year && typeof ed?.period === "string") {
        const m = ed.period.match(/(\d{4})\s*$/);
        if (m) year = parseInt(m[1], 10);
      }
      const degree = String(ed?.degree || "").trim() || null;
      const field = String(ed?.fieldOfStudy || "").trim() || null;
      return name ? { name, degree, field, year } : null;
    })
    .filter((e): e is School => !!e);
}
const latestOf = (list: School[]): School | null => [...list].sort((a, b) => (b.year ?? -1) - (a.year ?? -1))[0] ?? null;
const isBachelor = (e: School) => !!e.degree && BACHELOR.test(e.degree);
const isPostgrad = (e: School) => !!e.degree && !isBachelor(e) && POSTGRAD.test(e.degree);

/** The schools on the report card. `school` is the latest bachelor's when
 *  there is one, else the latest education entry. `school2` is the latest
 *  OTHER degree, greyed under it: a postgraduate degree when the first is
 *  the bachelor's, else the bachelor's; never a school with no degree named
 *  (a high school, a certificate). */
export function schoolsOf(education: unknown): { school: ProfileFacts["school"]; school2: ProfileFacts["school2"] } {
  const entries = schoolEntries(education);
  if (!entries.length) return { school: null, school2: null };
  const bachelors = entries.filter(isBachelor);
  const school = latestOf(bachelors.length ? bachelors : entries) as School;
  const others = entries.filter((e) => e !== school);
  const school2 = latestOf(others.filter(isBachelor(school) ? isPostgrad : (e) => isBachelor(e) || isPostgrad(e)));
  return { school, school2 };
}

/** The school shown first on the report card. */
export const schoolOf = (education: unknown): ProfileFacts["school"] => schoolsOf(education).school;

/** The level the current title states, and nothing else. An internship or
 *  a Junior title reads junior whatever else the title says ("Senior
 *  Software Engineer Intern" is an intern); a Staff, Principal,
 *  Distinguished or Architect title reads staff; Lead, Team Leader, Head of,
 *  Manager, Director, a VP, SVP or EVP, a founder or a C-level title reads
 *  lead; Senior reads senior; anything else is mid, "no senior title yet".
 *  "Member of Technical Staff" is a rank at a lab, not a staff title, a
 *  chief of staff is not staff level, and lead generation is not leading. */
export function seniorityOf(title: string | null | undefined): NonNullable<ProfileFacts["seniority"]> {
  const given = (title || "").trim();
  if (!given) return { level: null, note: "no current title" };
  const t = given.replace(/member of (the )?technical staff|technical staff|chief of staff|lead generation/gi, " ");
  const from = "from the current title";
  if (/\b(junior|jr|intern|internship)\b/i.test(t)) return { level: "junior", note: from };
  if (/\b(staff|principal|distinguished|architect)\b/i.test(t)) return { level: "staff", note: from };
  if (/\b(lead|team leader|head of|manager|director|vp|svp|evp|vice president|ceo|cto|coo|chief technology officer|co-?founder|founder)\b/i.test(t)) return { level: "lead", note: from };
  if (/\b(senior|sr)\b/i.test(t)) return { level: "senior", note: from };
  return { level: "mid", note: "no senior title yet" };
}

/** A skill tag as a key: "Rust (Programming Language)" and "rust" are one skill. */
export const skillKey = (tag: string) => tag.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9+#.]+/g, " ").trim();
const skillName = (tag: string) => tag.replace(/\s*\(.*?\)\s*$/, "").trim() || tag.trim();
const MAX_PROFILE_SKILLS = 40;
const MAX_JOB_SKILLS = 8;

/** Facts about the person for the report card, computed by CODE: years,
 *  tenure, the companies with their dates and skill tags, the school, the
 *  level the current title states, the skills with their dated years, and
 *  the current employer's size when its company page is known. Never a model. */
export function profileFacts(args: {
  facts: CandidateFacts | null;
  jobs: JobText[];
  education?: unknown;
  employer?: { name: string; employees: number | null; founded: number | null } | null;
  /** The profile's own skills list, for the skills never tagged on a dated job. */
  profileSkills?: string[];
}): ProfileFacts {
  const { facts, jobs } = args;
  const dated = jobs.filter((j) => j.career && j.years != null);
  const avg = dated.length ? Math.round((dated.reduce((a, j) => a + (j.years as number), 0) / dated.length) * 10) / 10 : null;
  // The current job as the facts chose it (an engineering role among those
  // still "Present"), first; the rest in profile order.
  const currentJob = facts?.currentTitle ? jobs.find((j) => j.current && j.title === facts.currentTitle && j.company === facts.currentCompany) : undefined;
  const ordered = currentJob ? [currentJob, ...jobs.filter((j) => j !== currentJob)] : jobs;
  const companies = ordered
    .filter((j) => j.from)
    .slice(0, 8)
    .map((j) => ({ name: j.company, title: j.title, from: j.from, to: j.to, years: j.years, career: j.career, ...(j.tags.length ? { skills: j.tags.slice(0, MAX_JOB_SKILLS) } : {}) }));
  // Skills from the job tags, merged by dated positions: the years are the
  // merged span of the CAREER jobs that tag the skill (an overlap counts
  // once; an internship counts for nothing, as the facts rules say), where
  // it was used is the companies, current job first, and a skill is current
  // when the current job tags it. The profile's own list follows, for what
  // was never tagged on a job.
  const isCurrent = (j: JobText) => (currentJob ? j === currentJob : j.current && j.career);
  type Acc = { name: string; ivs: [number, number][]; where: string[]; current: boolean };
  const acc = new Map<string, Acc>();
  for (const j of ordered) {
    for (const tag of j.tags) {
      const key = skillKey(tag);
      if (!key) continue;
      let a = acc.get(key);
      if (!a) {
        a = { name: skillName(tag), ivs: [], where: [], current: false };
        acc.set(key, a);
      }
      // The span as the career counts it (clamped to graduation), so the
      // skill's years are the years the facts show for it.
      const span = j.careerSpan ?? j.span;
      if (j.career && span) a.ivs.push(span);
      const at = j.company || j.title;
      if (at && !a.where.includes(at)) a.where.push(at);
      if (isCurrent(j)) a.current = true;
    }
  }
  const tagged = [...acc.values()]
    .map((a) => ({ name: a.name, years: a.ivs.length ? mergedYears(a.ivs) : null, where: a.where.slice(0, 4), current: a.current, listedOnly: false }))
    .sort((a, b) => (b.years ?? -1) - (a.years ?? -1) || a.name.localeCompare(b.name));
  const listed: ProfileFacts["skills"] = [];
  for (const raw of args.profileSkills || []) {
    const key = skillKey(raw);
    if (!key || acc.has(key) || listed.some((s) => skillKey(s.name) === key)) continue;
    listed.push({ name: skillName(raw), years: null, where: [], current: false, listedOnly: true });
  }
  const skills = [...tagged, ...listed].slice(0, MAX_PROFILE_SKILLS);
  const employer = args.employer && facts?.currentCompany && sameCompany(args.employer.name, facts.currentCompany) ? args.employer : null;
  const employees = employer?.employees ?? null;
  const current: ProfileFacts["current"] = facts?.currentTitle || facts?.currentCompany
    ? {
        title: facts?.currentTitle ?? null,
        company: facts?.currentCompany ?? null,
        months: facts?.currentTenureYears != null ? Math.max(1, Math.round(facts.currentTenureYears * 12)) : null,
        employees,
        founded: employer?.founded ?? null,
        tag: employees != null && employees < 200 ? "startup" : employees != null && employees > 2000 ? "large" : null,
      }
    : null;
  return {
    engineeringYears: facts?.engineeringYears ?? null,
    careerYears: facts?.careerYears ?? null,
    careerSince: facts?.careerSince ?? null,
    avgTenureYears: avg,
    careerJobs: dated.length,
    current,
    companies,
    ...schoolsOf(args.education ?? null),
    // Facts from the lists, by code: a top university among the schools, a
    // top employer among the companies. Never a row, never a label.
    topSchool: topUniversityOf(schoolNamesOf(args.education ?? null)),
    topEmployer: topEmployerOf([facts?.currentCompany, ...jobs.map((j) => j.company)]),
    seniority: seniorityOf(facts?.currentTitle),
    skills,
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
