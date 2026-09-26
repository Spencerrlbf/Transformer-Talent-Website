// Server-only guards. Candidate locking and shared writer gate belong to caller.
import { randomUUID } from "node:crypto";
import type { PersonConnection } from "./save";
import { directoryCanonicalUsername } from "./directory-sources";
export type AuditWriter =
  | "application"
  | "refresh"
  | "directory"
  | "recruiter"
  | "projection"
  | "undo";
export interface AuditOperation {
  id: string;
  candidateId: string;
  writer: AuditWriter;
  receiptRef: string;
  anchorHash: string;
}
const GUARD = "candidate-audit-1";
const scopes: Record<string, { writer?: AuditWriter; fields: string[] }> = {
  profile: {
    fields: [
      "full_name",
      "current_title",
      "current_company",
      "current_company_id",
      "work_experience",
      "education",
      "education_schools",
      "education_degrees",
      "education_fields",
      "top_skills",
      "all_skills_text",
      "previous_companies",
      "headline",
      "profile_summary",
      "location",
      "profile_picture_url",
      "email",
      "phone",
      "updated_at",
    ],
  },
  refresh_metadata: {
    writer: "refresh",
    fields: [
      "linkedin_enrichment_date",
      "calculated_experience_years",
      "updated_at",
    ],
  },
  directory_metadata: {
    writer: "directory",
    fields: [
      "directory_contact_id",
      "directory_sync_hash",
      "source",
      "status",
      "follow_up_at",
      "linkedin_enrichment_date",
      "calculated_experience_years",
      "updated_at",
    ],
  },
  recruiter_contact: { writer: "recruiter", fields: ["contact", "updated_at"] },
  application_finalize: {
    writer: "application",
    fields: [
      "candidate_id",
      "pool_created_person",
      "parsed_profile",
      "updated_at",
    ],
  },
};
const integer = (v: unknown) =>
  typeof v === "string" &&
  /^\d{1,19}$/.test(v) &&
  BigInt(v) <= BigInt("9223372036854775807");
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
async function auxiliaryProof(c: PersonConnection, id: string) {
  const row = (
    await c.query(
      "select person_private.audit_auxiliary_proof($1::uuid) result",
      [id],
    )
  ).rows[0].result;
  if (row.n > 1000) throw Error("audit_auxiliary_limit");
  return row.proof as Record<string, string>;
}
async function currentBoundary(c: PersonConnection, id: string) {
  const row = (
    await c.query(
      `select person_private.audit_candidate_hash(to_jsonb(c)) candidate_hash,
 coalesce((select max(id) from public.person_change_events where candidate_id=c.id),0)::text captured_version
 from public.candidates c where c.id=$1`,
      [id],
    )
  ).rows[0];
  if (!row) throw Error("audit_candidate_missing");
  return row;
}
async function ensureAnchor(c: PersonConnection, id: string) {
  const a = (
    await c.query(
      `select a.*,a.anchor_hash=person_private.audit_anchor_hash(to_jsonb(a)) valid,
 person_private.audit_candidate_hash(a.before_image) candidate_hash from public.person_audit_anchors a where candidate_id=$1`,
      [id],
    )
  ).rows[0];
  if (!a) throw Error("audit_anchor_required");
  if (
    !a.valid ||
    a.parser_version !== "person-v3" ||
    a.before_image?.id !== id ||
    !["legacy", "receipt_created"].includes(a.kind)
  )
    throw Error("audit_anchor_invalid");
  if (
    (
      await c.query(
        "select 1 from public.person_source_holds where candidate_id=$1 and resolved_at is null limit 1",
        [id],
      )
    ).rows.length
  )
    throw Error("audit_source_hold");
  if (a.kind === "legacy") {
    const s = a.legacy_doc?.source;
    if (
      !s ||
      !(
        await c.query(
          `select 1 from public.candidate_sources where candidate_id=$1 and source='legacy_import' and source_ref=$2 and payload_hash=$3 and parser_version=$4 and fetched_at=$5::timestamptz and provider is not distinct from $6 and raw_in is not distinct from $7 and enrichment_id is not distinct from $8::uuid limit 1`,
          [
            id,
            s.source_ref,
            s.payload_hash,
            s.parser_version,
            s.fetched_at,
            s.provider,
            s.raw_in,
            s.enrichment_id,
          ],
        )
      ).rows.length
    )
      throw Error("audit_anchor_source");
  }
  if (a.kind === "receipt_created") {
    const creator = a.external_proof?.creator_event_id;
    if (!integer(creator)) throw Error("audit_creation_event");
    const e = (
      await c.query(
        `select o.writer,o.receipt_ref from public.person_change_events e join public.person_change_attributions x on x.event_id=e.id join public.person_audit_operations o on o.id=x.operation_id
   where e.id=$2::bigint and e.candidate_id=$1 and e.source_table='candidates' and e.source_row_id=$1::text and e.operation='INSERT' and e.previous_payload is null and e.payload->>'id'=$1::text
   and x.scope='creation' and x.candidate_id=$1 and o.candidate_id=$1 and o.receipt_ref=$3 and e.transaction_id=o.transaction_id
   and person_private.audit_candidate_hash(e.payload)=$4 and x.event_hash=md5(jsonb_build_array(e.id,e.candidate_id,e.source_table,e.source_row_id,e.operation,e.transaction_id::text,e.previous_payload,e.payload)::text)`,
        [id, creator, a.creator_ref, a.candidate_hash],
      )
    ).rows[0];
    if (!e || !["application", "directory"].includes(e.writer))
      throw Error("audit_creation_event");
    await creationReceipt(c, id, e.writer, a.creator_ref, a.before_image);
  }
  const aux = await auxiliaryProof(c, id);
  if (Object.keys(aux).some((k) => aux[k] !== a.external_proof?.[k]))
    throw Error("audit_auxiliary_changed");
  return { anchor: a, aux };
}
async function checkCandidateChain(
  c: PersonConnection,
  id: string,
  version: string,
  startHash: string,
  anchorHash: string,
  end: { candidate_hash: string; captured_version: string },
) {
  const events = (
    await c.query(
      `select e.id::text,e.operation,e.source_row_id,e.payload->>'id' payload_id,e.previous_payload->>'id' prior_id,
 person_private.audit_candidate_hash(e.previous_payload) before_hash,person_private.audit_candidate_hash(e.payload) after_hash,
 a.event_id::text attributed,a.scope,a.changed_fields,
 (select coalesce(array_agg(k order by k),'{}') from (select jsonb_object_keys(coalesce(e.previous_payload,'{}')) k union select jsonb_object_keys(e.payload)) keys where e.previous_payload->k is distinct from e.payload->k) actual_fields,
 a.event_hash=md5(jsonb_build_array(e.id,e.candidate_id,e.source_table,e.source_row_id,e.operation,e.transaction_id::text,e.previous_payload,e.payload)::text) hash_valid,
 a.candidate_id attribution_candidate,o.candidate_id operation_candidate,o.writer,o.evidence,
 e.transaction_id is not null and e.transaction_id=o.transaction_id transaction_valid
 from (select * from public.person_change_events where candidate_id=$1 and source_table='candidates' and id>$2::bigint and id<=$3::bigint order by id limit 201)e
 left join public.person_change_attributions a on a.event_id=e.id left join public.person_audit_operations o on o.id=a.operation_id order by e.id`,
      [id, version, end.captured_version],
    )
  ).rows;
  if (events.length > 200) throw Error("audit_event_limit");
  let current = startHash;
  for (const e of events) {
    if (
      e.source_row_id !== id ||
      e.payload_id !== id ||
      e.prior_id !== id ||
      e.operation !== "UPDATE"
    )
      throw Error("audit_event_chain");
    if (e.attributed) {
      const rule = scopes[e.scope];
      if (
        !e.hash_valid ||
        !e.transaction_valid ||
        e.attribution_candidate !== id ||
        e.operation_candidate !== id ||
        !rule ||
        e.scope === "application_finalize" ||
        (rule.writer && rule.writer !== e.writer) ||
        JSON.stringify(e.changed_fields) !== JSON.stringify(e.actual_fields) ||
        e.actual_fields.some((k: string) => !rule.fields.includes(k)) ||
        e.evidence?.guard?.anchor_hash !== anchorHash
      )
        throw Error("audit_attribution_invalid");
    }
    if (e.before_hash !== current) throw Error("audit_event_chain");
    if (e.before_hash !== e.after_hash && !e.attributed)
      throw Error("audit_unattributed_change");
    current = e.after_hash;
  }
  if (current !== end.candidate_hash) throw Error("audit_event_chain");
}
/** Validate first, then retain the pre-write boundary in an immutable operation.
 * Later guards recheck the actual captured events after this boundary. */
