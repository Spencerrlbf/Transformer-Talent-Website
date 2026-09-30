// A Transformer Talent website application (website_applications) as a
// PersonDoc that only fills gaps. A public form cannot prove who is typing,
// so what it carries never finds or joins a person, and its e-mail and phone
// are 'claimed' (kept, never ranked) unless the application created the
// person. Its LinkedIn history, when a Harvest pull was made, is the Harvest
// translator's job, not this one's. Client companies' applications never
// enter the pool: any organization other than TT is refused.
import type { PersonContact, PersonDoc } from "./types";
import { assembleDoc, emailContact, githubContact, isoOf, makeHeader, mergeContacts, phoneContact, TT_ORG_ID } from "./normalize";

export interface ApplicationRow {
  id: string;
  organization_id?: string | null;
  candidate_id?: string | null;
  created_at: string;
  name?: string | null;
  email?: string | null;
  location?: string | null;
  source?: string | null;
  /** The contact block a recruiter can edit on the application (app_ keys). */
  contact?: { email?: string | null; phone?: string | null; github?: string | null; otherEmails?: string[] | null } | null;
  /** What the résumé parse found. */
  parsed_profile?: { email?: string | null; phone?: string | null; [k: string]: unknown } | null;
  [column: string]: unknown;
}

export function fromApplication(websiteApplicationRow: ApplicationRow, createdThePerson: boolean, candidateId?: string): PersonDoc {
  const app = websiteApplicationRow;
  if (app.organization_id && app.organization_id !== TT_ORG_ID) {
    throw new Error("fromApplication: only Transformer Talent's own applications enter the pool");
  }
  const id = candidateId ?? app.candidate_id ?? "";
  const status: PersonContact["status"] = createdThePerson ? "active" : "claimed";
  const typed = { status, source_detail: "application" };
  const edited = { status, source_detail: "application_contact" };
  const resume = { status, source_detail: "application_resume" };
  const c = app.contact && typeof app.contact === "object" ? app.contact : null;
  const p = app.parsed_profile && typeof app.parsed_profile === "object" ? app.parsed_profile : null;
  return assembleDoc({
    candidate_id: id,
    mode: "fill_gaps",
    source: {
      source: "application",
      provider: "website",
      source_ref: app.id,
      fetched_at: isoOf(app.created_at) ?? "1970-01-01T00:00:00.000Z",
      raw_in: "inline",
      enrichment_id: null,
    },
    identities: [{ kind: "tt_application_id", value: app.id }],
    header: makeHeader({ full_name: app.name, location: app.location }),
    contacts: mergeContacts([
      emailContact(app.email, typed),
      emailContact(c?.email, edited),
      ...(Array.isArray(c?.otherEmails) ? c!.otherEmails! : []).map((e) => emailContact(e, edited)),
      phoneContact(c?.phone, edited),
      githubContact(c?.github, edited),
      emailContact(p?.email, resume),
      phoneContact(p?.phone, resume),
    ]),
  });
}
