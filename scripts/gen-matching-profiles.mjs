#!/usr/bin/env node
// Generate structured matching profiles for every live role from the
// (already anonymized) rewritten JD + structured fields. Re-run only when
// roles change deliberately — regenerated profiles alter role content and
// can invalidate cached verdicts. Logic lives in lib/server/roles-pipeline
// (bundled via build-worker-lib); this script is a thin caller.
import fs from "node:fs";
import { execSync } from "node:child_process";

try {
  const envFile = fs.readFileSync(new URL("../.env.scripts", import.meta.url), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

execSync("node scripts/build-worker-lib.mjs", { cwd: new URL("..", import.meta.url), stdio: "inherit" });
const { generateMatchingProfile } = await import("./dist/worker-lib.mjs");

const roles = JSON.parse(fs.readFileSync(new URL("../data/roles.json", import.meta.url)));

const out = {};
let done = 0;
const queue = [...roles];
await Promise.all(Array.from({ length: 8 }, async () => {
  while (queue.length) {
    const r = queue.shift();
    try {
      out[r.jobId] = await generateMatchingProfile(r);
    } catch (e) {
      console.error("fail", r.jobId, String(e).slice(0, 120));
    }
    done++;
    if (done % 20 === 0) console.log(done, "/", roles.length);
  }
}));
fs.writeFileSync(new URL("../data/matching-profiles.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(`wrote ${Object.keys(out).length} matching profiles`);
