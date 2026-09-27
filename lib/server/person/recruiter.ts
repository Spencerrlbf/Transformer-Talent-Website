import { transitionSupport } from "../person-transition/context";
import {
  beginGuardedAuditOperationLocked,
  attributeAuditMutation,
} from "./audit";
// A contact edit is one website transaction. Public/tenant applications and
// sourced records never enter this TT-only service.
import { createHash } from "node:crypto";
import {
  assembleDoc,
  makeHeader,
  emailContact,
  phoneContact,
  githubContact,
  normalizeEmail,
  normalizePhone,
  mergeContacts,
  stableStringify,
  TT_ORG_ID,
} from "./normalize";
import {
  compatibilityProjection,
  projectionEnvelope,
  readPersonProjection,
  beginPersonTransaction,
  lockPerson,
  savePersonLocked,
  withPersonConnection,
  type PersonConnection,
} from "./save";
import {
  effectivePoolContact,
  eligiblePoolContact,
  type PoolContact,
} from "./contacts";
const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const str = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
export interface RecruiterContactInput {
  organizationId: string;
  candidateId: string;
  actorId: string;
  requestId: string;
  contact: PoolContact;
  mode: "shadow" | "live";
}
function cleanContact(input: PoolContact): PoolContact {
  const email = str(input.email),
    phone = str(input.phone),
    github = str(input.github);
  if (email && (email.length > 160 || !normalizeEmail(email)))
    throw Error("invalid_email");
  if (phone && (phone.length > 40 || !normalizePhone(phone)))
    throw Error("invalid_phone");
  if (github && (github.length > 160 || !githubContact(github)))
    throw Error("invalid_github");
  if (input.otherEmails != null && !Array.isArray(input.otherEmails))
    throw Error("invalid_email");
  const seen = new Set([normalizeEmail(email)]),
    others: string[] = [];
  for (const raw of input.otherEmails ?? []) {
    const value = str(raw);
    if (!value) continue;
    const normalized = normalizeEmail(value);
    if (value.length > 160 || !normalized) throw Error("invalid_email");
    if (!seen.has(normalized)) {
      seen.add(normalized);
      others.push(value);
    }
    if (others.length >= 8) break;
  }
  return { email, phone, github, otherEmails: others };
}
async function currentContact(
  c: PersonConnection,
  id: string,
  mode: "shadow" | "live",
) {
  const row = (
    await c.query(
      "select contact,exists(select 1 from public.person_projection_state p where p.candidate_id=c.id) published from public.candidates c where id=$1",
      [id],
    )
  ).rows[0];
  if (mode !== "live" || !row.published) return row.contact as PoolContact;
  const contacts = (
    await c.query(
      "select * from public.candidate_contacts where candidate_id=$1",
      [id],
    )
  ).rows;
  return effectivePoolContact(contacts, row.contact).contact;
}
function prepareContact(
  a: RecruiterContactInput,
  cleaned: PoolContact,
  existing: any[],
  editedAt: string,
) {
  const requestedKeys = new Map<
    string,
    { kind: string; value_normalized: string }
  >();
  for (const [kind, value] of [
    ["email", normalizeEmail(cleaned.email)],
    ["phone", normalizePhone(cleaned.phone)],
    ["github", githubContact(cleaned.github)?.value_normalized],
    ...(cleaned.otherEmails ?? []).map((value) => [
      "email",
      normalizeEmail(value),
    ]),
  ])
    if (kind && value)
      requestedKeys.set(`${kind}:${value}`, { kind, value_normalized: value });
  const priorContactFlags = [...requestedKeys.values()].map((key) => {
    const previous = existing.find(
      (row) =>
        row.kind === key.kind && row.value_normalized === key.value_normalized,
    );
    return {
      ...key,
      existed: !!previous,
      never_primary: previous ? previous.never_primary : null,
    };
  });
  const choices = {
    email: normalizeEmail(cleaned.email),
    phone: normalizePhone(cleaned.phone),
  };
  for (const [kind, value] of Object.entries(choices)) {
    const row = existing.find(
      (row) => row.kind === kind && row.value_normalized === value,
    );
    if (
      row &&
      (row.never_primary ||
        ["invalid", "bounced", "do_not_use", "removed", "shared"].includes(
          row.status,
        ) ||
        (kind === "email" &&
          !eligiblePoolContact({ ...row, status: "active" })))
    )
      throw Error(`${kind}_unusable`);
  }
  const contacts = mergeContacts([
    emailContact(cleaned.email, {
      is_manual: true,
      source_detail: "recruiter_primary",
    }),
    phoneContact(cleaned.phone, {
      is_manual: true,
      source_detail: "recruiter",
    }),
    githubContact(cleaned.github, {
      is_manual: true,
      source_detail: "recruiter",
    }),
    ...(cleaned.otherEmails ?? []).map((value) =>
      emailContact(value, { source_detail: "recruiter_other" }),
    ),
  ]);
  for (const contact of contacts) {
    const previous = existing.find(
      (row) =>
        row.kind === contact.kind &&
        row.value_normalized === contact.value_normalized,
    );
    if (previous?.never_primary) contact.never_primary = true;
  }
  const doc = assembleDoc({
    candidate_id: a.candidateId,
    mode: "contacts_only",
    source: {
      source: "recruiter",
      provider: "website-recruiter",
      source_ref: a.requestId,
      fetched_at: editedAt,
      raw_in: "inline",
      enrichment_id: null,
    },
    identities: [],
    header: makeHeader({}),
    contacts,
  });
  return { doc, choices, priorContactFlags };
}
export async function saveRecruiterContactOnConnection(
  c: PersonConnection,
  a: RecruiterContactInput,
) {
  if (a.organizationId !== TT_ORG_ID) throw Error("person_recruiter_tenant");
  if (![a.candidateId, a.actorId, a.requestId].every(uuid))
    throw Error("person_recruiter_identity");
  if (!["shadow", "live"].includes(a.mode))
    throw Error("person_recruiter_mode");
  const cleaned = cleanContact(a.contact);
  const hash = createHash("sha256")
    .update(stableStringify(cleaned))
    .digest("hex");
  if (transitionSupport()) return saveCertifiedRecruiter(c, a, cleaned, hash);
  try {
    await beginPersonTransaction(c);
    const before = await lockPerson(c, a.candidateId);
    const old = (
      await c.query(
        "select * from public.person_recruiter_receipts where id=$1",
        [a.requestId],
      )
    ).rows[0];
    if (old) {
      if (
        old.candidate_id !== a.candidateId ||
        old.actor_id !== a.actorId ||
        old.input_hash !== hash
      )
        throw Error("person_recruiter_receipt_conflict");
      const contact = await currentContact(c, a.candidateId, a.mode);
      await c.query("commit");
      return { contact, replayed: true };
    }
    if (
      !(
        await c.query(
          "select 1 from public.candidate_profile_state where candidate_id=$1",
          [a.candidateId],
        )
      ).rows.length
    )
      throw Error("person_recruiter_not_migrated");
    if (
      (
        await c.query(
          "select 1 from public.person_source_holds where candidate_id=$1 and resolved_at is null limit 1",
          [a.candidateId],
        )
      ).rows.length
    )
      throw Error("person_recruiter_source_hold");
    const existing = (
      await c.query(
        "select * from public.candidate_contacts where candidate_id=$1",
        [a.candidateId],
      )
    ).rows;
    // Record the exact pre-edit eligibility input under the candidate lock.
    // Source timestamps use transaction start and cannot reconstruct this
    // state after a delayed admission or a later replay of historical facts.
    const editedAt = (
      await c.query("select clock_timestamp() at")
    ).rows[0].at.toISOString();
    const { doc, choices, priorContactFlags } = prepareContact(
      a,
      cleaned,
      existing,
      editedAt,
    );
    const audit = await beginGuardedAuditOperationLocked(c, before, {
      writer: "recruiter",
      receiptRef: `recruiter:${a.requestId}`,
      evidence: { prior_contact_flags: priorContactFlags },
    });
    await c.query(
      "insert into public.person_recruiter_receipts(id,candidate_id,actor_id,input_hash,edited_at,requested_contact,before_contact,document,mode) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        a.requestId,
        a.candidateId,
        a.actorId,
        hash,
        editedAt,
        cleaned,
        before.contact,
        doc,
        a.mode,
      ],
    );
    await savePersonLocked(c, [doc], { mode: "shadow" }, before, audit);
    for (const [kind, value] of Object.entries(choices))
      await c.query(
        "insert into public.person_recruiter_primary(candidate_id,kind,chosen_value,receipt_id) values($1,$2,$3,$4) on conflict(candidate_id,kind) do update set chosen_value=excluded.chosen_value,receipt_id=excluded.receipt_id",
        [a.candidateId, kind, value, a.requestId],
      );
    // Even an empty doc can withdraw a historical manual preference.
    await c.query("select public.person_rerank_contacts($1)", [a.candidateId]);
    await c.query(
      "update public.candidate_profile_state set rev=rev+1,updated_at=clock_timestamp() where candidate_id=$1",
      [a.candidateId],
    );
    const stored = (
      await c.query(
        "select * from public.candidate_contacts where candidate_id=$1",
        [a.candidateId],
      )
    ).rows;
    for (const [kind, value] of Object.entries(choices))
      if (
        value &&
        !stored.some(
          (row) =>
            row.kind === kind &&
            row.value_normalized === value &&
            row.rank === 1 &&
            eligiblePoolContact(row),
        )
      )
        throw Error(`${kind}_unusable`);
    await attributeAuditMutation(
      c,
      audit,
      { scope: "recruiter_contact", table: "candidates", rowId: a.candidateId },
      () =>
        c.query(
          "update public.candidates set contact=$2,updated_at=clock_timestamp() where id=$1 returning id",
          [a.candidateId, cleaned],
        ),
    );
    const result = await savePersonLocked(
      c,
      [doc],
      { mode: a.mode },
      before,
      audit,
    );
    const contact =
      a.mode === "live"
        ? effectivePoolContact(stored, cleaned).contact
        : cleaned;
    await c.query(
      "update public.person_recruiter_receipts set effective_contact=$2,result=$3 where id=$1",
      [a.requestId, contact, result],
    );
    await c.query("commit");
    return { contact, replayed: false };
  } catch (error) {
    await c.query("rollback").catch(() => {});
    throw error;
  }
}
export const saveRecruiterContact = (a: RecruiterContactInput) =>
  withPersonConnection((c) => saveRecruiterContactOnConnection(c, a));

