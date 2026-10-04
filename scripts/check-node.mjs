#!/usr/bin/env node
// The supported Node.js runtime for this repository: major 24, the version every
// piece of release evidence was produced with (RELEASE_MANIFEST.md). The Next.js
// server (Vercel reads package.json#engines), the Actions workers (setup-node) and
// every local harness (this check runs from scripts/build-worker-lib.mjs, which each
// harness calls first) must agree. Running the node:test suites under Node 20 is not
// supported: its test lifecycle differs and the suites fail before exercising any
// application code (see RELEASE_REMEDIATION.md, "Node runtime").
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const SUPPORTED_MAJOR = 24;
export function checkNode(version = process.version, { engines } = {}) {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  const declared = engines ?? JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).engines?.node;
  if (declared !== `${SUPPORTED_MAJOR}.x`) throw Error(`node_runtime:engines_mismatch:${declared}`);
  if (major !== SUPPORTED_MAJOR) throw Error(`node_runtime:unsupported:${version} (supported: ${SUPPORTED_MAJOR}.x)`);
  return { version, major };
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try { console.log(JSON.stringify({ node: checkNode().version, supported: `${SUPPORTED_MAJOR}.x` })); }
  catch (error) { console.error(error.message); process.exit(1); }
}
