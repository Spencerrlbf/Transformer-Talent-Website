#!/usr/bin/env node
// Sync data/roles.json + data/matching-profiles.json into the V2 spine:
// org_roles (upsert by organization_id+external_id, close missing roles) and
// job_embeddings (facets 'context' and 'requirements', content-hash deduped —
// unchanged text costs nothing on re-runs). Run after roles change, alongside
// embed-roles.mjs. Row/text shaping lives in lib/server/roles-pipeline
// (bundled via build-worker-lib); this script orchestrates.
import fs from "node:fs";
import crypto from "node:crypto";

// Local runs: creds live in .env.scripts (git-ignored; assembled from the
// Recruitment-Matching and reply-ops .env files — Vercel sensitive vars can't
// be pulled back).
try {
  const envFile = fs.readFileSync(new URL("../.env.scripts", import.meta.url), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}
const { orgRoleRow, facetTexts, embedTexts, EMBED_MODEL, EMBED_DIMS } = await import("./dist/worker-lib.mjs");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://kmuihequfurvjxpnugxf.supabase.co").trim();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY || !process.env.OPENAI_API_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY and OPENAI_API_KEY required");

const roles = JSON.parse(fs.readFileSync(new URL("../data/roles.json", import.meta.url)));
const profiles = JSON.parse(fs.readFileSync(new URL("../data/matching-profiles.json", import.meta.url)));

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...headers, ...init.headers } });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

const [org] = await rest("organizations?slug=eq.transformer-talent&select=id");
if (!org) throw new Error("organization transformer-talent not found");

// 1. Upsert org_roles.
const roleRows = roles.map((r) => orgRoleRow(org.id, r, profiles[r.jobId], "notion"));
await rest("org_roles?on_conflict=organization_id,external_id", {
  method: "POST",
  headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  body: JSON.stringify(roleRows),
});

// Close roles that dropped out of roles.json (delisted/removed in Notion).
const current = new Set(roles.map((r) => r.jobId));
const dbRoles = await rest(`org_roles?organization_id=eq.${org.id}&select=id,external_id,status`);
const stale = dbRoles.filter((d) => !current.has(d.external_id) && d.status === "open");
for (const s of stale) {
  await rest(`org_roles?id=eq.${s.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "closed", updated_at: new Date().toISOString() }),
  });
}
console.log(`org_roles: upserted ${roleRows.length}, closed ${stale.length}`);

// 2. Facet texts.
const byExternal = new Map(dbRoles.map((d) => [d.external_id, d.id]));
// re-read to include freshly inserted ids
if (roles.some((r) => !byExternal.has(r.jobId))) {
  for (const d of await rest(`org_roles?organization_id=eq.${org.id}&select=id,external_id`)) {
    byExternal.set(d.external_id, d.id);
  }
}

const wanted = [];
for (const r of roles) {
  const roleId = byExternal.get(r.jobId);
  if (!roleId) continue;
  const facets = facetTexts(r, profiles[r.jobId]);
  for (const [facet, content] of Object.entries(facets)) {
    if (content) wanted.push({ org_role_id: roleId, facet, content, content_hash: sha(content) });
  }
}

// 3. Hash-dedupe against what's already stored; drop superseded vectors.
const existing = await rest("job_embeddings?select=id,org_role_id,facet,content_hash");
const have = new Set(existing.map((e) => `${e.org_role_id}|${e.facet}|${e.content_hash}`));
const wantKeys = new Set(wanted.map((w) => `${w.org_role_id}|${w.facet}|${w.content_hash}`));
const superseded = existing.filter((e) => !wantKeys.has(`${e.org_role_id}|${e.facet}|${e.content_hash}`));
for (const e of superseded) await rest(`job_embeddings?id=eq.${e.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
const todo = wanted.filter((w) => !have.has(`${w.org_role_id}|${w.facet}|${w.content_hash}`));
console.log(`job_embeddings: ${todo.length} to embed, ${wanted.length - todo.length} unchanged, ${superseded.length} superseded removed`);

// 4. Embed in batches and insert.
for (let i = 0; i < todo.length; i += 100) {
  const batch = todo.slice(i, i + 100);
  const vectors = await embedTexts(batch.map((b) => b.content));
  await rest("job_embeddings?on_conflict=org_role_id,facet,content_hash", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(batch.map((b, j) => ({
      ...b, model: EMBED_MODEL, dimensions: EMBED_DIMS, embedding: JSON.stringify(vectors[j]),
    }))),
  });
  console.log(`embedded ${Math.min(i + 100, todo.length)}/${todo.length}`);
}
console.log("done");
