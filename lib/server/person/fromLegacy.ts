// The old bulk import (and whatever later routes wrote into the same
// candidates columns) as a PersonDoc.
//
// Jobs come from candidates.work_experience in either of its two shapes
// (read by the same poolExperiences code the judge and the signals use),
// else from the raw import JSON. linkedin_data comes in two generations of
// the RapidAPI scraper:
//   A  { success, message, data: { basic_info: { urn, public_identifier,
//        email, top_skills, location{country_code}, open_to_work, ... },
//        experience[], education[], skills[] } }
//   B  { urn, username, geo{countryCode}, isOpenToWork, profilePicture,
//        fullPositions[], position[], educations[], skills[{name,
//        endorsementsCount}] }
// Company ids and school ids with years live only in the raw JSON; a job
// whose stored copy lost its company id gets it back from the raw position
// at the same company. Schools come from the raw education when there is
// one, else from the "School - Degree in Field" lines.
import { poolEducation, poolExperiences, type PoolCandidate } from "../pool/profile";
import { isClearSideRoleTitle } from "./role-selection";
import type { ExperienceRow } from "../facts";
import type { PersonContact, PersonDoc, PersonEducation, PersonIdentity, PersonJob } from "./types";
import {
  assembleDoc,
  clean,
  cleanLong,
  companyOf,
  countryCodeOf,
  emailContact,
  emailLabel,
  emailsInText,
  endorsementCount,
  finishEducations,
  finishJobs,
  githubContact,
  isoOf,
  jobSkillNames,
  linkedinUrnOf,
  linkedinUsernameOf,
  makeEducation,
  makeHeader,
  makeJob,
  mergeContacts,
  monthOf,
  normalizedName,
  normalizeEmail,
  normalizeTitle,
  phoneContact,
  schoolOf,
  SkillBag,
  skillLines,
  spanYears,
  statusFromCheck,
  uncapped,
  verificationRawOf,
  yearOf,
} from "./normalize";

type Obj = Record<string, any>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const objs = (v: unknown): Obj[] => arr(v).filter((x): x is Obj => !!obj(x));

/** The candidates columns the old import filled (all optional but id). */
export interface LegacyCandidateRow {
  id: string;
  created_at?: string | null;
  source?: string | null;
  full_name?: string | null;
  headline?: string | null;
  profile_summary?: string | null;
  location?: string | null;
  profile_picture_url?: string | null;
  linkedin_username?: string | null;
  linkedin_url?: string | null;
  airtable_id?: string | null;
  directory_contact_id?: string | null;
  email?: string | null;
  phone?: string | null;
  contact?: { email?: string | null; phone?: string | null; github?: string | null; otherEmails?: string[] | null } | null;
  work_experience?: unknown;
  education?: string | null;
  education_schools?: string[] | null;
  education_degrees?: string[] | null;
  education_fields?: string[] | null;
  top_skills?: string[] | null;
  all_skills_text?: string | null;
  skills_endorsements?: unknown;
  linkedin_data?: unknown;
  linkedin_enrichment_date?: string | null;
  current_title?: string | null;
  current_company?: string | null;
}

/** A candidate_emails row (the typed, verified table). */
export interface LegacyEmailRow {
  id: string;
  email_address: string | null;
  email_type?: string | null;
  email_source?: string | null;
  is_primary?: boolean | null;
  quality?: string | null;
  result?: string | null;
  resultcode?: number | string | null;
  subresult?: string | null;
  verification_date?: string | null;
  last_verification_attempt?: string | null;
  raw_response?: unknown;
  created_at?: string | null;
}

/** A candidate_emails_v2 row (the April copy of the table above). */
export interface LegacyEmailV2Row {
  id: string;
  email_raw?: string | null;
  email_normalized?: string | null;
  email_type?: string | null;
  email_source?: string | null;
  is_primary?: boolean | null;
  quality?: string | null;
  result?: string | null;
  resultcode?: number | string | null;
  subresult?: string | null;
  verification_date?: string | null;
  last_verification_attempt?: string | null;
  raw_response?: unknown;
  created_at?: string | null;
}

