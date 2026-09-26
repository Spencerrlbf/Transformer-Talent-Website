// Live directory inputs have independent clocks. The historical person-v3
// translator remains frozen for migration replay.
import { createHash } from "node:crypto";
import {
  fromDirectory,
  type DirectoryBoardRow,
  type DirectoryHarvestRow,
  type DirectoryExperienceRow,
  type DirectoryEducationRow,
  type DirectoryEmailRow,
  type DirectoryPhoneRow,
} from "./fromDirectory";
import {
  assembleDoc,
  clean,
  isoOf,
  linkedinUrnOf,
  linkedinUsernameOf,
  makeHeader,
  normalizeEmail,
  stableStringify,
} from "./normalize";
import type { PersonDoc, PersonHeader, PersonIdentity } from "./types";
export interface DirectorySnapshot {
  board: DirectoryBoardRow;
  harvest: DirectoryHarvestRow | null;
  exps: DirectoryExperienceRow[];
  edus: DirectoryEducationRow[];
  emails: DirectoryEmailRow[];
  phones: DirectoryPhoneRow[];
  facts: Record<string, any>[];
  identifiers: Record<string, any>[];
}
const UNKNOWN = "1970-01-01T00:00:00.000Z";
const digest = (x: unknown) =>
  createHash("sha256").update(stableStringify(x)).digest("hex");
const ordered = (xs: any[]) =>
  [...xs].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
