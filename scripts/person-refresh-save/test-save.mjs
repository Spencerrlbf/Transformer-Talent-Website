import test from 'node:test';import assert from 'node:assert/strict';import{randomUUID}from'node:crypto';import pg from'pg';
import*as lib from'../dist/worker-lib.mjs';import{prepareAuditFixture}from'../person-audit/local-fixture.mjs';
const url=process.env.LOCAL_DATABASE_URL;if(!/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/person_refresh_save_test$/.test(url??''))throw Error('local_fixture_required');
const pool=new pg.Pool({connectionString:url,max:8,options:"-c statement_timeout=15000"});const org=lib.TT_ORG_ID;
const phase=(enabled=true)=>pool.query("update person_private.transition_control set enabled=$1,phase='open' where singleton",[enabled]);
const row=async id=>(await pool.query('select to_jsonb(c) r from candidates c where id=$1',[id])).rows[0].r;
async function use(fn){const c=await pool.connect();try{return await fn(c)}finally{await c.query('rollback');c.release()}}
async function fixture(mode='shadow', options={}){
 await phase(false);const candidate=randomUUID(),queue=randomUUID(),username='refresh-save-'+candidate,ledger=randomUUID();
 await pool.query("insert into candidates(id,full_name,linkedin_username,current_title,created_at) values($1,'Synthetic Refresh Save',$2,'Original Engineer','2020-01-01')",[candidate,username]);
 if(options.before)await pool.query('update candidates set notes=$2,resume_text=$3 where id=$1',[candidate,'Synthetic retained notes','Synthetic retained resume']);
 await prepareAuditFixture(candidate);
 await pool.query('insert into refresh_queue(id,organization_id,candidate_id) values($1,$2,$3)',[queue,org,candidate]);
 if(options.cache!==false)await pool.query("insert into candidate_enrichments(id,candidate_id,organization_id,linkedin_username,raw_payload,created_at) values($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day')",[ledger,candidate,org,username,{headline:'Refreshed synthetic profile',publicIdentifier:username,experience:[{position:'Refreshed Engineer',companyName:'Synthetic Refresh Co',startDate:{year:2021,month:1},isCurrent:true}]}]);
 const a={organizationId:org,queueId:queue,requestId:randomUUID(),token:randomUUID(),dailyCap:options.cache===false?100:0,allowPaid:options.cache===false,mode,candidate,ledger};const before=await row(candidate);
 await phase();process.env.PERSON_TRANSITION_SUPPORT='on';const take=()=>use(c=>lib.claimCertifiedRefreshOnConnection(c,a));const claim=options.lease?await fault('person_private.transition_work','before insert',`new.lease_until:=clock_timestamp()+interval '${options.lease} milliseconds';return new;`,take):await take();assert.equal(claim.status,'claimed');
 return{...a,before,workId:claim.workId};
}
const save=a=>use(c=>lib.saveCertifiedRefreshOnConnection(c,a));
test.after(async()=>{delete process.env.PERSON_TRANSITION_SUPPORT;await pool.end()});
test('certified shadow refresh normalizes and completes without changing serving fields',async()=>{
 const a=await fixture();const out=await save(a);assert.equal(out.status,'done');assert.equal(out.projected,false);assert.deepEqual(await row(a.candidate),a.before);
 assert.equal((await pool.query('select header from candidate_profile_state where candidate_id=$1',[a.candidate])).rows[0].header.current_title.value,'Refreshed Engineer');
 assert.equal((await pool.query('select status from person_private.transition_work where id=$1',[a.workId])).rows[0].status,'completed');
 assert.equal((await pool.query('select count(*)::int n from person_derivative_jobs where candidate_id=$1',[a.candidate])).rows[0].n,0);
 assert.deepEqual(await save(a),out);
});
test('certified live refresh atomically projects, dates, enqueues and completes',async()=>{
 const a=await fixture('live');const out=await save(a);assert.equal(out.status,'done');assert.equal(out.projected,true);const current=await row(a.candidate);assert.equal(current.current_title,'Refreshed Engineer');assert.equal(current.id,a.candidate);
 const state=(await pool.query('select s.rev::text,p.revision::text from candidate_profile_state s join person_projection_state p using(candidate_id) where candidate_id=$1',[a.candidate])).rows[0];assert.equal(state.rev,state.revision);assert.equal(out.revision,state.rev);
 assert.equal((await pool.query('select status from refresh_queue where id=$1',[a.queueId])).rows[0].status,'done');assert.equal((await pool.query('select count(*)::int n from person_derivative_jobs where candidate_id=$1',[a.candidate])).rows[0].n,1);
 assert.deepEqual(await save(a),out);await assert.rejects(save({...a,mode:'shadow'}),/refresh_save_binding/);
});
test('save requires the original request token and retained source ownership',async()=>{
 const a=await fixture();await assert.rejects(save({...a,token:randomUUID()}),/refresh_binding/);assert.deepEqual(await row(a.candidate),a.before);
});
test('failure after normalization leaves facts and queue unchanged while retaining the cache',async()=>{
 const a=await fixture('live');const prior=(await pool.query('select rev::text from candidate_profile_state where candidate_id=$1',[a.candidate])).rows[0];
 const c=await pool.connect(),query=c.query.bind(c);c.query=async(sql,args)=>{if(typeof sql==='string'&&sql.includes('refresh_save_project'))throw Error('synthetic_projection_failure');return query(sql,args)};
 try{await assert.rejects(lib.saveCertifiedRefreshOnConnection(c,a),/synthetic_projection_failure/)}finally{await query('rollback');c.query=query;c.release()}
 assert.deepEqual(await row(a.candidate),a.before);assert.deepEqual((await pool.query('select rev::text from candidate_profile_state where candidate_id=$1',[a.candidate])).rows[0],prior);
 assert.equal((await pool.query('select phase,ledger_snapshot from person_refresh_attempts where queue_id=$1',[a.queueId])).rows[0].phase,'claimed');assert.equal((await save(a)).status,'done');
});