/** An outreach e-mail's outcome (candidate_communications): a bounce or a
 *  reply, sent to one candidate_emails row (email_used). */
export interface LegacyCommunicationRow {
  id: string;
  communication_type?: string | null;
  status?: string | null;
  email_used?: string | null;
  communication_date?: string | null;
  response_date?: string | null;
}

/** The old import stopped before the website's own LinkedIn refresh began
 *  (the Harvest ledger starts 2026-08-15): a row whose enrichment date is
 *  older than this, and that no directory sync relabelled, still holds the
 *  import's lists. */
export const LEGACY_IMPORT_END = "2026-08-01T00:00:00.000Z";

export interface LegacyRaw {
  generation: "A" | "B" | null;
  experience: Obj[];
  education: Obj[];
  profileSkills: { name: unknown; endorsements: number | null }[];
  topSkills: string[];
  urn: string | null;
  username: string | null;
  email: string | null;
  countryCode: string | null;
  openToWork: boolean | null;
  photo: string | null;
  headline: string | null;
  summary: string | null;
  fullName: string | null;
  location: string | null;
}

/** What the raw import JSON holds, from either generation. */
export function legacyRaw(linkedinData: unknown): LegacyRaw {
  const empty: LegacyRaw = {
    generation: null, experience: [], education: [], profileSkills: [], topSkills: [], urn: null, username: null, email: null,
    countryCode: null, openToWork: null, photo: null, headline: null, summary: null, fullName: null, location: null,
  };
  const ld = obj(linkedinData);
  if (!ld) return empty;
  const a = obj(ld.data);
  if (a && (obj(a.basic_info) || Array.isArray(a.experience))) {
    const bi = obj(a.basic_info) ?? {};
    const loc = obj(bi.location);
    return {
      generation: "A",
      experience: objs(a.experience),
      education: objs(a.education),
      // One raw element can hold several skills, one per line.
      profileSkills: arr(a.skills).flatMap(skillLines).map((s) => ({ name: s, endorsements: null })),
      topSkills: arr(bi.top_skills).filter((s): s is string => typeof s === "string"),
      urn: linkedinUrnOf(bi.urn),
      username: clean(bi.public_identifier)?.toLowerCase() ?? null,
      email: clean(bi.email),
      countryCode: countryCodeOf(loc?.country_code),
      openToWork: typeof bi.open_to_work === "boolean" ? bi.open_to_work : null,
      photo: clean(bi.profile_picture_url),
      headline: clean(bi.headline),
      summary: cleanLong(bi.about),
      fullName: clean(bi.fullname),
      location: clean(loc?.full),
    };
  }
  if (Array.isArray(ld.fullPositions) || Array.isArray(ld.position) || typeof ld.urn === "string") {
    const full = objs(ld.fullPositions);
    const geo = obj(ld.geo);
    return {
      generation: "B",
      experience: full.length ? full : objs(ld.position),
      education: objs(ld.educations),
      profileSkills: objs(ld.skills).map((s) => ({ name: s.name, endorsements: endorsementCount(s.endorsementsCount) })),
      topSkills: [],
      urn: linkedinUrnOf(ld.urn),
      username: clean(ld.username)?.toLowerCase() ?? null,
      email: null,
      countryCode: countryCodeOf(geo?.countryCode),
      openToWork: typeof ld.isOpenToWork === "boolean" ? ld.isOpenToWork : null,
      photo: clean(ld.profilePicture),
      headline: clean(ld.headline),
      summary: cleanLong(ld.summary),
      fullName: [clean(ld.firstName), clean(ld.lastName)].filter(Boolean).join(" ") || null,
      location: clean(geo?.full),
    };
  }
  return empty;
}

/** The company fields a position carries, in either shape. */
function positionCompany(p: Obj) {
  return {
    name: p.company ?? p.companyName,
    linkedin_id: p.company_id ?? p.companyId,
    linkedin_username: p.companyUsername,
    linkedin_url: p.company_linkedin_url ?? p.companyURL,
    logo_url: p.company_logo_url ?? p.companyLogo,
  };
}

