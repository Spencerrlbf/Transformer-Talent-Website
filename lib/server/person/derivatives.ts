// Server/worker only. Replaceable vectors never serve as source evidence.
import { createHash, randomUUID } from "node:crypto";
import { TT_ORG_ID } from "./normalize";
import { publishedPersonRowsOnConnection } from "./published";
import { poolProfileText } from "../pool/profile";
import {
  beginPersonTransaction,
  lockPerson,
  withPersonConnection,
  type PersonConnection,
} from "./save";
const MODEL = "text-embedding-3-small",
  DIMS = 1536;
const SOURCES = ["linkedin_profile", "resume", "summary"] as const;
type Sources = Partial<Record<(typeof SOURCES)[number], string>>;
type Scope = { organizationId: string; candidateId: string };
type Chunk = {
  source_type: string;
  chunk_index: number;
  content: string;
  content_hash: string;
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const key = (x: Chunk) => `${x.source_type}|${x.chunk_index}|${x.content_hash}`;
function scoped(a: Scope) {
  if (a.organizationId !== TT_ORG_ID) throw Error("person_derivative_scope");
}
export function personDerivativeChunks(sources: Sources): Chunk[] {
  const result: Chunk[] = [];
  for (const source_type of SOURCES) {
    const text = sources[source_type];
    if (typeof text !== "string") continue;
    let content = "",
      bytes = 0,
      index = 0;
    const push = () => {
      const value = content.trim();
      if (value)
        result.push({
          source_type,
          chunk_index: index++,
          content: value,
          content_hash: hash(value),
        });
      content = "";
      bytes = 0;
    };
    for (const char of text.trim()) {
      const size = Buffer.byteLength(char);
      if (content.length + char.length > 2800 || bytes + size > 7500) {
        push();
        if (index >= 6) break;
      }
      content += char;
      bytes += size;
    }
    if (index < 6) push();
  }
  return result;
}
async function canonical(c: PersonConnection, id: string) {
  const row = (await publishedPersonRowsOnConnection(c, [id])).get(id);
  if (!row) throw Error("person_profile_unavailable");
  const resume = (
    await c.query("select resume_text from public.candidates where id=$1", [id])
  ).rows[0]?.resume_text;
  const sources: Sources = {
    linkedin_profile: poolProfileText(row),
    resume: resume ?? "",
    summary: row.profile_summary ?? "",
  };
  return {
    revision: String(row.published_revision),
    sources,
    hash: hash(JSON.stringify([MODEL, DIMS, sources])),
  };
}
/** Caller already owns gate72005 and the person advisory/row locks. Enqueue
 * only after an authorized live intake has finalized its profile and resume. */
export async function enqueuePersonDerivativesLocked(
  c: PersonConnection,
  a: Scope & { receiptRef: string },
) {
  scoped(a);
  const current = await canonical(c, a.candidateId);
  await c.query(
    `insert into public.person_derivative_jobs as old(candidate_id,desired_revision,desired_hash,sources,model,dimensions,receipt_ref)
 values($1,$2,$3,$4,$5,$6,$7) on conflict(candidate_id) do update set
 desired_revision=excluded.desired_revision,desired_hash=excluded.desired_hash,sources=excluded.sources,model=excluded.model,dimensions=excluded.dimensions,receipt_ref=excluded.receipt_ref,
 status=case when old.desired_hash<>excluded.desired_hash then 'pending' else old.status end,
 attempts=case when old.desired_hash<>excluded.desired_hash then 0 else old.attempts end,
 claim_token=case when old.desired_hash<>excluded.desired_hash then null else old.claim_token end,
 lease_until=case when old.desired_hash<>excluded.desired_hash then null else old.lease_until end,
 claim_missing=case when old.desired_hash<>excluded.desired_hash then null else old.claim_missing end,
 error_code=case when old.desired_hash<>excluded.desired_hash then null else old.error_code end,
 updated_at=case when old.desired_hash<>excluded.desired_hash then clock_timestamp() else old.updated_at end`,
    [
      a.candidateId,
      current.revision,
      current.hash,
      JSON.stringify(current.sources),
      MODEL,
      DIMS,
      a.receiptRef,
    ],
  );
  return current;
}
async function transaction<T>(
  c: PersonConnection,
  a: Scope,
  fn: () => Promise<T>,
) {
  scoped(a);
  try {
    await beginPersonTransaction(c);
    await lockPerson(c, a.candidateId);
    const out = await fn();
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  }
}
const jobRow = async (c: PersonConnection, id: string) =>
  (
    await c.query(
      "select *,lease_until>clock_timestamp() as lease_valid from public.person_derivative_jobs where candidate_id=$1 for update",
      [id],
    )
  ).rows[0];
const existing = async (c: PersonConnection, id: string) =>
  (
    await c.query(
      "select id,source_type,chunk_index,content_hash,model,dimensions from public.candidate_embeddings where organization_id=$1 and candidate_id=$2 and source_type=any($3::text[])",
      [TT_ORG_ID, id, SOURCES],
    )
  ).rows;
const reusable = (r: any) => r.model === MODEL && r.dimensions === DIMS;
async function terminal(
  c: PersonConnection,
  id: string,
  status: string,
  error: string | null,
) {
  await c.query(
    "update public.person_derivative_jobs set status=$2,claim_token=null,lease_until=null,claim_missing=null,error_code=$3,updated_at=clock_timestamp() where candidate_id=$1",
    [id, status, error],
  );
}
export async function preparePersonDerivativesOnConnection(
  c: PersonConnection,
  a: Scope,
) {
  return transaction(c, a, async () => {
    let job = await jobRow(c, a.candidateId);
    if (!job) return { status: "absent" as const };
    // Refresh the entire desired set, including resume changes without a profile
    // revision. Contact-only edits retain the token, cache and attempt budget.
    try {
      await enqueuePersonDerivativesLocked(c, {
        ...a,
        receiptRef: job.receipt_ref,
      });
    } catch (e) {
      if ((e as Error).message !== "person_profile_unavailable") throw e;
      await terminal(c, a.candidateId, "review", "profile_unavailable");
      return { status: "review" as const };
    }
    job = await jobRow(c, a.candidateId);
    if (job.status === "done" || job.status === "review")
      return { status: job.status as "done" | "review" };
    if (job.status === "processing" && job.lease_valid)
      return { status: "busy" as const };
    if (job.attempts >= 3) {
      await terminal(c, a.candidateId, "review", "attempt_limit");
      return { status: "review" as const };
    }
    const wanted = personDerivativeChunks(job.sources),
      rows = await existing(c, a.candidateId);
    const have = new Set(rows.filter(reusable).map(key)),
      missing = wanted.filter((x) => !have.has(key(x))),
      token = randomUUID();
    await c.query(
      "update public.person_derivative_jobs set status='processing',attempts=attempts+1,claim_token=$2,lease_until=clock_timestamp()+interval '10 minutes',claim_missing=$3,error_code=null,updated_at=clock_timestamp() where candidate_id=$1",
      [a.candidateId, token, JSON.stringify(missing)],
    );
    return {
      status: "claimed" as const,
      ...a,
      token,
      revision: String(job.desired_revision),
      desiredHash: job.desired_hash,
      managed: [...SOURCES],
      missing,
    };
  });
}
function validVectors(vectors: unknown, count: number): vectors is number[][] {
  return (
    Array.isArray(vectors) &&
    vectors.length === count &&
    vectors.every(
      (v) =>
        Array.isArray(v) &&
        v.length === DIMS &&
        v.every((x) => typeof x === "number" && Number.isFinite(x)),
    )
  );
}
export async function completePersonDerivativesOnConnection(
  c: PersonConnection,
  a: Scope & { token: string; vectors: number[][] },
) {
  return transaction(c, a, async () => {
    const job = await jobRow(c, a.candidateId);
    if (
      !job ||
      job.status !== "processing" ||
      job.claim_token !== a.token ||
      !job.lease_valid
    )
      return { status: "stale" as const };
    const current = await canonical(c, a.candidateId);
    if (current.hash !== job.desired_hash) {
      await enqueuePersonDerivativesLocked(c, {
        ...a,
        receiptRef: job.receipt_ref,
      });
      return { status: "stale" as const };
    }
    const missing: Chunk[] = job.claim_missing,
      wanted = personDerivativeChunks(current.sources);
    if (!validVectors(a.vectors, missing.length))
      throw Error("person_derivative_vectors");
    const rows = await existing(c, a.candidateId),
      byKey = new Map(missing.map((x, i) => [key(x), a.vectors[i]])),
      want = new Set(wanted.map(key));
    const retained = new Set(rows.filter(reusable).map(key));
    if (wanted.some((x) => !retained.has(key(x)) && !byKey.has(key(x))))
      throw Error("person_derivative_cache_changed");
    const obsolete = rows
      .filter((r) => !reusable(r) || !want.has(key(r)))
      .map((r) => r.id);
    if (obsolete.length)
      await c.query(
        "delete from public.candidate_embeddings where organization_id=$1 and candidate_id=$2 and id=any($3::uuid[])",
        [TT_ORG_ID, a.candidateId, obsolete],
      );
    for (const part of wanted) {
      if (retained.has(key(part))) continue;
      await c.query(
        "insert into public.candidate_embeddings(organization_id,candidate_id,source_type,chunk_index,content,content_hash,model,dimensions,embedding) values($1,$2,$3,$4,$5,$6,$7,$8,$9::vector)",
        [
          TT_ORG_ID,
          a.candidateId,
          part.source_type,
          part.chunk_index,
          part.content,
          part.content_hash,
          MODEL,
          DIMS,
          JSON.stringify(byKey.get(key(part))),
        ],
      );
    }
    await c.query(
      "update public.person_derivative_jobs set status='done',desired_revision=$2,completed_hash=desired_hash,claim_token=null,lease_until=null,claim_missing=null,error_code=null,updated_at=clock_timestamp() where candidate_id=$1",
      [a.candidateId, current.revision],
    );
    return { status: "done" as const };
  });
}
export async function failPersonDerivativesOnConnection(
  c: PersonConnection,
  a: Scope & { token: string },
) {
  return transaction(c, a, async () => {
    const job = await jobRow(c, a.candidateId);
    if (!job || job.status !== "processing" || job.claim_token !== a.token)
      return;
    await terminal(
      c,
      a.candidateId,
      job.attempts >= 3 ? "review" : "pending",
      "derivative_retry_required",
    );
  });
}
export async function embedPersonDerivativeChunks(
  parts: Pick<Chunk, "content">[],
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<number[][]> {
  if (!parts.length) return [];
  if (
    parts.length > 18 ||
    parts.some(
      (p) =>
        !p.content ||
        p.content.length > 2800 ||
        Buffer.byteLength(p.content) > 7500,
    )
  )
    throw Error("person_derivative_input");
  let response: Response;
  try {
    response = await fetcher("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        dimensions: DIMS,
        encoding_format: "float",
        input: parts.map((x) => x.content),
      }),
      signal: AbortSignal.timeout(90000),
    });
  } catch {
    throw Error("person_derivative_transport");
  }
  if (!response.ok) throw Error(`person_derivative_http_${response.status}`);
  let body: any;
  try {
    body = await response.json();
  } catch {
    throw Error("person_derivative_response");
  }
  if (
    body?.model !== MODEL ||
    !Array.isArray(body?.data) ||
    body.data.length !== parts.length
  )
    throw Error("person_derivative_response");
  const out: number[][] = Array(parts.length),
    seen = new Set<number>();
  for (const item of body.data) {
    if (
      !Number.isInteger(item.index) ||
      item.index < 0 ||
      item.index >= parts.length ||
      seen.has(item.index) ||
      !validVectors([item.embedding], 1)
    )
      throw Error("person_derivative_response");
    seen.add(item.index);
    out[item.index] = item.embedding;
  }
  return out;
}
export const preparePersonDerivatives = (a: Scope) =>
  withPersonConnection((c) => preparePersonDerivativesOnConnection(c, a));
