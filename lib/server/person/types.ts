// The PersonDoc: what every source's translator produces and save_person
// (migration 072) consumes. One shape for every route that knows something
// about a person, so the old import, the Harvest refresh, the directory and
// an application are saved by the same rules.
//
// The fields are exactly the trial spec's. A few extra, clearly marked
// fields carry values the TypeScript side has already normalised
// (normalized_name, linkedin_url_normalized, identity, is_placeholder,
// legacy_email_ids) so the SQL can trust them instead of re-deriving them.
// The SQL may ignore them; nothing in the doc depends on them being read.

/** How a doc may change the person's lists. */
export type PersonDocMode = "replace_lists" | "fill_gaps" | "contacts_only";

export type SourceKind = "legacy_import" | "harvest" | "directory" | "application" | "recruiter";
export type RawIn = "candidate_enrichments" | "candidates.linkedin_data" | "directory" | "inline";

export interface PersonSource {
  source: SourceKind;
  provider: string | null;
  source_ref: string | null;
  /** When the data was true (ISO timestamp). Decides which source owns the lists. */
  fetched_at: string;
  /** sha256 over the doc content and fetched_at: the same input twice gives the same hash. */
  payload_hash: string;
  raw_in: RawIn;
  enrichment_id: string | null;
  parser_version: string;
}

export type IdentityKind = "linkedin_urn" | "linkedin_username" | "directory_contact_id" | "airtable_id" | "tt_application_id";
export interface PersonIdentity {
  kind: IdentityKind;
  value: string;
}

export interface PersonHeader {
  full_name: string | null;
  headline: string | null;
  summary: string | null;
  location: string | null;
  /** ISO 3166 alpha-2, upper case ("US"), when the source says. */
  location_country: string | null;
  photo: string | null;
  open_to_work: boolean | null;
}

export interface PersonCompany {
  name: string | null;
  linkedin_id: string | null;
  linkedin_username: string | null;
  linkedin_url: string | null;
  logo_url: string | null;
  tier: 1 | 2 | null;
  // Extras (normalised in TypeScript; see normalize.ts).
  normalized_name: string | null;
  linkedin_url_normalized: string | null;
  /** li:<id> | u:<username> | url:<normalized url> | n:<normalized name>; null when nothing names the company. */
  identity: string | null;
  /** Self-employed, Freelance, Stealth, Career Break, Confidential with no LinkedIn identity. */
  is_placeholder: boolean;
}

export interface PersonJob {
  title: string | null;
  company: PersonCompany;
  employment_type: string | null;
  location: string | null;
  description: string | null;
  duration_text: string | null;
  start_year: number | null;
  start_month: number | null;
  end_year: number | null;
  end_month: number | null;
  is_current: boolean;
  is_side_role: boolean;
  skills: string[];
  sort_order: number;
  row_key: string;
}

export interface PersonSchool {
  name: string;
  linkedin_org_id: string | null;
  linkedin_url: string | null;
  logo_url: string | null;
  tier: 1 | 2 | null;
  // Extras (normalised in TypeScript; see normalize.ts).
  normalized_name: string;
  linkedin_url_normalized: string | null;
  /** li:<org id> | url:<normalized url> | n:<normalized name>. */
  identity: string;
}

export type DegreeLevel = "high_school" | "associate" | "bachelor" | "master" | "mba" | "doctorate" | "professional" | "certificate" | "other";

export interface PersonEducation {
  school: PersonSchool;
  degree: string | null;
  degree_level: DegreeLevel | null;
  field_of_study: string | null;
  start_year: number | null;
  start_month: number | null;
  end_year: number | null;
  end_month: number | null;
  description: string | null;
  activities: string | null;
  sort_order: number;
  row_key: string;
}

export interface PersonSkill {
  name: string;
  /** The facts.ts skill key: "Rust (Programming Language)" and "rust" are one skill. */
  key: string;
  /** LinkedIn's featured top skills (Harvest topSkills, the old import's basic_info.top_skills). */
  is_top: boolean;
  endorsements: number | null;
  /** How many of the doc's jobs tag the skill. */
  job_count: number | null;
  sort_order: number;
}

export type ContactKind = "email" | "phone" | "github" | "website";
export type ContactLabel = "personal" | "business" | "academic" | "mobile" | "home" | "office" | "unknown";
export type ContactStatus = "active" | "invalid" | "bounced" | "do_not_use" | "removed" | "claimed" | "shared";

export interface PersonContact {
  kind: ContactKind;
  value_raw: string;
  value_normalized: string;
  label: ContactLabel;
  status: ContactStatus;
  never_primary: boolean;
  is_manual: boolean;
  /** Where inside the source it came from, e.g. 'directory_primary', 'candidate_emails:pas'. */
  source_detail: string | null;
  quality: string | null;
  result: string | null;
  resultcode: string | null;
  subresult: string | null;
  verifier: string | null;
  verified_at: string | null;
  legacy_email_id: string | null;
  // Extra: every candidate_emails id the address came from (legacy_email_id is the first).
  legacy_email_ids: string[];
}

export interface PersonDoc {
  candidate_id: string;
  mode: PersonDocMode;
  source: PersonSource;
  identities: PersonIdentity[];
  header: PersonHeader;
  jobs: PersonJob[];
  educations: PersonEducation[];
  skills: PersonSkill[];
  contacts: PersonContact[];
}
