#!/usr/bin/env node
// Regenerate site_role_embeddings from data/roles.json. Run after roles change
// (part of `npm run sync-roles`: DB + embeddings + Airtable in one step).
import fs from "node:fs";
try {
  const envFile = fs.readFileSync(new URL("../.env.scripts", import.meta.url), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}
const SUPABASE_URL = process.env.SUPABASE_URL || "https://kmuihequfurvjxpnugxf.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI = process.env.OPENAI_API_KEY;
const roles = JSON.parse(fs.readFileSync(new URL("../data/roles.json", import.meta.url)));
const texts = roles.map((r) =>
  [r.title, r.roleType, r.description, r.jd?.about, (r.jd?.needs || []).join(". "), r.techStack, r.industry, r.locations.join(", ")]
    .filter(Boolean).join(". ").slice(0, 7000)
);
const res = await fetch("https://api.openai.com/v1/embeddings", {
  method: "POST",
  headers: { Authorization: `Bearer ${OPENAI}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
});
if (!res.ok) throw new Error(`embed ${res.status}: ${await res.text()}`);
const vectors = (await res.json()).data;
const rows = roles.map((r, i) => ({
  job_id: r.jobId, title: r.title,
  embedding: JSON.stringify(vectors[i].embedding),
  updated_at: new Date().toISOString(),
}));
const up = await fetch(`${SUPABASE_URL}/rest/v1/site_role_embeddings`, {
  method: "POST",
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
  body: JSON.stringify(rows),
});
if (!up.ok) throw new Error(`upsert ${up.status}: ${await up.text()}`);
console.log(`embedded and upserted ${rows.length} roles`);
