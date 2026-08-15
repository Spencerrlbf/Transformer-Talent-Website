// Deterministic fact engine: answers the countable screening questions
// ("3+ years of Python?", "used Kubernetes in current role?") straight from
// the structured candidate_experiences rows — free, exact, and impossible to
// hallucinate. The LLM only handles judgment questions.

import { sbRest } from "./supabase";

export interface ExperienceRow {
  title: string | null;
  company_name: string | null;
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
  years: number; // merged-interval years across positions that used it (0 when listed-only)
  usedInCurrentRole: boolean;
  positions: string[]; // "Title at Company" citations
  listedOnly?: boolean; // on their profile, but no dated position evidence
}

export interface CandidateFacts {
  totalYears: number | null;
  currentTitle: string | null;
  currentCompany: string | null;
  skills: SkillFact[];
}

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

export function computeFacts(
  experiences: ExperienceRow[],
  skillTerms: string[],
  profileSkills: string[] = []
): CandidateFacts {
  const now = new Date();
  const nowY = now.getUTCFullYear();
  const nowM = now.getUTCMonth() + 1;
  const rows = [...experiences].sort((a, b) => a.sort_order - b.sort_order);
  const current = rows.find((r) => r.is_current) || rows[0] || null;

  const allIntervals = rows
    .map((r) => interval(r, nowY, nowM))
    .filter((i): i is [number, number] => !!i);

  const skills: SkillFact[] = [];
  for (const skill of [...new Set(skillTerms.map((s) => s.trim()).filter(Boolean))].slice(0, 20)) {
    const using = rows.filter((r) => usedSkill(r, skill));
    if (!using.length) {
      // Harvest often leaves per-position skills empty — a profile-level
      // listing is still a fact, just a weaker one. Report it as such
      // instead of silently dropping the skill.
      if (profileSkills.some((s) => skillMatches(skill, s))) {
        skills.push({ skill, years: 0, usedInCurrentRole: false, positions: [], listedOnly: true });
      }
      continue;
    }
    const ivs = using.map((r) => interval(r, nowY, nowM)).filter((i): i is [number, number] => !!i);
    skills.push({
      skill,
      years: mergedYears(ivs),
      usedInCurrentRole: !!current && using.includes(current),
      positions: using
        .slice(0, 4)
        .map((r) => [r.title, r.company_name && `at ${r.company_name}`].filter(Boolean).join(" "))
        .filter(Boolean),
    });
  }

  return {
    totalYears: allIntervals.length ? mergedYears(allIntervals) : null,
    currentTitle: current?.title ?? null,
    currentCompany: current?.company_name ?? null,
    skills,
  };
}

export async function fetchExperiences(candidateId: string): Promise<ExperienceRow[]> {
  try {
    const res = await sbRest(
      `candidate_experiences?candidate_id=eq.${candidateId}&select=title,company_name,start_month,start_year,end_month,end_year,is_current,duration_text,skills,description,sort_order&order=sort_order.asc`
    );
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

// Compact evidence block for prompts and recommendation cards.
export function formatFacts(facts: CandidateFacts): string {
  const lines: string[] = [];
  if (facts.totalYears !== null) lines.push(`Total experience: ${facts.totalYears} years`);
  if (facts.currentTitle) {
    lines.push(`Current role: ${facts.currentTitle}${facts.currentCompany ? ` at ${facts.currentCompany}` : ""}`);
  }
  for (const s of facts.skills) {
    lines.push(
      s.listedOnly
        ? `${s.skill}: listed on profile, no dated position evidence`
        : `${s.skill}: ${s.years}y${s.usedInCurrentRole ? ", incl. current role" : ""} (${s.positions[0] || "prior role"})`
    );
  }
  return lines.join("\n");
}
