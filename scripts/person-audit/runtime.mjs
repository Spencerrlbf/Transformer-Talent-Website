import {capacityGate} from '../person-publish/lib.mjs';
export async function timed(pool,seconds,sql,values=[]){
 const c=await pool.connect();
 try{await c.query('begin isolation level read committed');await c.query(`set local statement_timeout='${seconds}s'`);const r=await c.query(sql,values);await c.query('commit');return r;}
 catch(e){await c.query('rollback').catch(()=>{});throw e;}finally{c.release();}
}
export function auditCapacity(pool,options){
 const gate=capacityGate({query:async()=>{
  const r=await pool.query('select public.person_backfill_metrics() result');const m=r.rows[0]?.result;
  for(const k of ['database_bytes','blocked_sessions'])if(!['number','string'].includes(typeof m?.[k])||String(m[k]).trim()===''||!Number.isSafeInteger(Number(m[k]))||Number(m[k])<0)throw Error('audit_capacity');
  return r;
 }},options);
 return async()=>{try{return await gate();}catch(e){if(['publish_capacity','publish_latency'].includes(e.message))throw Error(e.message.replace('publish_','audit_'));throw e;}};
}
// Run identity is serialized across whole CLI invocations on one backend. Never
// hold a transaction open across external reads. 72014 is audit-only.
export async function withAuditRunLock(pool,runId,fn){
 const c=await pool.connect();let locked=false,broken;
 try{locked=(await c.query('select pg_try_advisory_lock(72014,hashtext($1)) locked',[runId])).rows[0].locked;if(!locked)throw Error('audit_run_active');
  return await fn({query:(...args)=>c.query(...args),connect:async()=>({query:(...args)=>c.query(...args),release(){}})});
 }finally{
  if(locked)try{const r=await c.query('select pg_advisory_unlock(72014,hashtext($1)) released',[runId]);if(!r.rows[0]?.released)throw Error('audit_session_lock_lost');}catch(e){broken=e;}
  c.release(broken);if(broken)throw Error('audit_session_lock_lost');
 }
}
