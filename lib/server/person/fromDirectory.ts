// One engaged-directory contact (the communications project) as a PersonDoc.
//
// Input shapes. The first four are the rows scripts/sync-directory.mjs
// already reads; the last two are new reads. Every field beyond the ones
// the sync selects today is optional and used only when present, so the
// runner can select more (the Harvest ids live in them) without a change
// here. The comms column names for e-mails and phones below are taken from
// the reply-ops code (bd/people.py, candidates.py, company_lists.py) and
// must be confirmed against the live schema by the runner:
//   boardRow    board.candidates (select v.*): contact_id, name, first_name,
//               last_name, metro, primary_email, email_status, linkedin_url,
//               title, company, location, linkedin_headline, one_liner,
//               education, school, skills, status, do_not_contact,
//               follow_up_date, airtable_record_ids, updated_at
//   harvestRow  comms.harvest_profiles (select *): contact_id, fetched_at,
//               linkedin_url, public_identifier, first_name, last_name,
//               headline, about, location_text, country_code, open_to_work,
//               skills (jsonb), current_title, current_company, ...; plus,
//               optionally, `raw`: the Harvest JSON from comms.source_versions
//               (it carries the LinkedIn account id)
//   exps        comms.contact_experiences where superseded_at is null: the
//               sync's columns (title, company_name, company_linkedin_url,
//               location, start/end month/year, is_current, duration_text,
//               description, sort_order) and, when selected,
//               company_linkedin_id, company_universal_name,
//               employment_type, skills, raw
//   edus        comms.contact_educations where superseded_at is null:
//               school_name, degree, field_of_study, start_year, end_year,
//               sort_order and, when selected, school_linkedin_url,
//               description, raw
//   emails      comms.emails for the contact: normalized, original_value,
//               classification (personal | business | academic | unknown),
//               verification jsonb { status: Verified | Risky | Unknown |
//               Bounced | Invalid ..., primary, can_use, source, provider,
//               result, checked_at, bounced_at }
//   phones      comms.profile_facts where field = 'phone': value (jsonb
//               text, 10 digits), provenance ('manual' | 'source'),
//               recorded_at; a plain string is accepted too
// With no Harvest profile in the directory the doc carries contacts and the
// name only (mode contacts_only): the directory's own title, school and
// skills text is not LinkedIn-grade and never replaces the lists.
import type { PersonContact, PersonDoc, PersonEducation, PersonIdentity } from "./types";
import {
  assembleDoc,
  clean,
  cleanLong,
  companyOf,
  emailContact,
  emailLabel,
  finishEducations,
  finishJobs,
  isoOf,
  jobSkillNames,
  linkedinUrnOf,
  linkedinUsernameOf,
  makeEducation,
  makeHeader,
  makeJob,
  mergeContacts,
  monthOf,
  normalizeEmail,
  phoneContact,
  schoolOf,
  SkillBag,
  yearOf,
} from "./normalize";

type Obj = Record<string, any>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);

export interface DirectoryBoardRow {
  contact_id: string;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  metro?: string | null;
  primary_email?: string | null;
  email_status?: string | null;
  linkedin_url?: string | null;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  linkedin_headline?: string | null;
  one_liner?: string | null;
  education?: string | null;
  school?: unknown;
  skills?: unknown;
  status?: string | null;
  do_not_contact?: boolean | null;
  airtable_record_ids?: unknown;
  updated_at?: string | Date | null;
  [column: string]: unknown;
}

export interface DirectoryHarvestRow {
  contact_id?: string;
  fetched_at?: string | Date | null;
  linkedin_url?: string | null;
  public_identifier?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  headline?: string | null;
  about?: string | null;
  location_text?: string | null;
  country_code?: string | null;
  open_to_work?: boolean | null;
  skills?: unknown;
  emails?: unknown;
  /** The Harvest JSON (comms.source_versions), when the runner reads it. */
  raw?: unknown;
  [column: string]: unknown;
}

export interface DirectoryExperienceRow {
  title?: string | null;
  company_name?: string | null;
  company_linkedin_url?: string | null;
  company_linkedin_id?: string | null;
  company_universal_name?: string | null;
  employment_type?: string | null;
  location?: string | null;
  start_month?: number | null;
  start_year?: number | null;
  end_month?: number | null;
  end_year?: number | null;
  is_current?: boolean | null;
  duration_text?: string | null;
  description?: string | null;
  skills?: unknown;
  raw?: unknown;
  sort_order?: number | null;
  [column: string]: unknown;
}

export interface DirectoryEducationRow {
  school_name?: string | null;
  school_linkedin_url?: string | null;
  degree?: string | null;
  field_of_study?: string | null;
  start_year?: number | null;
  end_year?: number | null;
  description?: string | null;
  raw?: unknown;
  sort_order?: number | null;
  [column: string]: unknown;
}

