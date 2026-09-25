// The person as today's candidates columns would hold them, worked out from
// the new tables (or from a PersonDoc, which has the same parts). Used only
// for the trial's before/after page and its checks: nothing writes these.
//
// The shapes are the ones harvestToPoolRecord and the directory sync write
// today: positions newest first with month-name dates (the real job first),
// "School - Degree in Field" lines, every skill, the current job's title and
// company, plus each position's employment type and a company reference.
import { computeFacts, type ExperienceRow } from "../facts";
import { poolEducation, poolExperiences, poolSkills, type PoolCandidate } from "../pool/profile";
import type { PersonContact, PersonHeader } from "./types";
import { isSideRole, rankedContacts } from "./normalize";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A job as candidate_experiences holds it (company_name, company_id) or as a doc holds it (company{}). */
export interface ProjectJobIn {
  title?: string | null;
  company_name?: string | null;
  company?: { name?: string | null; identity?: string | null; linkedin_url?: string | null } | null;
  company_id?: string | null;
  company_linkedin_url?: string | null;
  employment_type?: string | null;
  location?: string | null;
  description?: string | null;
  duration_text?: string | null;
  start_year?: number | null;
  start_month?: number | null;
  end_year?: number | null;
  end_month?: number | null;
  is_current?: boolean | null;
  is_side_role?: boolean | null;
  skills?: string[] | null;
  sort_order?: number | null;
  removed_at?: string | null;
}
/** An education row (candidate_educations, or a doc's educations). */
export interface ProjectEduIn {
  school_name?: string | null;
  school?: { name?: string | null } | null;
  degree?: string | null;
  field_of_study?: string | null;
  start_year?: number | null;
  end_year?: number | null;
  sort_order?: number | null;
  removed_at?: string | null;
}
/** A skill row (candidate_skills joined to skills.name, or a doc's skills). */
export interface ProjectSkillIn {
  name?: string | null;
  sort_order?: number | null;
  removed_at?: string | null;
}
/** A contact row (candidate_contacts, or a doc's contacts); rank when the database set it. */
export type ProjectContactIn = Partial<PersonContact> & { kind: PersonContact["kind"]; value_normalized: string; rank?: number | null };

export interface ProjectionInput {
  jobs: ProjectJobIn[];
  educations: ProjectEduIn[];
  skills: ProjectSkillIn[];
  header?: Partial<PersonHeader> | null;
  contacts?: ProjectContactIn[] | null;
}

export interface ProjectedPosition {
  title: string | null;
  company: string | null;
  duration: string | null;
  location: string | null;
  is_current: boolean;
  start_date: { year: number; month: string | null } | null;
  end_date: { year: number; month: string | null } | null;
  description: string | null;
  company_linkedin_url: string | null;
  employment_type: string | null;
  /** companies.id when read from the tables, else the company identity string. */
  company_ref: string | null;
}

export interface Projection {
  current_title: string | null;
  current_company: string | null;
  work_experience: ProjectedPosition[];
  education: string | null;
  education_schools: string[];
  /** One entry per school (null where the school has no degree). */
  education_degrees: (string | null)[];
  /** One entry per school (null where the school has no field). */
  education_fields: (string | null)[];
  top_skills: string[];
  all_skills_text: string | null;
  /** Employers other than the current one, most recent first, each once. */
  previous_companies: string[];
  /** computeFacts over the tables' jobs, with the schools' end years (a known graduation anchors the career). */
  career_years: number | null;
  /** computeFacts as the signals read the projected columns today (education lines carry no years). */
  career_years_today_rule: number | null;
  headline: string | null;
  profile_summary: string | null;
  location: string | null;
  profile_picture_url: string | null;
  /** The rank-1 address and number (the database's rank, else the writer's rule). */
  email: string | null;
  phone: string | null;
  /** Every usable address, best first. */
  emails: string[];
}

const live = <T extends { removed_at?: string | null; sort_order?: number | null }>(rows: T[] | null | undefined): T[] =>
  (rows || []).filter((r) => r && !r.removed_at).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
const txt = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function ranked(contacts: ProjectContactIn[], kind: "email" | "phone"): string[] {
  const mine = contacts.filter((c) => c.kind === kind);
  if (mine.some((c) => c.rank != null)) {
    return mine
      .filter((c) => c.rank != null && (c.status ?? "active") === "active")
      .sort((a, b) => (a.rank as number) - (b.rank as number))
      .map((c) => c.value_normalized);
  }
  const full = mine.map((c) => ({
    value_raw: c.value_raw ?? c.value_normalized,
    label: c.label ?? "unknown",
    status: c.status ?? "active",
    never_primary: !!c.never_primary,
    is_manual: !!c.is_manual,
    source_detail: c.source_detail ?? null,
    quality: c.quality ?? null,
    result: c.result ?? null,
    resultcode: null,
    subresult: null,
    verifier: null,
    verified_at: c.verified_at ?? null,
    legacy_email_id: null,
    legacy_email_ids: [],
    kind: c.kind,
    value_normalized: c.value_normalized,
  })) as PersonContact[];
  return rankedContacts(full, kind).map((c) => c.value_normalized);
}

