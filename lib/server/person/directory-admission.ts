import { fromDirectory } from "./fromDirectory";
import {
  directoryDocuments,
  type DirectorySnapshot,
} from "./directory-sources";
import { stableStringify } from "./normalize";
import type { PersonDoc } from "./types";

export type DirectoryAdmissionEvidence = {
  version: "directory-admission-1";
  parserVersion: "person-v3";
  candidateId: string;
  receiptId: string;
  snapshot: DirectorySnapshot;
  sources: Array<{
    id: string;
    payload_hash: string;
    parser_version: string;
    fetched_at: string;
  }>;
  header: Record<string, any>;
  prior: null | {
    receiptId: string;
    candidateId: string;
    hasDocuments: true;
    snapshot: DirectorySnapshot;
    sourceReviews: Array<Record<string, any>>;
  };
};
export type DirectoryAdmissionDecision = {
  docs: PersonDoc[];
  reviews: Array<Record<string, any>>;
};
const uuid = (x: unknown): x is string =>
  typeof x === "string" &&
  /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(x);
const receipt = (x: unknown): x is string =>
  typeof x === "string" && /^[1-9][0-9]*$/.test(x);
const object = (x: any) =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const date = (x: unknown) =>
  typeof x === "string" && Number.isFinite(Date.parse(x));
function snapshotValid(s: DirectorySnapshot) {
  return (
    object(s) &&
    object(s.board) &&
    uuid(s.board.contact_id) &&
    (s.harvest === null || object(s.harvest)) &&
    [s.exps, s.edus, s.emails, s.facts, s.identifiers].every(
      (a) => Array.isArray(a) && a.every(object),
    ) &&
    Array.isArray(s.phones) &&
    s.phones.every((x) => typeof x === "string" || object(x))
  );
}
/** Capture data, not authority. The direct writer must prove the SQL selections
 * and privately bind this evidence under locks before it can authorize a save. */
export function captureDirectoryAdmissionEvidence(
  input: DirectoryAdmissionEvidence,
): DirectoryAdmissionEvidence {
  let e: DirectoryAdmissionEvidence;
  try {
    e = JSON.parse(JSON.stringify(input));
  } catch {
    throw Error("directory_admission_shape");
  }
  if (
    !object(e) ||
    e.version !== "directory-admission-1" ||
    e.parserVersion !== "person-v3"
  )
    throw Error("directory_admission_version");
  if (
    !uuid(e.candidateId) ||
    !receipt(e.receiptId) ||
    !snapshotValid(e.snapshot) ||
    !object(e.header) ||
    !Array.isArray(e.sources) ||
    e.sources.some(
      (x) =>
        !object(x) ||
        !uuid(x.id) ||
        typeof x.payload_hash !== "string" ||
        typeof x.parser_version !== "string" ||
        !date(x.fetched_at),
    )
  )
    throw Error("directory_admission_shape");
  if (
    Object.values(e.header).some(
      (x) => !object(x) || !date(x.at) || !uuid(x.source_id),
    )
  )
    throw Error("directory_admission_header");
  if (
    e.prior !== null &&
    (!object(e.prior) ||
      e.prior.candidateId !== e.candidateId ||
      !receipt(e.prior.receiptId) ||
      BigInt(e.prior.receiptId) >= BigInt(e.receiptId) ||
      e.prior.hasDocuments !== true ||
      !snapshotValid(e.prior.snapshot) ||
      !Array.isArray(e.prior.sourceReviews) ||
      e.prior.sourceReviews.some(
        (x) =>
          !object(x) ||
          typeof x.component !== "string" ||
          typeof x.reason !== "string",
      ))
  )
    throw Error("directory_admission_prior");
  return e;
}
/** Frozen decision semantics: no clock, SQL, current-state reads or cache trust. */
export function evaluateDirectoryAdmission(
  input: DirectoryAdmissionEvidence,
): DirectoryAdmissionDecision {
  const e = captureDirectoryAdmissionEvidence(input),
    id = e.candidateId,
    s = e.snapshot,
    sources = e.sources,
    state = { header: e.header },
    prior = e.prior
      ? { snapshot: e.prior.snapshot, source_reviews: e.prior.sourceReviews }
      : null,
    all = directoryDocuments(s, id);
  const baseline = fromDirectory(
    s.board,
    s.harvest,
    s.exps,
    s.edus,
    s.emails,
    s.phones,
    id,
  );
  const exact = sources.some(
    (x) =>
      x.payload_hash === baseline.source.payload_hash &&
      x.parser_version === baseline.source.parser_version &&
      new Date(x.fetched_at).toISOString() === baseline.source.fetched_at,
  );
  const reviews = new Map<string, any>(
    (prior?.source_reviews ?? []).map((x: any) => [x.component, x]),
  );
  const hold = (component: string, reason: string) =>
    reviews.set(component, { component, reason });
  for (const d of all)
    for (const contact of d.contacts)
      if (contact.source_detail === "directory_contact_chronology")
        hold(
          `email:${contact.value_normalized}`,
          "directory_contact_chronology",
        );
  const previous = new Map(
    prior
      ? directoryDocuments(prior.snapshot, id).map((d) => [
          d.source.source_ref,
          d,
        ])
      : [],
  );
  const docs = all.filter((d) => {
    const ref = d.source.source_ref!,
      old = previous.get(ref);
    const history = ref.endsWith(":harvest"),
      board = ref.includes(":board:");
    if ((history || board) && exact) return false;
    // An unchanged rejected component is still rejected, not an accepted
    // predecessor. Its scoped review remains until proven newer input arrives.
    if (
      (history || board) &&
      old?.source.payload_hash === d.source.payload_hash
    )
      return false;
    if (
      history &&
      ((old && d.source.fetched_at <= old.source.fetched_at) ||
        (!prior &&
          sources.some(
            (x) => new Date(x.fetched_at).toISOString() >= d.source.fetched_at,
          )))
    ) {
      hold("harvest", "directory_history_chronology");
      return false;
    }
    if (history) reviews.delete("harvest");
    if (board) {
      const field = Object.keys(d.header).find(
        (k) => d.header[k as keyof typeof d.header] != null,
      )!;
      const current = state?.header?.[field];
      if (current?.value === d.header[field as keyof typeof d.header])
        return false;
      const baselineBlocked =
        current &&
        sources.some((x) => x.id === current.source_id) &&
        d.source.fetched_at <= new Date(current.at).toISOString();
      if (
        current &&
        (d.mode === "fill_gaps" ||
          baselineBlocked ||
          (old && d.source.fetched_at <= old.source.fetched_at))
      ) {
        hold(field, "directory_header_chronology");
        return false;
      }
      if (!current || d.source.fetched_at > new Date(current.at).toISOString())
        reviews.delete(field);
    }
    return true;
  });
  if (!docs.length) docs.push(all[0]);
  return { docs, reviews: [...reviews.values()] };
}

/** Proves the output only relative to supplied evidence. Certification of input
 * ownership, source completeness and prior selection remains the writer's job. */
export function directoryAdmissionMatches(
  evidence: DirectoryAdmissionEvidence,
  decision: unknown,
): boolean {
  try {
    return (
      stableStringify(evaluateDirectoryAdmission(evidence)) ===
      stableStringify(decision)
    );
  } catch {
    return false;
  }
}
