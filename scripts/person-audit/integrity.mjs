import {arr,same,sameSource} from './evidence.mjs';
import {sourceReferences} from './references.mjs';
// checkStored proves list ownership/keys and projection executability. These
// additional checks prove content, retained source contacts, identities and the
// current primary choices which key-only comparisons do not cover.
export function exactStored(s,docs,lib,out){
 if(!sourceReferences(s,docs,out))return false;
 const n=s.normalized,sourceById=new Map(arr(n.sources).map(x=>[x.id,x]));
 for(const field of ['jobs','educations','skills']){const owner=n.state?.[`${field}_source_id`];if(owner&&arr(n[field]).some(row=>!row.removed_at&&row.source_id!==owner))return out.review('list_row_owner_invalid');}
 const docForRow=(r,field,key)=>docs.filter(d=>{const src=sourceById.get(r.source_id);return src&&sameSource(src,d.source);}).flatMap(d=>arr(d[field])).filter(d=>d[key]===r[key]);
 for(const [field,cols] of [['jobs',['title','employment_type','location','description','duration_text','start_year','start_month','end_year','end_month','is_current','is_side_role','sort_order']],['educations',['degree','degree_level','field_of_study','start_year','start_month','end_year','end_month','description','activities','sort_order']]]){
  for(const row of arr(n[field]).filter(r=>!r.removed_at)){
   const candidates=docForRow(row,field,'row_key');
   if(!candidates.some(doc=>cols.every(k=>same(row[k],doc[k],lib))&&(field!=='jobs'||same(row.skills??[],arr(doc.skills).map(x=>typeof x==='string'?x:x.name),lib))))return out.review('stored_fact_unwitnessed');
  }
 }
 for(const [field,value] of Object.entries(n.state?.header??{})){
  const src=sourceById.get(value.source_id);
  if(!src||!docs.some(d=>d.source.source===src.source&&d.source.source_ref===src.source_ref&&d.source.payload_hash===value.payload_hash&&same(d.header?.[field],value.value,lib)&&Date.parse(d.header_dates?.[field]??d.source.fetched_at)===Date.parse(value.at)))return out.review('header_unwitnessed');
 }
 if(!headerEvidence(n,docs,sourceById,lib,out))return false;
 const contacts=arr(n.contacts),identities=arr(n.identities);
 if(!contactEvidence(contacts,docs,lib,out))return false;
 for(const d of docs){
  if(arr(d.contacts).some(c=>!contacts.some(r=>r.kind===c.kind&&r.value_normalized===c.value_normalized)))return out.review('document_contact_missing');
  for(const identity of arr(d.identities))if(!identities.some(r=>r.kind===identity.kind&&r.value===identity.value))return out.review('document_identity_missing');
 }
 if(contacts.some(c=>c.rank!=null&&(c.status!=='active'||c.never_primary||(c.kind==='email'&&lib.checkClass(c.quality,c.result)==='bad'))))return out.review('contact_rank_invalid');
 for(const c of contacts)if(!docs.some(d=>arr(d.contacts).some(x=>x.kind===c.kind&&x.value_normalized===c.value_normalized)))return out.review('contact_unwitnessed');
 for(const r of identities)if(!docs.some(d=>arr(d.identities).some(x=>x.kind===r.kind&&x.value===r.value)))return out.review('identity_unwitnessed');
 // Explicit primary rows supersede historical is_manual / directory flags.
 for(const p of arr(s.recruiter_primary)){
  const receipt=arr(s.recruiter_receipts).find(r=>r.id===p.receipt_id);const normalize=p.kind==='email'?lib.normalizeEmail:lib.normalizePhone;
  if(!receipt||normalize(receipt.requested_contact?.[p.kind])!==p.chosen_value)return out.review('contact_authority_invalid');
  if(p.chosen_value&&contacts.some(c=>c.kind===p.kind&&c.value_normalized===p.chosen_value&&c.status==='active'&&!c.never_primary&&Number(c.rank)!==1))return out.review('contact_authority_invalid');
 }
 if(s.expected_contact_ranks){
  const ranks=new Map(s.expected_contact_ranks.map(x=>[x.id,x.new_rank==null?null:String(x.new_rank)]));
  if(ranks.size!==contacts.length||contacts.some(c=>ranks.get(c.id)!==(c.rank==null?null:String(c.rank))))return out.review('contact_rank_invalid');
 }
 out.checks.exact_facts=true;return true;
}

