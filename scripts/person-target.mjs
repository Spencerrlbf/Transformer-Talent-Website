// One explicit environment for every normalized-storage process: the server's
// REST and PostgreSQL clients, the Actions workers, and the operator CLIs.
// PERSON_TARGET_PROJECT_REF names the Supabase project that is allowed to
// receive effects. Nothing here defaults to the original website project;
// a missing or mismatched selection fails before any connection, queue claim,
// write or provider call. Plain ESM with no dependencies so the Next.js server
// (allowJs), the bundled worker library and the scripts share one copy.
//
// Signals checked offline, before connecting:
//   REST       https://<ref>.supabase.co
//   JWT keys   payload.ref claim (legacy anon/service keys are JWTs)
//   direct PG  db.<ref>.supabase.co:5432
//   pooler PG  *.pooler.supabase.com with username <role>.<ref>
//              (the host is shared by every project in the region, so the
//              username suffix is the only offline identity signal there)
//   CLI        <workdir>/supabase/.temp/project-ref
//   local      loopback hosts only, selected with PERSON_TARGET_PROJECT_REF=local
// Runtime proof: public.person_target_identity() returns the cluster's
// pg_control_system identifier AND the project label an operator wrote into
// person_private.target_identity (20261013090000). A REST client and a
// PostgreSQL client must report the same identifier and the same label, and the
// label must equal the selection; the identifier alone cannot tell a physical
// clone (the restored copy) from its source.
const REF=/^[a-z]{20}$/;
export const LOCAL_TARGET='local';
const LOOPBACK=new Set(['localhost','127.0.0.1','::1','[::1]']);
const fail=(code)=>{const e=Error(`person_target:${code}`);e.code='person_target';return e;};
export const isTargetError=(error)=>typeof error?.message==='string'&&error.message.startsWith('person_target:');

/** The selected project. `local` is only for disposable loopback databases.
 * @param {Record<string,string|undefined>} [env] */
export function selectedTarget(env=process.env){
 const raw=env.PERSON_TARGET_PROJECT_REF;
 if(raw===undefined||raw==='')throw fail('missing');
 if(raw===LOCAL_TARGET)return {ref:LOCAL_TARGET,local:true};
 if(!REF.test(raw))throw fail('invalid');
 return {ref:raw,local:false};
}
/** @param {Record<string,string|undefined>} [env] */
export const hasSelectedTarget=(env=process.env)=>env.PERSON_TARGET_PROJECT_REF!==undefined&&env.PERSON_TARGET_PROJECT_REF!=='';

function parseUrl(value,code){
 if(typeof value!=='string'||!value)throw fail(code);
 try{return new URL(value);}catch{throw fail(code);}
}
/** The project a Supabase REST URL names, or null for any other host. */
export function restProjectRef(url){
 const u=parseUrl(url,'rest_url');
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||!['','/'].includes(u.pathname))return null;
 const m=/^([a-z]{20})\.supabase\.co$/.exec(u.hostname);
 return m?m[1]:null;
}
/** A REST URL that cannot reach any hosted project: loopback, or the reserved
 * `.invalid` TLD that fixtures use as a sealed sentinel (RFC 2606). */
export function isSealedRestUrl(url){
 if(url===undefined||url==='')return true;
 let u;try{u=new URL(url);}catch{return false;}
 return LOOPBACK.has(u.hostname)||u.hostname.endsWith('.invalid');
}
/** A PostgreSQL URL that stays on this machine. */
export function isLoopbackDatabaseUrl(url){
 if(url===undefined||url==='')return true;
 try{return databaseIdentity(url).kind==='local';}catch{return false;}
}
export function checkRestUrl(url,target=selectedTarget()){
 if(target.local){
  const u=parseUrl(url,'rest_url');
  if(!isSealedRestUrl(url)||u.username||u.password||u.hash)throw fail('rest_mismatch');
  return target.ref;
 }
 const ref=restProjectRef(url);
 if(ref!==target.ref)throw fail('rest_mismatch');
 return ref;
}
/** The `ref` claim of a legacy Supabase JWT key, or null when the key carries no
 * decodable project claim (for example an `sb_secret_` key). */