/** The jobs: work_experience in either shape, else the raw JSON's positions.
 *  A camel-shape stored list (companyName/start/end) is the import's copy of
 *  generation B's "position" list; its "fullPositions" also holds the other
 *  roles at the same employers, so when it is longer it is the list. */
function legacyJobs(row: LegacyCandidateRow, raw: LegacyRaw, bag: SkillBag): PersonJob[] {
  const stored = objs(row.work_experience);
  const camel = stored.length > 0 && stored.some((p) => "companyName" in p || "start" in p);
  const useFull = camel && raw.generation === "B" && raw.experience.length > stored.length;
  const positions = stored.length && !useFull ? stored : raw.experience;
  const rows: ExperienceRow[] = uncapped<Obj, ExperienceRow>(positions, (items) => poolExperiences({ id: row.id, work_experience: items } as PoolCandidate), {});

  // Company identity and position details by company name from the raw JSON,
  // for stored positions that lost them in a later rewrite. A name the raw
  // JSON gives two different LinkedIn identities is left alone.
  const byName = new Map<string, Obj | null>();
  const byPosition = new Map<string, Obj>();
  if (stored.length && !useFull) {
    for (const p of raw.experience) {
      const c = companyOf(positionCompany(p));
      const n = normalizedName(c.name);
      if (!n) continue;
      if (c.linkedin_id || c.linkedin_username || c.linkedin_url_normalized) {
        const had = byName.get(n);
        if (had === undefined) byName.set(n, p);
        else if (had && companyOf(positionCompany(had)).identity !== c.identity) byName.set(n, null);
      }
      const start = obj(p.start_date) ?? obj(p.start);
      byPosition.set(`${n}|${normalizeTitle(p.title)}|${yearOf(start?.year) ?? ""}`, p);
    }
  }

  return rows.map((r, i) => {
    const p = positions[i] ?? {};
    let company = companyOf({ ...positionCompany(p), name: r.company_name ?? positionCompany(p).name });
    const n = normalizedName(company.name);
    const same = n ? byPosition.get(`${n}|${normalizeTitle(r.title)}|${r.start_year ?? ""}`) : undefined;
    if (!company.linkedin_id && !company.linkedin_username && !company.linkedin_url_normalized && n) {
      const from = byName.get(n);
      if (from) company = companyOf({ ...positionCompany(from), name: company.name, logo_url: company.logo_url ?? positionCompany(from).logo_url });
    }
    return makeJob({
      title: clean(r.title),
      company,
      employment_type: clean(p.employment_type ?? p.employmentType ?? same?.employment_type ?? same?.employmentType),
      location: clean(r.location),
      description: cleanLong(p.description),
      duration_text: clean(r.duration_text),
      start_year: r.start_year,
      start_month: r.start_month,
      end_year: r.end_year,
      end_month: r.end_month,
      is_current: r.is_current === true,
      skills: jobSkillNames(p.skills ?? same?.skills, bag),
      sort_order: i,
    });
  });
}

/** A school name as a matching key between the record's lines and the raw
 *  JSON, which spell names a little differently ("University of Illinois at
 *  Urbana-Champaign" / "University of Illinois Urbana-Champaign",
 *  "... Technologies" / "... Technology"): the normalised words without
 *  of/at/the/and/in/for, a plural "s" off, in sorted order. */
