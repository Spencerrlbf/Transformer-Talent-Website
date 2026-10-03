// Phase-3 access to the upgraded fixture database without re-running the shared
// application fixture's own suite (it executes its tests at import time).
import pg from 'pg';
const url=process.env.LOCAL_DATABASE_URL;
if(!/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_[a-z_]+_test$/.test(url||''))throw Error('local fixture required');
export const pool=new pg.Pool({connectionString:url,max:4});
const auditLib=await import('../dist/worker-lib.mjs'),{planAudit}=await import('../person-audit/postcutover.mjs');
export async function plan(id){const c=await pool.connect();try{await c.query('begin read only');await c.query("set local statement_timeout='15s'");const s=(await c.query('select person_postcutover_audit_inputs_with_witness($1) r',[JSON.stringify([id])])).rows[0].r[0];return planAudit(s,auditLib,{complete:true,rows:new Map()});}finally{await c.query('rollback');c.release();}}
