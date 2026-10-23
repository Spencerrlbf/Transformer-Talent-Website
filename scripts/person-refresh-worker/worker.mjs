import { randomUUID } from 'node:crypto';
// Every retry below repeats the same database operation/identity. The external
// provider is called only after a freshly committed start permission, once.
async function retryDatabase(fn, attempts=2) {
  for(let i=1;;i++){try{return await fn()}catch(e){if(i===attempts)throw e}}
}
export async function runCertifiedRefresh({lib,organizationId,mode,dailyCap,allowPaid,noTopup=false,concurrency=1,harvestProfile,log=console.log,warn=console.error}) {
  if(process.env.PERSON_TRANSITION_SUPPORT!=='on')throw Error('refresh_worker_disabled');
  if(organizationId!==lib.TT_ORG_ID||!['shadow','live'].includes(mode))throw Error('person_refresh_scope');
  if(!Number.isInteger(dailyCap)||dailyCap<0||dailyCap>10000||typeof allowPaid!=='boolean'||typeof noTopup!=='boolean')throw Error('person_refresh_cap');
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw Error('person_refresh_concurrency');
  const limit=Math.min(500,Math.max(50,dailyCap));
  let selected=await lib.pickCertifiedRefresh({organizationId,limit});
  if(selected.phase==='open'&&!noTopup&&allowPaid&&dailyCap>selected.queued.length){
    const needed=Math.min(500,dailyCap)-selected.queued.length;
    if(needed>0)await lib.topUpCertifiedRefresh({organizationId,limit:needed});
    selected=await lib.pickCertifiedRefresh({organizationId,limit});
  }
  const stats={refreshed:0,failed:0,skipped:0,review:selected.review,uncertain:selected.uncertain,budget:0,derivativesDeferred:mode==='live'};
  const seen=new Set();
  const work=[...selected.recovery.map(row=>({row,recovery:true})),...selected.queued.map(row=>({row,recovery:false}))]
    .filter(({row})=>{if(seen.has(row.candidateId))return false;seen.add(row.candidateId);return true});
  log(JSON.stringify({phase:'certified_refresh',mode,queued:work.length,dailyCap}));
  function counted(result){
    if(result?.status==='done'){stats.refreshed++;return true}
    if(result?.status==='review'){stats.review++;return true}
    if(result?.status==='uncertain'){stats.uncertain++;return true}
    if(result?.status==='budget'){stats.budget++;return true}
    if(['busy','held','missing'].includes(result?.status)){stats.skipped++;return true}
    return false;
  }
  async function attempt(row,freeOnly=false,allowLateRetry=true){
    const key={organizationId,queueId:row.queueId,requestId:randomUUID(),token:randomUUID()};
    try {
      const claim=await retryDatabase(()=>lib.claimCertifiedRefresh({...key,dailyCap,allowPaid:allowPaid&&!freeOnly}));
      if(counted(claim))return;
      if(claim.status!=='claimed')throw Error('refresh_claim_result');
      if(claim.needsHarvest){
        const start=await lib.startCertifiedRefreshProvider(key);
        if(counted(start))return;
        if(start.status!=='start')throw Error('refresh_start_result');
        const raw=await harvestProfile(start.linkedinUrl);
        const stored=await retryDatabase(()=>lib.storeCertifiedRefreshPayload({...key,raw}),3);
        if(stored.status==='retry'){
          if(!allowLateRetry){stats.skipped++;return}
          // The source has been retained and old work completed. A new UUID is
          // allowed once, only while open, with paid access explicitly disabled.
          const phase=await lib.pickCertifiedRefresh({organizationId,limit:1});
          if(phase.phase!=='open'){stats.skipped++;return}
          await attempt(row,true,false);return;
        }
        if(stored.status!=='stored')throw Error('refresh_store_result');
      }
      const saved=await retryDatabase(()=>lib.saveCertifiedRefresh({...key,mode}));
      if(!counted(saved))throw Error('refresh_save_result');
    } catch {
      // This also covers a lost claim result: its generated key is retained even
      // before the claim response is known. A done proof wins over the error.
      let outcome;
      try{outcome=await lib.failCertifiedRefresh(key)}catch{warn('person_refresh_failure_record_unavailable')}
      if(counted(outcome))return;
      stats.failed++;warn('person_refresh_retry_required');
    }
  }
  async function processRow({row,recovery}){
    if(!recovery){await attempt(row,row.freeOnly);return}
    try{
      const result=await lib.recoverCertifiedRefresh(row);
      if(counted(result))return;
      if(result.status!=='retry')throw Error('refresh_recovery_result');
      if(selected.phase!=='open'){stats.skipped++;return}
      await attempt(row,true,false);
    }catch{stats.failed++;warn('person_refresh_recovery_required')}
  }
  await Promise.all(Array.from({length:concurrency},async()=>{while(work.length)await processRow(work.shift())}));
  // Certified derivative consumer admission is a separate release gate. Never
  // use the legacy paid drain merely because profile publication succeeded.
  log(JSON.stringify({phase:'certified_refresh_complete',...stats}));return stats;
}
