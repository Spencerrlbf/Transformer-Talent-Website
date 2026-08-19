#!/usr/bin/env node
// Sourcing run resumer (GitHub Actions, every 15 min). Any run stuck in an
// active stage with no recent progress gets driven forward — a closed
// laptop delays a run by minutes, not until someone reopens the page.
// The engine's lease makes this safe alongside a live browser driver:
// claim-or-busy, fenced writes.
//
// Run `node scripts/build-worker-lib.mjs` first (the Action does).
import fs from "node:fs";

try {
  const envFile = fs.readFileSync(new URL("../.env.scripts", import.meta.url), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const { advanceRun, RunFailure } = await import("./dist/worker-lib.mjs");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) throw new Error("Supabase creds required");
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// Total wall-clock cap for one resumer tick; the next tick continues.
const JOB_DEADLINE = Date.now() + 12 * 60 * 1000;
const STALE_MINUTES = 5;

const staleBefore = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();
const res = await fetch(
  `${SUPABASE_URL}/rest/v1/sourcing_runs?status=in.(previewed,importing,ranking,screening)` +
    `&updated_at=lt.${staleBefore}&select=id,status,updated_at&order=updated_at.asc&limit=10`,
  { headers }
);
const runs = res.ok ? await res.json() : [];
console.log(`${runs.length} stalled run(s)`);

for (const run of runs) {
  if (Date.now() > JOB_DEADLINE) { console.log("tick deadline reached"); break; }
  console.log(`resuming ${run.id} (${run.status}, idle since ${run.updated_at})`);
  let busyStreak = 0;
  while (Date.now() < JOB_DEADLINE) {
    try {
      const r = await advanceRun(run.id, 50_000);
      if (r.done) { console.log(`  ${run.id}: ${r.status} (imported ${r.imported}, reviewed ${r.screened})`); break; }
      if (r.busy) {
        busyStreak++;
        if (busyStreak >= 3) { console.log(`  ${run.id}: busy (another driver) — moving on`); break; }
        await new Promise((s) => setTimeout(s, Math.min(r.retryAfterMs ?? 15_000, 60_000)));
      } else {
        busyStreak = 0;
      }
    } catch (err) {
      if (err instanceof RunFailure) { console.log(`  ${run.id}: failed (${err.message})`); break; }
      console.error(`  ${run.id}: transient (${err.message}) — retrying shortly`);
      await new Promise((s) => setTimeout(s, 10_000));
    }
  }
}
console.log("resumer done");