/** Employers other than the current one, most recent first, each once (the
 *  rule the matcher's anonymised list and the résumé parser use). */
function previousCompanies(positions: ProjectedPosition[], currentIndex: number): string[] {
  const current = currentIndex >= 0 ? positions[currentIndex]?.company?.toLowerCase() ?? null : null;
  const seen = new Set<string>();
  const out: string[] = [];
  positions.forEach((p, i) => {
    const c = p.company;
    if (!c || i === currentIndex || c.toLowerCase() === current || seen.has(c.toLowerCase())) return;
    seen.add(c.toLowerCase());
    out.push(c);
  });
  return out;
}

export function project(tables: ProjectionInput): Projection {
  const jobs = live(tables.jobs);
  const edus = live(tables.educations);
  const skills = live(tables.skills)
    .map((s) => txt(s.name))
    .filter((s): s is string => !!s);

  const companyName = (j: ProjectJobIn) => txt(j.company_name) ?? txt(j.company?.name);
  const work_experience: ProjectedPosition[] = jobs.map((j) => {
    const current = j.is_current === true;
    return {
      title: txt(j.title),
      company: companyName(j),
      duration: txt(j.duration_text),
      location: txt(j.location),
      is_current: current,
      start_date: j.start_year ? { year: j.start_year, month: j.start_month ? MONTH_NAMES[j.start_month - 1] : null } : null,
      end_date: j.end_year && !current ? { year: j.end_year, month: j.end_month ? MONTH_NAMES[j.end_month - 1] : null } : null,
      description: txt(j.description),
      company_linkedin_url: txt(j.company_linkedin_url) ?? txt(j.company?.linkedin_url),
      employment_type: txt(j.employment_type),
      company_ref: txt(j.company_id) ?? txt(j.company?.identity),
    };
  });

  const side = (j: ProjectJobIn) => (typeof j.is_side_role === "boolean" ? j.is_side_role : isSideRole(j.title, companyName(j)));
  const current = jobs.find((j) => j.is_current === true && !side(j)) ?? jobs[0] ?? null;

  const schools = edus.map((e) => ({ school: txt(e.school_name) ?? txt(e.school?.name), degree: txt(e.degree), field: txt(e.field_of_study), end: e.end_year ?? null })).filter((e) => !!e.school) as {
    school: string;
    degree: string | null;
    field: string | null;
    end: number | null;
  }[];
  const lines = schools.map((e) => (e.degree && e.field ? `${e.school} - ${e.degree} in ${e.field}` : e.degree ? `${e.school} - ${e.degree}` : e.field ? `${e.school} - ${e.field}` : e.school));

  const rows: ExperienceRow[] = jobs.map((j, i) => ({
    title: txt(j.title),
    company_name: companyName(j),
    employment_type: txt(j.employment_type),
    location: txt(j.location),
    start_month: j.start_month ?? null,
    start_year: j.start_year ?? null,
    end_month: j.end_month ?? null,
    end_year: j.end_year ?? null,
    is_current: j.is_current === true,
    duration_text: txt(j.duration_text),
    skills: j.skills ?? [],
    description: txt(j.description),
    sort_order: i,
  }));
  const withYears = schools.map((e) => ({ schoolName: e.school, degree: e.degree, fieldOfStudy: e.field, endDate: { year: e.end } }));
  const careerYears = rows.length ? computeFacts(rows, [], skills, withYears).careerYears : null;

  const columns: PoolCandidate = {
    id: "",
    work_experience,
    education: lines.length ? lines.join("\n") : null,
    education_schools: schools.map((e) => e.school),
    top_skills: skills,
    all_skills_text: skills.length ? skills.join(", ") : null,
  };
  const todayRows = poolExperiences(columns);
  const todayYears = todayRows.length ? computeFacts(todayRows, [], poolSkills(columns), poolEducation(columns)).careerYears : null;

  const contacts = tables.contacts || [];
  const emails = ranked(contacts, "email");
  const phones = ranked(contacts, "phone");
  const h = tables.header || {};
  return {
    current_title: current ? txt(current.title) : null,
    current_company: current ? companyName(current) : null,
    work_experience,
    education: columns.education ?? null,
    education_schools: schools.map((e) => e.school),
    education_degrees: schools.map((e) => e.degree),
    education_fields: schools.map((e) => e.field),
    top_skills: skills,
    all_skills_text: columns.all_skills_text ?? null,
    previous_companies: previousCompanies(work_experience, current ? jobs.indexOf(current) : -1),
    career_years: careerYears,
    career_years_today_rule: todayYears,
    headline: txt(h.headline),
    profile_summary: txt(h.summary),
    location: txt(h.location),
    profile_picture_url: txt(h.photo),
    email: emails[0] ?? null,
    phone: phones[0] ?? null,
    emails,
  };
}