async function intercept(a,needle,fn){
 const c=await pool.connect(),query=c.query.bind(c);let used=false;
 c.query=async(sql,args)=>{if(!used&&typeof sql==='string'&&sql.includes(needle)){used=true;return fn(query,sql,args)}return query(sql,args)};
 try{return await lib.saveCertifiedRefreshOnConnection(c,a)}finally{await query('rollback');c.query=query;c.release()}
}
async function fault(table,event,body,fn){
 await pool.query(`create function public.refresh_save_test_fault() returns trigger language plpgsql as $fault$ begin ${body} end $fault$;create trigger zz_refresh_save_test_fault ${event} on ${table} for each row execute function public.refresh_save_test_fault()`);
 try{return await fn()}finally{await pool.query(`drop trigger zz_refresh_save_test_fault on ${table};drop function public.refresh_save_test_fault()`)}
}
async function unchanged(a){
 assert.deepEqual(await row(a.candidate),a.before);
 assert.equal((await pool.query('select count(*)::int n from person_private.refresh_saves where id=$1',[a.requestId])).rows[0].n,0);
 assert.equal((await pool.query('select phase from person_refresh_attempts where queue_id=$1',[a.queueId])).rows[0].phase,'claimed');
 assert.equal((await pool.query('select count(*)::int n from candidate_enrichments where id=$1',[a.ledger])).rows[0].n,1);
}
for(const needle of ['refresh_save_seal','refresh_save_audit_begin','refresh_save_normalize','refresh_save_project','refresh_save_metadata','refresh_save_enqueue','refresh_save_complete','commit'])test('failure at '+needle+' rolls back all profile and completion writes',async()=>{
 const a=await fixture('live');await assert.rejects(intercept(a,needle,()=>{throw Error('synthetic_failure')}),/synthetic_failure/);await unchanged(a);assert.equal((await save(a)).status,'done');
});
for(const [table,event,body] of [
 ['person_private.refresh_saves','before insert','return null;'],
 ['person_private.refresh_saves','before update',"new.candidate_id:=gen_random_uuid();return new;"],
 ['public.person_audit_operations','before insert',"new.evidence:='{}';return new;"],
 ['person_private.refresh_audit_operations','before insert','return null;'],
 ['person_private.refresh_normalization_frames','before insert','return null;'],
 ['person_private.refresh_normalization_frames','before delete','return null;'],
 ['person_private.refresh_projection_frames','before insert','return null;'],
 ['person_private.refresh_projection_frames','before delete','return null;'],
 ['person_private.refresh_metadata_frames','before insert','return null;'],
 ['person_private.refresh_metadata_frames','before delete','return null;'],
 ['public.person_projection_history','before insert','return null;'],
 ['public.person_projection_state','before insert','return null;'],
 ['public.person_change_attributions','before insert','return null;'],
 ['public.person_derivative_jobs','before insert','return null;'],
 ['public.refresh_queue','before update',"if new.status='done' then return null;end if;return new;"],
 ['public.person_refresh_attempts','before update',"if new.phase='done' then return null;end if;return new;"]
])test('suppressed or altered write fails atomically: '+table+' '+event,async()=>{
 const a=await fixture('live');await fault(table,event,body,()=>assert.rejects(save(a)));await unchanged(a);assert.equal((await save(a)).status,'done');
});
test('partial begin, audit and normalization cannot commit',async()=>{
 for(const stop of ['refresh_save_seal','refresh_save_normalize','refresh_save_project']){
 const a=await fixture('live');await assert.rejects(intercept(a,stop,async query=>{await query('commit');throw Error('partial_commit_accepted')}),/refresh_save_incomplete/);await unchanged(a);}
});
test('committed save response loss is recovered as done and never reopens the queue',async()=>{
 const a=await fixture('live');await assert.rejects(intercept(a,'commit',async(query,sql,args)=>{await query(sql,args);throw Error('response_lost')}),/response_lost/);
 const out=await save(a);assert.equal(out.status,'done');assert.deepEqual(await use(c=>lib.failCertifiedRefreshOnConnection(c,a)),out);assert.equal((await pool.query('select status from refresh_queue where id=$1',[a.queueId])).rows[0].status,'done');
});
test('replay keeps the historical result after a later certified refresh',async()=>{
 const a=await fixture('live'),first=await save(a),q=randomUUID();
 await pool.query('insert into refresh_queue(id,organization_id,candidate_id) values($1,$2,$3)',[q,org,a.candidate]);
 const b={...a,queueId:q,requestId:randomUUID(),token:randomUUID()};assert.equal((await use(c=>lib.claimCertifiedRefreshOnConnection(c,b))).status,'claimed');const second=await save(b);assert.equal(second.changed,false);assert.equal(second.projected,false);
 assert.deepEqual(await save(a),first);assert.deepEqual(await save(b),second);
 assert.match((await pool.query('select status from refresh_queue where id=$1',[a.queueId])).rows[0].status,/^archived_/);
});
test('metadata keeps unrelated fields and original enrichment date',async()=>{
 const a=await fixture('live',{before:true});await save(a);const current=await row(a.candidate);
 assert.equal(current.notes,a.before.notes);assert.equal(current.resume_text,a.before.resume_text);
 const source=(await pool.query('select source_snapshot from person_private.refresh_lifecycles where request_id=$1',[a.requestId])).rows[0].source_snapshot;
 assert.equal(Date.parse(current.linkedin_enrichment_date),Date.parse(source.created_at));
});
test('missing anchor and a source hold prevent any save',async()=>{
 for(const kind of ['anchor','hold']){
 const a=await fixture('live');
 if(kind==='anchor')await pool.query('delete from person_private.certified_audit_anchors where candidate_id=$1',[a.candidate]);
 else await use(async c=>{await c.query('begin');await c.query('alter table person_source_holds disable trigger user');await c.query("insert into person_source_holds(candidate_id,ledger_id,evidence_hash,reason,evidence) values($1,gen_random_uuid(),'synthetic','harvest_cache_date_unknown','{}')",[a.candidate]);await c.query('alter table person_source_holds enable trigger user');await c.query('commit')});
 await assert.rejects(save(a),/audit_anchor_uncertified|refresh_candidate_changed/);await unchanged(a);
 }
});
test('private functions and tables are inaccessible to browser and service roles',async()=>{
 assert.equal((await pool.query("select bool_or(has_function_privilege(r.rolname,p.oid,'EXECUTE')) allowed from pg_roles r cross join pg_proc p where r.rolname in ('anon','authenticated','service_role') and p.pronamespace='person_private'::regnamespace and p.proname like 'refresh_%'")).rows[0].allowed,false);
 assert.equal((await pool.query("select bool_or(has_table_privilege(r.rolname,c.oid,'INSERT,UPDATE,DELETE,SELECT')) allowed from pg_roles r cross join pg_class c where r.rolname in ('anon','authenticated','service_role') and c.relnamespace='person_private'::regnamespace and c.relname like 'refresh_%' and c.relkind='r'")).rows[0].allowed,false);
});
for(const support of ['off','bad'])test('save validates '+support+' before database access',async()=>{
 process.env.PERSON_TRANSITION_SUPPORT=support;await assert.rejects(lib.saveCertifiedRefreshOnConnection({query:()=>assert.fail('query executed')},{organizationId:org,queueId:randomUUID(),requestId:randomUUID(),token:randomUUID(),mode:'live'}),/refresh_save_disabled|transition_configuration/);process.env.PERSON_TRANSITION_SUPPORT='on';
});
test('completed refresh is reconstructable by the existing offline auditor',async()=>{
 const a=await fixture('live');await save(a);
 const {planAudit}=await import('../person-audit/postcutover.mjs');
 const s=(await pool.query('select person_postcutover_audit_inputs_with_witness($1::jsonb) r',[JSON.stringify([a.candidate])])).rows[0].r[0];
 const out=planAudit(s,lib);assert.equal(out.status,'verified',JSON.stringify(out));
});
for(const [name,sql] of [
 ['candidate',"alter table candidates disable trigger user;update candidates set notes='corrupt' where id=$1;alter table candidates enable trigger user;"],
 ['projection',"alter table person_projection_state disable trigger user;delete from person_projection_state where candidate_id=$1;alter table person_projection_state enable trigger user;"],
 ['history',"alter table person_projection_history disable trigger user;delete from person_projection_history where candidate_id=$1;alter table person_projection_history enable trigger user;"],
 ['derivative',"alter table person_derivative_jobs disable trigger user;delete from person_derivative_jobs where candidate_id=$1;alter table person_derivative_jobs enable trigger user;"],
 ['audit_boundary',"update person_private.refresh_audit_operations set captured_version=captured_version+1 where candidate_id=$1;"],
 ['attribution',"alter table person_change_attributions disable trigger user;delete from person_change_attributions where candidate_id=$1;alter table person_change_attributions enable trigger user;"]
])for(const needle of ['refresh_save_complete','commit'])test('late '+name+' corruption before '+needle+' rolls the transaction back',async()=>{
 const a=await fixture('live');await assert.rejects(intercept(a,needle,async(query,original,args)=>{for(const statement of sql.split(';').filter(Boolean))await query(statement,statement.includes('$1')?[a.candidate]:[]);return query(original,args)}));await unchanged(a);
});