function schoolKey(name: unknown): string | null {
  const n = normalizedName(typeof name === "string" ? name : null);
  if (!n) return null;
  const words = n.split(" ").filter((w) => !["of", "at", "the", "and", "in", "for", "de"].includes(w)).map((w) => (w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
  return words.length ? [...words].sort().join(" ") : n;
}

/** Is the row still the old import's, lists and all? (Not relabelled by a
 *  directory sync and not refreshed since the import ended.) */
export function legacyUntouched(row: LegacyCandidateRow): boolean {
  const led = isoOf(row.linkedin_enrichment_date);
  const relabelled = row.source === "directory" || row.source === "airtable_sync";
  return !relabelled && !!led && led < LEGACY_IMPORT_END;
}

/** One raw education entry (either generation) as a doc education, with the
 *  school's LinkedIn id and the years; `line` overrides the school name,
 *  degree and field (the record's own text). */
function rawEducation(raw: LegacyRaw, ed: Obj, i: number, line?: { schoolName: string; degree: string | null; fieldOfStudy: string | null }): PersonEducation | null {
  const a = raw.generation === "A";
  const school = schoolOf(
    a
      ? { name: line?.schoolName ?? ed.school, linkedin_org_id: ed.school_id, linkedin_url: ed.school_linkedin_url, logo_url: ed.school_logo_url }
      : { name: line?.schoolName ?? ed.schoolName, linkedin_org_id: ed.schoolId, linkedin_url: ed.url, logo_url: objs(ed.logo)[0]?.url }
  );
  if (!school) return null;
  const start = obj(a ? ed.start_date : ed.start);
  const end = obj(a ? ed.end_date : ed.end);
  const span = spanYears(ed.duration);
  return makeEducation({
    school,
    degree: clean(a ? ed.degree_name ?? ed.degree : ed.degree) ?? clean(line?.degree),
    field_of_study: clean(a ? ed.field_of_study : ed.fieldOfStudy) ?? clean(line?.fieldOfStudy),
    start_year: yearOf(start?.year) ?? span.start,
    start_month: monthOf(start?.month),
    end_year: yearOf(end?.year) ?? span.end,
    end_month: monthOf(end?.month),
    description: cleanLong(ed.description),
    activities: cleanLong(ed.activities),
    sort_order: i,
  });
}

/** Two school keys name the same school: equal, or one's words (at least
 *  two) all in the other's ("Anna University" / "Anna University Chennai"). */
function sameSchool(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const A = new Set(a.split(" "));
  const B = new Set(b.split(" "));
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  return small.size >= 2 && [...small].every((w) => big.has(w));
}

/** Schools. The record's education lines are what the site shows today; the
 *  raw JSON has the school ids and years. While the row is still the old
 *  import's, the raw entries are the list (the lines were made from them),
 *  plus any line naming a school the raw JSON lacks. Once a directory sync
 *  or a refresh rewrote the row, its lines are the list: each line takes the
 *  id, years and degree of a raw entry at the same school (same degree
 *  first); a line that joins several schools ("A, B") becomes their raw
 *  entries; another degree the raw JSON has at a school the lines still name
 *  is kept; a school only the raw JSON still names is not brought back. */
function legacyEducations(row: LegacyCandidateRow, raw: LegacyRaw): PersonEducation[] {
  const lines = poolEducation(row as PoolCandidate);
  const ok = (e: PersonEducation | null | undefined): e is PersonEducation => !!e;
  const lineOnly = (l: (typeof lines)[number], i: number) => {
    const school = schoolOf({ name: l.schoolName });
    return school
      ? makeEducation({ school, degree: clean(l.degree), field_of_study: clean(l.fieldOfStudy), start_year: null, start_month: null, end_year: null, end_month: null, description: null, activities: null, sort_order: i })
      : null;
  };
  if (!raw.education.length) return lines.map(lineOnly).filter(ok);
  const rawKeys = raw.education.map((ed) => schoolKey(raw.generation === "A" ? ed.school : ed.schoolName));
  const rawDegree = (k: number) => normalizeTitle(clean(raw.generation === "A" ? raw.education[k].degree_name ?? raw.education[k].degree : raw.education[k].degree));
  const matchesOf = (l: (typeof lines)[number]) => {
    const key = schoolKey(l.schoolName);
    return raw.education.map((_, k) => k).filter((k) => sameSchool(key, rawKeys[k]));
  };
  if (!lines.length || legacyUntouched(row)) {
    const fromRaw = raw.education.map((ed, i) => rawEducation(raw, ed, i)).filter(ok);
    const extra = lines.filter((l) => !matchesOf(l).length).map((l, i) => lineOnly(l, fromRaw.length + i)).filter(ok);
    return [...fromRaw, ...extra];
  }
  const used = new Set<number>();
  const named = new Set<string | null>();
  const out: (PersonEducation | null)[] = [];
  for (const l of lines) {
    const matches = matchesOf(l);
    for (const k of matches) named.add(rawKeys[k]);
    if (!matches.length) {
      out.push(lineOnly(l, out.length));
      continue;
    }
    if (new Set(matches.map((k) => rawKeys[k])).size > 1) {
      // One line naming several schools: each school's own entries.
      for (const k of matches) if (!used.has(k)) (used.add(k), out.push(rawEducation(raw, raw.education[k], out.length)));
      continue;
    }
    const free = matches.filter((k) => !used.has(k));
    const deg = normalizeTitle(clean(l.degree));
    const pick = free.find((k) => rawDegree(k) === deg) ?? (!deg || free.every((k) => !rawDegree(k)) ? free[0] : undefined) ?? free.find((k) => !rawDegree(k));
    if (pick !== undefined) {
      used.add(pick);
      out.push(rawEducation(raw, raw.education[pick], out.length, l));
      continue;
    }
    // No entry for this degree: the line, with the school's LinkedIn identity from the raw JSON.
    const e = rawEducation(raw, raw.education[matches[0]], out.length, l);
    out.push(e ? makeEducation({ ...e, degree: clean(l.degree), field_of_study: clean(l.fieldOfStudy), start_year: null, start_month: null, end_year: null, end_month: null, description: null, activities: null }) : null);
  }
  raw.education.forEach((ed, k) => {
    if (!used.has(k) && named.has(rawKeys[k])) out.push(rawEducation(raw, ed, out.length));
  });
  return out.filter(ok);
}

/** Every skill the row and the raw JSON name, first-seen order. */
function legacyProfileSkills(row: LegacyCandidateRow, raw: LegacyRaw, bag: SkillBag): void {
  const endorsed = new Map<string, number>();
  for (const s of objs(row.skills_endorsements)) {
    const n = endorsementCount(s.endorsementsCount);
    if (typeof s.name === "string" && n != null) endorsed.set(s.name.trim().toLowerCase(), n);
  }
  const top = new Set(raw.topSkills.map((s) => s.trim().toLowerCase()));
  const add = (name: unknown, endorsements: number | null = null) => {
    const k = typeof name === "string" ? name.trim().toLowerCase() : "";
    bag.add(name, { is_top: top.has(k), endorsements: endorsements ?? endorsed.get(k) ?? null });
  };
  for (const s of arr(row.top_skills)) add(s);
  for (const s of String(row.all_skills_text || "").split(/,|\n/)) add(s);
  for (const s of objs(row.skills_endorsements)) add(s.name);
  for (const s of raw.topSkills) add(s);
  for (const s of raw.profileSkills) add(s.name, s.endorsements);
}

const verifierOf = (raw: unknown, checked: boolean): string | null => {
  const t = typeof raw === "string" ? raw : raw ? JSON.stringify(raw) : "";
  if (/livemode|credits/.test(t)) return "millionverifier";
  return checked ? "legacy_import" : null;
};

/** candidate_emails and candidate_emails_v2 rows as contacts, with their
 *  checks; an outreach bounce or reply to a candidate_emails row is the
 *  newest check of that address when it is newer than the verifier's. */
function legacyEmailContacts(v1: LegacyEmailRow[], v2: LegacyEmailV2Row[], comms: LegacyCommunicationRow[]): (PersonContact | null)[] {
  const order = <T extends { is_primary?: boolean | null; created_at?: string | null; id: string }>(rows: T[]) =>
    [...rows].sort((a, b) => Number(!!b.is_primary) - Number(!!a.is_primary) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || a.id.localeCompare(b.id));
  const one = (table: string, r: LegacyEmailRow | LegacyEmailV2Row, address: unknown, legacyId: string | null) => {
    const norm = normalizeEmail(address);
    if (!norm) return null;
    const checked = !!(r.quality || r.result);
    return emailContact(address, {
      label: emailLabel(r.email_type, norm),
      status: statusFromCheck(r.quality, r.result),
      source_detail: `${table}:${r.email_source || "unknown"}${r.is_primary ? ":primary" : ""}`,
      quality: clean(r.quality),
      result: clean(r.result),
      resultcode: r.resultcode == null ? null : String(r.resultcode),
      subresult: clean(r.subresult),
      verifier: verifierOf(r.raw_response, checked),
      verified_at: isoOf(r.verification_date) ?? (checked ? isoOf(r.last_verification_attempt) : null),
      verification_raw: verificationRawOf(r.raw_response),
      legacy_email_id: legacyId,
      legacy_email_ids: legacyId ? [legacyId] : [],
      // What the Network treats as the person's primary today: is_primary, or an email_source of 'primary'.
      legacy_primary: !!r.is_primary || String(r.email_source ?? "").toLowerCase() === "primary",
    });
  };
  // The latest outreach outcome per candidate_emails row: bounced or replied.
  const outcome = new Map<string, { status: string; at: string | null }>();
  for (const c of comms) {
    const status = String(c.status ?? "").toLowerCase();
    if (!c.email_used || String(c.communication_type ?? "email").toLowerCase() !== "email" || !["bounced", "replied"].includes(status)) continue;
    const at = isoOf(status === "replied" ? c.response_date ?? c.communication_date : c.communication_date);
    const had = outcome.get(c.email_used);
    if (!had || String(at ?? "") > String(had.at ?? "")) outcome.set(c.email_used, { status, at });
  }
  const outreach = v1.map((r) => {
    const o = outcome.get(r.id);
    if (!o) return null;
    return emailContact(r.email_address, o.status === "bounced"
      ? { status: "bounced", quality: "bad", result: "bounced", verifier: "outreach", verified_at: o.at, source_detail: "candidate_communications:bounced", legacy_email_id: r.id, legacy_email_ids: [r.id] }
      : { status: "active", quality: "good", result: "replied", verifier: "outreach", verified_at: o.at, source_detail: "candidate_communications:replied", legacy_email_id: r.id, legacy_email_ids: [r.id] });
  });
  return [
    ...order(v1).map((r) => one("candidate_emails", r, r.email_address, r.id)),
    ...order(v2).map((r) => one("candidate_emails_v2", r, r.email_normalized ?? r.email_raw, null)),
    ...outreach,
  ];
}

/** A LinkedIn username as the old column holds it: the text before a ";"
 *  (some rows carry "slug; address"), when it is a slug (no spaces, "@",
 *  ":" or "/"; placeholders such as "xxxxx:" are not usernames). */
function usernameOfColumn(v: unknown): string | null {
  const t = typeof v === "string" ? v.split(";")[0].trim().toLowerCase() : "";
  return t && /^[^\s,@:/?#]+$/u.test(t) ? t : null;
}

/** When the lists this row holds were true: the import date while the row
 *  is still an old-import row, else when the row was created. */
export function legacyFetchedAt(row: LegacyCandidateRow): string {
  const led = isoOf(row.linkedin_enrichment_date);
  const relabelled = row.source === "directory" || row.source === "airtable_sync";
  const at = !relabelled && led && led < LEGACY_IMPORT_END ? led : isoOf(row.created_at) ?? led;
  return at ?? "1970-01-01T00:00:00.000Z";
}

/** The record's current title and company, as a job, when the list lacks
 *  them: a person with a title and employer on the record but no position
 *  list, or whose list's real job (the first, after ordering) has ended and
 *  does not name that title (a later sync wrote the title). Needs an
 *  employer (every job links to a company); a title that is clearly a side
 *  role is added only when the list is empty. */
function recordCurrentJob(row: LegacyCandidateRow, jobs: PersonJob[]): PersonJob | null {
  const title = clean(row.current_title);
  const company = clean(row.current_company);
  if (!company) return null;
  if (jobs.length) {
    if (jobs[0].is_current) return null;
    if (title && jobs.some((j) => normalizeTitle(j.title) === normalizeTitle(title))) return null;
    if (!title && jobs.some((j) => normalizedName(j.company.name) === normalizedName(company))) return null;
    if (isClearSideRoleTitle(title, company)) return null;
  }
  return makeJob({
    title,
    company: companyOf({ name: company }),
    employment_type: null,
    location: null,
    description: null,
    duration_text: null,
    start_year: null,
    start_month: null,
    end_year: null,
    end_month: null,
    is_current: true,
    skills: [],
    sort_order: -1,
  });
}

export function fromLegacyImport(
  candidateRow: LegacyCandidateRow,
  legacyEmails: LegacyEmailRow[] = [],
  v2Emails: LegacyEmailV2Row[] = [],
  communications: LegacyCommunicationRow[] = []
): PersonDoc {
  const row = candidateRow;
  const raw = legacyRaw(row.linkedin_data);

  const bag = new SkillBag();
  legacyProfileSkills(row, raw, bag);
  const listed = legacyJobs(row, raw, bag);
  const extra = recordCurrentJob(row, finishJobs(listed).jobs);
  const { jobs } = finishJobs(extra ? [extra, ...listed] : listed);
  for (const j of jobs) for (const s of j.skills) bag.add(s);
  const { educations } = finishEducations(legacyEducations(row, raw));

  const c = row.contact && typeof row.contact === "object" ? row.contact : null;
  const contacts = mergeContacts([
    ...legacyEmailContacts(legacyEmails, v2Emails, communications),
    emailContact(row.email, { source_detail: "candidates.email" }),
    phoneContact(row.phone, { source_detail: "candidates.phone" }),
    // A recruiter's curated contact: the chosen address and number lead.
    emailContact(c?.email, { is_manual: true, source_detail: "recruiter_primary" }),
    phoneContact(c?.phone, { is_manual: true, source_detail: "recruiter" }),
    githubContact(c?.github, { is_manual: true, source_detail: "recruiter" }),
    ...arr(c?.otherEmails).map((e) => emailContact(e, { source_detail: "recruiter_other" })),
    // Only in the raw scrape, or written in the person's own About: kept, never made primary on its own.
    emailContact(raw.email, { never_primary: true, source_detail: "linkedin_data" }),
    ...[...emailsInText(row.profile_summary), ...emailsInText(raw.summary)].map((e) => emailContact(e, { never_primary: true, source_detail: "profile_about" })),
  ]);

  // The username from the profile URL when there is one: the column sometimes carries more than the slug.
  const username = linkedinUsernameOf(row.linkedin_url) ?? usernameOfColumn(row.linkedin_username);
  const identities: (PersonIdentity | null)[] = [
    username ? { kind: "linkedin_username", value: username } : null,
    raw.urn ? { kind: "linkedin_urn", value: raw.urn } : null,
    row.airtable_id ? { kind: "airtable_id", value: row.airtable_id.trim() } : null,
    row.directory_contact_id ? { kind: "directory_contact_id", value: row.directory_contact_id } : null,
  ];

  return assembleDoc({
    candidate_id: row.id,
    mode: "replace_lists",
    source: {
      source: "legacy_import",
      provider: raw.generation ? `rapidapi-${raw.generation.toLowerCase()}` : null,
      source_ref: row.id,
      fetched_at: legacyFetchedAt(row),
      raw_in: "candidates.linkedin_data",
      enrichment_id: null,
    },
    identities,
    header: makeHeader({
      current_title: row.current_title ?? jobs[0]?.title,
      current_company: row.current_company ?? jobs[0]?.company.name,
      full_name: row.full_name ?? raw.fullName,
      headline: row.headline ?? raw.headline,
      summary: row.profile_summary ?? raw.summary,
      location: row.location ?? raw.location,
      location_country: raw.countryCode,
      photo: row.profile_picture_url ?? raw.photo,
      open_to_work: raw.openToWork,
    }),
    jobs,
    educations,
    skills: bag.list(jobs),
    contacts,
  });
}
