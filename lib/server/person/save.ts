// Server/worker only. One checked-out PostgreSQL connection owns the complete
// transaction, including the existing TypeScript projection and before-image.
import { createHash, randomUUID } from "node:crypto";
import { project, type ProjectionInput } from "./project";
import type { PersonDoc } from "./types";
import { normalizeEmail, normalizePhone, checkClass } from "./normalize";
import {
  beginGuardedAuditOperationLocked,
  attributeAuditMutation,
  type AuditOperation,
} from "./audit";

export interface PersonConnection {
  query(
    sql: string,
    values?: any[],
  ): Promise<{ rows: any[]; rowCount?: number | null }>;
}
export interface SavePersonOptions {
  mode: "shadow" | "live";
}
export interface SavePersonResult {
  candidateId: string;
  changed: boolean;
  revision: string;
  projected: boolean;
  semanticChanged: boolean;
}
export const PROFILE_FIELDS = [
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
] as const;
function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])]),
    );
  return value;
}
const hash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
const profileOf = (row: Record<string, unknown>) =>
  Object.fromEntries(PROFILE_FIELDS.map((k) => [k, row[k] ?? null]));
/** Exact compatibility hash used for published reads and write drift checks. */
export const projectionProfileHash = (row: Record<string, unknown>): string =>
  hash(profileOf(row));
/** Used for observation only. This writer never calls paid enrichment or marks
 * matching/embedding work stale just because storage representation changed. */
export function semanticProfileHash(row: Record<string, any>): string {
  const clean = (v: any): any =>
    typeof v === "string"
      ? v.replace(/\s+/g, " ").trim()
      : Array.isArray(v)
        ? v.map(clean)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .filter(
                  ([k]) => !["company_ref", "current_company_id"].includes(k),
                )
                .map(([k, x]) => [k, clean(x)]),
            )
          : v;
  return hash(clean(profileOf(row)));
}
export async function readPersonProjection(
  client: PersonConnection,
  candidateId: string,
): Promise<ProjectionInput> {
  const state = (
    await client.query(
      "select * from public.candidate_profile_state where candidate_id=$1",
      [candidateId],
    )
  ).rows[0];
  if (!state) throw Error("person_state_missing");
  const jobs = (
    await client.query(
      `select e.*,coalesce(e.company_name,c.name) as company_name,coalesce(e.company_linkedin_url,c.linkedin_url) as company_linkedin_url
 from public.candidate_experiences e left join public.companies c on c.id=e.company_id
 where e.candidate_id=$1 and e.source='person' and e.removed_at is null order by e.sort_order,e.id`,
      [candidateId],
    )
  ).rows;
  const educations = (
    await client.query(
      `select e.*,s.name as school_name from public.candidate_educations e join public.schools s on s.id=e.school_id
 where e.candidate_id=$1 and e.removed_at is null order by e.sort_order,e.id`,
      [candidateId],
    )
  ).rows;
  const skills = (
    await client.query(
      `select s.*,k.name from public.candidate_skills s join public.skills k on k.id=s.skill_id
 where s.candidate_id=$1 and s.removed_at is null order by s.sort_order,s.skill_id`,
      [candidateId],
    )
  ).rows;
  const contacts = (
    await client.query(
      "select * from public.candidate_contacts where candidate_id=$1 order by kind,rank nulls last,value_normalized",
      [candidateId],
    )
  ).rows;
  const jobs_source = state.jobs_source_id
    ? (
        await client.query(
          "select source,fetched_at from public.candidate_sources where id=$1",
          [state.jobs_source_id],
        )
      ).rows[0]
    : null;
  return {
    jobs,
    educations,
    skills,
    contacts,
    contact_ranks_authoritative: true,
    header: Object.fromEntries(
      Object.entries(state.header ?? {}).map(([k, v]) => [
        k,
        (v as any)?.value,
      ]),
    ),
    header_provenance: state.header,
    jobs_source,
  };
}
export async function beginPersonTransaction(client: PersonConnection) {
  await client.query("begin");
  await client.query(
    "set local lock_timeout='3s'; set local statement_timeout='20s'; set local idle_in_transaction_session_timeout='30s'",
  );
  // Same normalized-writer lock first as save_person, then take the strongest
  // candidate lock before any projection/capture write can upgrade a row lock.
  await client.query("select pg_advisory_xact_lock_shared(72005,0)");
}
export async function lockPerson(client: PersonConnection, id: string) {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [id]);
  const before = (
    await client.query(
      "select * from public.candidates where id=$1 for update",
      [id],
    )
  ).rows[0];
  if (!before) throw Error("person_not_found");
  return before;
}
async function updateProfile(
  client: PersonConnection,
  id: string,
  profile: Record<string, any>,
  audit: AuditOperation,
) {
  const keys = PROFILE_FIELDS.filter((k) => Object.hasOwn(profile, k));
  const values = keys.map((k) =>
    k === "work_experience" ? JSON.stringify(profile[k]) : profile[k],
  );
  await attributeAuditMutation(
    client,
    audit,
    { scope: "profile", table: "candidates", rowId: id },
    () =>
      client.query(
        `update public.candidates set ${keys.map((k, i) => `"${k}"=$${i + 2}`).join(",")},updated_at=clock_timestamp() where id=$1 returning id`,
        [id, ...values],
      ),
  );
}
async function storeProjectionBaseline(
  client: PersonConnection,
  id: string,
  revision: string,
  profile: Record<string, any>,
) {
  await client.query(
    `insert into public.person_projection_state as old(candidate_id,revision,profile_hash,semantic_hash) values($1,$2,$3,$4)
 on conflict(candidate_id) do update set revision=excluded.revision,profile_hash=excluded.profile_hash,semantic_hash=excluded.semantic_hash,updated_at=clock_timestamp()
 where (old.revision,old.profile_hash,old.semantic_hash) is distinct from (excluded.revision,excluded.profile_hash,excluded.semantic_hash)`,
    [id, revision, hash(profile), semanticProfileHash(profile)],
  );
}
interface ComputedProjection {
  original: Record<string, any>;
  after: Record<string, any>;
  changedFields: string[];
  emailCollision: boolean;
  invalidatedKinds: Set<string>;
  projectionEmail: string | null;
}
/** Pure read: what the compatibility columns would become. Writes nothing.
 * Throws legacy_projection_drift when the row changed since it was last
 * projected, so a stale before-image can never be published over a newer edit. */
