#!/usr/bin/env node
// Run locally after the source scan completes. No database password in logs;
// the existing linked website CLI connection supplies authorization.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const args=new Map(process.argv.slice(2).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];}));
const run=args.get('--run-id'),workdir=args.get('--workdir');
if(!/^[a-zA-Z0-9_-]{1,100}$/.test(run??'')||!workdir)throw Error('Explicit --run-id and --workdir are required');
const directory=path.resolve(workdir);
const project=fs.readFileSync(path.join(directory,'supabase/.temp/project-ref'),'utf8').trim();
if(project!=='kmuihequfurvjxpnugxf')throw Error('Linked project is not the website database');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'person-finalize-'));
try{
 const file=path.join(tmp,'finish.sql');
 fs.writeFileSync(file,`begin;
set local statement_timeout='8s';
set local lock_timeout='2s';
do $guard$ begin
 if not exists(select 1 from public.backfill_runs where run_id='${run}' and status='paused' and notes->>'kind'='reconcile' and notes->>'source_scan_complete'='true') then raise exception 'Source scan is not ready for finalization';end if;
end $guard$;
select public.person_reconcile_finish('${run}',(select (notes->>'external_stable')::boolean from public.backfill_runs where run_id='${run}'));
commit;`,{mode:0o600});
 const output=execFileSync(process.env.SUPABASE_CLI??'supabase',['db','query','--linked','--workdir',directory,'-f',file],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
 process.stdout.write(output);
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
