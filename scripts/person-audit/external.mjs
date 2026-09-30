// Read-only external evidence. Full provenance, including facts/identifiers and
// retained directory source-version payloads. No communications/v2 writes.
import {createHash} from 'node:crypto';
import {readDirectory} from '../person-trial.mjs';
import {timed} from './runtime.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const incomplete=reason=>({complete:false,reason});
export function externalReader({pool,comms,cols,lib,gate=async()=>{},expired=()=>false,read=readDirectory}){
 const check=async()=>{if(expired())throw Error('audit_duration');await gate();if(expired())throw Error('audit_duration');};
 const scope=async()=>{await check();return (await timed(pool,15,'select public.person_postcutover_audit_external_inputs() r')).rows[0].r;};
 async function directory(ids){
  if(!ids.length)return {complete:true,rows:new Map()};
  if(!comms||!cols)return {...incomplete('external_unavailable'),rows:new Map()};
  const rows=new Map();
  try{for(let i=0;i<ids.length;i+=100){await check();const chunk=ids.slice(i,i+100);const page=await read(comms,chunk,cols,{provenance:true});if(page.size!==chunk.length||chunk.some(id=>!page.has(id)))return {...incomplete('external_coverage'),rows:new Map()};for(const entry of page)rows.set(...entry);}}
  catch(e){if(['audit_duration','audit_capacity','audit_latency'].includes(e.message))throw e;return {...incomplete('external_unavailable'),rows:new Map()};}
  return {complete:true,rows};
 }
 return {
  async page(snapshots){return directory([...new Set(snapshots.flatMap(s=>(s.boundary?.directory_epochs??[]).map(d=>d.contact_id)))].sort());},
  async fingerprint(){
   const before=await scope();
   if(!Array.isArray(before?.contact_ids)||before.contact_count!==before.contact_ids.length)throw Error('audit_external_scope');
   const h=createHash('sha256');h.update(JSON.stringify({scope_hash:before.scope_hash,v2_hash:before.v2_hash,v2_rows:before.v2_rows,contact_count:before.contact_count}));
   for(let i=0;i<before.contact_ids.length;i+=100){const ids=before.contact_ids.slice(i,i+100);const page=await directory(ids);if(!page.complete)return incomplete(page.reason);for(const id of ids)h.update(JSON.stringify([id,lib.directorySnapshotHash(page.rows.get(id))]));}
   const after=await scope();
   if(hash(before)!==hash(after))return incomplete('external_scope_moved');
   return {complete:true,hash:h.digest('hex'),scope_hash:before.scope_hash,v2_hash:before.v2_hash,v2_rows:before.v2_rows,contact_count:before.contact_count};
  },
 };
}
