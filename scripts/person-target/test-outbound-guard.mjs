// Denied transports for the disposable deployment (RR-08). Offline: the original
// fetch is replaced by a recorder, so "allowed" means the recorder was reached and
// "denied" means it was not.
import test from 'node:test';
import assert from 'node:assert/strict';
const reached=[];
globalThis.fetch=async(input)=>{reached.push(new URL(typeof input==='string'?input:input.url).hostname);return {ok:true,status:200};};
const {installOutboundGuard,deniedRequests,deniedHosts,hostDenied,isOutboundDenied}=await import('./dist/server.mjs');

test('host list parsing: exact and suffix entries, invalid entries refused',()=>{
 assert.deepEqual(deniedHosts({}),[]);
 assert.deepEqual(deniedHosts({OUTBOUND_DENY_HOSTS:'api.us.nylas.com, api.resend.com,.airtable.com'}),['api.us.nylas.com','api.resend.com','.airtable.com']);
 assert.throws(()=>deniedHosts({OUTBOUND_DENY_HOSTS:'bad host'}),/outbound_deny_hosts_invalid/);
 assert.equal(hostDenied('api.airtable.com',['.airtable.com']),true);
 assert.equal(hostDenied('airtable.com',['.airtable.com']),true);
 assert.equal(hostDenied('notairtable.com',['.airtable.com']),false);
 assert.equal(hostDenied('API.RESEND.COM',['api.resend.com']),true);
 assert.equal(hostDenied('api.resend.com.',['api.resend.com']),true);
 assert.equal(hostDenied('api.airtable.com.',['.airtable.com']),true);
});
test('unset: nothing is installed and every request reaches the transport',async()=>{
 assert.deepEqual(installOutboundGuard({}),[]);
 await fetch('https://api.us.nylas.com/v3/grants/x');
 assert.deepEqual(reached,['api.us.nylas.com']);assert.deepEqual(deniedRequests(),{});
});
test('set: provider hosts are denied before the request leaves; others pass; counts are kept',async()=>{
 const hosts=installOutboundGuard({OUTBOUND_DENY_HOSTS:'api.us.nylas.com,api.resend.com,.airtable.com,api.harvest-api.com'});
 assert.equal(hosts.length,4);
 reached.length=0;
 for(const url of ['https://api.us.nylas.com/v3/grants/g1','https://api.resend.com/emails','https://api.airtable.com/v0/base/Candidates','https://api.harvest-api.com/linkedin/profile']){
  const error=await fetch(url,{method:'DELETE'}).catch(e=>e);
  assert.ok(isOutboundDenied(error),url);assert.match(error.message,/^outbound_denied:/);
 }
 assert.deepEqual(reached,[]);
 assert.deepEqual(deniedRequests(),{'api.us.nylas.com':1,'api.resend.com':1,'api.airtable.com':1,'api.harvest-api.com':1});
 // Request objects and URL objects are recognized too.
 await assert.rejects(fetch(new Request('https://api.resend.com/emails')),/outbound_denied:api.resend.com/);
 await assert.rejects(fetch(new URL('https://api.us.nylas.com/v3/x')),/outbound_denied:api.us.nylas.com/);
 // The database and OpenAI stay reachable: only the listed hosts are denied.
 await fetch('https://abcdefghijklmnopqrst.supabase.co/rest/v1/organizations');
 await fetch('https://api.openai.com/v1/embeddings');
 assert.deepEqual(reached,['abcdefghijklmnopqrst.supabase.co','api.openai.com']);
});
test('reinstall updates the list without stacking wrappers',async()=>{
 installOutboundGuard({OUTBOUND_DENY_HOSTS:'api.openai.com'});
 reached.length=0;
 await assert.rejects(fetch('https://api.openai.com/v1/embeddings'),/outbound_denied:api.openai.com/);
 await fetch('https://api.resend.com/emails');
 assert.deepEqual(reached,['api.resend.com']);
 installOutboundGuard({});
 await fetch('https://api.openai.com/v1/embeddings');
 assert.deepEqual(reached,['api.resend.com','api.openai.com']);
});
