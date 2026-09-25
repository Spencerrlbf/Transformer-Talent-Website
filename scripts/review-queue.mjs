#!/usr/bin/env node
// Nightly review queue (GitHub Actions). Applications that arrived after
// their company's daily review allowance was used up wait as "queued"; this
// reviews them oldest first, each company within its own allowance, with the
// same pipeline the apply routes use (lib/server/review-queue.ts).
//
//   node scripts/build-worker-lib.mjs && node scripts/review-queue.mjs
//   DRY_RUN=1 node scripts/review-queue.mjs     (count only, spends nothing)
//   MAX=50 node scripts/review-queue.mjs        (stop after 50 reviews)
import fs from "node:fs";

try {
  const envFile = fs.readFileSync(new URL("../.env.scripts", import.meta.url), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase creds required");
const { reviewQueued, queuedCount } = await import("./dist/worker-lib.mjs");

const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
// Hard ceiling per run on top of each company's allowance (cost discipline).
const max = Math.max(0, Math.min(Number(process.env.MAX || 2000), 5000));
const deadline = Date.now() + 50 * 60 * 1000;

console.log(`${await queuedCount()} queued application(s)${dryRun ? " (dry run)" : ""}`);
const r = await reviewQueued({ max, deadline, dryRun });
console.log(`${dryRun ? "would review" : "reviewed"} ${r.reviewed}, failed ${r.failed}, still queued ${r.waiting}`);
