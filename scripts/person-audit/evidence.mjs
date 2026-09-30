// Pure source witnesses. Never turn the current compatibility row into a new
// historical legacy document. Exact receipts retain their original clocks.
import {createHash} from 'node:crypto';
import {createdThePerson} from '../person-trial.mjs';
export const arr=x=>Array.isArray(x)?x:[];
export const same=(a,b,lib)=>lib.stableStringify(a??null)===lib.stableStringify(b??null);
const at=x=>Number.isFinite(Date.parse(x))?new Date(x).toISOString():null;

export function sameSource(a,b){return a&&b&&['source','source_ref','payload_hash','parser_version','provider','raw_in','enrichment_id'].every(k=>(a[k]??null)===(b[k]??null))&&at(a.fetched_at)===at(b.fetched_at);}
export function validDocument(doc,id,lib){
 if(!doc||doc.candidate_id!==id||!['replace_lists','fill_gaps','contacts_only'].includes(doc.mode)||!doc.source||doc.source.parser_version!==lib.PARSER_VERSION||!at(doc.source.fetched_at)||!Array.isArray(doc.contacts)||!Array.isArray(doc.identities)||!doc.header)return false;
 const {source,...content}=doc;
 const hash=createHash('sha256').update(lib.stableStringify({content,source:source.source,ref:source.source_ref,at:source.fetched_at,v:lib.PARSER_VERSION})).digest('hex');
 return hash===source.payload_hash;
}
export function collectEvidence(s,lib,external,out){
 const id=s.candidate_id,docs=[],receipts=new Map(),byDate=new Map();
 const add=(doc,owner,{admitted=true,timelessIdentity=false}={})=>{
  if(!validDocument(doc,id,lib)){out.review('document_invalid');return false;}
  const k=lib.stableStringify([doc.source.source,doc.source.source_ref,at(doc.source.fetched_at)]),previous=byDate.get(k);
  if(previous&&previous!==doc.source.payload_hash&&!timelessIdentity){out.review('same_snapshot_mutation');return false;}byDate.set(k,doc.source.payload_hash);
  const stored=arr(s.normalized?.sources).some(src=>sameSource(src,doc.source));
  if(!admitted&&!stored){out.pending('raw_fact_not_admitted');return true;}
  if(!docs.some(x=>same(x.doc,doc,lib)))docs.push({doc,owner,admitted});return true;
 };
 const receipt=(ref,r,expected)=>{
  if(r.candidate_id!==id||!arr(r.documents).length||!same(r.documents,expected,lib)){out.review('receipt_invalid');return false;}
  receipts.set(ref,r);return r.documents.every(d=>add(d,ref));
 };
 const ledgerDoc=(l)=>{
  if(!l||l.organization_id!==lib.TT_ORG_ID||(l.candidate_id&&l.candidate_id!==id)||l.provider!=='harvest'||l.status!=='ok'||!l.raw_payload||!at(l.created_at))throw Error('ledger_invalid');
  return lib.fromHarvest(l.raw_payload,{...l,created_at:at(l.created_at)},id);
 };
 try{
  if(s.anchor.kind==='legacy'&&!add(s.anchor.legacy_doc,'anchor'))return null;
  for(const r of arr(s.application_receipts)){
   const a=r.application_snapshot;
   if(a?.id!==r.application_id||a.organization_id!==lib.TT_ORG_ID||!at(a.created_at)||(a.candidate_id&&a.candidate_id!==id)||typeof r.created_person!=='boolean'){out.review('application_receipt_invalid');return null;}
   const expected=[lib.fromApplication(a,r.created_person,id),lib.applicationProfileDoc(a,id,a.parsed_profile)];
   if(r.harvest_ledger_id){const l=arr(s.ledger).find(l=>l.id===r.harvest_ledger_id);if(!l||l.cache_status!=='miss'||!same(a.harvest_profile,l.raw_payload,lib)){out.review('application_ledger_invalid');return null;}expected.push(ledgerDoc(l));}
   if(!receipt(`application:${r.application_id}`,r,expected))return null;
  }
  for(const r of arr(s.refresh_receipts)){
   if(r.phase==='review'){out.review('refresh_review');return null;}
   if(r.phase!=='done'){out.pending('refresh_pending');continue;}
   const l=r.ledger_snapshot;
   if(r.organization_id!==lib.TT_ORG_ID||r.candidate_id!==id||l?.candidate_id!==id||l?.id!==r.ledger_id||l?.cache_status!=='miss'||r.linkedin_username!==l.linkedin_username){out.review('refresh_receipt_invalid');return null;}
   if(!receipt(`refresh:${r.queue_id}`,r,[ledgerDoc(l)]))return null;
  }
  for(const r of arr(s.directory_receipts)){
   if(r.candidate_id!==id||r.phase!=='done')continue;
   if(r.snapshot?.board?.contact_id!==r.contact_id||lib.directorySnapshotHash(r.snapshot)!==r.snapshot_hash){out.review('directory_receipt_invalid');return null;}
   const reconstructed=lib.directoryDocuments(r.snapshot,id);
   if(!arr(r.documents).length||r.documents.some(d=>!reconstructed.some(x=>same(x,d,lib)))){out.review('directory_document_invalid');return null;}
   // Only admitted components: rejected/unchanged components must not be
   // regenerated into a fabricated successful receipt.
   receipts.set(`directory:${r.id}`,r);for(const d of r.documents)if(!add(d,`directory:${r.id}`,{timelessIdentity:d.source.source_ref===`${r.contact_id}:identities`&&d.mode==='contacts_only'&&Date.parse(d.source.fetched_at)===0}))return null;

  }
  for(const r of arr(s.recruiter_receipts)){
   if(!r.result){out.pending('recruiter_pending');continue;}
   const d=r.document,c=r.requested_contact;
   const uploadOperations=arr(s.operations).filter(o=>o.writer==='recruiter'&&o.receipt_ref===`recruiter:${r.id}`);
   const upload=uploadOperations[0]?.evidence?.resume_fill;
   if(upload){
    const input=upload.input,snapshot=upload.snapshot,a=snapshot?.application;
    if(uploadOperations.length!==1||upload.version!==1||r.candidate_id!==id||!['live','shadow'].includes(r.mode)||upload.mode!==r.mode||upload.organization_id!==lib.TT_ORG_ID||upload.actor_id!==r.actor_id||input?.actorId!==r.actor_id||input?.candidateId!==id||a?.candidate_id!==id||a?.organization_id!==lib.TT_ORG_ID||a?.id!==input?.applicationId||a?.resume_path!==input?.path||a?.person_resume_sha256!==input?.sha256||!/^[a-f0-9]{64}$/.test(input?.sha256??'')||at(upload.edited_at)!==at(r.edited_at)||upload.input_hash!==r.input_hash||!same(snapshot?.contact,r.before_contact,lib)||!Array.isArray(snapshot?.contacts)||!Array.isArray(snapshot?.choices)) {out.review('resume_fill_receipt_invalid');return null;}
    const hash=createHash('sha256').update(lib.stableStringify(input)).digest('hex');
    const fill=lib.resumeFillPlan(snapshot,input.extracted);
    const expected=lib.resumeFillDocument(id,r.id,at(r.edited_at),snapshot,input.extracted);
    const flags=expected.contacts.map(x=>({kind:x.kind,value_normalized:x.value_normalized,existed:false,never_primary:null}));
    if(hash!==r.input_hash||(!fill.phone&&!fill.email)||!same(fill.contact,c,lib)||!same(upload.requested,c,lib)||!same(expected,d,lib)||!same(uploadOperations[0].evidence.prior_contact_flags,flags,lib)){out.review('resume_fill_receipt_invalid');return null;}
    receipts.set(`recruiter:${r.id}`,r);if(!add(d,`recruiter:${r.id}`))return null;
    continue;
   }
   if(r.candidate_id!==id||!['live','shadow'].includes(r.mode)||d?.source?.source!=='recruiter'||d.source.provider!=='website-recruiter'||d.source.source_ref!==r.id||at(d.source.fetched_at)!==at(r.edited_at)||!c){out.review('recruiter_receipt_invalid');return null;}
   const inputHash=createHash('sha256').update(lib.stableStringify(c)).digest('hex');
   const contacts=lib.mergeContacts([
    lib.emailContact(c.email,{is_manual:true,source_detail:'recruiter_primary'}),
    lib.phoneContact(c.phone,{is_manual:true,source_detail:'recruiter'}),
    lib.githubContact(c.github,{is_manual:true,source_detail:'recruiter'}),
    ...arr(c.otherEmails).map(x=>lib.emailContact(x,{source_detail:'recruiter_other'})),
   ]);
   const operations=arr(s.operations).filter(o=>o.writer==='recruiter'&&o.receipt_ref===`recruiter:${r.id}`);
   const flags=operations[0]?.evidence?.prior_contact_flags;
   if(operations.length!==1||!Array.isArray(flags)||flags.length!==contacts.length||flags.length>11||new Set(flags.map(x=>`${x.kind}:${x.value_normalized}`)).size!==flags.length){out.review('recruiter_prior_evidence_missing');return null;}
   for(const x of contacts){
    const prior=flags.find(y=>y.kind===x.kind&&y.value_normalized===x.value_normalized);
    if(!prior||typeof prior.existed!=='boolean'||(prior.existed?typeof prior.never_primary!=='boolean':prior.never_primary!==null)){out.review('recruiter_prior_evidence_invalid');return null;}
    x.never_primary=prior.existed?prior.never_primary:false;
   }
   const expected=lib.assembleDoc({candidate_id:id,mode:'contacts_only',source:{source:'recruiter',provider:'website-recruiter',source_ref:r.id,fetched_at:at(r.edited_at),raw_in:'inline',enrichment_id:null},identities:[],header:lib.makeHeader({}),contacts});
   if(inputHash!==r.input_hash||!same(expected,d,lib)){out.review('recruiter_receipt_invalid');return null;}
   receipts.set(`recruiter:${r.id}`,r);if(!add(d,`recruiter:${r.id}`))return null;
  }
  for(const o of arr(s.operations)){
   if(o.candidate_id!==id||o.evidence?.guard?.version!==lib.AUDIT_GUARD_VERSION||o.evidence?.guard?.anchor_hash!==s.anchor.anchor_hash){out.review('operation_invalid');return null;}
   if(['application','refresh','directory','recruiter'].includes(o.writer)){
    if(!o.receipt_ref.startsWith(o.writer+':')||!receipts.has(o.receipt_ref)){out.review('operation_receipt_missing');return null;}
   }else if(o.writer==='projection'){
    if(!o.receipt_ref.startsWith('projection:')||(!['live','shadow'].includes(o.evidence.mode)&&!(o.evidence.mode==='publish'&&o.receipt_ref.startsWith(`projection:publish:${o.evidence.run_id}:`)))){out.review('operation_invalid');return null;}
    for(const d of arr(o.evidence.documents))if(!add(d,`operation:${o.id}`))return null;
   }else if(o.writer==='undo'){
    const h=arr(s.history).find(h=>String(h.id)===o.evidence.history_id);
    if(!h||h.candidate_id!==id||String(h.revision)!==o.evidence.revision||(arr(s.events).some(e=>e.attribution?.operation_id===o.id)&&!h.restored_at)||o.receipt_ref!==`undo:${h.id}`){out.review('undo_history_invalid');return null;}
   }else{out.review('operation_invalid');return null;}
  }
  for(const l of arr(s.ledger))if(!add(ledgerDoc(l),`raw-ledger:${l.id}`,{admitted:false}))return null;
  for(const a of arr(s.applications))if(!receipts.has(`application:${a.id}`)&&!sentApplication(s,a,lib)){
   if(a.organization_id!==lib.TT_ORG_ID||a.candidate_id!==id){out.review('application_owner_invalid');return null;}
   if(!add(lib.fromApplication(a,createdThePerson(a,s.anchor.before_image),id),`raw-application:${a.id}`,{admitted:false}))return null;
  }
  // Historical monolithic directory owners can only be reconstructed exactly
  // from a retained receipt snapshot or current complete external observation.
  const snapshots=[...arr(s.directory_receipts).map(r=>r.snapshot),...external?.rows?.values?.()??[]].filter(Boolean);
  for(const src of arr(s.normalized?.sources))if(src.source==='directory'&&!docs.some(x=>sameSource(src,x.doc.source))){
   let match;
   for(const d of snapshots){const built=lib.fromDirectory(d.board,d.harvest,d.exps,d.edus,d.emails,d.phones,id);if(sameSource(src,built.source)){match=built;break;}}
   if(!match){out.review('historical_owner_unavailable');return null;}if(!add(match,'historical-directory'))return null;
  }
  out.checks.documents={witnessed:docs.length,receipts:receipts.size};return {docs,receipts};
 }catch{out.review('source_reconstruction_failed');return null;}
}
/** A TT pipeline row created by the checked Network Send: witnessed, not a source.
 * With an event, the witness must come from that insert's transaction. */
