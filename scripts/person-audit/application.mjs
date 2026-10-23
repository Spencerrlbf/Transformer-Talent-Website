import {arr,same} from './evidence.mjs';
const order=value=>typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
/** Historical latestness comes from the private sequence journal, including
 * accepted intents which were still unlinked when this event committed. */
export function applicationPreferenceEvidence(s,e,op,lib){
 const matches=arr(s.application_preference_proofs).filter(p=>p.event_id===e.id);
 if(matches.length!==1)return false;const p=matches[0];
 const r=arr(s.application_receipts).find(r=>`application:${r.application_id}`===op.receipt_ref),a=r?.application_snapshot;
 if(!r||r.candidate_id!==s.candidate_id||!a||a.organization_id!==lib.TT_ORG_ID||a.source!=='future'||a.person_processing_version!==1||
  p.candidate_id!==s.candidate_id||p.application_id!==r.application_id||p.latest_application_id!==r.application_id||
  p.intent_hash!==a.person_intent_hash||p.event_hash!==e.actual_event_hash||!order(p.intent_order)||!order(p.decision_order)||BigInt(p.intent_order)>=BigInt(p.decision_order))return false;
 const expected={roles:a.preferred_roles??[],locations:a.preferred_locations??[],workplace:a.preferred_workplace??[],salary:a.comp_expectation??null};
 if(!same(e.payload?.follow_up_at,a.follow_up_at,lib)||!same(e.payload?.role_preferences,expected,lib))return false;
 return !arr(e.actual_changed_fields).includes('visa_status')||(typeof a.visa_status==='string'&&a.visa_status.length>0&&same(e.payload?.visa_status,a.visa_status,lib));
}
