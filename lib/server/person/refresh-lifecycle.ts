// Server/worker-only lifecycle. This module never calls a paid provider or writes
// a candidate profile. The worker stays disabled until atomic save is available.
import { transitionSupport, transitionUuid } from "../person-transition/context";
import { TT_ORG_ID } from "./normalize";
import { beginPersonTransaction, withPersonConnection, type PersonConnection } from "./save";
export type CertifiedRefreshRequest = {
  organizationId: string; requestId: string; queueId: string; token: string;
};
export type CertifiedRefreshSaveResult = { status: "done"; candidateId: string; projected: boolean; semanticChanged: boolean; changed: boolean; revision: string };
export type CertifiedRefreshClaim = CertifiedRefreshRequest & { dailyCap: number; allowPaid: boolean };
export type CertifiedRefreshClaimResult =
  | { status: "missing" | "busy" | "budget" }
  | { status: "review"; reason: string; workId: string }
  | { status: "claimed"; queueId: string; candidateId: string; requestId: string; token: string; workId: string; needsHarvest: boolean; linkedinUrl: string };
function validate(a: CertifiedRefreshRequest) {
  if (!transitionSupport()) throw Error("refresh_lifecycle_disabled");
  if (a.organizationId !== TT_ORG_ID || !transitionUuid(a.requestId) || !transitionUuid(a.queueId) || !transitionUuid(a.token)) throw Error("refresh_input");
}
function canonicalUrl(value: string) {
  const prefix = "https://www.linkedin.com/in/";
  if (!value.startsWith(prefix)) throw Error("refresh_identity");
  const username = decodeURIComponent(value.slice(prefix.length));
  if (!/^[\p{L}\p{N}\p{M}._-]{1,200}$/u.test(username) || username !== username.trim().toLowerCase() || value !== prefix + encodeURIComponent(username)) throw Error("refresh_identity");
}
async function transaction<T>(c: PersonConnection, a: CertifiedRefreshRequest, fn: () => Promise<T>) {
  validate(a);
  try { await beginPersonTransaction(c); const result = await fn(); await c.query("commit"); return result; }
  catch (e) { await c.query("rollback").catch(() => {}); throw e; }
}
const keys = (a: CertifiedRefreshRequest) => [a.organizationId, a.requestId, a.queueId, a.token];
export async function claimCertifiedRefreshOnConnection(c: PersonConnection, a: CertifiedRefreshClaim): Promise<CertifiedRefreshClaimResult> {
  validate(a);
  if (!Number.isInteger(a.dailyCap) || a.dailyCap < 0 || a.dailyCap > 10000 || typeof a.allowPaid !== "boolean") throw Error("refresh_input");
  return transaction(c, a, async () => {
    const result = (await c.query("select person_private.refresh_claim($1,$2,$3,$4,$5,$6) result", [...keys(a), a.dailyCap, a.allowPaid])).rows[0].result;
    // Preserve the existing Unicode username contract independently of the
    // database locale. A rejected identity rolls the whole reservation back.
    if (result.status === "claimed") canonicalUrl(result.linkedinUrl);
    return result;
  });
}
export async function startCertifiedRefreshProviderOnConnection(c: PersonConnection, a: CertifiedRefreshRequest): Promise<{ status: "start"; linkedinUrl: string } | { status: "uncertain" }> {
  return transaction(c, a, async () => {
    const result = (await c.query("select person_private.refresh_provider_start($1,$2,$3,$4) result", keys(a))).rows[0].result;
    if (result.status === "start") canonicalUrl(result.linkedinUrl);
    return result;
  });
}
export async function storeCertifiedRefreshPayloadOnConnection(c: PersonConnection, a: CertifiedRefreshRequest & { raw: unknown }): Promise<{ status: "stored" | "retry" }> {
  validate(a);
  if (!a.raw || typeof a.raw !== "object" || Array.isArray(a.raw) || (!(a.raw as Record<string, unknown>).headline && !(a.raw as Record<string, unknown>).experience)) throw Error("refresh_empty_payload");
  return transaction(c, a, async () => (await c.query("select person_private.refresh_store_payload($1,$2,$3,$4,$5::jsonb) result", [...keys(a), JSON.stringify(a.raw)])).rows[0].result);
}
export async function failCertifiedRefreshOnConnection(c: PersonConnection, a: CertifiedRefreshRequest): Promise<{ status: "uncertain" | "retry" } | { status: "review"; reason: string; workId: string } | CertifiedRefreshSaveResult> {
  return transaction(c, a, async () => (await c.query("select person_private.refresh_fail($1,$2,$3,$4) result", keys(a))).rows[0].result);
}
// Configuration and identity validation precede acquiring a pooled connection.
export const claimCertifiedRefresh = (a: CertifiedRefreshClaim) => { validate(a); return withPersonConnection(c => claimCertifiedRefreshOnConnection(c,a)); };
export const startCertifiedRefreshProvider = (a: CertifiedRefreshRequest) => { validate(a); return withPersonConnection(c => startCertifiedRefreshProviderOnConnection(c,a)); };
export const storeCertifiedRefreshPayload = (a: CertifiedRefreshRequest & {raw: unknown}) => { validate(a); return withPersonConnection(c => storeCertifiedRefreshPayloadOnConnection(c,a)); };
export const failCertifiedRefresh = (a: CertifiedRefreshRequest) => { validate(a); return withPersonConnection(c => failCertifiedRefreshOnConnection(c,a)); };
