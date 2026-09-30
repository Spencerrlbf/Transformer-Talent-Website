import {applicationPreferenceEvidence} from './application.mjs';
import {arr,sameSource,same} from './evidence.mjs';

// Check the independent candidate-indexed collection, not only attributions
// found by joining the candidate's events. Never load a foreign event payload.
export function attributionReferences(s,lib,out){
 if(s.reference_version!==1||s.boundary?.reference_version!==1||!Array.isArray(s.attribution_refs))return out.review('reference_proof_required');
 if(s.attribution_refs.length>200)return out.review('attribution_refs_limit');
 const events=new Map(arr(s.events).map(e=>[e.id,e])),ops=new Map(arr(s.operations).map(o=>[o.id,o])),refs=new Map();
 for(const r of s.attribution_refs){
  const e=events.get(r.event_id),op=ops.get(r.operation_id),a=e?.attribution;
  if(refs.has(r.event_id)||r.candidate_id!==s.candidate_id||!e||e.candidate_id!==s.candidate_id||!op||op.candidate_id!==s.candidate_id||!a||a.event_id!==e.id||a.candidate_id!==s.candidate_id||a.operation_id!==r.operation_id)return out.review('attribution_reference_invalid');
  refs.set(r.event_id,r);
  if(a.event_hash!==e.actual_event_hash||op.transaction_id!==e.transaction_id||JSON.stringify([...arr(a.changed_fields)].sort())!==JSON.stringify([...arr(e.actual_changed_fields)].sort()))return out.review('attribution_invalid');
  if(a.scope==='creation'){
   if(e.source_table!=='candidates'||e.source_row_id!==s.candidate_id||e.operation!=='INSERT'||s.anchor.kind!=='receipt_created'||String(s.anchor.external_proof?.creator_event_id)!==e.id||!['application','directory'].includes(op.writer))return out.review('attribution_invalid');
  }else{
   const rule=lib.AUDIT_SCOPES[a.scope];
   if(!rule||(rule.writer&&rule.writer!==op.writer)||arr(e.actual_changed_fields).some(k=>!rule.fields.includes(k))||op.evidence?.guard?.version!==lib.AUDIT_GUARD_VERSION||op.evidence?.guard?.anchor_hash!==s.anchor.anchor_hash)return out.review('attribution_invalid');
   if(e.operation!=='UPDATE')return out.review('attribution_invalid');
   if(a.scope==='application_preferences'&&!applicationPreferenceEvidence(s,e,op,lib))return out.review('application_preferences_unwitnessed');
   if(a.scope==='application_finalize'){
    const r=arr(s.application_receipts).find(r=>r.application_id===e.source_row_id&&r.candidate_id===s.candidate_id);
    if(!r||['name','contact'].some(k=>arr(e.actual_changed_fields).includes(k)&&!same(e.payload?.[k],r.application_snapshot?.[k],lib)))return out.review('application_edit_unattributed');
    if(e.source_table!=='website_applications'||op.receipt_ref!==`application:${e.source_row_id}`||e.payload?.id!==e.source_row_id||e.payload?.organization_id!==lib.TT_ORG_ID||e.payload?.candidate_id!==s.candidate_id||(e.previous_payload?.candidate_id!=null&&e.previous_payload.candidate_id!==s.candidate_id))return out.review('attribution_invalid');
   }else if(e.source_table!=='candidates'||e.source_row_id!==s.candidate_id)return out.review('attribution_invalid');
  }
 }
 if(arr(s.events).some(e=>e.attribution&&!refs.has(e.id)))return out.review('attribution_reference_invalid');
 out.checks.reference_version=1;return true;
}

export function sourceReferences(s,docs,out){
 const n=s.normalized,id=s.candidate_id,sources=arr(n.sources),byId=new Map(sources.map(x=>[x.id,x]));
 if(byId.size!==sources.length||sources.some(x=>x.candidate_id!==id))return out.review('source_reference_invalid');
 const owned=sourceId=>sourceId!=null&&byId.has(sourceId);
 if(n.state?.candidate_id!==id)return out.review('source_reference_invalid');
 for(const field of ['lists_source_id','jobs_source_id','educations_source_id','skills_source_id'])if(n.state[field]!=null&&!owned(n.state[field]))return out.review('source_reference_invalid');
 for(const value of Object.values(n.state.header??{}))if(!owned(value.source_id))return out.review('source_reference_invalid');
 // Removed rows keep their historical owner, which may differ from the
 // current list owner. Their provenance must still belong to this person.
 for(const field of ['contacts','identities','jobs','educations','skills'])for(const row of arr(n[field])){
  if(row.candidate_id!==id||!owned(row.source_id))return out.review('source_reference_invalid');
  if(field==='contacts'||field==='identities'){
   const src=byId.get(row.source_id),key=field==='contacts'?'value_normalized':'value';
   if(field==='contacts'&&row.source!==src.source)return out.review('source_reference_invalid');
   if(!docs.some(d=>sameSource(src,d.source)&&arr(d[field]).some(x=>x.kind===row.kind&&x[key]===row[key])))return out.review('source_reference_unwitnessed');
  }
 }
 return true;
}
