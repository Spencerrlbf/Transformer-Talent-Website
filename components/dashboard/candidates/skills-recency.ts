// The skills on the report card, grouped by when they were last used: on the
// current job, on previous jobs (each with the year it was last used), or
// only on the profile's skills list. Pure: written by code from the job tags
// and the dated positions, and rendered by SkillsChips.
import type { ProfileFacts } from "@/lib/rolecard";
import { companyKey } from "@/lib/company-snapshot";
import { stillThere, yearOf } from "./report-format";

type Skill = NonNullable<ProfileFacts["skills"]>[number];
type Job = ProfileFacts["companies"][number];

export interface SkillChip {
  name: string;
  /** Dated career years on the jobs the skill is tagged on. */
  years: number | null;
  /** The companies the skill is tagged on, as the profile names them. */
  where: string[];
  /** Previous jobs only: "now" when one of those jobs is still running, else
   *  the year the latest of them ended; null when none matched a dated job. */
  lastUsed: string | null;
  /** Tagged only on internships or other positions that are not career jobs,
   *  which count for no years. */
  internOnly: boolean;
}

export interface SkillGroups {
  current: SkillChip[];
  previous: SkillChip[];
  listed: SkillChip[];
  /** "VIVA AI, since 2024": the current job the first group is about, else "". */
  currentNote: string;
}

const year4 = (s: string | null | undefined) => (s && s.match(/\d{4}/)?.[0]) || "";

/** Most years first; the same years, by name. Undated last. */
const byYearsThenName = (a: SkillChip, b: SkillChip) => (b.years ?? -1) - (a.years ?? -1) || a.name.localeCompare(b.name);

/** The first position is the current job when it is still running and the
 *  profile's current employer is that company (the career list's own test). */
export function currentJobOf(p: ProfileFacts): Job | null {
  const c = p.companies[0];
  if (!c || !stillThere(c.to)) return null;
  return !p.current?.company || p.current.company === c.name ? c : null;
}

/** "now" when any job the skill was tagged on is still running, else the
 *  year the latest of them ended; null when no tagged company is a dated job. */
function lastUsedOn(where: string[], jobs: Job[]): string | null {
  const keys = new Set(where.map(companyKey));
  const matched = jobs.filter((j) => keys.has(companyKey(j.name)));
  if (!matched.length) return null;
  if (matched.some((j) => stillThere(j.to))) return "now";
  const years = matched.map((j) => yearOf(j.from, j.to)).filter(Boolean).map(Number);
  return years.length ? String(Math.max(...years)) : null;
}

export function skillsByRecency(p: ProfileFacts): SkillGroups {
  const skills: Skill[] = p.skills || [];
  const careerAt = new Set(p.companies.filter((c) => c.career).map((c) => companyKey(c.name)));
  const asideAt = new Set(p.companies.filter((c) => !c.career).map((c) => companyKey(c.name)));
  const internOnly = (s: Skill) => s.where.length > 0 && s.where.every((w) => asideAt.has(companyKey(w)) && !careerAt.has(companyKey(w)));
  const chip = (s: Skill, previous: boolean): SkillChip => ({
    name: s.name,
    years: s.years,
    where: s.where,
    lastUsed: previous ? lastUsedOn(s.where, p.companies) : null,
    internOnly: internOnly(s),
  });
  const current = skills.filter((s) => s.current).map((s) => chip(s, false)).sort(byYearsThenName);
  const previous = skills.filter((s) => !s.current && !s.listedOnly).map((s) => chip(s, true)).sort(byYearsThenName);
  const listed = skills.filter((s) => !s.current && s.listedOnly).map((s) => chip(s, false)).sort(byYearsThenName);
  const job = currentJobOf(p);
  const since = job ? year4(job.from) : "";
  const currentNote = job ? (since ? `${job.name}, since ${since}` : job.name) : "";
  return { current, previous, listed, currentNote };
}