async function computeProjection(
  client: PersonConnection,
  id: string,
  before: Record<string, any>,
): Promise<ComputedProjection> {
  const tables = await readPersonProjection(client, id);
  const projection = project(tables);
  const previousProjection = (
    await client.query(
      "select profile_hash from public.person_projection_state where candidate_id=$1",
      [id],
    )
  ).rows[0];
  if (
    previousProjection &&
    previousProjection.profile_hash !== hash(profileOf(before))
  )
    throw Error("legacy_projection_drift");
  const after: Record<string, any> = {
    ...profileOf(before),
    ...Object.fromEntries(
      PROFILE_FIELDS.filter((k) => k !== "full_name").map((k) => [
        k,
        (projection as any)[k] ?? null,
      ]),
    ),
  };
  // Missing list data is not a deliberate clear. An explicitly owned empty list
  // IS a clear, and is preserved by project(). No change to career-year rules:
  // the existing app computes them from the same positions with computeFacts().
  const state = (
    await client.query(
      "select * from public.candidate_profile_state where candidate_id=$1",
      [id],
    )
  ).rows[0];
  if (!state.jobs_source_id && !tables.jobs.length)
    for (const k of ["work_experience", "previous_companies"])
      after[k] = before[k] ?? null;
  if (!state.educations_source_id && !tables.educations.length)
    for (const k of [
      "education",
      "education_schools",
      "education_degrees",
      "education_fields",
    ])
      after[k] = before[k] ?? null;
  if (!state.skills_source_id && !tables.skills.length)
    for (const k of ["top_skills", "all_skills_text"])
      after[k] = before[k] ?? null;
  const header = state.header ?? {};
  const headerMap = {
    headline: "headline",
    profile_summary: "summary",
    location: "location",
    profile_picture_url: "photo",
  };
  for (const [column, field] of Object.entries(headerMap))
    if (
      !header[field] ||
      (header[field].source === "application" && before[column])
    )
      after[column] = before[column] ?? null;
  if (
    header.full_name?.value &&
    !(header.full_name.source === "application" && before.full_name)
  )
    after.full_name = header.full_name.value;
  for (const key of ["current_title", "current_company"])
    if (!header[key] && !tables.jobs.length && !state.jobs_source_id)
      after[key] = before[key] ?? null;
  const invalidatedKinds = new Set<string>();
  for (const kind of ["email", "phone"]) {
    const current =
      kind === "email"
        ? normalizeEmail(before[kind])
        : normalizePhone(before[kind]);
    const invalidated = tables.contacts?.some(
      (c) =>
        c.kind === kind &&
        c.value_normalized === current &&
        (["invalid", "bounced", "do_not_use", "removed", "shared"].includes(
          c.status ?? "active",
        ) ||
          (kind === "email" && checkClass(c.quality, c.result) === "bad")),
    );
    // A claim or an unrelated contact provides no authority to erase an
    // incumbent address. Explicit negative evidence for that value does.
    if (invalidated) invalidatedKinds.add(kind);
    if (!after[kind] && !invalidated) after[kind] = before[kind] ?? null;
  }
  const companyIds = [
    ...new Set(
      projection.work_experience
        .filter(
          (p) =>
            p.company?.toLowerCase() === after.current_company?.toLowerCase(),
        )
        .map((p) => p.company_ref)
        .filter(Boolean),
    ),
  ];
  after.current_company_id =
    companyIds.length === 1
      ? companyIds[0]
      : !state.jobs_source_id &&
          !tables.jobs.length &&
          after.current_company === before.current_company
        ? (before.current_company_id ?? null)
        : null;
  const original = profileOf(before);
  let emailCollision = false;
  if (
    after.email &&
    after.email !== before.email &&
    (
      await client.query(
        "select id from public.candidates where email=$1 and id<>$2 limit 1",
        [after.email, id],
      )
    ).rows.length
  ) {
    after.email = invalidatedKinds.has("email") ? null : (before.email ?? null);
    emailCollision = true;
  }
  const changedFields = PROFILE_FIELDS.filter(
    (k) => hash(original[k] ?? null) !== hash(after[k] ?? null),
  );
  return {
    original,
    after,
    changedFields,
    emailCollision,
    invalidatedKinds,
    projectionEmail: projection.email ?? null,
  };
}
/** Writes a computed projection inside the caller's audited transaction and
 * keeps the before-image. runId marks history rows written by a publish run. */
