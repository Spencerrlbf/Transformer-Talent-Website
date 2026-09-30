import test from 'node:test';import assert from 'node:assert/strict';import{spawnSync}from'node:child_process';
for(const [key,value] of [['REFRESH_DAILY_CAP','5x'],['REFRESH_DAILY_CAP','-1'],['REFRESH_DAILY_CAP','10001'],['REFRESH_DAILY_CAP','1.5'],['CONCURRENCY','0'],['CONCURRENCY','9'],['CONCURRENCY','2x']])test(`actual certified CLI rejects malformed ${key}=${value} before network`,()=>{
 const out=spawnSync(process.execPath,['--import','./scripts/person-directory-input/no-network.mjs','scripts/refresh-worker.mjs'],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,PERSON_TRANSITION_SUPPORT:'on',PERSON_WRITE_MODE:'shadow',SUPABASE_URL:'http://127.0.0.1:9',SUPABASE_SERVICE_ROLE_KEY:'synthetic',HARVEST_API_KEY:'synthetic',PRECOMPUTE_BACKFILL:'',REFRESH_DAILY_CAP:'0',CONCURRENCY:'1',[key]:value}});
 assert.equal(out.status,1);assert.match(out.stderr,/person_refresh_configuration/);assert.doesNotMatch(out.stderr,/unexpected_network_effect/);
});
