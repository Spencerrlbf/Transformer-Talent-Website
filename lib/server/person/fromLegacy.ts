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
  endorsementCount,
  finishEducations,
  finishJobs,
  githubContact,
  isoOf,
  jobSkillNames,
  linkedinUrnOf,
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
  statusFromCheck,
  uncapped,
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
      profileSkills: arr(a.skills).map((s) => ({ name: s, endorsements: null })),
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

/** A year span written as text ("2018 - 2022", "2016 – Present"). */
function yearsFromText(t: unknown): { start: number | null; end: number | null } {
  const m = typeof t === "string" ? t.match(/(\d{4})\s*[-–—]\s*(\d{4})?/) : null;
  return m ? { start: yearOf(Number(m[1])), end: m[2] ? yearOf(Number(m[2])) : null } : { start: null, end: null };
}

/** The jobs: work_experience in either shape, else the raw JSON's positions. */
function legacyJobs(row: LegacyCandidateRow, raw: LegacyRaw, bag: SkillBag): PersonJob[] {
  const stored = objs(row.work_experience);
  const positions = stored.length ? stored : raw.experience;
  const rows: ExperienceRow[] = uncapped<Obj, ExperienceRow>(positions, (items) => poolExperiences({ id: row.id, work_experience: items } as PoolCandidate), {});

  // Company identity and position details by company name from the raw JSON,
  // for stored positions that lost them in a later rewrite. A name the raw
  // JSON gives two different LinkedIn identities is left alone.
  const byName = new Map<string, Obj | null>();
  const byPosition = new Map<string, Obj>();
  if (stored.length) {
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

/** Schools with ids and years from the raw JSON, else the education lines. */
function legacyEducations(row: LegacyCandidateRow, raw: LegacyRaw): PersonEducation[] {
  if (raw.education.length) {
    return raw.education
      .map((ed, i) => {
        const a = raw.generation === "A";
        const school = schoolOf(
          a
            ? { name: ed.school, linkedin_org_id: ed.school_id, linkedin_url: ed.school_linkedin_url, logo_url: ed.school_logo_url }
            : { name: ed.schoolName, linkedin_org_id: ed.schoolId, linkedin_url: ed.url, logo_url: objs(ed.logo)[0]?.url }
        );
        if (!school) return null;
        const start = obj(a ? ed.start_date : ed.start);
        const end = obj(a ? ed.end_date : ed.end);
        const span = yearsFromText(ed.duration);
        return makeEducation({
          school,
          degree: clean(a ? ed.degree_name ?? ed.degree : ed.degree),
          field_of_study: clean(a ? ed.field_of_study : ed.fieldOfStudy),
          start_year: yearOf(start?.year) ?? span.start,
          start_month: monthOf(start?.month),
          end_year: yearOf(end?.year) ?? span.end,
          end_month: monthOf(end?.month),
          description: cleanLong(ed.description),
          activities: cleanLong(ed.activities),
          sort_order: i,
        });
      })
      .filter((e): e is PersonEducation => !!e);
  }
  return poolEducation(row as PoolCandidate)
    .map((e, i) => {
      const school = schoolOf({ name: e.schoolName });
      return school
        ? makeEducation({ school, degree: clean(e.degree), field_of_study: clean(e.fieldOfStudy), start_year: null, start_month: null, end_year: null, end_month: null, description: null, activities: null, sort_order: i })
        : null;
    })
    .filter((e): e is PersonEducation => !!e);
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

/** candidate_emails and candidate_emails_v2 rows as contacts, with their checks. */
function legacyEmailContacts(v1: LegacyEmailRow[], v2: LegacyEmailV2Row[]): (PersonContact | null)[] {
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
      legacy_email_id: legacyId,
      legacy_email_ids: legacyId ? [legacyId] : [],
    });
  };
  return [
    ...order(v1).map((r) => one("candidate_emails", r, r.email_address, r.id)),
    ...order(v2).map((r) => one("candidate_emails_v2", r, r.email_normalized ?? r.email_raw, null)),
  ];
}

/** When the lists this row holds were true: the import date while the row
 *  is still an old-import row, else when the row was created. */
export function legacyFetchedAt(row: LegacyCandidateRow): string {
  const led = isoOf(row.linkedin_enrichment_date);
  const relabelled = row.source === "directory" || row.source === "airtable_sync";
  const at = !relabelled && led && led < LEGACY_IMPORT_END ? led : isoOf(row.created_at) ?? led;
  return at ?? "1970-01-01T00:00:00.000Z";
}

export function fromLegacyImport(candidateRow: LegacyCandidateRow, legacyEmails: LegacyEmailRow[] = [], v2Emails: LegacyEmailV2Row[] = []): PersonDoc {
  const row = candidateRow;
  const raw = legacyRaw(row.linkedin_data);

  const bag = new SkillBag();
  legacyProfileSkills(row, raw, bag);
  const { jobs } = finishJobs(legacyJobs(row, raw, bag));
  for (const j of jobs) for (const s of j.skills) bag.add(s);
  const { educations } = finishEducations(legacyEducations(row, raw));

  const c = row.contact && typeof row.contact === "object" ? row.contact : null;
  const contacts = mergeContacts([
    ...legacyEmailContacts(legacyEmails, v2Emails),
    emailContact(row.email, { source_detail: "candidates.email" }),
    phoneContact(row.phone, { source_detail: "candidates.phone" }),
    // A recruiter's curated contact: the chosen address and number lead.
    emailContact(c?.email, { is_manual: true, source_detail: "recruiter_primary" }),
    phoneContact(c?.phone, { is_manual: true, source_detail: "recruiter" }),
    githubContact(c?.github, { is_manual: true, source_detail: "recruiter" }),
    ...arr(c?.otherEmails).map((e) => emailContact(e, { source_detail: "recruiter_other" })),
    // Only in the raw scrape: kept, never made primary on its own.
    emailContact(raw.email, { never_primary: true, source_detail: "linkedin_data" }),
  ]);

  const identities: (PersonIdentity | null)[] = [
    row.linkedin_username ? { kind: "linkedin_username", value: row.linkedin_username.trim().toLowerCase() } : null,
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
