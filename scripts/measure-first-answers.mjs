#!/usr/bin/env node
// STUB for build step 10 of the homepage. It queries nothing today.
//
// Intended measurement, once the closed roles exist:
//   brief received  = the role's created timestamp in org_roles
//   first answer    = the earliest of
//                       the first profile shared to the client for that role, and
//                       the first written market read for that role
//   kind            = "profile" when the earliest was a shared profile,
//                     "market_read" when it was a written market read
//   roles           = closed roles only; open roles are never counted
// Output: data/first-answers.json in the shape lib/home/first-answers.ts reads:
//   { measuredAt: ISO string, roles: [{ roleId, briefReceivedAt, firstAnswerAt, kind }] }
// The homepage renders its measuring state until that file holds at least
// CDF_MIN_ROLES roles (lib/home/placeholders.ts).
//
// Usage:
//   node scripts/measure-first-answers.mjs [--out data/first-answers.json] [--dry-run]
// Without --dry-run the stub writes an EMPTY but valid file, and only when no
// file exists yet, so a real measurement is never overwritten and the page's
// measuring state stays honest.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = path.join("data", "first-answers.json");

function parseArgs(argv) {
  const opts = { out: DEFAULT_OUT, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--out") {
      const v = argv[++i];
      if (!v) fail("--out needs a path");
      opts.out = v;
    } else if (a.startsWith("--out=")) opts.out = a.slice("--out=".length);
    else if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else fail(`unknown argument ${a}`);
  }
  return opts;
}

function usage() {
  console.log("usage: node scripts/measure-first-answers.mjs [--out data/first-answers.json] [--dry-run]");
}

function fail(msg) {
  console.error(`measure-first-answers: ${msg}`);
  usage();
  process.exit(2);
}

const PLAN = `
measure-first-answers (stub, build step 10): no query is run today.

  brief received : org_roles.created_at for the role
  first answer   : min(first profile shared to the client, first written market read)
  kind           : "profile" or "market_read", whichever came first
  roles          : closed roles only
  output         : { measuredAt, roles: [{ roleId, briefReceivedAt, firstAnswerAt, kind }] }
`;

const { out, dryRun } = parseArgs(process.argv.slice(2));
const target = path.isAbsolute(out) ? out : path.join(ROOT, out);

console.log(PLAN.trim());
console.log(`\ntarget: ${path.relative(ROOT, target) || target}`);

if (fs.existsSync(target)) {
  console.log("a file already exists at the target; left untouched.");
  process.exit(0);
}

const empty = { measuredAt: new Date().toISOString(), roles: [] };

if (dryRun) {
  console.log("dry run: would write an empty measurement file:");
  console.log(JSON.stringify(empty, null, 2));
  process.exit(0);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(empty, null, 2) + "\n");
console.log("wrote an empty measurement file (zero roles); the page stays in its measuring state.");
