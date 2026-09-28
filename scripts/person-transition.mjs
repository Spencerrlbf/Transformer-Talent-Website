#!/usr/bin/env node
// Cutover runbook: the transition controller and operator maintenance windows.
// Direct website session only (PERSON_PUBLISH_DATABASE_URL, port 5432).
//
//   node scripts/person-transition.mjs --status
//   node scripts/person-transition.mjs --arm|--drain|--seal|--reopen|--disarm --expect-phase=P --reason=code
//   node scripts/person-transition.mjs --wait-drained [--max-seconds=600]
//   node scripts/person-transition.mjs --open-window=catchup|anchors|publish --run=RUN --minutes=N --expect-phase=P --reason=code
//   node scripts/person-transition.mjs --close-window=WORK_ID --reason=code
//
// Every change and window names the phase the operator expects (--expect-phase);
// a different phase is refused. Output is status JSON only.
import {pathToFileURL} from 'node:url';
import {openDatabase,parseOptions,safeReason,log} from './person-publish/lib.mjs';

export const SPEC={
 status:{type:'flag',default:false},
 arm:{type:'flag',default:false},drain:{type:'flag',default:false},seal:{type:'flag',default:false},
 reopen:{type:'flag',default:false},disarm:{type:'flag',default:false},
 'wait-drained':{type:'flag',name:'waitDrained',default:false},
 'max-seconds':{type:'int',name:'maxSeconds',min:1,max:3600,default:600},
 'open-window':{type:'enum',name:'openWindow',values:['catchup','anchors','publish'],default:null},
 run:{type:'run',default:null},
 minutes:{type:'int',min:1,max:720,default:null},
 'close-window':{type:'uuid',name:'closeWindow',default:null},
 reason:{type:'text',max:80,default:null},
 'expect-phase':{type:'enum',name:'expectPhase',values:['disabled','open','draining','held'],default:null},
};
const ACTIONS=['arm','drain','seal','reopen','disarm'];
/** Controller and window refusals are the operator's signal; other errors stay sanitized. */
export const reasonOf=(error)=>/^(transition|maintenance)_[a-z_]+(:[a-z_]+)?$/.test(error?.message??'')?error.message:safeReason(error);
const phaseOf=(s)=>s.enabled?s.phase:'disabled';
/** The operator states the phase they believe the controller is in; anything else is refused. */
async function expectPhase(pool,expected){
 const s=(await pool.query('select public.person_transition_status() s')).rows[0].s;
 if(phaseOf(s)!==expected)throw Error(`transition_expected:${phaseOf(s)}`);
 return s;
}
const REASON=/^[a-z0-9_]{1,80}$/;

/** Controller state, open maintenance windows and unresolved TT work by family. */
export async function transitionStatus(pool){
 const status=(await pool.query('select public.person_transition_status() s')).rows[0].s;
 const windows=(await pool.query(`select w.id work_id,e.step,e.run_id,w.status,w.lease_until,(w.lease_until<=clock_timestamp()) expired
  from person_private.transition_work w join person_private.maintenance_events e on e.work_id=w.id and e.action='open'
  where w.family='maintenance' and w.status<>'completed' order by w.created_at`)).rows;
 const unresolved=(await pool.query(`select family,status,(lease_until<=clock_timestamp()) expired,count(*)::int n from person_private.transition_work
  where scope='tt_person' and status<>'completed' group by 1,2,3 order by 1,2,3`)).rows;
 return {...status,windows,unresolved};
}
export async function setTransition(pool,action,reason,expected){
 if(!ACTIONS.includes(action)||!REASON.test(reason??''))throw Error('transition_input');
 const s=await expectPhase(pool,expected);
 return (await pool.query('select person_private.transition_set($1,$2,$3,$4) r',[action,s.revision,s.generation,reason])).rows[0].r;
}
export async function openWindow(pool,step,run,minutes,reason,expected){
 if(!REASON.test(reason??''))throw Error('transition_input');
 const s=await expectPhase(pool,expected);
 return (await pool.query('select person_private.maintenance_open($1,$2,$3,$4,$5,$6) r',[step,run,minutes,s.revision,s.generation,reason])).rows[0].r;
}
export async function closeWindow(pool,workId,reason){
 if(!REASON.test(reason??''))throw Error('transition_input');
 return (await pool.query('select person_private.maintenance_close($1,$2) r',[workId,reason])).rows[0].r;
}
/** While draining, wait for live admitted TT work to finish. Parked (deferred)
 * work is resolved, as for seal. Expired or uncertain work never finishes by
 * waiting: it is reported as stuck at once (retire expired pre-effects work by
 * re-claiming it; review uncertain work). */
