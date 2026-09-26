// Shared pieces of the cutover runbook CLIs (publish, undo, guard). Direct
// PostgreSQL through the website project's server-only URL, never REST and
// never the communications database. Logs carry ids, counts and statuses only.
import pg from 'pg';
import {execFileSync} from 'node:child_process';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RUN_ID=/^[a-zA-Z0-9_-]{1,100}$/;

export function databaseConfig(env=process.env,applicationName='tt-person-publish'){
 const url=env.LOCAL_DATABASE_URL??env.PERSON_DATABASE_URL;
 if(!url)throw Error('publish_database_url_required');
 const parsed=new URL(url);
 if(!['postgres:','postgresql:'].includes(parsed.protocol)||(env.LOCAL_DATABASE_URL&&!['localhost','127.0.0.1'].includes(parsed.hostname)))throw Error('publish_database_url');
 if(parsed.hash||[...parsed.searchParams.keys()].some(k=>k!=='sslmode')||parsed.searchParams.getAll('sslmode').length>1)throw Error('publish_database_url');
 // Every transaction sets its own local lock/statement timeouts; this bounds
 // the reads and checkpoints made outside them.
 return {connectionString:url,max:2,statement_timeout:20000,connectionTimeoutMillis:10000,idleTimeoutMillis:10000,allowExitOnIdle:true,application_name:applicationName};
}
export async function openDatabase(env=process.env,applicationName){
 const pool=new pg.Pool(databaseConfig(env,applicationName));
 pool.on('error',()=>{});
 try{await pool.query('select 1');}catch(e){await pool.end();throw e;}
 return pool;
}
export function pinnedCommit(env=process.env){
 if(env.GITHUB_SHA&&/^[0-9a-f]{40}$/.test(env.GITHUB_SHA))return env.GITHUB_SHA;
 try{return execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();}catch{return 'unknown';}
}
/** --key=value options with explicit bounds. Unknown keys are refused. */
export function parseOptions(argv,spec){
 const out={};
 for(const [key,def] of Object.entries(spec))out[def.name??key]=def.default;
 for(const arg of argv){
  const m=/^--([a-z-]+)(?:=(.*))?$/.exec(arg);if(!m)throw Error('publish_option');
  const def=spec[m[1]];if(!def)throw Error(`publish_option:${m[1]}`);
  const name=def.name??m[1],value=m[2];
  if(def.type==='flag'){if(value!==undefined)throw Error(`publish_option:${m[1]}`);out[name]=true;continue;}
  if(value===undefined)throw Error(`publish_option:${m[1]}`);
  if(def.type==='int'){if(!/^\d+$/.test(value))throw Error(`publish_option:${m[1]}`);const n=Number(value);if(!Number.isSafeInteger(n)||n<def.min||n>def.max)throw Error(`publish_option:${m[1]}`);out[name]=n;continue;}
  if(def.type==='enum'){if(!def.values.includes(value))throw Error(`publish_option:${m[1]}`);out[name]=value;continue;}
  if(def.type==='uuid'){if(!uuid.test(value))throw Error(`publish_option:${m[1]}`);out[name]=value.toLowerCase();continue;}
  if(def.type==='uuids'){const ids=value.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);if(!ids.length||ids.length>def.max||ids.some(x=>!uuid.test(x)))throw Error(`publish_option:${m[1]}`);out[name]=ids;continue;}
  if(def.type==='run'){if(!RUN_ID.test(value))throw Error(`publish_option:${m[1]}`);out[name]=value;continue;}
  if(def.type==='text'){if(!value.length||value.length>def.max)throw Error(`publish_option:${m[1]}`);out[name]=value;continue;}
  throw Error(`publish_option:${m[1]}`);
 }
 for(const [key,def] of Object.entries(spec))if(def.required&&out[def.name??key]===undefined)throw Error(`publish_option_required:${key}`);
 return out;
}
/** Database health between batches: size cap, blocked sessions, latency drift.
 * Same shape as the backfill and anchor runners. */
export function capacityGate(pool,{maxBytes,now=Date.now}){
 const samples=[];let normal=0,slow=0;
 return async function check(){
  const start=now(),m=(await pool.query('select public.person_backfill_metrics() result')).rows[0].result,elapsed=now()-start;
  if(!Number.isFinite(Number(m.database_bytes))||!Number.isFinite(Number(m.blocked_sessions)))throw Error('publish_capacity');
  if(Number(m.database_bytes)>=maxBytes||Number(m.blocked_sessions)>5)throw Error('publish_capacity');
  if(samples.length<3){samples.push(elapsed);if(samples.length===3)normal=[...samples].sort((a,b)=>a-b)[1];}
  else{slow=elapsed>Math.max(250,normal*2)?slow+1:0;if(slow>=3)throw Error('publish_latency');}
  return {query_ms:elapsed,database_bytes:Number(m.database_bytes),blocked_sessions:Number(m.blocked_sessions),queue_pending:Number(m.queue_pending??0)};
 };
}
export function safeReason(error){
 const message=error?.message??'';
 if(/^(publish_|person_|audit_|legacy_|invalid_)[a-z_:0-9-]+$/.test(message))return message;
 return `operation_failed:${/^[0-9A-Z]{5}$/.test(error?.code??'')?error.code:'unknown'}`;
}
export const log=(record)=>console.log(JSON.stringify(record));
