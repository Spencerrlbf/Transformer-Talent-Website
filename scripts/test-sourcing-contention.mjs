#!/usr/bin/env node
// Lease-contention and kill/handover test for the hardened sourcing engine.
// Mock provider; short lease TTL so takeover paths run fast.
//
// Proves:
// 1. Two concurrent drivers: exactly one works, the other reports busy.
// 2. A killed driver (child process SIGKILLed mid-screening) leaves the run
//    recoverable: after TTL, a new driver claims, heals orphans, finishes.
// 3. No row is double-screened (screened_count == done rows, every done row
//    has a verdict) and no run-level counters drift.
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const line of fs.readFileSync(path.join(root, ".env.scripts"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.SOURCING_PROVIDER_MODE = "mock";
process.env.SOURCING_LEASE_TTL = "15"; // fast takeover for the test

execFileSync("npx", ["--yes", "esbuild@0.28.2", "lib/server/sourcing/run.ts", "--bundle",
  "--platform=node", "--format=esm", `--alias:@=${root}`,
  "--outfile=scripts/dist/sourcing-run-test.mjs", "--log-level=warning"], { cwd: root, stdio: "inherit" });

const { previewSearch, createRun, advanceRun } = await import("./dist/sourcing-run-test.mjs");

const H = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
const q = async (p, init = {}) => {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${p}`, { ...init, headers: { ...H, ...init.headers } });
  if (!r.ok) throw new Error(`${p.split("?")[0]} ${r.status}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
};

const [org] = await q("organizations?slug=eq.demo-co&select=id");
const [role] = await q(`org_roles?organization_id=eq.${org.id}&status=eq.open&select=id&limit=1`);

const query = { currentJobTitles: ["Backend Engineer"], locations: ["New York"], search: "contention test" };
const preview = await previewSearch(org.id, query);
if (!preview.ok) throw new Error("preview failed");
const run = await createRun({ organizationId: org.id, orgRoleId: role.id, query, matchEstimate: preview.total });
console.log(`run ${run.id}`);

// ---- Test 1: concurrent drivers — exactly one busy ----
const [a, b] = await Promise.all([advanceRun(run.id, 20_000), advanceRun(run.id, 20_000)]);
const busyCount = [a, b].filter((r) => r.busy).length;
console.log(`concurrent drivers: A=${a.busy ? "busy" : a.status} B=${b.busy ? "busy" : b.status}`);
if (busyCount !== 1) throw new Error(`TEST 1 FAILED: expected exactly 1 busy, got ${busyCount}`);
console.log("TEST 1 OK: exactly one driver worked, one was refused\n");

// Drive to screening stage.
for (let i = 0; i < 60; i++) {
  const s = await advanceRun(run.id, 50_000);
  if (s.busy) { await new Promise((r2) => setTimeout(r2, 3000)); continue; }
  console.log(`  ${s.status}: pages ${s.pagesFetched}, reviewed ${s.screened}/${s.screenTarget}`);
  if (s.status === "screening" && s.screened > 0) break;
  if (s.done) break;
}

// ---- Test 2: kill a driver mid-wave, then recover ----
console.log("\nspawning child driver, will SIGKILL mid-wave…");
const child = spawn(process.execPath, ["-e", `
  const mod = await import(${JSON.stringify(path.join(root, "scripts/dist/sourcing-run-test.mjs"))});
  console.log("child driving");
  await mod.advanceRun(${JSON.stringify(run.id)}, 45000);
`], { cwd: root, env: process.env, stdio: "inherit" });
await new Promise((r2) => setTimeout(r2, 6000)); // let it claim + start a wave
child.kill("SIGKILL");
console.log("child killed; waiting out lease TTL…");
await new Promise((r2) => setTimeout(r2, 17_000));

// New driver takes over and finishes the run.
let final = null;
for (let i = 0; i < 120; i++) {
  const s = await advanceRun(run.id, 50_000);
  if (s.busy) { await new Promise((r2) => setTimeout(r2, Math.min(s.retryAfterMs ?? 3000, 15_000))); continue; }
  if (i % 5 === 0) console.log(`  ${s.status}: reviewed ${s.screened}/${s.screenTarget}`);
  if (s.done) { final = s; break; }
}
if (!final || final.status !== "done") throw new Error(`TEST 2 FAILED: run did not complete (${final?.status})`);
console.log(`TEST 2 OK: recovered after kill, run done (${final.screened}/${final.screenTarget})\n`);

// ---- Test 3: integrity ----
const [counts] = await q(
  `sourcing_run_candidates?run_id=eq.${run.id}&select=id.count()`
).then(() => [null]).catch(() => [null]);
void counts;
const doneRows = await q(`sourcing_run_candidates?run_id=eq.${run.id}&screen_status=eq.done&select=id,verdict`);
const pendingRows = await q(`sourcing_run_candidates?run_id=eq.${run.id}&screen_status=eq.pending&select=id`);
const noVerdict = doneRows.filter((r) => !r.verdict).length;
const [runRow] = await q(`sourcing_runs?id=eq.${run.id}&select=screened_count,screen_target,allfail_streak`);
console.log(`integrity: done=${doneRows.length} pending=${pendingRows.length} noVerdict=${noVerdict} screened_count=${runRow.screened_count}`);
if (pendingRows.length) throw new Error("TEST 3 FAILED: stuck pending rows remain");
if (noVerdict) throw new Error("TEST 3 FAILED: done rows without verdicts");
if (runRow.screened_count !== doneRows.length) throw new Error(`TEST 3 FAILED: screened_count ${runRow.screened_count} != done ${doneRows.length}`);
console.log("TEST 3 OK: no stuck rows, verdicts complete, counts truthful");

console.log("\nALL CONTENTION TESTS PASSED");