export function sentApplication(s,row,lib,event=null){
 const witnesses=arr(s.application_sends).filter(x=>x.application_id===row?.id);
 if(witnesses.length!==1)return false;
 const w=witnesses[0],e=w.insert_event,original=w.inserted_row;
 if(!original||!e||w.candidate_id!==s.candidate_id||row.candidate_id!==s.candidate_id||row.organization_id!==lib.TT_ORG_ID||row.source!=='transformer_talent'||row.status!=='processed'||original.id!==row.id||original.candidate_id!==row.candidate_id||original.organization_id!==row.organization_id||original.source!==row.source||original.status!==row.status)return false;
 const {resume_embedding,matching_embedding,resume_text,notes,...captured}=original;
 return typeof w.row_hash==='string'&&/^[a-f0-9]{32}$/.test(w.row_hash)&&w.row_hash===w.actual_row_hash&&typeof w.event_hash==='string'&&/^[a-f0-9]{32}$/.test(w.event_hash)&&w.event_hash===e.actual_event_hash&&w.event_id===e.id&&e.candidate_id===s.candidate_id&&e.source_table==='website_applications'&&e.source_row_id===row.id&&e.operation==='INSERT'&&e.previous_payload==null&&w.transaction_id===e.transaction_id&&same(captured,e.payload,lib)&&(!event||(event.id===e.id&&event.transaction_id===e.transaction_id&&event.actual_event_hash===e.actual_event_hash&&same(event.payload,e.payload,lib)));
}