export interface DirectoryEmailRow {
  normalized?: string | null;
  original_value?: string | null;
  classification?: string | null;
  verification?: unknown;
  /** Accepted aliases, should the runner select them under other names. */
  email?: string | null;
  address?: string | null;
  is_primary?: boolean | null;
  [column: string]: unknown;
}

export type DirectoryPhoneRow = string | { value?: unknown; phone?: unknown; provenance?: string | null; recorded_at?: string | Date | null; [column: string]: unknown };

/** The directory's Airtable record ids ("rec" + 14), as the sync reads them. */
const recordIds = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\s]+/) : []).map((s) => String(s).trim()).filter((s) => /^rec[A-Za-z0-9]{14}$/.test(s));

/** A directory verification status as the contact's check and status. */
export function directoryCheck(statusText: unknown, v: Obj = {}): { status: PersonContact["status"]; quality: string | null; result: string | null } {
  const s = String(statusText ?? v.status ?? "").trim().toLowerCase();
  const result = clean(v.result) ?? (s || null);
  if (v.bounced_at || /bounce/.test(s)) return { status: "bounced", quality: "bad", result };
  if (/invalid|undeliverable|\bbad\b|disposable/.test(s)) return { status: "invalid", quality: "bad", result };
  if (v.can_use === false || /do not|dnc|unsubscrib|opt.?out/.test(s)) return { status: "do_not_use", quality: null, result };
  if (/verified|valid|deliverable|\bok\b|good/.test(s)) return { status: "active", quality: "good", result: clean(v.result) ?? "ok" };
  if (/risky|catch|accept/.test(s)) return { status: "active", quality: "risky", result: clean(v.result) ?? "catch_all" };
  return { status: "active", quality: null, result: s && s !== "unknown" ? result : null };
}

/** Every directory address with its type and check; the directory's primary is marked. */
function directoryEmails(board: DirectoryBoardRow, emails: DirectoryEmailRow[]): (PersonContact | null)[] {
  const primary = normalizeEmail(board.primary_email);
  const rows = emails.map((r) => {
    const v = obj(r.verification) ?? {};
    const address = r.original_value ?? r.normalized ?? r.email ?? r.address;
    return { r, v, norm: normalizeEmail(r.normalized ?? address), address };
  });
  const flagged = primary ?? rows.find((x) => x.v.primary === true || x.r.is_primary === true)?.norm ?? null;
  const out = rows.map(({ r, v, norm, address }) => {
    if (!norm) return null;
    const check = directoryCheck(v.status, v);
    return emailContact(address, {
      label: emailLabel(r.classification, norm),
      status: check.status,
      quality: check.quality,
      result: check.result,
      verifier: clean(v.provider) ?? clean(v.source) ?? "directory",
      verified_at: isoOf(v.checked_at) ?? isoOf(v.verified_at) ?? isoOf(v.bounced_at),
      source_detail: norm === flagged ? "directory_primary" : "directory",
    });
  });
  // The board's primary is always carried, even when comms.emails lacks it.
  if (primary && !rows.some((x) => x.norm === primary)) {
    const check = directoryCheck(board.email_status);
    out.unshift(emailContact(board.primary_email, { status: check.status, quality: check.quality, result: check.result, verifier: check.quality ? "directory" : null, source_detail: "directory_primary" }));
  }
  return out;
}

function directoryPhones(phones: DirectoryPhoneRow[]): (PersonContact | null)[] {
  return phones.map((p) => {
    const o = typeof p === "string" ? { value: p } : p;
    const value = typeof o.value === "string" || typeof o.value === "number" ? o.value : o.phone;
    return phoneContact(value, { source_detail: o.provenance === "manual" ? "directory_manual" : "directory" });
  });
}

