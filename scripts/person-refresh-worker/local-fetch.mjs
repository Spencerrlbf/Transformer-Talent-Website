// Actual CLI test preload: only the guarded loopback fixture can receive traffic.
const db=new URL(process.env.PERSON_DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(db.hostname)||db.pathname!=='/person_refresh_worker_test')throw Error('local_fixture_required');
const native=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const value=String(input),url=new URL(value);
 if(url.origin==='https://api.harvestapi.io'&&url.pathname==='/linkedin/profile')
  return native(new URL('/provider',process.env.SUPABASE_URL),init);
 if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('EXTERNAL_FETCH_FORBIDDEN');
 return native(input,init);
};
