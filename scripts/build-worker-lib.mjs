#!/usr/bin/env node
// Bundles lib/server/worker-lib.ts into scripts/dist/worker-lib.mjs so the
// nightly worker imports the SAME compiled modules the website runs — one
// source of truth for facts, screening, and spine writes.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(
  "npx",
  [
    "--yes",
    "esbuild@0.28.2",
    "lib/server/worker-lib.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--alias:@=${root}`,
    "--outfile=scripts/dist/worker-lib.mjs",
    "--log-level=warning",
  ],
  { cwd: root, stdio: "inherit" }
);
console.log("built scripts/dist/worker-lib.mjs");
