// Main's private read-only endpoint, exercised offline with sealed transports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {GET,tokenMatches,LINK_TTL_SECONDS,setRead} from './dist/access.mjs';
const keys=['INTERNAL_RESUMES_TOKEN','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_STORAGE_KEY'];
const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]])),fetchBefore=globalThis.fetch;
const token='synthetic-internal-token-0123456789',id='00000000-0000-4000-8000-000000000001';
let reads,signs;
test.beforeEach(()=>{
 reads=[];signs=[];Object.assign(process.env,{INTERNAL_RESUMES_TOKEN:token,SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service'});delete process.env.SUPABASE_STORAGE_KEY;
 setRead(async resource=>{reads.push(resource);return Response.json([{resume_path:`synthetic/${id}-resume.pdf`}]);});
 globalThis.fetch=async(input,init)=>{assert.equal(String(input),`https://synthetic.invalid/storage/v1/object/sign/resumes/synthetic/${id}-resume.pdf`,'outbound blocked');signs.push(init);return Response.json({signedURL:'/object/sign/resumes/synthetic?token=synthetic'});};
});
test.after(()=>{globalThis.fetch=fetchBefore;for(const [k,v]of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;});
const request=(auth=`Bearer ${token}`,key=id)=>GET(new Request('https://local.invalid/api/internal/resumes/'+key,{headers:auth?{authorization:auth}:{}}),{params:Promise.resolve({id:key})});
async function refusal(r,status,error){assert.equal(r.status,status);assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(await r.json(),{error});}
test('unset and short configured tokens fail closed',async()=>{delete process.env.INTERNAL_RESUMES_TOKEN;assert.equal(tokenMatches(`Bearer ${token}`),false);await refusal(await request(),401,'unauthorized');process.env.INTERNAL_RESUMES_TOKEN='short';assert.equal(tokenMatches('Bearer short'),false);assert.equal(reads.length,0);assert.equal(signs.length,0);});
test('wrong, missing and malformed authorization does not access data',async()=>{for(const auth of [null,'Basic '+token,'Bearer wrong'])await refusal(await request(auth),401,'unauthorized');assert.equal(reads.length,0);assert.equal(signs.length,0);assert.equal(tokenMatches(`bEaReR ${token}`),true);});
test('invalid application id is refused before lookup',async()=>{await refusal(await request(undefined,'invalid'),404,'not_found');assert.equal(reads.length,0);assert.equal(signs.length,0);});
for(const rows of [[],[{resume_path:null}]])test('missing resume returns not found without storage access',async()=>{setRead(async()=>Response.json(rows));await refusal(await request(),404,'not_found');assert.equal(signs.length,0);});
test('authorized read returns a ten-minute signed link with no-store',async()=>{const r=await request();assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(await r.json(),{url:'https://synthetic.invalid/storage/v1/object/sign/resumes/synthetic?token=synthetic',expires_in:600,file_name:'resume.pdf'});assert.equal(LINK_TTL_SECONDS,600);assert.deepEqual(reads,[`website_applications?id=eq.${id}&select=resume_path&limit=1`]);assert.equal(signs.length,1);assert.equal(signs[0].method,'POST');assert.deepEqual(JSON.parse(signs[0].body),{expiresIn:600});assert.ok(signs[0].signal instanceof AbortSignal);});
test('lookup failure is sanitized and never reaches storage',async()=>{setRead(async()=>new Response('synthetic-private-detail',{status:500}));await refusal(await request(),502,'unavailable');assert.equal(signs.length,0);});
for(const status of [400,404])test(`storage ${status} becomes not found`,async()=>{globalThis.fetch=async()=>new Response('synthetic-private-detail',{status});await refusal(await request(),404,'not_found');});
test('storage server failure is sanitized',async()=>{globalThis.fetch=async()=>new Response('synthetic-private-detail',{status:500});await refusal(await request(),502,'unavailable');});
test('storage transport failure is sanitized',async()=>{globalThis.fetch=async()=>{throw Error('synthetic-private-detail');};await refusal(await request(),502,'unavailable');});
test('absent signed URL returns not found',async()=>{globalThis.fetch=async()=>Response.json({});await refusal(await request(),404,'not_found');});
test('missing storage credentials refuses without an external request',async()=>{delete process.env.SUPABASE_SERVICE_ROLE_KEY;await refusal(await request(),502,'unavailable');assert.equal(signs.length,0);});
