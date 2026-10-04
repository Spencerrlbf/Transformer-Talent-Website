import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PIN} from './start-catchup.mjs';
export const COMPATIBILITY_ID='c4d0e4e-explicit-contact-clear-v1';
const trialHash='73b97b65f2376e6058bc1bad2d852cdaf845d0b04927e6e5e5db64a1710f370a';
const hash=b=>createHash('sha256').update(b).digest('hex');
const replace=(s,a,b)=>{if(s.split(a).length!==2)throw Error('catchup_run:compatibility_source');return s.replace(a,b);};
export function checkCompatibilityApproval(env,target){
 if(target!=='local'&&env.PERSON_CATCHUP_COMPATIBILITY_ID!==COMPATIBILITY_ID)throw Error('catchup_run:compatibility_approval');
}
export function checkArtifactApproval(env,target,manifest){
 const expected=env.PERSON_CATCHUP_ARTIFACT_SHA256;
 if((target!=='local'&&!expected)||(expected&&expected!==manifest.artifact_identity))throw Error('catchup_run:artifact_approval');
}
export function prepareCompatibilityRuntime(runtime){
 const files=['scripts/person-trial.mjs','scripts/person-reconcile.mjs','scripts/person-backfill.mjs','scripts/person-backfill/engine.mjs','scripts/dist/worker-lib.mjs'];
 const inputs=Object.fromEntries(files.map(f=>[f,fs.readFileSync(path.join(runtime.root,f))]));
 if(hash(inputs[files[0]])!==trialHash)throw Error('catchup_run:compatibility_source');
 let trial=inputs[files[0]].toString();
 trial=replace(trial,'export async function readNew(site, ids, { globalCounts = true } = {}) {','export async function readNew(site, ids, { globalCounts = true } = {}) {\n  const snapshot = await contactSnapshot(site, ids);');
 trial=replace(trial,'()=>selectIn(site,"candidate_profile_state","candidate_id",ids,{order:"candidate_id.asc"}),','()=>snapshot.profile_state,');
 trial=replace(trial,'()=>selectIn(site,"candidate_contacts","candidate_id",ids,{order:"candidate_id.asc,kind.asc,value_normalized.asc"}),','()=>snapshot.contacts,');
 trial=replace(trial,'()=>selectIn(site,"candidate_contact_summary","candidate_id",ids,{order:"candidate_id.asc"})','()=>snapshot.contact_summary');
 trial=replace(trial,'    contacts: groupBy(contacts, "candidate_id"),','    contacts: groupBy(contacts, "candidate_id"),\n    decisions: new Map(snapshot.decisions.map(d=>[`${d.candidate_id}:${d.kind}`,d])),');
 trial=replace(trial,'const ok = usable ? ranked1.length === 1 && eligible(ranked1[0]) : ranked1.length === 0;','const kind = check === "one_primary_email" ? "email" : "phone";\n    const ok = primaryDecision(rows, t.decisions.get(`${id}:${kind}`), eligible);');
 trial=replace(trial,'#!/usr/bin/env node','#!/usr/bin/env node\nimport {contactSnapshot,primaryDecision} from "./contact-compat-snapshot.mjs";');
 const helper=fs.readFileSync(new URL('./contact-compat-snapshot.mjs',import.meta.url));
 const outputs={...inputs,'scripts/person-trial.mjs':Buffer.from(trial),'scripts/contact-compat-snapshot.mjs':helper};
 const manifest={pin:PIN,compatibility_id:COMPATIBILITY_ID,snapshot_sql_sha256:hash(fs.readFileSync(new URL('../../supabase/migrations/20261005120000_person_catchup_contact_snapshot.sql',import.meta.url))),files:Object.fromEntries(Object.entries(outputs).map(([f,b])=>[f,{input_sha256:inputs[f]?hash(inputs[f]):null,output_sha256:hash(b)}]))};
 manifest.artifact_identity=hash(JSON.stringify(manifest));
 const base=fileURLToPath(new URL('../dist/',import.meta.url));fs.mkdirSync(base,{recursive:true});
 const root=fs.mkdtempSync(path.join(base,'catchup-compat-'));
 for(const [f,b] of Object.entries(outputs)){fs.mkdirSync(path.dirname(path.join(root,f)),{recursive:true});fs.writeFileSync(path.join(root,f),b);}
 fs.symlinkSync(path.join(runtime.root,'node_modules'),path.join(root,'node_modules'),'dir');
 fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 return {...runtime,root,manifest};
}
