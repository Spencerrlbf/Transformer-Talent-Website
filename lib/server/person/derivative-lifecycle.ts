// Server only. Each operation commits one short transaction. No HTTP or vector
// publication here; callers cannot infer permission to spend from claim replay.
import { transitionSupport, transitionUuid } from '../person-transition/context';
import { TT_ORG_ID } from './normalize';
import { beginPersonTransaction, withPersonConnection, type PersonConnection } from './save';
import { personDerivativeInput, personDerivativeChunks } from './derivatives';
export type CertifiedDerivativeRequest = { organizationId: string; candidateId: string; requestId: string; token: string };
export type CertifiedDerivativeClaim = CertifiedDerivativeRequest & { allowPaid: boolean };
function validate(a: CertifiedDerivativeRequest) {
 if (!transitionSupport()) throw Error('derivative_lifecycle_disabled');
 if (a.organizationId !== TT_ORG_ID || !transitionUuid(a.candidateId) || !transitionUuid(a.requestId) || !transitionUuid(a.token)) throw Error('derivative_scope');
}
const keys=(a: CertifiedDerivativeRequest)=>[a.organizationId,a.requestId,a.candidateId,a.token];
async function transaction<T>(c: PersonConnection,a: CertifiedDerivativeRequest,fn:()=>Promise<T>) {
 validate(a);
 try { await beginPersonTransaction(c);const r=await fn();await c.query('commit');return r; }
 catch(e) {await c.query('rollback').catch(()=>{});throw e;}
}
export async function claimCertifiedDerivativesOnConnection(c: PersonConnection,a: CertifiedDerivativeClaim) {
 validate(a);if (typeof a.allowPaid !== 'boolean') throw Error('derivative_input');
 if (!a.allowPaid) return {status:'disabled'};
 return transaction(c,a,async()=>{
  const r=(await c.query('select person_private.derivative_claim_begin($1,$2,$3,$4) result',keys(a))).rows[0].result;
  if(r.status!=='prepare') return r;
  // begin already holds controller/request/work/candidate/job in that order.
  const input=await personDerivativeInput(c,a.candidateId);
  const parts=personDerivativeChunks(input.sources);
  return (await c.query('select person_private.derivative_claim_seal($1,$2::jsonb,$3::jsonb) result',[a.requestId,JSON.stringify(input),JSON.stringify(parts)])).rows[0].result;
 });
}
export async function startCertifiedDerivativesProviderOnConnection(c: PersonConnection,a: CertifiedDerivativeRequest) {
 return transaction(c,a,async()=>{
  await c.query('select person_private.derivative_consumer_enter($1,$2,$3,$4,true,false)',keys(a));
  const input=await personDerivativeInput(c,a.candidateId);
  return (await c.query('select person_private.derivative_provider_start($1,$2::jsonb) result',[a.requestId,JSON.stringify(input)])).rows[0].result;
 });
}
export async function storeCertifiedDerivativeVectorsOnConnection(c: PersonConnection,a: CertifiedDerivativeRequest & {vectors: number[][]}) {
 validate(a);
 if(!Array.isArray(a.vectors) || a.vectors.length>18 || a.vectors.some(v=>!Array.isArray(v)||v.length!==1536||v.some(n=>typeof n!=='number'||!Number.isFinite(n)))) throw Error('derivative_vectors');
 return transaction(c,a,async()=> (await c.query('select person_private.derivative_store_vectors($1,$2,$3,$4,$5::jsonb) result',[...keys(a),JSON.stringify(a.vectors)])).rows[0].result);
}
export async function recoverCertifiedDerivativesOnConnection(c: PersonConnection,a: CertifiedDerivativeRequest) {
 return transaction(c,a,async()=> (await c.query('select person_private.derivative_recover($1,$2,$3,$4) result',keys(a))).rows[0].result);
}
export const claimCertifiedDerivatives=(a:CertifiedDerivativeClaim)=>{validate(a);if(typeof a.allowPaid!=='boolean')throw Error('derivative_input');return a.allowPaid?withPersonConnection(c=>claimCertifiedDerivativesOnConnection(c,a)):Promise.resolve({status:'disabled'});};
export const startCertifiedDerivativesProvider=(a:CertifiedDerivativeRequest)=>{validate(a);return withPersonConnection(c=>startCertifiedDerivativesProviderOnConnection(c,a));};
export const storeCertifiedDerivativeVectors=(a:CertifiedDerivativeRequest & {vectors:number[][]})=>{validate(a);return withPersonConnection(c=>storeCertifiedDerivativeVectorsOnConnection(c,a));};
export const recoverCertifiedDerivatives=(a:CertifiedDerivativeRequest)=>{validate(a);return withPersonConnection(c=>recoverCertifiedDerivativesOnConnection(c,a));};
