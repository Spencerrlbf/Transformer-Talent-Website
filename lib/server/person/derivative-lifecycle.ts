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
/** Publish the certified result: replace the person's chunk embeddings, mark the
 * job done and close the lifecycle. No provider call. Replays return the result. */
async function retainedResult(c: PersonConnection,a: CertifiedDerivativeRequest,phase:string,column:'publish_result'|'payload_result') {
 const r=(await c.query(`select phase,${column} result,claim_result->>'token' token,candidate_id from person_private.derivative_lifecycles where request_id=$1`,[a.requestId])).rows[0];
 return r&&r.phase===phase&&r.token===a.token&&r.candidate_id===a.candidateId?r.result:null;
}
export async function publishCertifiedDerivativesOnConnection(c: PersonConnection,a: CertifiedDerivativeRequest) {
 validate(a);
 // A repeated publish (lost acknowledgement, or a second worker) returns the retained result.
 const done=await retainedResult(c,a,'published','publish_result');if(done)return done;
 try {
  return await transaction(c,a,async()=>{
   await c.query('select person_private.derivative_consumer_enter($1,$2,$3,$4,false,false)',keys(a));
   const input=await personDerivativeInput(c,a.candidateId);
   return (await c.query('select person_private.derivative_publish($1,$2::jsonb) result',[a.requestId,JSON.stringify(input)])).rows[0].result;
  });
 } catch(e) { const again=await retainedResult(c,a,'published','publish_result');if(again)return again;throw e; }
}
export const publishCertifiedDerivatives=(a:CertifiedDerivativeRequest)=>{validate(a);return withPersonConnection(c=>publishCertifiedDerivativesOnConnection(c,a));};
/** A definite provider failure (an HTTP error response): the job returns to pending. */
/** HTTP statuses that mean the request was refused, not processed (never billed). */
export const DEFINITE_PROVIDER_FAILURES=new Set([400,401,403,404,413,422,429]);
export async function failCertifiedDerivativesProviderOnConnection(c: PersonConnection,a: CertifiedDerivativeRequest & {httpStatus:number}) {
 validate(a);
 if(!DEFINITE_PROVIDER_FAILURES.has(a.httpStatus)) throw Error('derivative_failure_input');
 const done=await retainedResult(c,a,'failed','payload_result');if(done)return done;
 return transaction(c,a,async()=>{
  await c.query('select person_private.derivative_consumer_enter($1,$2,$3,$4,true,false)',keys(a));
  return (await c.query('select person_private.derivative_provider_failed($1,$2) result',[a.requestId,a.httpStatus])).rows[0].result;
 });
}
/** People whose provider call was certified today (UTC): the daily cap spans runs. */
export async function paidCertifiedDerivativesToday():Promise<number> {
 if(!transitionSupport()) throw Error('derivative_lifecycle_disabled');
 return withPersonConnection(async c=>Number((await c.query(
  "select count(*) n from person_private.derivative_lifecycles where provider_started_at>=date_trunc('day',now() at time zone 'utc') at time zone 'utc'")).rows[0].n));
}
/** Pending jobs that reached the attempt limit (the legacy consumer marked these review). */
export async function attemptLimitedCertifiedDerivatives():Promise<number> {
 if(!transitionSupport()) throw Error('derivative_lifecycle_disabled');
 return withPersonConnection(async c=>Number((await c.query("select count(*) n from public.person_derivative_jobs where status='pending' and attempts>=3")).rows[0].n));
}
export const failCertifiedDerivativesProvider=(a:CertifiedDerivativeRequest & {httpStatus:number})=>{validate(a);return withPersonConnection(c=>failCertifiedDerivativesProviderOnConnection(c,a));};
/** Pending TT jobs a worker may claim (read only). */
export async function pendingCertifiedDerivatives(limit:number):Promise<string[]> {
 if(!transitionSupport()) throw Error('derivative_lifecycle_disabled');
 if(!Number.isInteger(limit)||limit<1||limit>5000) throw Error('derivative_input');
 return withPersonConnection(async c=>(await c.query(
  // New applicants first, then recruiter edits, then directory and refresh, each oldest
  // first: a backlog must not hold a new applicant's search chunks past the next run.
  `select candidate_id from public.person_derivative_jobs where status='pending' and attempts<3
   order by (receipt_ref like 'application:%') desc,(receipt_ref like 'recruiter:%') desc,updated_at,candidate_id limit $1`,[limit])).rows.map(r=>r.candidate_id));
}
/** Retained lifecycles whose work is still open: publish a stored result, or recover (read only). */
export async function resumableCertifiedDerivatives(limit:number):Promise<{requestId:string;candidateId:string;token:string;phase:string;live:boolean}[]> {
 if(!transitionSupport()) throw Error('derivative_lifecycle_disabled');
 if(!Number.isInteger(limit)||limit<1||limit>5000) throw Error('derivative_input');
 return withPersonConnection(async c=>(await c.query(
  `select e.request_id,e.candidate_id,e.claim_result->>'token' token,e.phase,(w.status='active' and w.lease_until>clock_timestamp()) live
   from person_private.derivative_lifecycles e join person_private.transition_work w on w.id=e.work_id
   where w.status='active' and e.phase in ('claimed','stored') order by e.request_id limit $1`,[limit])).rows
  .map(r=>({requestId:r.request_id,candidateId:r.candidate_id,token:r.token,phase:r.phase,live:r.live})));
}
/** The controller as the worker sees it: fresh claims only while open or disabled. */
export async function certifiedDerivativesAdmitting():Promise<boolean> {
 if(!transitionSupport()) throw Error('derivative_lifecycle_disabled');
 return withPersonConnection(async c=>{const s=(await c.query('select public.person_transition_status() s')).rows[0].s;return !s.enabled||s.phase==='open';});
}