export async function waitDrained(pool,{maxSeconds,sleep=(ms)=>new Promise(r=>setTimeout(r,ms)),now=Date.now}){
 const started=now();
 for(;;){
  const s=await transitionStatus(pool);
  if(phaseOf(s)!=='draining')throw Error(`transition_expected:${phaseOf(s)}`);
  const work=s.unresolved.filter(u=>u.family!=='maintenance'&&u.status!=='deferred');
  const stuck=work.filter(u=>u.status==='uncertain'||u.expired);
  const live=work.filter(u=>u.status==='active'&&!u.expired).reduce((n,u)=>n+u.n,0);
  if(stuck.length)return {...s,drained:false,stuck};
  if(!live)return {...s,drained:true};
  if((now()-started)/1000>=maxSeconds)return {...s,drained:false,live};
  await sleep(5000);
 }
}

export async function main(argv=process.argv.slice(2),{env=process.env,out=log}={}){
 const o=parseOptions(argv,SPEC);
 const chosen=[o.status,...ACTIONS.map(a=>o[a]),o.waitDrained,Boolean(o.openWindow),Boolean(o.closeWindow)].filter(Boolean).length;
 if(chosen!==1)throw Error('transition_option:one_action');
 const changes=ACTIONS.some(a=>o[a])||Boolean(o.openWindow);
 if((changes||o.closeWindow)&&!REASON.test(o.reason??''))throw Error('transition_option_required:reason');
 if(changes&&!o.expectPhase)throw Error('transition_option_required:expect_phase');
 if(o.openWindow&&(!o.run||!o.minutes))throw Error('transition_option_required:run_and_minutes');
 // Options that do not belong to the chosen action are refused, not ignored.
 if(!o.openWindow&&(o.run||o.minutes))throw Error('transition_option:unused_run_or_minutes');
 if(!changes&&o.expectPhase)throw Error('transition_option:unused_expect_phase');
 if(!(changes||o.closeWindow)&&o.reason)throw Error('transition_option:unused_reason');
 if(!o.waitDrained&&argv.some(a=>a.startsWith('--max-seconds=')))throw Error('transition_option:unused_max_seconds');
 const pool=await openDatabase(env,'tt-person-transition');
 try{
  let result;
  if(o.status)result={action:'transition_status',...await transitionStatus(pool)};
  else if(o.waitDrained)result={action:'transition_wait',...await waitDrained(pool,{maxSeconds:o.maxSeconds})};
  else if(o.openWindow)result={action:'maintenance_open',...await openWindow(pool,o.openWindow,o.run,o.minutes,o.reason,o.expectPhase)};
  else if(o.closeWindow)result={action:'maintenance_close',...await closeWindow(pool,o.closeWindow,o.reason)};
  else{const action=ACTIONS.find(a=>o[a]);result={action:`transition_${action}`,...await setTransition(pool,action,o.reason,o.expectPhase)};}
  out(result);
  if(result.drained===false)process.exitCode=2;
  return result;
 }finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(error=>{console.error(JSON.stringify({phase:'transition_stopped',reason:reasonOf(error)}));process.exitCode=1;});
