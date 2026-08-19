#!/usr/bin/env node
// End-to-end sourcing pipeline test. Mock provider by default (no Harvest
// spend; embeddings + screening still hit OpenAI for real — keep
// SCREEN_TARGET small).
//
//   node scripts/run-sourcing-pipeline.mjs                    mock, demo-co
//   ORG=demo-co SCREEN_TARGET=3 node scripts/run-sourcing-pipeline.mjs
//   CLEANUP=1 node scripts/run-sourcing-pipeline.mjs          delete prior test runs first
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const envFile = fs.readFileSync(path.join(root, ".env.scripts"), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}
if (!process.env.SOURCING_PROVIDER_MODE) process.env.SOURCING_PROVIDER_MODE = "mock";

execFileSync(
  "npx",
  ["--yes", "esbuild@0.28.2", "lib/server/sourcing/run.ts", "--bundle",
    "--platform=node", "--format=esm", `--alias:@=${root}`,
    "--outfile=scripts/dist/sourcing-run-test.mjs", "--log-level=warning"],
  { cwd: root, stdio: "inherit" }
);
const { previewSearch, createRun, advanceRun, providerMode } = await import("./dist/sourcing-run-test.mjs");

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const rest = async (p, init = {}) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { ...init, headers: { ...headers, ...init.headers } });
  if (!r.ok) throw new Error(`${p.split("?")[0]} ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
};

const orgSlug = process.env.ORG || "demo-co";
const [org] = await rest(`organizations?slug=eq.${orgSlug}&select=id,slug`);
if (!org) throw new Error(`org ${orgSlug} not found`);
const [role] = await rest(`org_roles?organization_id=eq.${org.id}&status=eq.open&select=id,external_id,title&limit=1`);
if (!role) throw new Error(`no open role for ${orgSlug}`);
console.log(`mode=${providerMode()} org=${org.slug} role=#${role.external_id} ${role.title}`);

if (process.env.CLEANUP === "1") {
  const runs = await rest(`sourcing_runs?organization_id=eq.${org.id}&select=id`);
  for (const r of runs) {
    await rest(`sourcing_run_candidates?run_id=eq.${r.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    await rest(`usage_events?run_id=eq.${r.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  }
  await rest(`sourced_candidates?organization_id=eq.${org.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } })
    .catch(async () => {
      await rest(`sourced_candidates?organization_id=eq.${org.id}&first_run_id=not.is.null`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    });
  for (const r of runs) await rest(`sourcing_runs?id=eq.${r.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  console.log(`cleaned ${runs.length} prior runs`);
}

const query = {
  currentJobTitles: ["Backend Engineer", "Software Engineer"],
  locations: ["New York"],
  search: "python distributed systems",
};

const t0 = Date.now();
const preview = await previewSearch(org.id, query);
console.log(`preview:`, preview.ok ? `${preview.total} matches` : `${preview.code} (${preview.total})`);
if (!preview.ok) process.exit(1);

const run = await createRun({
  organizationId: org.id,
  orgRoleId: role.id,
  query,
  matchEstimate: preview.total,
});
console.log(`run ${run.id} created (review-all)`);

for (let i = 0; i < 300; i++) {
  const s = await advanceRun(run.id, 45_000);
  console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${s.status}: pages ${s.pagesFetched}, imported ${s.imported}, dupes ${s.duplicates}, reviewed ${s.screened}/${s.screenTarget}${s.busy ? " (busy)" : ""}`);
  if (s.done) break;
  if (s.busy) await new Promise((r) => setTimeout(r, Math.min(s.retryAfterMs ?? 5000, 30_000)));
}

const top = await rest(
  `sourcing_run_candidates?run_id=eq.${run.id}&order=rank.asc&limit=8&select=rank,rank_score,embed_score,keyword_score,tag,reason,screen_status,sourced_candidates(full_name,current_title,current_company,location)`
);
console.log("\ntop ranked:");
for (const r of top) {
  const c = r.sourced_candidates;
  console.log(
    `  #${r.rank} ${c.full_name} — ${c.current_title ?? "?"} @ ${c.current_company ?? "?"} | score ${r.rank_score?.toFixed(3)} (e${r.embed_score?.toFixed(2)}/k${r.keyword_score?.toFixed(2)})` +
      (r.tag ? ` | ${r.tag.toUpperCase()}: ${String(r.reason).slice(0, 90)}` : ` | ${r.screen_status}`)
  );
}

const events = await rest(`usage_events?run_id=eq.${run.id}&select=event_type,quantity,credits`);
const summary = {};
for (const e of events) {
  summary[e.event_type] = summary[e.event_type] || { quantity: 0, credits: 0 };
  summary[e.event_type].quantity += e.quantity;
  summary[e.event_type].credits += e.credits;
}
console.log("\nusage events:", JSON.stringify(summary));
console.log("\nOK");