test('shadow facts published by a new live request report a real change',async()=>{
 const a=await fixture('shadow');await save(a);const q=randomUUID();await pool.query('insert into refresh_queue(id,organization_id,candidate_id) values($1,$2,$3)',[q,org,a.candidate]);const b={...a,queueId:q,requestId:randomUUID(),token:randomUUID(),mode:'live'};await use(c=>lib.claimCertifiedRefreshOnConnection(c,b));const out=await save(b);assert.equal(out.projected,true);assert.equal(out.changed,true);
});

test('final completion writes crossing the normal save lease roll back',async()=>{
 const a=await fixture('live',{lease:600});await fault('person_private.transition_work','before update',"if new.status='completed' then perform pg_sleep(0.7);end if;return new;",()=>assert.rejects(save(a),/refresh_save_incomplete|refresh_expired|refresh_work_proof/));await unchanged(a);
});
test('actual candidate row wait rechecks lease before normalizing',async()=>{
 const a=await fixture('live',{lease:300});const b=await pool.connect();await b.query('begin');await b.query('select 1 from candidates where id=$1 for update',[a.candidate]);
 try{const pending=save(a);pending.catch(()=>{});await new Promise(r=>setTimeout(r,400));await b.query('commit');await assert.rejects(pending,/refresh_expired/);}finally{await b.query('rollback');b.release()}await unchanged(a);
});
test('reconciler bookkeeping does not invalidate historical refresh replay',async()=>{
 const a=await fixture('live');const out=await save(a);await use(async c=>{await c.query('begin');await c.query('alter table person_change_events disable trigger user');await c.query('update person_change_events set reconciled_at=clock_timestamp() where candidate_id=$1',[a.candidate]);await c.query('alter table person_change_events enable trigger user');await c.query('commit')});assert.deepEqual(await save(a),out);
});

