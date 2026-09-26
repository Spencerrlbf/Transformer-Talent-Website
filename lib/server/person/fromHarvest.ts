// A Harvest LinkedIn profile (candidate_enrichments.raw_payload) as a
// PersonDoc. The positions are read by spine.ts harvestToExperiences, the
// converter the refresh and the fact engine already use, over the whole
// list; the company ids, school ids and years the old candidates columns
// dropped are kept. Harvest carries no e-mail field; an address the person
// wrote in their About is kept (never primary), and their listed websites
// become website/GitHub contacts. A section the payload has nothing for
// (no positions, say) is left out of the doc, so it never empties a list.
import { harvestToExperiences } from "../spine";
import type { PersonDoc, PersonEducation } from "./types";
import {
  assembleDoc,
  clean,
  cleanLong,
  companyOf,
  emailContact,
  emailsInText,
  endorsementCount,
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
  schoolOf,
  SkillBag,
  spanYears,
  uncapped,
  websiteContact,
  yearOf,
} from "./normalize";

type Obj = Record<string, any>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter((x): x is Obj => !!obj(x)) : []);

/** The ledger row that holds the payload (candidate_enrichments). */
export interface HarvestLedgerRow {
  id: string;
  candidate_id?: string | null;
  created_at: string;
  provider?: string | null;
  operation?: string | null;
}

/** The Harvest skills list and topSkills, first-seen order. */
export function harvestSkills(payload: Obj, bag: SkillBag): void {
  const top = new Set((Array.isArray(payload.topSkills) ? payload.topSkills : []).filter((s: unknown): s is string => typeof s === "string").map((s: string) => s.trim().toLowerCase()));
  for (const s of Array.isArray(payload.skills) ? payload.skills : []) {
    const name = typeof s === "string" ? s : obj(s)?.name;
    bag.add(name, { is_top: typeof name === "string" && top.has(name.trim().toLowerCase()), endorsements: endorsementCount(obj(s)?.endorsements) });
  }
  for (const s of Array.isArray(payload.topSkills) ? payload.topSkills : []) bag.add(s, { is_top: true });
}

/** The positions of a Harvest profile as doc jobs (not yet ordered or keyed). */
export function harvestJobs(payload: Obj, bag?: SkillBag) {
  const list = (payload.experience || payload.experiences) as unknown;
  const all = uncapped<unknown, ReturnType<typeof harvestToExperiences>[number]>(
    Array.isArray(list) ? list : [],
    (items) => harvestToExperiences({ experience: items }),
    {}
  );
  return all.map((r, i) => {
    const e = (obj(r.raw) ?? {}) as Obj;
    return makeJob({
      title: clean(r.title),
      company: companyOf({
        name: r.company_name,
        linkedin_id: e.companyId,
        linkedin_username: e.companyUniversalName,
        linkedin_url: r.company_linkedin_url,
        logo_url: obj(e.companyLogo)?.url ?? (typeof e.companyLogo === "string" ? e.companyLogo : null),
      }),
      employment_type: clean(r.employment_type),
      location: clean(r.location),
      description: cleanLong(e.description),
      duration_text: clean(r.duration_text),
      start_year: yearOf(r.start_year),
      start_month: r.start_month,
      end_year: yearOf(r.end_year),
      end_month: yearOf(r.end_year) ? r.end_month : null,
      is_current: r.is_current === true,
      skills: jobSkillNames(r.skills, bag),
      sort_order: i,
    });
  });
}

/** The education of a Harvest profile, with school ids and years. */
export function harvestEducations(payload: Obj): PersonEducation[] {
  return objs(payload.education)
    .map((ed, i) => {
      const school = schoolOf({ name: ed.schoolName ?? ed.title, linkedin_org_id: ed.schoolId, linkedin_url: ed.schoolLinkedinUrl, logo_url: obj(ed.schoolLogo)?.url });
      if (!school) return null;
      const start = obj(ed.startDate);
      const end = obj(ed.endDate);
      const span = spanYears(ed.period);
      return makeEducation({
        school,
        degree: clean(ed.degree),
        field_of_study: clean(ed.fieldOfStudy),
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

/** The header fields of a Harvest profile. */
export function harvestHeader(payload: Obj) {
  const loc = payload.location as { linkedinText?: string; countryCode?: string; parsed?: { text?: string; countryCode?: string } } | string | null | undefined;
  return makeHeader({
    full_name: [clean(payload.firstName), clean(payload.lastName)].filter(Boolean).join(" ") || null,
    headline: payload.headline,
    summary: payload.about,
    location: typeof loc === "string" ? loc : loc?.linkedinText || loc?.parsed?.text,
    location_country: typeof loc === "object" && loc ? loc.countryCode || loc.parsed?.countryCode : null,
    photo: clean(payload.photo) ?? obj(payload.profilePicture)?.url,
    open_to_work: payload.openToWork,
  });
}

const hasItems = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

export function fromHarvest(payload: Record<string, unknown>, ledgerRow: HarvestLedgerRow, candidateId?: string): PersonDoc {
  const p = (obj(payload) ?? {}) as Obj;
  const bag = new SkillBag();
  harvestSkills(p, bag);
  const { jobs } = finishJobs(harvestJobs(p, bag));
  for (const j of jobs) for (const s of j.skills) bag.add(s);
  const { educations } = finishEducations(harvestEducations(p));
  // A section the pull returned empty is not asserted (the live refresh never blanks a column either).
  const hasSkills = hasItems(p.skills) || hasItems(p.topSkills);
  const urn = linkedinUrnOf(p.id);
  const username = clean(p.publicIdentifier)?.toLowerCase() ?? linkedinUsernameOf(p.linkedinUrl);
  return assembleDoc({
    candidate_id: candidateId ?? ledgerRow.candidate_id ?? "",
    mode: "replace_lists",
    source: {
      source: "harvest",
      provider: ledgerRow.provider ?? "harvest",
      source_ref: ledgerRow.id,
      fetched_at: isoOf(ledgerRow.created_at) ?? "1970-01-01T00:00:00.000Z",
      raw_in: "candidate_enrichments",
      enrichment_id: ledgerRow.id,
    },
    identities: [
      urn ? { kind: "linkedin_urn", value: urn } : null,
      username ? { kind: "linkedin_username", value: username } : null,
    ],
    header: harvestHeader(p),
    jobs: hasItems(p.experience || p.experiences) ? jobs : undefined,
    educations: hasItems(p.education) ? educations : undefined,
    skills: hasSkills ? bag.list(jobs) : undefined,
    contacts: mergeContacts([
      ...emailsInText(p.about).map((e) => emailContact(e, { never_primary: true, source_detail: "profile_about" })),
      ...(Array.isArray(p.websites) ? p.websites : []).map((w) => websiteContact(w, { source_detail: "harvest_websites" })),
    ]),
  });
}