export async function beginGuardedAuditOperationLocked(
  c: PersonConnection,
  before: Record<string, any>,
  args: {
    writer: AuditWriter;
    receiptRef: string;
    evidence?: Record<string, unknown>;
  },
): Promise<AuditOperation> {
  const id = before.id;
  if (
    ![
      "application",
      "refresh",
      "directory",
      "recruiter",
      "projection",
      "undo",
    ].includes(args.writer) ||
    !args.receiptRef.startsWith(`${args.writer}:`) ||
    args.receiptRef.length > 200
  )
    throw Error("audit_operation_identity");
  const { anchor, aux } = await ensureAnchor(c, id),
    end = await currentBoundary(c, id);
  const last = (
    await c.query(
      `select evidence->'guard' guard from public.person_audit_operations where candidate_id=$1 and evidence->'guard'->>'version'=$2 and evidence->'guard'->>'anchor_hash'=$3 order by created_at desc,id desc limit 1`,
      [id, GUARD, anchor.anchor_hash],
    )
  ).rows[0]?.guard;
  let version = String(anchor.captured_version),
    candidateHash = anchor.candidate_hash;
  if (last) {
    if (
      !integer(last.captured_version) ||
      !hash(last.candidate_hash) ||
      BigInt(last.captured_version) < BigInt(version) ||
      BigInt(last.captured_version) > BigInt(end.captured_version) ||
      Object.keys(aux).some((k) => last.auxiliary?.[k] !== aux[k])
    )
      throw Error("audit_checkpoint_invalid");
    version = last.captured_version;
    candidateHash = last.candidate_hash;
  }
  await checkCandidateChain(
    c,
    id,
    version,
    candidateHash,
    anchor.anchor_hash,
    end,
  );
  const operation: AuditOperation = {
    id: randomUUID(),
    candidateId: id,
    writer: args.writer,
    receiptRef: args.receiptRef,
    anchorHash: anchor.anchor_hash,
  };
  await c.query(
    `insert into public.person_audit_operations(id,candidate_id,writer,receipt_ref,evidence) values($1,$2,$3,$4,$5)`,
    [
      operation.id,
      id,
      args.writer,
      args.receiptRef,
      {
        ...args.evidence,
        guard: {
          version: GUARD,
          anchor_hash: anchor.anchor_hash,
          ...end,
          auxiliary: aux,
        },
      },
    ],
  );
  return operation;
}
/** One explicit mutation of one source row. Never attributes other TX events. */
export async function attributeAuditMutation<
  T extends { rows: any[]; rowCount?: number | null },
