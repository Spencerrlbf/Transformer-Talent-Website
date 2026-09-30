// Private database-backed selection and restart recovery. Never call providers.
import { transitionSupport, transitionUuid } from '../person-transition/context';
import { TT_ORG_ID } from './normalize';
import { beginPersonTransaction, withPersonConnection, type PersonConnection } from './save';
import type { CertifiedRefreshClaim, CertifiedRefreshRequest, CertifiedRefreshSaveResult } from './refresh-lifecycle';
type Batch = { organizationId: string; limit: number };
export type CertifiedRefreshSelection = {
  phase: 'open' | 'held' | 'draining';
  recovery: (CertifiedRefreshClaim & {candidateId: string})[];
  queued: {queueId: string; candidateId: string; freeOnly: boolean}[];
  review: number; uncertain: number;
};
function scope(org: string) {
  if (!transitionSupport()) throw Error('refresh_worker_disabled');
  if (org !== TT_ORG_ID) throw Error('refresh_worker_scope');
}
function batch(a: Batch) { scope(a.organizationId); if (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > 500) throw Error('refresh_worker_input'); }
function request(a: CertifiedRefreshRequest) { scope(a.organizationId); if (![a.queueId,a.requestId,a.token].every(transitionUuid)) throw Error('refresh_worker_input'); }
async function query<T>(c: PersonConnection, sql: string, args: unknown[]): Promise<T> {
  try { await beginPersonTransaction(c); const out=(await c.query(sql,args)).rows[0].result; await c.query('commit'); return out; }
  catch(e) { await c.query('rollback').catch(()=>{}); throw e; }
}
export async function pickCertifiedRefreshOnConnection(c: PersonConnection,a: Batch): Promise<CertifiedRefreshSelection> {
  batch(a);return query(c,'select person_private.refresh_worker_pick($1,$2) result',[a.organizationId,a.limit]);
}
export async function topUpCertifiedRefreshOnConnection(c: PersonConnection,a: Batch): Promise<{phase: 'open'|'held'|'draining';inserted: number}> {
  batch(a);return query(c,'select person_private.refresh_worker_topup($1,$2) result',[a.organizationId,a.limit]);
}
export async function recoverCertifiedRefreshOnConnection(c: PersonConnection,a: CertifiedRefreshRequest): Promise<CertifiedRefreshSaveResult | {status: 'retry'|'uncertain'|'busy'|'held'} | {status:'review';reason:string;workId:string}> {
  request(a);return query(c,'select person_private.refresh_worker_recover($1,$2,$3,$4) result',[a.organizationId,a.requestId,a.queueId,a.token]);
}
export const pickCertifiedRefresh=(a:Batch)=>{batch(a);return withPersonConnection(c=>pickCertifiedRefreshOnConnection(c,a));};
export const topUpCertifiedRefresh=(a:Batch)=>{batch(a);return withPersonConnection(c=>topUpCertifiedRefreshOnConnection(c,a));};
export const recoverCertifiedRefresh=(a:CertifiedRefreshRequest)=>{request(a);return withPersonConnection(c=>recoverCertifiedRefreshOnConnection(c,a));};
