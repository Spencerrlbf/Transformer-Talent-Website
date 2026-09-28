#!/usr/bin/env node
// Cutover runbook: the transition controller and operator maintenance windows.
// Direct website session only (PERSON_PUBLISH_DATABASE_URL, port 5432).
//
//   node scripts/person-transition.mjs --status
//   node scripts/person-transition.mjs --arm|--drain|--seal|--reopen|--disarm --reason=code
//   node scripts/person-transition.mjs --wait-drained [--max-seconds=600]
//   node scripts/person-transition.mjs --open-window=catchup|anchors|publish --run=RUN --minutes=N --reason=code
//   node scripts/person-transition.mjs --close-window=WORK_ID --reason=code
//
// Every change reads the current revision and generation first, so a stale
// operator view is refused (transition_stale). Output is status JSON only.
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
};
const ACTIONS=['arm','drain','seal','reopen','disarm'];
/** Controller and window refusals are the operator's signal; other errors stay sanitized. */
export const reasonOf=(error)=>/^(transition|maintenance)_[a-z_]+$/.test(error?.message??'')?error.message:safeReason(error);
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
export async function setTransition(pool,action,reason){
 if(!ACTIONS.includes(action)||!REASON.test(reason??''))throw Error('transition_input');
 const s=(await pool.query('select public.person_transition_status() s')).rows[0].s;
 return (await pool.query('select person_private.transition_set($1,$2,$3,$4) r',[action,s.revision,s.generation,reason])).rows[0].r;
}
export async function openWindow(pool,step,run,minutes,reason){
 if(!REASON.test(reason??''))throw Error('transition_input');
 const s=(await pool.query('select public.person_transition_status() s')).rows[0].s;
 return (await pool.query('select person_private.maintenance_open($1,$2,$3,$4,$5,$6) r',[step,run,minutes,s.revision,s.generation,reason])).rows[0].r;
}
export async function closeWindow(pool,workId,reason){
 if(!REASON.test(reason??''))throw Error('transition_input');
 return (await pool.query('select person_private.maintenance_close($1,$2) r',[workId,reason])).rows[0].r;
}
/** Poll until admitted TT work has finished (draining lets owned work complete). */
export async function waitDrained(pool,{maxSeconds,sleep=(ms)=>new Promise(r=>setTimeout(r,ms)),now=Date.now}){
 const started=now();
 for(;;){
  const s=await transitionStatus(pool);
  const open=s.unresolved.filter(u=>u.family!=='maintenance').reduce((n,u)=>n+u.n,0);
  if(!open)return {...s,drained:true};
  if((now()-started)/1000>=maxSeconds)return {...s,drained:false};
  await sleep(5000);
 }
}

export async function main(argv=process.argv.slice(2),{env=process.env,out=log}={}){
 const o=parseOptions(argv,SPEC);
 const chosen=[o.status,...ACTIONS.map(a=>o[a]),o.waitDrained,Boolean(o.openWindow),Boolean(o.closeWindow)].filter(Boolean).length;
 if(chosen!==1)throw Error('transition_option:one_action');
 if((ACTIONS.some(a=>o[a])||o.openWindow||o.closeWindow)&&!REASON.test(o.reason??''))throw Error('transition_option_required:reason');
 if(o.openWindow&&(!o.run||!o.minutes))throw Error('transition_option_required:run_and_minutes');
 const pool=await openDatabase(env,'tt-person-transition');
 try{
  let result;
  if(o.status)result={action:'transition_status',...await transitionStatus(pool)};
  else if(o.waitDrained)result={action:'transition_wait',...await waitDrained(pool,{maxSeconds:o.maxSeconds})};
  else if(o.openWindow)result={action:'maintenance_open',...await openWindow(pool,o.openWindow,o.run,o.minutes,o.reason)};
  else if(o.closeWindow)result={action:'maintenance_close',...await closeWindow(pool,o.closeWindow,o.reason)};
  else{const action=ACTIONS.find(a=>o[a]);result={action:`transition_${action}`,...await setTransition(pool,action,o.reason)};}
  out(result);
  if(result.drained===false)process.exitCode=2;
  return result;
 }finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 main().catch(error=>{console.error(JSON.stringify({phase:'transition_stopped',reason:reasonOf(error)}));process.exitCode=1;});