// One atomic edit; a completed request returns current UI contact without
// changing the original edit's immutable receipt, timestamp or publication mode.
async function saveCertifiedRecruiter(
  c: PersonConnection,
  a: RecruiterContactInput,
  cleaned: PoolContact,
  hash: string,
) {
  try {
    await beginPersonTransaction(c);
    const admission = (
      await c.query(
        "select person_private.recruiter_begin($1,$2,$3,$4,$5,$6,$7) result",
        [
          a.organizationId,
          a.requestId,
          a.candidateId,
          a.actorId,
          hash,
          cleaned,
          a.mode,
        ],
      )
    ).rows[0].result;
    if (admission.status === "unavailable")
      throw Error("person_recruiter_unavailable");
    if (admission.status === "completed") {
      const contact = await currentContact(c, a.candidateId, a.mode);
      await c.query("commit");
      return { contact, replayed: true };
    }
    const { doc, choices, priorContactFlags } = prepareContact(
      a,
      cleaned,
      admission.contacts,
      new Date(admission.editedAt).toISOString(),
    );
    await c.query("select person_private.recruiter_seal($1,$2,$3,$4)", [
      a.requestId,
      doc,
      choices,
      JSON.stringify(priorContactFlags),
    ]);
    await c.query("select person_private.recruiter_audit_begin($1)", [
      a.requestId,
    ]);
    await c.query("select person_private.recruiter_normalize($1)", [
      a.requestId,
    ]);
    await c.query("select person_private.recruiter_contact($1)", [a.requestId]);
    if (a.mode === "live") {
      const tables = await readPersonProjection(c, a.candidateId);
      const state = (
        await c.query(
          "select * from public.candidate_profile_state where candidate_id=$1",
          [a.candidateId],
        )
      ).rows[0];
      const before = (
        await c.query("select person_private.publication_candidate($1) value", [
          a.candidateId,
        ])
      ).rows[0].value;
      const computed = await compatibilityProjection(
        tables,
        state,
        before,
        async () => false,
      );
      await c.query("select person_private.recruiter_project($1,$2)", [
        a.requestId,
        projectionEnvelope(a.candidateId, before, computed),
      ]);
    }
    const contact = await currentContact(c, a.candidateId, a.mode);
    await c.query("select person_private.recruiter_complete($1,$2)", [
      a.requestId,
      contact,
    ]);
    await c.query("commit");
    return { contact, replayed: false };
  } catch (error) {
    await c.query("rollback").catch(() => {});
    throw error;
  }
}
