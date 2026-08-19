#!/usr/bin/env node
// Validate the EM judge against a completed live run's real candidates:
// re-judge each with one or two models and print old-tag vs new side by side.
//
//   node scripts/validate-sourced-judge.mjs <run-id-prefix> [gpt-4o-mini,gpt-4o]
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const line of fs.readFileSync(path.join(root, ".env.scripts"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

execFileSync("npx", ["--yes", "esbuild@0.28.2", "lib/server/worker-lib.ts", "--bundle",
  "--platform=node", "--format=esm", `--alias:@=${root}`,
  "--outfile=scripts/dist/worker-lib.mjs", "--log-level=warning"], { cwd: root, stdio: "inherit" });
execFileSync("npx", ["--yes", "esbuild@0.28.2", "lib/server/sourcing/judge.ts", "--bundle",
  "--platform=node", "--format=esm", `--alias:@=${root}`,
  "--outfile=scripts/dist/sourcing-judge-test.mjs", "--log-level=warning"], { cwd: root, stdio: "inherit" });

const { computeFacts, formatFacts, harvestToExperiences, linkedinProfileText } = await import("./dist/worker-lib.mjs");
const { judgeSourcedCandidate } = await import("./dist/sourcing-judge-test.mjs");

const runPrefix = process.argv[2];
const models = (process.argv[3] || "gpt-4o-mini").split(",");
if (!runPrefix) { console.error("usage: node scripts/validate-sourced-judge.mjs <run-id-prefix> [models]"); process.exit(1); }

const URL_ = process.env.SUPABASE_URL.trim();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const q = async (p) => (await fetch(`${URL_}/rest/v1/${p}`, { headers: H })).json();

const runs = await q(`sourcing_runs?select=id,org_role_id&order=created_at.desc&limit=50`);
const run = runs.find((r) => r.id.startsWith(runPrefix));
if (!run) throw new Error(`run ${runPrefix} not found`);
const [role] = await q(
  `org_roles?id=eq.${run.org_role_id}&select=title,jd,skills,tech_stack,matching_profile`
);
const jd = role.jd || {};
const jdText = [
  jd.about,
  jd.doing?.length ? `Responsibilities:\n- ${jd.doing.join("\n- ")}` : null,
  jd.needs?.length ? `Requirements:\n- ${jd.needs.join("\n- ")}` : null,
  jd.bonus?.length ? `Nice to have:\n- ${jd.bonus.join("\n- ")}` : null,
].filter(Boolean).join("\n\n") || (role.matching_profile?.must_haves || []).join("; ");
const skills = (role.skills || []).map((s) => ({
  skill: s.skill, must_have: !!s.must_have, alternates: s.alternates || [],
}));
const minYears = role.matching_profile?.min_years ?? null;

const rows = await q(
  `sourcing_run_candidates?run_id=eq.${run.id}&order=rank.asc&select=rank,tag,sourced_candidates(full_name,current_title,current_company,skills,profile)`
);
console.log(`\n${role.title} — ${rows.length} candidates, models: ${models.join(" vs ")}\n`);

for (const row of rows) {
  const c = row.sourced_candidates;
  const profile = c.profile;
  if (!profile) continue;
  const expRows = harvestToExperiences(profile);
  const facts = computeFacts(expRows, [], c.skills || [], profile.education ?? null);
  const input = {
    roleTitle: role.title,
    jdText,
    skills,
    minYears,
    profileText: linkedinProfileText(profile).slice(0, 5000),
    factsBlock: formatFacts(facts),
    careerYears: facts.careerYears,
  };
  const results = await Promise.all(models.map((m) => judgeSourcedCandidate({ ...input, model: m })));
  console.log(`#${row.rank} ${c.full_name} — ${c.current_title ?? "?"} @ ${c.current_company ?? "?"}`);
  console.log(`   old engine: ${row.tag ?? "-"}`);
  results.forEach((r, i) => {
    if (!r) { console.log(`   ${models[i]}: (failed)`); return; }
    console.log(`   ${models[i]}: ${r.tag.toUpperCase()}`);
    console.log(`      why: ${r.why_fit}`);
    if (r.gaps_to_probe.length) console.log(`      probe: ${r.gaps_to_probe.join(" · ")}`);
  });
  console.log("");
}