export function directorySnapshotHash(snapshot: DirectorySnapshot): string {
  const s = JSON.parse(JSON.stringify(snapshot)) as DirectorySnapshot;
  return digest({
    ...s,
    exps: ordered(s.exps),
    edus: ordered(s.edus),
    emails: ordered(s.emails),
    phones: ordered(s.phones),
    facts: ordered(s.facts),
    identifiers: ordered(s.identifiers),
  });
}
const username = (v: unknown) => {
  const parsed =
    linkedinUsernameOf(v) ??
    (typeof v === "string" && !v.includes("/") ? v.trim().toLowerCase() : null);
  return parsed && /^[\p{L}\p{N}\p{M}._-]{1,200}$/u.test(parsed)
    ? parsed
    : null;
};
export function directoryIdentities(s: DirectorySnapshot): PersonIdentity[] {
  const ids: PersonIdentity[] = [
    { kind: "directory_contact_id", value: s.board.contact_id },
  ];
  const add = (kind: PersonIdentity["kind"], value: string | null) => {
    if (value) ids.push({ kind, value });
  };
  const h = s.harvest,
    raw = h?.raw as Record<string, any> | null;
  for (const v of [
    s.board.linkedin_url,
    h?.linkedin_url,
    h?.public_identifier,
    raw?.linkedinUrl,
    raw?.linkedin_url,
    raw?.publicIdentifier,
    raw?.public_identifier,
  ])
    add("linkedin_username", username(v));
  add("linkedin_urn", linkedinUrnOf(raw?.id));
  const airtables = Array.isArray(s.board.airtable_record_ids)
    ? s.board.airtable_record_ids
    : String(s.board.airtable_record_ids ?? "").split(/[,\s]+/);
  for (const v of airtables)
    if (/^rec[A-Za-z0-9]{14}$/.test(String(v))) add("airtable_id", String(v));
  for (const r of s.identifiers) {
    if (["linkedin", "linkedin_username", "linkedin_url"].includes(r.kind))
      add(
        "linkedin_username",
        username(r.original_value ?? r.value) ?? username(r.value),
      );
    if (["linkedin_urn", "linkedin_member_id"].includes(r.kind))
      add("linkedin_urn", linkedinUrnOf(r.value));
    if (
      ["airtable", "airtable_id"].includes(r.kind) &&
      /^rec[A-Za-z0-9]{14}$/.test(String(r.value))
    )
      add("airtable_id", String(r.value));
  }
  return [
    ...new Map(ids.map((x) => [`${x.kind}:${x.value}`, x])).values(),
  ].sort((a, b) =>
    `${a.kind}:${a.value}`.localeCompare(`${b.kind}:${b.value}`),
  );
}
export function directoryCanonicalUsername(
  s: DirectorySnapshot,
): string | null {
  return (
    username(s.harvest?.public_identifier) ??
    username(s.harvest?.linkedin_url) ??
    username(s.board.linkedin_url) ??
    directoryIdentities(s).find((x) => x.kind === "linkedin_username")?.value ??
    null
  );
}
export function directoryPrimary(s: DirectorySnapshot): string | null {
  const d = fromDirectory(
    s.board,
    null,
    [],
    [],
    s.emails,
    [],
    s.board.contact_id,
  );
  return (
    d.contacts.find(
      (c) => c.kind === "email" && c.source_detail === "directory_primary",
    )?.value_normalized ?? null
  );
}
const boardFields = (b: DirectoryBoardRow): Partial<PersonHeader> => ({
  full_name:
    clean(b.name) ||
    [clean(b.first_name), clean(b.last_name)].filter(Boolean).join(" ") ||
    null,
  current_title: clean(b.title),
  current_company: clean(b.company),
  headline: clean(b.linkedin_headline) || clean(b.one_liner),
  location: clean(b.location) || clean(b.metro),
});
const factKeys: Record<string, string[]> = {
  full_name: ["name", "full_name"],
  current_title: ["title", "current_title"],
  current_company: ["company", "current_company"],
  headline: ["headline", "linkedin_headline", "one_liner"],
  location: ["location", "metro"],
};
function factDate(
  s: DirectorySnapshot,
  field: string,
  value: unknown,
): string | null {
  // Generic row updated_at includes workflow changes and is not a fact date.
  // Import/source recorded_at is ingestion time, not proof of when the
  // copied profile was true. Only an explicit manual field edit supplies a
  // board fact clock here; Harvest retains its separate fetched_at witness.
  const latest = s.facts
    .filter(
      (f) =>
        f.provenance === "manual" &&
        factKeys[field].includes(f.field) &&
        isoOf(f.recorded_at),
    )
    .sort(
      (a, b) =>
        isoOf(b.recorded_at)!.localeCompare(isoOf(a.recorded_at)!) ||
        String(b.id).localeCompare(String(a.id)),
    )[0];
  return latest && clean(latest.value) === value
    ? isoOf(latest.recorded_at)
    : null;
}
export function directoryDocuments(
  s: DirectorySnapshot,
  id: string,
): PersonDoc[] {
  const docs: PersonDoc[] = [];
  const ref = s.board.contact_id;
  const doc = (
    suffix: string,
    at: string,
    mode: PersonDoc["mode"],
    content: Partial<Omit<PersonDoc, "candidate_id" | "mode" | "source">>,
  ) =>
    assembleDoc({
      candidate_id: id,
      mode,
      source: {
        source: "directory",
        provider: "comms-live",
        source_ref: `${ref}:${suffix}`,
        fetched_at: at,
        raw_in: "directory",
        enrichment_id: null,
      },
      identities: [],
      header: makeHeader({}),
      contacts: [],
      ...content,
    });
  docs.push(
    doc("identities", UNKNOWN, "contacts_only", {
      identities: directoryIdentities(s),
    }),
  );
  if (s.harvest) {
    const h = s.harvest;
    const d = fromDirectory(
      {
        contact_id: ref,
        name: [h.first_name, h.last_name].filter(Boolean).join(" "),
      },
      h,
      s.exps,
      s.edus,
      [],
      [],
      id,
    );
    const { candidate_id, source, mode, ...content } = d;
    docs.push(
      doc(
        "harvest",
        isoOf(h.fetched_at) ?? UNKNOWN,
        isoOf(h.fetched_at) ? "replace_lists" : "fill_gaps",
        { ...content, identities: [] },
      ),
    );
  }
  for (const [field, value] of Object.entries(boardFields(s.board))) {
    if (!value) continue;
    const at = factDate(s, field, value);
    docs.push(
      doc(`board:${field}`, at ?? UNKNOWN, at ? "replace_lists" : "fill_gaps", {
        header: makeHeader({ [field]: value }),
      }),
    );
  }
  // Board fallback address is retained, but its primary flag has a separate
  // observed-snapshot authority and cannot advance verification/history dates.
  const emails = [...s.emails];
  const primary = normalizeEmail(s.board.primary_email);
  if (
    primary &&
    !emails.some(
      (e) => normalizeEmail(e.normalized ?? e.original_value) === primary,
    )
  )
    emails.push({
      normalized: primary,
      original_value: s.board.primary_email,
      verification: { status: s.board.email_status },
    });
  for (const e of ordered(emails)) {
    const v = { ...((e.verification as Record<string, unknown>) ?? {}) };
    delete v.primary;
    const r = { ...e, verification: v, is_primary: false };
    const d = fromDirectory({ contact_id: ref }, null, [], [], [r], [], id);
    const contacts = d.contacts.map((c) => ({
      ...c,
      source_detail: "directory",
      verified_at:
        [isoOf(v.checked_at), isoOf(v.verified_at), isoOf(v.bounced_at)]
          .filter((x): x is string => !!x)
          .sort()
          .at(-1) ?? null,
    }));
    for (const c of contacts)
      if (c.status === "invalid" && !c.verified_at) {
        // A current negative with an unknown check date cannot disprove a
        // historic dated verification, but it cannot remain contactable either.
        // Keep both pieces of evidence; only a reviewed action clears the hold.
        c.status = "do_not_use";
        c.source_detail = "directory_contact_chronology";
      }
    if (contacts.length)
      docs.push(
        doc(
          `email:${digest(contacts.map((c) => c.value_normalized)).slice(0, 24)}`,
          contacts[0].verified_at ?? UNKNOWN,
          "contacts_only",
          { contacts },
        ),
      );
  }
  for (const p of ordered(s.phones)) {
    const d = fromDirectory({ contact_id: ref }, null, [], [], [], [p], id);
    if (d.contacts.length)
      docs.push(
        doc(
          `phone:${digest(d.contacts.map((c) => c.value_normalized)).slice(0, 24)}`,
          typeof p === "object" ? (isoOf(p.recorded_at) ?? UNKNOWN) : UNKNOWN,
          "contacts_only",
          { contacts: d.contacts },
        ),
      );
  }
  return docs;
}
