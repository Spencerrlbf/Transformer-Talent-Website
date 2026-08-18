#!/usr/bin/env node
// Smoke test for lib/server/sourcing/harvest.ts. Bundles the provider the
// same way the worker lib is built, then exercises it.
//
//   node scripts/test-sourcing-provider.mjs           mock mode (free)
//   LIVE=1 node scripts/test-sourcing-provider.mjs    adds ~3 real requests
//     (1 lead-search page ≈ $0.10, 1 company search, 1 full profile)
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

execFileSync(
  "npx",
  ["--yes", "esbuild@0.28.2", "lib/server/sourcing/harvest.ts", "--bundle",
    "--platform=node", "--format=esm", `--alias:@=${root}`,
    "--outfile=scripts/dist/sourcing-harvest-test.mjs", "--log-level=warning"],
  { cwd: root, stdio: "inherit" }
);

const live = process.env.LIVE === "1";
if (!live) process.env.SOURCING_PROVIDER_MODE = "mock";
const { providerMode, searchLeadsPage, previewLeadCount, getFullProfile, searchCompanies } =
  await import("./dist/sourcing-harvest-test.mjs");

console.log(`mode: ${providerMode()}`);

const query = {
  currentJobTitles: ["Backend Engineer", "Software Engineer"],
  locations: ["New York"],
  search: "python distributed systems",
};

const preview = await previewLeadCount(query);
console.log(`\npreview: ~${preview.total} matches (${preview.totalPages} pages)`);
for (const s of preview.sample) {
  console.log(`  ${s.fullName} — ${s.currentTitle ?? "?"} at ${s.currentCompany ?? "?"} (${s.location ?? "?"}) ${s.linkedinUrl}`);
}

if (!live) {
  const page6 = await searchLeadsPage(query, 6); // mock total 137 → last page has 12
  console.log(`\npage 6: ${page6.leads.length} leads (expect 12 in mock)`);
}

const companies = await searchCompanies("Stripe");
console.log(`\ncompany search "Stripe": ${companies.length} hits`);
for (const c of companies) console.log(`  ${c.name} → ${c.linkedinUrl} (${c.location ?? "?"})`);

const profileUrl = live && preview.sample[0] ? preview.sample[0].linkedinUrl : "https://www.linkedin.com/in/mock-avery-stone-1/";
const profile = await getFullProfile(profileUrl);
console.log(`\nfull profile (${profileUrl}):`);
console.log(`  name: ${profile?.firstName} ${profile?.lastName} | headline: ${profile?.headline}`);
console.log(`  experience entries: ${Array.isArray(profile?.experience) ? profile.experience.length : 0}, skills: ${Array.isArray(profile?.skills) ? profile.skills.length : 0}`);

console.log("\nOK");