for(const [table,column,expression] of [['candidate_profile_state','header',"'{}'::jsonb"],['candidate_sources','payload_hash',"'corrupt'"]])for(const needle of ['refresh_save_complete','commit'])test('late normalized '+table+' corruption before '+needle+' is rejected',async()=>{
 const a=await fixture('shadow');await assert.rejects(intercept(a,needle,async(query,original,args)=>{await query('alter table '+table+' disable trigger user');await query('update '+table+' set '+column+'='+expression+' where candidate_id=$1',[a.candidate]);await query('alter table '+table+' enable trigger user');return query(original,args)}));await unchanged(a);
});
for(const table of ['refresh_normalization_frames','refresh_projection_frames','refresh_metadata_frames'])test('stranded '+table+' cannot commit',async()=>{
 const a=await fixture('live');await assert.rejects(intercept(a,'commit',async(query,original,args)=>{
 if(table==='refresh_normalization_frames')await query('insert into person_private.refresh_normalization_frames select pg_backend_pid(),pg_current_xact_id(),id,work_id,candidate_id,document from person_private.refresh_saves where id=$1',[a.requestId]);
 else if(table==='refresh_projection_frames')await query('insert into person_private.refresh_projection_frames select pg_backend_pid(),pg_current_xact_id(),work_id,candidate_id,audit_id,candidate_before,candidate_after,id from person_private.refresh_saves where id=$1',[a.requestId]);
 else await query('insert into person_private.refresh_metadata_frames(backend_pid,transaction_id,execution_id,before_row,after_row) select pg_backend_pid(),pg_current_xact_id(),id,candidate_before,candidate_after from person_private.refresh_saves where id=$1',[a.requestId]);
 return query(original,args)}));await unchanged(a);
});
test('extra private audit map cannot certify an unrelated public operation',async()=>{
 const a=await fixture('live');await save(a);const other=await fixture('live');await save(other);
 await pool.query('insert into person_private.refresh_audit_operations select b.audit_id,a.id,a.work_id,a.candidate_id,a.transaction_id,(a.audit_operation->\'evidence\'->\'guard\'->>\'captured_version\')::bigint,null,person_private.directory_operation_hash(o) from person_private.refresh_saves a join person_private.refresh_saves b on b.id=$2 join person_audit_operations o on o.id=b.audit_id where a.id=$1 on conflict(operation_id) do update set execution_id=excluded.execution_id',[a.requestId,other.requestId]);
 assert.equal((await pool.query('select count(*)::int n from person_private.certified_audit_operations where operation_id=(select audit_id from person_private.refresh_saves where id=$1)',[other.requestId])).rows[0].n,0);
});