export const completePersonDerivatives = (
  a: Scope & { token: string; vectors: number[][] },
) => withPersonConnection((c) => completePersonDerivativesOnConnection(c, a));
export const failPersonDerivatives = (a: Scope & { token: string }) =>
  withPersonConnection((c) => failPersonDerivativesOnConnection(c, a));
export async function processPersonDerivatives(a: Scope) {
  scoped(a);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { status: "not_configured" };
  const claim = await preparePersonDerivatives(a);
  if (claim.status !== "claimed") return claim;
  try {
    return await completePersonDerivatives({
      ...claim,
      vectors: await embedPersonDerivativeChunks(claim.missing, apiKey),
    });
  } catch {
    await failPersonDerivatives(claim);
    return { status: "retry" };
  }
}
export async function drainPersonDerivatives(a: {
  organizationId: string;
  limit?: number;
}) {
  if (a.organizationId !== TT_ORG_ID) throw Error("person_derivative_scope");
  const limit = a.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw Error("person_derivative_limit");
  if (!process.env.OPENAI_API_KEY) return { processed: 0, retry: 0 };
  const rows = await withPersonConnection(
    async (c) =>
      (
        await c.query(
          "select candidate_id from public.person_derivative_jobs where status='pending' or (status='processing' and lease_until<=clock_timestamp()) order by updated_at,candidate_id limit $1",
          [limit],
        )
      ).rows,
  );
  let processed = 0,
    retry = 0;
  for (const row of rows) {
    try {
      const r = await processPersonDerivatives({
        ...a,
        candidateId: row.candidate_id,
      });
      processed++;
      if (r.status === "retry") retry++;
    } catch {
      retry++;
    }
  }
  return { processed, retry };
}