>(
  c: PersonConnection,
  op: AuditOperation,
  scope: {
    scope: string;
    table: "candidates" | "website_applications";
    rowId: string;
  },
  mutate: () => Promise<T>,
): Promise<T> {
  if (
    !op?.id ||
    !scopes[scope.scope] ||
    (scope.table === "candidates" && scope.rowId !== op.candidateId)
  )
    throw Error("audit_operation_required");
  const boundary = (
    await c.query(
      `select coalesce(max(id),0)::text n from public.person_change_events where candidate_id=$1 and source_table=$2 and source_row_id=$3 and transaction_id=pg_current_xact_id()`,
      [op.candidateId, scope.table, scope.rowId],
    )
  ).rows[0].n;
  const result = await mutate();
  const events = (
    await c.query(
      `select id::text from public.person_change_events where candidate_id=$1 and source_table=$2 and source_row_id=$3 and transaction_id=pg_current_xact_id() and id>$4::bigint order by id limit 2`,
      [op.candidateId, scope.table, scope.rowId, boundary],
    )
  ).rows;
  if (
    ![0, 1].includes(result.rowCount as number) ||
    result.rows.length !== result.rowCount ||
    events.length !== result.rowCount ||
    (result.rowCount === 1 && String(result.rows[0]?.id) !== scope.rowId)
  )
    throw Error("audit_mutation_scope");
  for (const e of events)
    await c.query(
      "select person_private.attribute_change($1::bigint,$2::uuid,$3)",
      [e.id, op.id, scope.scope],
    );
  return result;
}

