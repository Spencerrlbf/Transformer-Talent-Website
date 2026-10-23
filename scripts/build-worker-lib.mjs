#!/usr/bin/env node
// Bundles lib/server/worker-lib.ts into scripts/dist/worker-lib.mjs so the
// nightly worker imports the SAME compiled modules the website runs — one
// source of truth for facts, screening, and spine writes.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { checkNode } from "./check-node.mjs";

// Every harness and worker builds this bundle first: refuse an unsupported runtime
// here so no suite or worker runs on a Node major the release evidence does not cover.
checkNode();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(
  "npx",
  [
    "--yes",
    "esbuild@0.28.2",
    "lib/server/worker-lib.ts",
    "--bundle",
    "--platform=node",
    "--external:pg",
    "--format=esm",
    `--alias:@=${root}`,
    "--outfile=scripts/dist/worker-lib.mjs",
    "--log-level=warning",
  ],
  { cwd: root, stdio: "inherit" }
);
console.log("built scripts/dist/worker-lib.mjs");