export function keyProjectRef(key){
 if(typeof key!=='string')return null;
 const parts=key.split('.');
 if(parts.length!==3)return null;
 try{
  const payload=JSON.parse(Buffer.from(parts[1].replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'));
  return typeof payload?.ref==='string'&&REF.test(payload.ref)?payload.ref:null;
 }catch{return null;}
}
/** A key whose claim names another project is refused. A key without a claim is
 * accepted only when `requireClaim` is false; the runtime identity check must
 * then prove the destination instead. */
export function checkServiceKey(key,target=selectedTarget(),{requireClaim=false}={}){
 if(typeof key!=='string'||!key)throw fail('key_missing');
 const ref=keyProjectRef(key);
 if(target.local){if(ref!==null)throw fail('key_mismatch');return null;}
 if(ref===null){if(requireClaim)throw fail('key_unverifiable');return null;}
 if(ref!==target.ref)throw fail('key_mismatch');
 return ref;
}
// pg (pg-connection-string) applies URL query options AFTER the authority: `?host=`,
// `?port=`, `?user=` and their percent-encoded spellings move the connection to a
// destination the authority does not name, and a repeated `sslmode` lets the last
// value win. The validated identity must be the destination pg uses, so only one
// `sslmode`, at most once, is accepted; every other option is refused.
const DATABASE_OPTIONS=new Set(['sslmode']);
// TLS modes a hosted destination may ask for. `disable`, `allow` and `no-verify`
// would let the connection be read or redirected on the path; `prefer` is an alias
// today but changes meaning in the next pg major.
const HOSTED_SSLMODES=new Set(['require','verify-ca','verify-full']);
function checkDatabaseOptions(u,hosted){
 const keys=[...u.searchParams.keys()];
 if(keys.some(k=>!DATABASE_OPTIONS.has(k)))throw fail('database_options');
 for(const k of DATABASE_OPTIONS)if(u.searchParams.getAll(k).length>1)throw fail('database_options');
 const mode=u.searchParams.get('sslmode');
 if(hosted&&mode!==null&&!HOSTED_SSLMODES.has(mode))throw fail('database_options');
}
/** Parse a PostgreSQL URL into its identity signals without exposing the password.
 * The result describes the destination pg connects to: option overrides are refused,
 * and every part pg could otherwise take from the environment (PGPORT, PGUSER,
 * PGDATABASE) must be explicit. A string pg would re-encode before parsing
 * (whitespace, malformed percent sequences) is refused outright: pg then resolves it
 * against its internal base and connects to host `base`. */
export function databaseIdentity(url){
 if(typeof url!=='string'||/\s/.test(url)||/%(?![0-9a-f]{2})/i.test(url))throw fail('database_url');
 const u=parseUrl(url,'database_url');
 if(!['postgres:','postgresql:'].includes(u.protocol)||u.hash)throw fail('database_url');
 if(!/^\/[^/]+$/.test(u.pathname))throw fail('database_url');
 const host=u.hostname.replace(/^\[|\]$/g,'');
 const username=decodeURIComponent(u.username||'');
 let kind,ref,role=username;
 if(LOOPBACK.has(u.hostname)||LOOPBACK.has(host)){kind='local';ref=LOCAL_TARGET;}
 else{
  let m=/^db\.([a-z]{20})\.supabase\.co$/.exec(host);
  if(m){kind='direct';ref=m[1];}
  else if(/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host)){
   m=/^(.+)\.([a-z]{20})$/.exec(username);
   if(!m)throw fail('pooler_username');
   kind='pooler';ref=m[2];role=m[1];
  }
  else throw fail('database_host');
 }
 checkDatabaseOptions(u,kind!=='local');
 if(!u.port)throw fail('database_port');
 if(!username)throw fail('database_role');
 return {kind,ref,host,port:u.port,role};
}
/** `ports` restricts the transport (publish/anchor CLIs need the 5432 session
 * endpoints; the application writer needs the 6543 transaction pooler). */
export function checkDatabaseUrl(url,target=selectedTarget(),{ports}={}){
 const id=databaseIdentity(url);
 if(target.local){if(id.kind!=='local')throw fail('database_mismatch');}
 else{if(id.kind==='local'||id.ref!==target.ref)throw fail('database_mismatch');}
 if(ports&&id.kind!=='local'&&!ports.includes(id.port))throw fail('database_port');
 return id;
}
/** A Supabase CLI workdir is linked to exactly one project. */
export function checkLinkedWorkdir(projectRefFileText,target=selectedTarget()){
 const ref=String(projectRefFileText??'').trim();
 if(target.local)throw fail('workdir_local');
 if(ref!==target.ref)throw fail('workdir_mismatch');
 return ref;
}
/** Every signal a process holds, checked together. Missing optional signals are
 * skipped; present ones must all name the selected project.
 * @param {Record<string,string|undefined>} [env]
 * @param {{restUrl?:string,serviceKey?:string,databaseUrls?:(string|undefined)[],ports?:string[]}} [options] */
export function checkTargetEnvironment(env=process.env,{restUrl=env.SUPABASE_URL,serviceKey=env.SUPABASE_SERVICE_ROLE_KEY,databaseUrls=[],ports}={}){
 const target=selectedTarget(env);
 const report={ref:target.ref,local:target.local,rest:null,key:null,databases:[]};
 if(restUrl!==undefined)report.rest=checkRestUrl(restUrl,target);
 if(serviceKey!==undefined)report.key=checkServiceKey(serviceKey,target);
 for(const url of databaseUrls)if(url!==undefined){const id=checkDatabaseUrl(url,target,{ports});report.databases.push({kind:id.kind,host:id.host,port:id.port});}
 return report;
}
export const IDENTITY_SQL='select public.person_target_identity() identity';
const digits=/^[0-9]{1,20}$/;
const payloadOf=(result)=>result&&typeof result==='object'&&result.identity&&typeof result.identity==='object'?result.identity:result;
export function identityValue(result){
 const value=payloadOf(result)?.system_identifier;
 return typeof value==='string'&&digits.test(value)?value:typeof value==='number'&&Number.isSafeInteger(value)?String(value):null;
}
/** The project label the database holds (person_private.target_identity, written once
 * by an operator with an explicit value), or null when the database was never
 * labelled. Never inferred from the environment. */
export function identityRef(result){
 const value=payloadOf(result)?.project_ref;
 return value===LOCAL_TARGET||(typeof value==='string'&&REF.test(value))?value:null;
}
/** A cluster identifier alone cannot tell a physical clone from its source: a copy
 * restored from a backup keeps pg_control_system's identifier (production and the
 * test copy both report 7550817586112808987). The identity a process records and
 * compares is the label and the identifier together. */
export const identityKey=(identity)=>`${identity.project_ref}:${identity.system_identifier}`;
function checkPayload(result,code){
 const system_identifier=identityValue(result);
 if(!system_identifier)throw fail(code);
 const project_ref=identityRef(result);
 if(!project_ref)throw fail('identity_unlabelled');
 return {system_identifier,project_ref};
}
/** Prove the clients reach the selected project's database. `readRest` and
 * `readDatabase` return person_target_identity() payloads; `ref` is the selected
 * target (`local` for loopback fixtures). Every payload must carry the cluster
 * identifier and the database-held label, the payloads must agree on both, and the
 * label must equal `ref`. An unlabelled database is refused (`identity_unlabelled`);
 * a label naming another project is refused (`identity_label_mismatch`); nothing
 * here relabels anything. */
export async function verifyRuntimeIdentity({readRest,readDatabase,ref}){
 if(ref!==LOCAL_TARGET&&!(typeof ref==='string'&&REF.test(ref)))throw fail('identity_target');
 let rest=null,database=null;
 if(readRest)rest=checkPayload(await readRest().catch(()=>null),'identity_rest');
 if(readDatabase)database=checkPayload(await readDatabase().catch(()=>null),'identity_database');
 if(!rest&&!database)throw fail('identity_target');
 if(rest&&database){
  if(rest.system_identifier!==database.system_identifier)throw fail('identity_mismatch');
  if(rest.project_ref!==database.project_ref)throw fail('identity_label_mismatch');
 }
 const identity=rest??database;
 if(identity.project_ref!==ref)throw fail('identity_label_mismatch');
 return {...identity,key:identityKey(identity)};
}
/** The same proof for one PostgreSQL client or pool (anything with `query`). */
export const verifyDatabaseIdentity=(db,ref)=>verifyRuntimeIdentity({readDatabase:async()=>(await db.query(IDENTITY_SQL)).rows[0]?.identity,ref});