async function creationReceipt(
  c: PersonConnection,
  id: string,
  writer: "application" | "directory",
  ref: string,
  seed?: Record<string, any>,
) {
  const key = ref.slice(writer.length + 1);
  if (
    !ref.startsWith(`${writer}:`) ||
    (writer === "application"
      ? !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          key,
        )
      : !/^\d{1,19}$/.test(key))
  )
    throw Error("audit_creation_receipt");
  const receipt = (
    await c.query(
      writer === "application"
        ? `select r.*,a.name seed_name from public.person_application_receipts r join public.website_applications a on a.id=r.application_id where r.application_id=$2::uuid and r.candidate_id=$1 and r.created_person and a.organization_id='801865a7-6533-41d2-9c45-e4a90e6ad51a'`
        : `select r.*,r.snapshot->'board'->>'name' seed_name from public.person_directory_receipts r where r.id=$2::bigint and r.candidate_id=$1 and r.created_person`,
      [id, key],
    )
  ).rows[0];
  if (!receipt) throw Error("audit_creation_receipt");
  if (seed) {
    const username =
      writer === "application"
        ? String(receipt.application_snapshot?.linkedin_username ?? "")
            .trim()
            .toLowerCase()
        : directoryCanonicalUsername(receipt.snapshot);
    const name =
      (writer === "application"
        ? receipt.application_snapshot?.name
        : receipt.snapshot?.board?.name) || username;
    if (
      !username ||
      seed.linkedin_username !== username ||
      seed.linkedin_url !==
        `https://www.linkedin.com/in/${encodeURIComponent(username)}` ||
      seed.full_name !== name ||
      seed.source !==
        (writer === "application" ? "website_applicant" : "directory")
    )
      throw Error("audit_creation_receipt");
  }
  return receipt;
}
/** A genuine same-transaction seed INSERT is evidence of receipt creation,
 * never an invented legacy_import. The caller must already have its receipt. */
export async function createReceiptAuditAnchorLocked(
  c: PersonConnection,
  before: Record<string, any>,
  args: { writer: "application" | "directory"; receiptRef: string },
): Promise<AuditOperation> {
  const id = before.id;
  if (
    (
      await c.query(
        `select 1 from public.person_audit_anchors where candidate_id=$1 union all select 1 from public.candidate_profile_state where candidate_id=$1 union all select 1 from public.candidate_sources where candidate_id=$1 limit 1`,
        [id],
      )
    ).rows.length
  )
    throw Error("audit_creation_not_new");
  if (
    (
      await c.query(
        "select 1 from public.person_source_holds where candidate_id=$1 and resolved_at is null limit 1",
        [id],
      )
    ).rows.length
  )
    throw Error("audit_source_hold");
  const receipt = await creationReceipt(c, id, args.writer, args.receiptRef);
  const events = (
    await c.query(
      `select id::text,payload,person_private.audit_candidate_hash(payload) candidate_hash from public.person_change_events where candidate_id=$1 and source_table='candidates' and source_row_id=$1::text and operation='INSERT' and previous_payload is null and transaction_id=pg_current_xact_id() order by id limit 2`,
      [id],
    )
  ).rows;
  if (events.length !== 1) throw Error("audit_creation_event");
  const event = events[0];
  await creationReceipt(c, id, args.writer, args.receiptRef, event.payload);
  const aux = await auxiliaryProof(c, id);
  if (Object.values(aux).some((h) => h !== "d751713988987e9331980363e24189ce"))
    throw Error("audit_creation_auxiliary");
  const boundary = await currentBoundary(c, id);
  await checkCandidateChain(
    c,
    id,
    event.id,
    event.candidate_hash,
    "",
    boundary,
  );
  const payload = {
    candidate_id: id,
    kind: "receipt_created",
    baseline_run: null,
    parser_version: "person-v3",
    legacy_doc: null,
    before_image: event.payload,
    source_catalog: [],
    revision: 0,
    captured_version: event.id,
    creator_ref: args.receiptRef,
    external_proof: { ...aux, creator_event_id: event.id },
  };
  // Cast the capture boundary on the SQL side; never round a bigint through JS.
  const anchor = (
    await c.query(
      `with p as(select $1::jsonb||jsonb_build_object('captured_version',$2::bigint) payload)
 insert into public.person_audit_anchors(candidate_id,kind,parser_version,before_image,source_catalog,revision,captured_version,creator_ref,external_proof,anchor_hash)
 select $3,'receipt_created','person-v3',payload->'before_image','[]',0,$2::bigint,payload->>'creator_ref',payload->'external_proof',person_private.audit_anchor_hash(payload) from p returning anchor_hash`,
      [payload, event.id, id],
    )
  ).rows[0];
  const operation: AuditOperation = {
    id: randomUUID(),
    candidateId: id,
    writer: args.writer,
    receiptRef: args.receiptRef,
    anchorHash: anchor.anchor_hash,
  };
  await c.query(
    "insert into public.person_audit_operations(id,candidate_id,writer,receipt_ref,evidence) values($1,$2,$3,$4,$5)",
    [
      operation.id,
      id,
      args.writer,
      args.receiptRef,
      {
        guard: {
          version: GUARD,
          anchor_hash: anchor.anchor_hash,
          ...boundary,
          auxiliary: aux,
        },
        creator_event_id: event.id,
      },
    ],
  );
  await c.query(
    "select person_private.attribute_change($1::bigint,$2::uuid,'creation')",
    [event.id, operation.id],
  );
  return operation;
}
