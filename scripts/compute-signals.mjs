#!/usr/bin/env node
// Person signals for the pool, by code: years, tenure, title family,
// seniority, top university and top employer, from the columns already
// stored on candidates and the lists in lib/server/signals. Writes one row
// per person to person_signals and rewrites it only when the inputs changed
// (source_hash). No model, no paid call.
//
// Modes:
//   node scripts/compute-signals.mjs                whole pool (about 420,000 people, ~10 min)
//   SINCE=2026-09-22 node scripts/compute-signals.mjs   only people updated since that date (nightly)
//   LIMIT=2000 node scripts/compute-signals.mjs     the first N people by id (a bounded test)
//
// Shared logic comes from the compiled website library: run
// `node scripts/build-worker-lib.mjs` first (the GitHub Action does).
import fs from "node:fs";

try {
  const envFile = fs.readFileSync(new URL("../.env.scripts", import.meta.url), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const { poolSignals } = await import("./dist/worker-lib.mjs");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
const LIMIT = Math.max(0, parseInt(process.env.LIMIT || "0", 10) || 0);
const SINCE = (process.env.SINCE || "").trim();
const PAGE = 500;

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path.split("?")[0]} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const COLS = "id,full_name,headline,current_title,current_company,profile_summary,location,work_experience,education,education_schools,top_skills,all_skills_text,calculated_experience_years,total_experience_years,updated_at";
const filter = SINCE ? `&updated_at=gte.${encodeURIComponent(SINCE)}` : "";
const t0 = Date.now();
const tally = { read: 0, written: 0, unchanged: 0, failed: 0 };
let lastId = "";
for (let page = 0; ; page++) {
  // Keyset paging on id: an offset over 420,000 rows slows down as it goes.
  const batch = await rest(`candidates?select=${COLS}${filter}${lastId ? `&id=gt.${lastId}` : ""}&order=id.asc&limit=${PAGE}`);
  if (!batch.length) break;
  lastId = batch[batch.length - 1].id;
  tally.read += batch.length;
  const ids = batch.map((c) => c.id);
  const existing = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    for (const r of await rest(`person_signals?candidate_id=in.(${ids.slice(i, i + 100).join(",")})&select=candidate_id,source_hash`)) existing.set(r.candidate_id, r.source_hash);
  }
  const rows = [];
  for (const c of batch) {
    try {
      const s = poolSignals(c);
      if (existing.get(c.id) === s.source_hash) {
        tally.unchanged++;
        continue;
      }
      rows.push({ ...s, computed_at: new Date().toISOString() });
    } catch (err) {
      tally.failed++;
      if (tally.failed <= 5) console.log(`  failed ${c.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (rows.length) {
    await rest("person_signals?on_conflict=candidate_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });
    tally.written += rows.length;
  }
  if (page % 20 === 0) console.log(`page ${page}: read ${tally.read}, written ${tally.written}, unchanged ${tally.unchanged}, failed ${tally.failed} (${Math.round((Date.now() - t0) / 1000)}s)`);
  if (LIMIT && tally.read >= LIMIT) break;
}
console.log(`done: read ${tally.read}, written ${tally.written}, unchanged ${tally.unchanged}, failed ${tally.failed} in ${Math.round((Date.now() - t0) / 1000)}s`);
