import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mapContact, syncHash } from "./sync-directory.mjs";
const exec = promisify(execFile);

// Exercise the actual CLI orchestration. Only the external directory connection
// and embedding service are fixtures; candidate REST reads/writes reach this server.
async function run(unchanged, race) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-directory-test-"));
  const cid = "00000000-0000-4000-8000-000000000001";
  const contact = { contact_id: cid, name: "Synthetic Person", linkedin_url: "https://www.linkedin.com/in/test-person", primary_email: null };
  const harvest = { contact_id: cid, fetched_at: "2026-09-24T12:00:00Z", current_title: "Engineer" };
  const exps = [{ contact_id: cid, title: "Engineer", company_name: "Example", is_current: true }];
  const candidate = { id: cid, directory_contact_id: cid, linkedin_username: "test-person", matching_embedding: "[0]", embedding_type: "airtable_sync",
    linkedin_enrichment_date: unchanged ? harvest.fetched_at : null,
    directory_sync_hash: unchanged ? syncHash(mapContact(contact, harvest, exps, []), harvest.fetched_at) : "old" };
  let profileWrites = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const reply = value => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
    if (url.pathname === "/embedding") {
      if (race) { candidate.linkedin_enrichment_date = "2026-09-26T12:00:00Z"; candidate.matching_embedding = "[99]"; }
      return reply({ data: [{ embedding: [1] }] });
    }
    if (req.method === "GET") {
      const fields = url.searchParams.get("select").split(",");
      return reply([Object.fromEntries(fields.map(k => [k, candidate[k] ?? null]))]);
    }
    let raw = "";
    for await (const part of req) raw += part;
    const patch = JSON.parse(raw);
    const filter = url.searchParams.get("linkedin_enrichment_date");
    if (filter === "is.null" && candidate.linkedin_enrichment_date != null) return reply([]);
    if (filter?.startsWith("eq.") && Date.parse(filter.slice(3)) !== Date.parse(candidate.linkedin_enrichment_date)) return reply([]);
    if (!Object.hasOwn(patch, "matching_embedding")) profileWrites++;
    Object.assign(candidate, patch);
    reply([{ id: cid }]);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await fs.copyFile(new URL("./sync-directory.mjs", import.meta.url), path.join(tmp, "sync-directory.mjs"));
    await fs.mkdir(path.join(tmp, "node_modules/pg"), { recursive: true });
    await fs.writeFile(path.join(tmp, "node_modules/pg/package.json"), JSON.stringify({ name: "pg", type: "module", exports: "./index.mjs" }));
    await fs.writeFile(path.join(tmp, "fixture.json"), JSON.stringify({ contact, harvest, exps }));
    await fs.writeFile(path.join(tmp, "node_modules/pg/index.mjs"), `
      import fs from 'node:fs';
      const f=JSON.parse(fs.readFileSync(new URL('../../fixture.json',import.meta.url)));
      export default { Client: class {
        async connect() {} async end() {}
        async query(sql) {
          if(sql.startsWith('set default_transaction_read_only')) return {rows:[]};
          if(sql.includes('from comms.workspaces')) return {rows:[{id:'workspace',name:'test',contacts:1}]};
          if(sql.includes('information_schema')) return {rows:[]};
          if(sql.includes('count(')) return {rows:[{}]};
          if(sql.startsWith('select v.*')) return {rows:[f.contact]};
          if(sql.includes('from comms.harvest_profiles')) return {rows:[f.harvest]};
          if(sql.includes('from comms.contact_experiences')) return {rows:f.exps};
          if(sql.includes('from comms.contact_educations')) return {rows:[]};
          throw Error('unexpected directory query');
        }
      }};
    `);
    await fs.writeFile(path.join(tmp, "preload.mjs"), `
      const real=globalThis.fetch, origin=process.env.SUPABASE_URL;
      globalThis.fetch=(url,init)=> {
        if(String(url)==='https://api.openai.com/v1/embeddings') return real(origin+'/embedding');
        if(!String(url).startsWith(origin+'/')) throw Error('EXTERNAL_FETCH_FORBIDDEN');
        return real(url,init);
      };
    `);
    const { stdout } = await exec(process.execPath, ["--import", "./preload.mjs", "sync-directory.mjs"], { cwd: tmp, timeout: 10000,
      env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${server.address().port}`, SUPABASE_SERVICE_ROLE_KEY: "test", COMMS_DATABASE_URL: "postgresql://unused/test",
        COMMS_WORKSPACE: "", OPENAI_API_KEY: "test", LIMIT: "1", DRY_RUN: "", SINCE: "" } });
    return { candidate, stdout, profileWrites };
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

for (const unchanged of [false, true]) {
  test(`new refresh after ${unchanged ? "unchanged-hash lookup" : "profile save"} keeps its embedding`, async () => {
    const s = await run(unchanged, true);
    assert.equal(s.profileWrites, unchanged ? 0 : 1);
    assert.equal(s.candidate.matching_embedding, "[99]");
    assert.match(s.stdout, /embedded 0/);
  });
}
test("the directory still saves the embedding when its profile has not changed", async () => {
  const s = await run(false, false);
  assert.equal(s.candidate.matching_embedding, "[1]");
  assert.match(s.stdout, /embedded 1/);
});