async function writeProjection(
  client: PersonConnection,
  id: string,
  revision: string,
  before: Record<string, any>,
  computed: ComputedProjection,
  audit: AuditOperation,
  runId: string | null = null,
): Promise<{ projected: boolean; semanticChanged: boolean; historyId: string | null }> {
  const { original, after, invalidatedKinds } = computed;
  const recordEmailCollision = async () =>
    client.query(
      `insert into public.identity_conflicts(kind,candidate_ids,incoming,evidence_hash)
   values('legacy_email_collision',array[$1::uuid],'{}'::jsonb,$2)
   on conflict(kind,evidence_hash) where status='open' do nothing`,
      [id, hash([id, computed.projectionEmail])],
    );
  if (computed.emailCollision) await recordEmailCollision();
  if (hash(original) === hash(after)) {
    await storeProjectionBaseline(client, id, revision, after);
    return { projected: false, semanticChanged: false, historyId: null };
  }
  // A legacy unique email collision must never merge identities or discard the
  // rest of a good profile update. Preserve its current compatibility address.
  await client.query("savepoint person_email");
  try {
    await updateProfile(client, id, after, audit);
  } catch (error) {
    if (
      (error as any).code !== "23505" ||
      !String((error as any).constraint ?? "").includes("email")
    )
      throw error;
    await client.query("rollback to savepoint person_email");
    after.email = invalidatedKinds.has("email") ? null : (before.email ?? null);
    await updateProfile(client, id, after, audit);
    await recordEmailCollision();
  }
  await client.query("release savepoint person_email");
  const semanticBefore = semanticProfileHash(original),
    semanticAfter = semanticProfileHash(after),
    afterHash = hash(after);
  const historyId = String(
    (
      await client.query(
        `insert into public.person_projection_history(candidate_id,revision,before_profile,after_hash,semantic_before,semantic_after,run_id)
 values($1,$2,$3,$4,$5,$6,$7) returning id`,
        [id, revision, original, afterHash, semanticBefore, semanticAfter, runId],
      )
    ).rows[0].id,
  );
  await storeProjectionBaseline(client, id, revision, after);
  return {
    projected: true,
    semanticChanged: semanticBefore !== semanticAfter,
    historyId,
  };
}
async function applyProjection(
  client: PersonConnection,
  id: string,
  revision: string,
  before: Record<string, any>,
  audit: AuditOperation,
) {
  const computed = await computeProjection(client, id, before);
  const { projected, semanticChanged } = await writeProjection(
    client,
    id,
    revision,
    before,
    computed,
    audit,
  );
  return { projected, semanticChanged };
}
/** Caller owns the transaction and has taken the shared writer gate and
 * candidate lock. Multiple source docs produce one compatibility projection. */
