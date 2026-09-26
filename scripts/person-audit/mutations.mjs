import {arr,same,sameSource} from './evidence.mjs';
const at=x=>x==null?null:Number.isFinite(Date.parse(x))?new Date(x).toISOString():null;
const newest=(a,b)=>at(a)==null?at(b):at(b)==null?at(a):Date.parse(a)>Date.parse(b)?at(a):at(b);
const years=(row,lib,clock)=>{if(!at(clock))return NaN;const n=lib.poolSignals({...row,calculated_experience_years:null,total_experience_years:null},new Date(clock)).years;return Number.isFinite(n)?Math.round(n):row.calculated_experience_years??null;};
export function creationEvidence(s,e,op,lib){
 const id=s.candidate_id,a=e.attribution;
 if(e.source_row_id!==id||e.candidate_id!==id||e.payload?.id!==id||e.previous_payload!=null||a.event_id!==e.id||a.candidate_id!==id||op.candidate_id!==id||op.transaction_id!==e.transaction_id||!same([...arr(a.changed_fields)].sort(),[...arr(e.actual_changed_fields)].sort(),lib))return false;
 const r=op.writer==='application'?arr(s.application_receipts).find(r=>`application:${r.application_id}`===op.receipt_ref):arr(s.directory_receipts).find(r=>`directory:${r.id}`===op.receipt_ref);
 if(!r?.created_person||r.candidate_id!==id)return false;
 const user=op.writer==='application'?String(r.application_snapshot?.linkedin_username??'').trim().toLowerCase():lib.directoryCanonicalUsername(r.snapshot);
 const name=(op.writer==='application'?r.application_snapshot?.name:r.snapshot?.board?.name)||user;
 const seed=e.payload;
 if(!user||seed.linkedin_username!==user||seed.linkedin_url!==`https://www.linkedin.com/in/${encodeURIComponent(user)}`||seed.full_name!==name||seed.source!==(op.writer==='application'?'website_applicant':'directory'))return false;
 const permitted=new Set(['id','full_name','first_name','last_name','linkedin_username','linkedin_url','source','status','created_at','updated_at']);
 const defaults={embedding_type:'unknown',linkedin_enrichment_status:'not_applicable',open_profile:false};
 return Object.entries(seed).every(([k,v])=>permitted.has(k)||v==null||v===''||same(v,[],lib)||same(v,{},lib)||same(v,defaults[k],lib));
}
export function metadataEvidence(s,e,op,lib){
 const before=e.previous_payload,after=e.payload,scope=e.attribution.scope;
 if(scope==='refresh_metadata'){
  const r=arr(s.refresh_receipts).find(r=>`refresh:${r.queue_id}`===op.receipt_ref);
  return r?.phase==='done'&&at(after.linkedin_enrichment_date)===newest(before.linkedin_enrichment_date,r.ledger_snapshot?.created_at)&&same(after.calculated_experience_years,years(before,lib,e.recorded_at),lib);
 }
 const r=arr(s.directory_receipts).find(r=>`directory:${r.id}`===op.receipt_ref);if(r?.phase!=='done')return false;
 // The writer emits a separate calculated-years event, then its linkage and
 // metadata event; each must match the exact corresponding statement.
 if(arr(e.actual_changed_fields).every(k=>['calculated_experience_years','updated_at'].includes(k)))return same(after.calculated_experience_years,years(before,lib,e.recorded_at),lib);
 const d=r.snapshot,historical=lib.fromDirectory(d.board,d.harvest,d.exps,d.edus,d.emails,d.phones,s.candidate_id),h=lib.directoryDocuments(d,s.candidate_id).find(x=>x.source.source_ref?.endsWith(':harvest'));
 const proven=[historical,...h?[h]:[]].some(x=>arr(s.normalized.sources).some(src=>sameSource(src,x.source)));
 const admitted=proven?at(d.harvest?.fetched_at):null;
 return after.directory_contact_id===r.contact_id&&after.directory_sync_hash===r.snapshot_hash&&after.source==='directory'&&after.status===(before.status==='Do Not Contact'?before.status:d.board.status||'engaged')&&(after.follow_up_at??null)===(before.follow_up_at??at(d.board.follow_up_date)?.slice(0,10)??null)&&at(after.linkedin_enrichment_date)===newest(before.linkedin_enrichment_date,admitted)&&same(after.calculated_experience_years,before.calculated_experience_years,lib);
}