const ranks={legacy_import:0,application:1,directory:2,harvest:3,recruiter:4};
const nonempty=x=>x!=null&&!(typeof x==='string'&&!x.trim())&&!(Array.isArray(x)&&!x.length)&&!(typeof x==='object'&&!Object.keys(x).length);
function beats(a,b){
 if((a.source==='recruiter')!==(b.source==='recruiter'))return a.source==='recruiter';
 if((a.source==='application')!==(b.source==='application'))return b.source==='application';
 return Date.parse(a.at)!==Date.parse(b.at)?Date.parse(a.at)>Date.parse(b.at):(ranks[a.source]??0)!==(ranks[b.source]??0)?ranks[a.source]>ranks[b.source]:a.payload_hash>b.payload_hash;
}
function headerEvidence(n,docs,sourceById,lib,out){
 const facts=new Map();
 for(const d of docs)if(d.mode!=='contacts_only')for(const [field,value] of Object.entries(d.header??{}))if(nonempty(value)){
  const list=facts.get(field)??[];list.push({value,source:d.source.source,at:d.header_dates?.[field]??d.source.fetched_at,payload_hash:d.source.payload_hash,parser_version:d.source.parser_version,doc:d});facts.set(field,list);
 }
 for(const [field,f] of facts){
  const current=n.state?.header?.[field];if(!current)return out.review('header_missing');
  const witness=f.find(x=>x.payload_hash===current.payload_hash&&same(x.value,current.value,lib)&&Date.parse(x.at)===Date.parse(current.at)&&sameSource(sourceById.get(current.source_id),x.doc.source));
  if(!witness||f.some(x=>x.doc.mode!=='fill_gaps'&&beats(x,witness)))return out.review('header_winner_invalid');
 }
 return true;
}
// Compare independent contact evidence, before consulting SQL ranks (which
// intentionally ranks the current rows and cannot prove their provenance).
function contactEvidence(contacts,docs,lib,out){
 for(const c of contacts){
  const facts=docs.flatMap(d=>arr(d.contacts).filter(x=>x.kind===c.kind&&x.value_normalized===c.value_normalized).map(x=>({...x,doc:d})));
  if(!facts.length)return out.review('contact_unwitnessed');
  if(c.never_primary!==facts.every(x=>!!x.never_primary)||c.is_manual!==facts.some(x=>!!x.is_manual)||c.legacy_primary!==facts.some(x=>!!x.legacy_primary))return out.review('contact_evidence_invalid');
  const negative=['removed','do_not_use','bounced'].find(st=>facts.some(x=>x.status===st));
  if(!negative&&['removed','do_not_use','bounced'].includes(c.status))return out.review('contact_status_unwitnessed');
  if(negative&&c.status!==negative)return out.review('contact_status_unwitnessed');
  const checks=facts.filter(x=>x.quality||x.result||x.verified_at),severity=x=>({none:0,good:1,risky:2,bad:3})[lib.checkClass(x.quality,x.result)];
  const verification=['quality','result','resultcode','subresult','verifier','verification_raw'];
  if(checks.length){
   const newest=Math.max(...checks.map(x=>x.verified_at?Date.parse(x.verified_at):-Infinity));
   const dated=checks.filter(x=>(x.verified_at?Date.parse(x.verified_at):-Infinity)===newest),worst=Math.max(...dated.map(severity));
   const winners=dated.filter(x=>severity(x)===worst);
   if(!winners.some(x=>verification.every(k=>same(x[k],c[k],lib))&&((x.verified_at==null&&c.verified_at==null)||Date.parse(x.verified_at)===Date.parse(c.verified_at))))return out.review('contact_verification_unwitnessed');
  }else if(verification.some(k=>c[k]!=null)||c.verified_at!=null)return out.review('contact_verification_unwitnessed');
  if(!checks.length&&facts.some(x=>x.status==='invalid')&&['active','shared'].includes(c.status))return out.review('contact_status_unwitnessed');
  if(facts.every(x=>x.status==='claimed')&&c.status!=='claimed')return out.review('contact_status_unwitnessed');
  if(!negative&&c.status==='active'&&(facts.some(x=>x.status==='shared')&&!facts.some(x=>x.is_manual&&x.status==='active')))return out.review('contact_status_unwitnessed');
 }
 return true;
}