export function fromDirectory(
  boardRow: DirectoryBoardRow,
  harvestRow: DirectoryHarvestRow | null,
  exps: DirectoryExperienceRow[] = [],
  edus: DirectoryEducationRow[] = [],
  emails: DirectoryEmailRow[] = [],
  phones: DirectoryPhoneRow[] = [],
  candidateId: string
): PersonDoc {
  const h = harvestRow ?? null;
  const raw = obj(h?.raw) ?? null;

  const bag = new SkillBag();
  if (h) {
    const hs = Array.isArray(h.skills) ? h.skills : typeof h.skills === "string" ? h.skills.split(/,|\n|;/) : [];
    for (const s of hs) bag.add(typeof s === "string" ? s : obj(s)?.name ?? obj(s)?.title);
    for (const s of Array.isArray(raw?.topSkills) ? raw!.topSkills : []) bag.add(s, { is_top: true });
  }

  // Inputs are sorted here, so an unordered query cannot change the doc or its hash.
  const byText = (a: unknown, b: unknown) => String(a ?? "").localeCompare(String(b ?? ""));
  const sortedExps = [...exps].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || byText(a.title, b.title) || byText(a.company_name, b.company_name) || (a.start_year ?? 0) - (b.start_year ?? 0));
  const { jobs } = finishJobs(
    sortedExps.map((e, i) => {
      const r = obj(e.raw) ?? {};
      return makeJob({
        title: clean(e.title),
        company: companyOf({
          name: e.company_name,
          linkedin_id: e.company_linkedin_id ?? r.companyId,
          linkedin_username: e.company_universal_name ?? r.companyUniversalName,
          linkedin_url: e.company_linkedin_url ?? r.companyLinkedinUrl,
          logo_url: obj(r.companyLogo)?.url,
        }),
        employment_type: clean(e.employment_type ?? r.employmentType),
        location: clean(e.location),
        // The directory cuts descriptions at 4,000 characters; its raw copy has them whole.
        description: cleanLong(r.description) ?? cleanLong(e.description),
        duration_text: clean(e.duration_text),
        start_year: yearOf(e.start_year),
        start_month: monthOf(e.start_month),
        end_year: yearOf(e.end_year),
        end_month: yearOf(e.end_year) ? monthOf(e.end_month) : null,
        is_current: e.is_current === true,
        skills: jobSkillNames(e.skills ?? r.skills, bag),
        sort_order: i,
      });
    })
  );
  for (const j of jobs) for (const s of j.skills) bag.add(s);

  const sortedEdus = [...edus].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || byText(a.school_name, b.school_name) || byText(a.degree, b.degree));
  const { educations } = finishEducations(
    sortedEdus
      .map((e, i) => {
        const r = obj(e.raw) ?? {};
        const school = schoolOf({ name: e.school_name ?? r.schoolName, linkedin_org_id: r.schoolId, linkedin_url: e.school_linkedin_url ?? r.schoolLinkedinUrl, logo_url: obj(r.schoolLogo)?.url });
        if (!school) return null;
        return makeEducation({
          school,
          degree: clean(e.degree),
          field_of_study: clean(e.field_of_study),
          start_year: yearOf(e.start_year),
          start_month: monthOf(obj(r.startDate)?.month),
          end_year: yearOf(e.end_year),
          end_month: monthOf(obj(r.endDate)?.month),
          description: cleanLong(e.description ?? r.description),
          activities: null,
          sort_order: i,
        });
      })
      .filter((e): e is PersonEducation => !!e)
  );

  const skills = bag.list(jobs);
  // Lists only from the directory's Harvest copy, and only when it has any.
  const lists = !!h && (jobs.length > 0 || educations.length > 0 || skills.length > 0);

  const linkedin = clean(h?.linkedin_url) || clean(boardRow.linkedin_url);
  const username = clean(h?.public_identifier)?.toLowerCase() ?? linkedinUsernameOf(linkedin);
  const urn = linkedinUrnOf(raw?.id);
  const identities: (PersonIdentity | null)[] = [
    { kind: "directory_contact_id", value: String(boardRow.contact_id) },
    username ? { kind: "linkedin_username", value: username } : null,
    urn ? { kind: "linkedin_urn", value: urn } : null,
    ...recordIds(boardRow.airtable_record_ids).map((id): PersonIdentity => ({ kind: "airtable_id", value: id })),
  ];

  const fullName = clean(boardRow.name) || [clean(boardRow.first_name), clean(boardRow.last_name)].filter(Boolean).join(" ") || null;
  const header = lists
    ? makeHeader({
        full_name: fullName,
        headline: clean(h?.headline) || clean(boardRow.linkedin_headline) || clean(boardRow.one_liner),
        summary: cleanLong(raw?.about) ?? h?.about,
        location: clean(h?.location_text) || clean(boardRow.location) || clean(boardRow.metro),
        location_country: h?.country_code,
        photo: clean(raw?.photo) ?? obj(raw?.profilePicture)?.url,
        open_to_work: h?.open_to_work,
      })
    : makeHeader({ full_name: fullName });

  return assembleDoc({
    candidate_id: candidateId,
    mode: lists ? "replace_lists" : "contacts_only",
    source: {
      source: "directory",
      provider: "comms",
      source_ref: String(boardRow.contact_id),
      fetched_at: isoOf(h?.fetched_at) ?? isoOf(boardRow.updated_at) ?? "1970-01-01T00:00:00.000Z",
      raw_in: "directory",
      enrichment_id: null,
    },
    identities,
    header,
    jobs: lists ? jobs : [],
    educations: lists ? educations : [],
    skills: lists ? skills : [],
    contacts: mergeContacts([
      ...directoryEmails(boardRow, [...emails].sort((a, b) => byText(a.normalized ?? a.email ?? a.address, b.normalized ?? b.email ?? b.address) || byText(a.original_value, b.original_value))),
      ...directoryPhones([...phones].sort((a, b) => byText(typeof a === "string" ? a : a.value ?? a.phone, typeof b === "string" ? b : b.value ?? b.phone))),
      // Addresses on the directory's Harvest copy (Harvest has returned none so far).
      ...(Array.isArray(h?.emails) ? h!.emails : []).map((e) => emailContact(e, { source_detail: "directory_harvest" })),
    ]),
  });
}
