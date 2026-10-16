// Fail closed: this scalar RPC carries all four relations in one statement snapshot.
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=()=>{throw Error('post_save_integrity:contact_snapshot');};
export async function contactSnapshot(site,ids){
 if(!Array.isArray(ids)||ids.length>500||ids.some(x=>!uuid.test(x))||new Set(ids).size!==ids.length)fail();
 let s;try{s=await site.rpc('person_catchup_contact_snapshot',{p_candidate_ids:ids});}catch(error){if((error?.message??'').includes('contact_snapshot_capacity'))throw Error('post_save_integrity:contact_snapshot_capacity');throw error;}
 if(!s||Array.isArray(s)||!Array.isArray(s.candidate_ids)||s.candidate_ids.length!==ids.length||new Set(s.candidate_ids).size!==ids.length||ids.some(x=>!s.candidate_ids.includes(x)))fail();
 const requested=new Set(ids);
 for(const key of ['contacts','decisions','contact_summary','profile_state']){
  if(!Array.isArray(s[key]))fail();
  const seen=new Set();
  for(const row of s[key]){
   if(!row||typeof row!=='object'||!requested.has(row.candidate_id))fail();
   if(key==='decisions'){
    if(!['email','phone'].includes(row.kind)||typeof row.suppressed!=='boolean'||!(row.chosen_value===null||typeof row.chosen_value==='string')||(row.suppressed&&row.chosen_value!==null))fail();
   }
   if(key==='profile_state'&&!(typeof row.rev==='number'?Number.isSafeInteger(row.rev)&&row.rev>0:typeof row.rev==='string'&&/^[1-9][0-9]*$/.test(row.rev)&&Number.isSafeInteger(Number(row.rev))))fail();
   if(key==='contact_summary'&&(['primary_email','primary_phone','secondary_email','secondary_phone'].some(k=>!(row[k]===null||typeof row[k]==='string'))||!Array.isArray(row.usable_emails)||row.usable_emails.some(x=>typeof x!=='string')))fail();
   if(key==='contacts'&&(!['email','phone','github','website'].includes(row.kind)||typeof row.value_normalized!=='string'||!(row.rank===null||Number.isInteger(row.rank)&&row.rank>=1&&row.rank<=32767)||!['active','invalid','bounced','do_not_use','removed','claimed','shared'].includes(row.status)||typeof row.never_primary!=='boolean'))fail();
   const identity=key==='decisions'?`${row.candidate_id}:${row.kind}`:key==='contacts'?`${row.candidate_id}:${row.kind}:${row.value_normalized}`:row.candidate_id;
   if(seen.has(identity))fail();seen.add(identity);
  }
  if(['profile_state','contact_summary'].includes(key)&&seen.size!==ids.length)fail();
 }
 if(!Array.isArray(s.row_counts)||s.row_counts.length!==ids.length||new Set(s.row_counts.map(r=>r?.candidate_id)).size!==ids.length)fail();
 for(const r of s.row_counts){if(!requested.has(r?.candidate_id)||!Number.isSafeInteger(r.contacts)||r.contacts<0||!Number.isSafeInteger(r.decisions)||r.decisions<0||r.contacts!==s.contacts.filter(c=>c.candidate_id===r.candidate_id).length||r.decisions!==s.decisions.filter(d=>d.candidate_id===r.candidate_id).length)fail();}
 if(s.contacts.length>10000||new TextEncoder().encode(JSON.stringify(s)).length>8388608)throw Error('post_save_integrity:contact_snapshot_capacity');
 return s;
}
export function primaryDecision(rows,decision,eligible){
 if(decision?.suppressed)return rows.every(c=>c.rank===null||c.rank===undefined);
 const ranked=rows.filter(c=>Number(c.rank)===1);
 const usable=rows.filter(eligible).length;
 const ordinary=usable?ranked.length===1&&eligible(ranked[0]):ranked.length===0;
 return ordinary;
}