export async function savePersonLocked(
  client: PersonConnection,
  docs: PersonDoc[],
  options: SavePersonOptions,
  before: Record<string, any>,
  audit: AuditOperation,
): Promise<SavePersonResult> {
  if (
    !audit?.id ||
    audit.candidateId !== before.id ||
    !(
      await client.query(
        "select 1 from public.person_audit_operations where id=$1 and candidate_id=$2 and transaction_id=pg_current_xact_id() and evidence->'guard'->>'anchor_hash'=$3",
        [audit.id, before.id, audit.anchorHash],
      )
    ).rows.length
  )
    throw Error("audit_operation_required");
  return saveDocumentsAndProjectLocked(client, docs, options, before, audit);
}
// Only the generic historical shadow entrypoint can admit sources before an
// anchor exists. It cannot publish any candidate compatibility fields.
async function saveDocumentsAndProjectLocked(
  client: PersonConnection,
  docs: PersonDoc[],
  options: SavePersonOptions,
  before: Record<string, any>,
  audit?: AuditOperation,
): Promise<SavePersonResult> {
  if (
    !["shadow", "live"].includes(options.mode) ||
    !docs.length ||
    docs.some((doc) => doc.candidate_id !== before.id)
  )
    throw Error("invalid_person_save");
  if (options.mode === "live" && !audit)
    throw Error("audit_operation_required");
  let changed = false,
    revision = "";
  for (const doc of docs) {
    const result = (
      await client.query("select public.save_person($1::jsonb) result", [doc])
    ).rows[0].result;
    revision = String(result.rev);
    changed ||= result.status !== "unchanged";
  }
  const projected =
    options.mode === "live"
      ? await applyProjection(client, before.id, revision, before, audit!)
      : { projected: false, semanticChanged: false };
  return {
    candidateId: before.id,
    changed: changed || projected.projected,
    revision,
    ...projected,
  };
}
/** Owns BEGIN/COMMIT on an idle connection. */
export async function savePersonOnConnection(
  client: PersonConnection,
  doc: PersonDoc,
  options: SavePersonOptions,
): Promise<SavePersonResult> {
  try {
    await beginPersonTransaction(client);
    const before = await lockPerson(client, doc.candidate_id);
    const anchored =
      (
        await client.query(
          "select 1 from public.person_audit_anchors where candidate_id=$1",
          [before.id],
        )
      ).rows.length > 0;
    const audit =
      options.mode === "live" || anchored
        ? await beginGuardedAuditOperationLocked(client, before, {
            writer: "projection",
            receiptRef: `projection:${randomUUID()}`,
            evidence: { documents: [doc], mode: options.mode },
          })
        : undefined;
    const result = audit
      ? await savePersonLocked(client, [doc], options, before, audit)
      : await saveDocumentsAndProjectLocked(client, [doc], options, before);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}
export async function undoPersonProjectionOnConnection(
  client: PersonConnection,
  id: string,
  revision: string,
): Promise<{ status: "restored" | "conflict" | "missing" }> {
  try {
    await beginPersonTransaction(client);
    const current = await lockPerson(client, id);
    const history = (
      await client.query(
        "select * from public.person_projection_history where candidate_id=$1 and revision=$2 and restored_at is null order by id desc limit 1",
        [id, revision],
      )
    ).rows[0];
    if (!history) {
      await client.query("rollback");
      return { status: "missing" };
    }
    const state = (
      await client.query(
        "select rev from public.candidate_profile_state where candidate_id=$1",
        [id],
      )
    ).rows[0];
    if (
      String(state?.rev) !== String(revision) ||
      hash(profileOf(current)) !== history.after_hash
    ) {
      await client.query("rollback");
      return { status: "conflict" };
    }
    const audit = await beginGuardedAuditOperationLocked(client, current, {
      writer: "undo",
      receiptRef: `undo:${history.id}`,
      evidence: { history_id: String(history.id), revision: String(revision) },
    });
    await updateProfile(client, id, history.before_profile, audit);
    await client.query(
      "update public.person_projection_history set restored_at=clock_timestamp() where id=$1",
      [history.id],
    );
    await storeProjectionBaseline(client, id, revision, history.before_profile);
    await client.query("commit");
    return { status: "restored" };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if ((error as any).code === "23505") return { status: "conflict" };
    throw error;
  }
}
export interface PublishPersonOptions {
  /** The publish run this write belongs to; recorded on the before-image. */
  runId: string;
  /** Compute and report the change; write nothing (the transaction rolls back). */
  dryRun: boolean;
}
export type PublishPersonStatus =
  | "projected"
  | "unchanged"
  | "held"
  | "unmigrated"
  | "drift"
  | "audit_blocked"
  | "dry_changed"
  | "dry_unchanged";
export interface PublishPersonResult {
  candidateId: string;
  status: PublishPersonStatus;
  revision: string | null;
  changedFields: string[];
  emailCollision: boolean;
  historyId: string | null;
  /** The audit guard's refusal code when status is audit_blocked. */
  reason?: string;
}
/** Publish one already-migrated person's compatibility columns from the
 * normalized tables, without a new source document. Owns BEGIN/COMMIT.
 * Held people and people without normalized state are reported, not written.
 * A row that changed since its last projection is reported as drift and left
 * alone. Live writes go through the same audited path as savePerson. */
export async function publishPersonProjectionOnConnection(
  client: PersonConnection,
  id: string,
  options: PublishPersonOptions,
): Promise<PublishPersonResult> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(options.runId))
    throw Error("invalid_publish_run");
  const done = (
    status: PublishPersonStatus,
    extra: Partial<PublishPersonResult> = {},
  ): PublishPersonResult => ({
    candidateId: id,
    status,
    revision: null,
    changedFields: [],
    emailCollision: false,
    historyId: null,
    ...extra,
  });
  try {
    await beginPersonTransaction(client);
    const before = await lockPerson(client, id);
    if (
      (
        await client.query(
          "select 1 from public.person_source_holds where candidate_id=$1 and resolved_at is null limit 1",
          [id],
        )
      ).rows.length
    ) {
      await client.query("rollback");
      return done("held");
    }
    const state = (
      await client.query(
        "select rev from public.candidate_profile_state where candidate_id=$1",
        [id],
      )
    ).rows[0];
    if (!state) {
      await client.query("rollback");
      return done("unmigrated");
    }
    const revision = String(state.rev);
    let computed: ComputedProjection;
    try {
      computed = await computeProjection(client, id, before);
    } catch (error) {
      if ((error as Error).message !== "legacy_projection_drift") throw error;
      await client.query("rollback");
      return done("drift", { revision });
    }
    const summary = {
      revision,
      changedFields: computed.changedFields,
      emailCollision: computed.emailCollision,
    };
    if (options.dryRun) {
      await client.query("rollback");
      return done(
        computed.changedFields.length ? "dry_changed" : "dry_unchanged",
        summary,
      );
    }
    if (!computed.changedFields.length) {
      await storeProjectionBaseline(client, id, revision, computed.after);
      await client.query("commit");
      return done("unchanged", summary);
    }
    let audit: AuditOperation;
    try {
      audit = await beginGuardedAuditOperationLocked(client, before, {
        writer: "projection",
        receiptRef: `projection:publish:${options.runId}:${randomUUID()}`,
        evidence: { mode: "publish", run_id: options.runId },
      });
    } catch (error) {
      // A missing anchor, a broken candidate chain (an unattributed legacy
      // edit) or an unresolved hold is this person's problem, not the run's.
      const reason = (error as Error).message;
      if (!/^audit_[a-z_]+$/.test(reason)) throw error;
      await client.query("rollback");
      return done("audit_blocked", { ...summary, reason });
    }
    const written = await writeProjection(
      client,
      id,
      revision,
      before,
      computed,
      audit,
      options.runId,
    );
    await client.query("commit");
    return done(written.projected ? "projected" : "unchanged", {
      ...summary,
      historyId: written.historyId,
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}
let poolPromise: Promise<import("pg").Pool> | undefined;
const errorCode = (error: unknown): string =>
  /^[0-9A-Z]{5}$/.test((error as any)?.code ?? "")
    ? (error as any).code
    : "operation_failed";
/** Uses the WEBSITE project's server-only pooled PostgreSQL URL. Never falls
 * back to COMMS_DATABASE_URL. Disabled feature paths never open a connection. */
export async function withPersonConnection<T>(
  operation: (client: PersonConnection) => Promise<T>,
): Promise<T> {
  if (typeof window !== "undefined") throw Error("server_only");
  const url = process.env.PERSON_DATABASE_URL;
  if (!url) throw Error("PERSON_DATABASE_URL is required for atomic saves");
  // Cache before the asynchronous import yields, so concurrent first requests
  // cannot each allocate their own connection pool.
  poolPromise ??= import("pg")
    .then(({ default: pg }) => {
      const pool = new pg.Pool({
        connectionString: url,
        max: 2,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 10000,
        allowExitOnIdle: true,
        application_name: "tt-person-writer",
      });
      pool.on("error", (error) =>
        console.error(`person_pool_idle_error:${errorCode(error)}`),
      );
      return pool;
    })
    .catch((error) => {
      poolPromise = undefined;
      throw error;
    });
  let client: import("pg").PoolClient | undefined;
  try {
    client = await (await poolPromise).connect();
    return await operation(client);
  } catch (error) {
    // Only exact, application-owned codes may escape. Driver details can
    // contain private candidate data and must remain redacted.
    const safeCodes = new Set([
      "person_profile_unavailable",
      "person_profile_read_limit",
      "invalid_email",
      "invalid_phone",
      "invalid_github",
      "email_unusable",
      "phone_unusable",
      "person_not_found",
      "person_recruiter_not_migrated",
      "person_recruiter_source_hold",
    ]);
    if (safeCodes.has((error as Error)?.message))
      throw Error((error as Error).message);
    throw Error(`person_save_failed:${errorCode(error)}`);
  } finally {
    client?.release();
  }
}

export async function savePerson(
  doc: PersonDoc,
  options: SavePersonOptions,
): Promise<SavePersonResult> {
  return withPersonConnection((client) =>
    savePersonOnConnection(client, doc, options),
  );
}
