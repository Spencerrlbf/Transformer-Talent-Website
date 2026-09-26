// Timed website PostgreSQL access for anchor preparation. The timeout is set
// before each SQL statement starts; a function-level SET cannot arm its caller.
import pg from 'pg';
const methods={person_backfill_metrics:[],person_audit_anchor_page:['p_after','p_limit'],person_audit_anchor_inputs:['p_ids'],person_audit_anchor_commit:['p_items']};
export function anchorDatabaseConfig(env=process.env){
 const url=env.LOCAL_DATABASE_URL??env.PERSON_DATABASE_URL;
 if(!url)throw Error('audit_database_url_required');
 const parsed=new URL(url);
 if(!['postgres:','postgresql:'].includes(parsed.protocol)||(env.LOCAL_DATABASE_URL&&!['localhost','127.0.0.1'].includes(parsed.hostname)))throw Error('audit_database_url');
 // pg applies URL query options after explicit client configuration. Only TLS
 // mode is accepted, so host/options/timeout overrides cannot bypass checks.
 if(parsed.hash||[...parsed.searchParams.keys()].some(k=>k!=='sslmode')||parsed.searchParams.getAll('sslmode').length>1)throw Error('audit_database_url');
 return {connectionString:url,max:2,statement_timeout:15000,connectionTimeoutMillis:10000,idleTimeoutMillis:10000,allowExitOnIdle:true,application_name:'tt-person-audit-anchors'};
}
export async function openAnchorDatabase(env=process.env){
 const pool=new pg.Pool(anchorDatabaseConfig(env));
 pool.on('error',()=>{}); // Caller logs only sanitized operation failures.
 try{await pool.query('select 1');}catch(e){await pool.end();throw e;}
 return {
  async rpc(fn,args){
   const keys=Object.hasOwn(methods,fn)?methods[fn]:null;if(!keys||Object.keys(args).length!==keys.length||keys.some(k=>!Object.hasOwn(args,k)))throw Error('audit_database_method');
   const sql=`select public.${fn}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) result`;
   const values=keys.map(k=>args[k]!==null&&typeof args[k]==='object'?JSON.stringify(args[k]):args[k]);
   return (await pool.query(sql,values)).rows[0].result;
  },
  end:()=>pool.end(),
 };
}