for(const table of ['application_projection_frames','directory_projection_frames','refresh_projection_frames','normalization_frames','refresh_normalization_frames'])test('no-op metadata rejects a nested '+table,async()=>{
 const a=await fixture('live');await save(a);const q=randomUUID();await pool.query('insert into refresh_queue(id,organization_id,candidate_id) values($1,$2,$3)',[q,org,a.candidate]);const b={...a,queueId:q,requestId:randomUUID(),token:randomUUID(),before:await row(a.candidate)};await use(c=>lib.claimCertifiedRefreshOnConnection(c,b));
 await assert.rejects(intercept(b,'refresh_save_metadata',async(query,original,args)=>{
 const current=(await query('select to_jsonb(c) r from candidates c where id=$1',[b.candidate])).rows[0].r;
 const source=(await query('select source_snapshot from person_private.refresh_lifecycles where request_id=$1',[b.requestId])).rows[0].source_snapshot;
 assert.equal(Date.parse(current.linkedin_enrichment_date),Date.parse(source.created_at));assert.equal(Number(current.calculated_experience_years),args[1]);
 await query('alter table person_private.'+table+' disable trigger all');
 if(table==='normalization_frames')await query('insert into person_private.normalization_frames select pg_backend_pid(),pg_current_xact_id(),work_id,gen_random_uuid(),candidate_id,document from person_private.refresh_saves where id=$1',[b.requestId]);
 else if(table==='refresh_normalization_frames')await query('insert into person_private.refresh_normalization_frames select pg_backend_pid(),pg_current_xact_id(),id,work_id,candidate_id,document from person_private.refresh_saves where id=$1',[b.requestId]);
 else if(table==='application_projection_frames')await query('insert into person_private.application_projection_frames select pg_backend_pid(),pg_current_xact_id(),work_id,candidate_id,audit_id,candidate_before,candidate_after from person_private.refresh_saves where id=$1',[b.requestId]);
 else {await query('alter table person_private.'+table+' disable trigger all');await query('insert into person_private.'+table+' select pg_backend_pid(),pg_current_xact_id(),work_id,candidate_id,audit_id,candidate_before,candidate_after,id from person_private.refresh_saves where id=$1',[b.requestId]);await query('alter table person_private.'+table+' enable trigger all');}
 await query('alter table person_private.'+table+' enable trigger all');
 return query(original,args)}),/refresh_metadata_nested/);await unchanged(b);
});

