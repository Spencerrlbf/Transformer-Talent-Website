// Atomic profile persistence after a certified refresh has retained its source.
import { transitionSupport, transitionUuid } from "../person-transition/context";
import { TT_ORG_ID } from "./normalize";
import { fromHarvest } from "./fromHarvest";
import { poolSignals } from "../pool/profile";
import { personDerivativeInput } from "./derivatives";
import { beginPersonTransaction, compatibilityProjection, projectionEnvelope, readPersonProjection, withPersonConnection, type PersonConnection } from "./save";
import type { CertifiedRefreshRequest, CertifiedRefreshSaveResult } from "./refresh-lifecycle";
export type CertifiedRefreshSave = CertifiedRefreshRequest & { mode: "shadow" | "live" };
function validate(a: CertifiedRefreshSave) {
  if (!transitionSupport()) throw Error("refresh_save_disabled");
  if (a.organizationId !== TT_ORG_ID || !transitionUuid(a.requestId) || !transitionUuid(a.queueId) || !transitionUuid(a.token) || !["shadow", "live"].includes(a.mode)) throw Error("refresh_save_input");
}
export async function saveCertifiedRefreshOnConnection(c: PersonConnection, a: CertifiedRefreshSave): Promise<CertifiedRefreshSaveResult> {
  validate(a);
  try {
    await beginPersonTransaction(c);
    const admission = (await c.query("select person_private.refresh_save_begin($1,$2,$3,$4,$5) result", [a.organizationId,a.requestId,a.queueId,a.token,a.mode])).rows[0].result;
    if (admission.status === "completed") { await c.query("commit"); return admission.result; }
    const id = admission.candidateId as string;
    const doc = fromHarvest(admission.source.raw_payload, admission.source, id);
    await c.query("select person_private.refresh_save_seal($1,$2)",[a.requestId,doc]);
    await c.query("select person_private.refresh_save_audit_begin($1)",[a.requestId]);
    await c.query("select person_private.refresh_save_normalize($1)",[a.requestId]);
    if (a.mode === "live") {
      const tables = await readPersonProjection(c,id);
      const state = (await c.query("select * from public.candidate_profile_state where candidate_id=$1",[id])).rows[0];
      const before = (await c.query("select person_private.publication_candidate($1) value",[id])).rows[0].value;
      const computed = await compatibilityProjection(tables,state,before,async()=>false);
      await c.query("select person_private.refresh_save_project($1,$2)",[a.requestId,projectionEnvelope(id,before,computed)]);
      const profile = (await c.query("select person_private.publication_candidate($1) value",[id])).rows[0].value;
      const years = poolSignals({...profile,calculated_experience_years:null,total_experience_years:null}).years;
      await c.query("select person_private.refresh_save_metadata($1,$2)",[a.requestId,Number.isFinite(years)?Math.round(years!):null]);
      const after = (await c.query("select person_private.publication_candidate($1) value",[id])).rows[0].value;
      const data = await personDerivativeInput(c,id);
      await c.query("select person_private.refresh_save_enqueue($1,$2,$3)",[a.requestId,after,data]);
    }
    const result = (await c.query("select person_private.refresh_save_complete($1) result",[a.requestId])).rows[0].result;
    await c.query("commit");return result;
  } catch(error) { await c.query("rollback").catch(()=>{});throw error; }
}
export const saveCertifiedRefresh = (a: CertifiedRefreshSave) => { validate(a);return withPersonConnection(c=>saveCertifiedRefreshOnConnection(c,a)); };