test('paid source survives atomic failure and a new free request completes it without repurchase',async()=>{
 const a=await fixture('live',{cache:false});assert.equal((await use(c=>lib.startCertifiedRefreshProviderOnConnection(c,a))).status,'start');
 const payload={headline:'Synthetic retained paid facts',experience:[]};assert.equal((await use(c=>lib.storeCertifiedRefreshPayloadOnConnection(c,{...a,raw:payload}))).status,'stored');
 const original=(await pool.query('select source_snapshot from person_private.refresh_lifecycles where request_id=$1',[a.requestId])).rows[0].source_snapshot;
 await assert.rejects(intercept(a,'refresh_save_complete',()=>{throw Error('synthetic_paid_save_failure')}),/synthetic_paid_save_failure/);
 assert.equal((await use(c=>lib.failCertifiedRefreshOnConnection(c,a))).status,'retry');const b={...a,requestId:randomUUID(),token:randomUUID(),dailyCap:0,allowPaid:false};const claim=await use(c=>lib.claimCertifiedRefreshOnConnection(c,b));assert.equal(claim.needsHarvest,false);assert.equal((await save(b)).status,'done');
 assert.equal((await pool.query('select count(*)::int n from candidate_enrichments where candidate_id=$1',[a.candidate])).rows[0].n,1);assert.deepEqual((await pool.query('select source_snapshot from person_private.refresh_lifecycles where request_id=$1',[b.requestId])).rows[0].source_snapshot,original);
});
test('actual derivative row wait crossing the lease rolls back publication',async()=>{
 const a=await fixture('live');await save(a);const q=randomUUID();await pool.query('insert into refresh_queue(id,organization_id,candidate_id) values($1,$2,$3)',[q,org,a.candidate]);const b={...a,queueId:q,requestId:randomUUID(),token:randomUUID(),before:await row(a.candidate)};
 await fault('person_private.transition_work','before insert',"new.lease_until:=clock_timestamp()+interval '700 milliseconds';return new;",()=>use(c=>lib.claimCertifiedRefreshOnConnection(c,b)));
 const blocker=await pool.connect();await blocker.query('begin');await blocker.query('select 1 from person_derivative_jobs where candidate_id=$1 for update',[b.candidate]);let pending;
 try{pending=save(b);pending.catch(()=>{});let blocked=false;for(let i=0;i<60;i++){blocked=(await pool.query("select exists(select 1 from pg_stat_activity where datname='person_refresh_save_test' and wait_event_type='Lock' and query like '%refresh_save_enqueue%') b")).rows[0].b;if(blocked)break;await new Promise(r=>setTimeout(r,10));}assert.equal(blocked,true);await new Promise(r=>setTimeout(r,750));await blocker.query('commit');await assert.rejects(pending,/refresh_expired|refresh_save_incomplete/);}finally{await blocker.query('rollback');blocker.release();if(pending)await pending.catch(()=>{})}await unchanged(b);
});
