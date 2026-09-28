#!/usr/bin/env node
// Hourly certified embedding worker (Spencer, 2026-09-28): writes the search chunks
// for people whose sources changed (applications, directory, refresh, recruiter)
// within the hour instead of at the nightly refresh. This is the only scheduled
// caller of runCertifiedDerivatives, so runs never overlap (see the workflow).
//
//   node scripts/derivative-worker.mjs
//
// Needs PERSON_TRANSITION_SUPPORT=on and PERSON_WRITE_MODE=live; otherwise it
// exits without work. DERIVATIVE_DAILY_CAP (default 200) is the most people paid
// for per UTC day, counted from the database across runs; a bad value fails first.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/** Parses DERIVATIVE_DAILY_CAP; fails closed on anything but an integer 0..10000. */
export function derivativeDailyCap(raw) {
  const cap = raw === undefined || raw === "" ? 200 : Number(raw);
  if (!/^\d*$/.test(raw ?? "") || !Number.isInteger(cap) || cap < 0 || cap > 10000) throw new Error("derivative_worker_configuration:DERIVATIVE_DAILY_CAP");
  return cap;
}

export async function main(env = process.env, { importLib = () => import("./dist/worker-lib.mjs"), log = console.log } = {}) {
  const dailyCap = derivativeDailyCap(env.DERIVATIVE_DAILY_CAP);
  if (env.PERSON_TRANSITION_SUPPORT !== "on" || env.PERSON_WRITE_MODE !== "live") {
    log(JSON.stringify({ phase: "derivative_worker_skipped", reason: "transition_support_off_or_not_live" }));
    return null;
  }
  if (!env.OPENAI_API_KEY) throw new Error("derivative_worker_configuration:OPENAI_API_KEY");
  const lib = await importLib();
  const { runCertifiedDerivatives } = await import("./person-derivative-worker/worker.mjs");
  const stats = await runCertifiedDerivatives({ lib, apiKey: env.OPENAI_API_KEY, dailyCap });
  log(JSON.stringify({ phase: "derivative_worker_done", ...stats }));
  return stats;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const envFile = fs.readFileSync(new URL("../.env.scripts", import.meta.url), "utf8");
    for (const line of envFile.split("\n")) {
      const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
  main().then((stats) => {
    // Errors and unknown paid results need a person to look; definite failures retry next run.
    process.exit(stats && (stats.errors || stats.unknown) ? 1 : 0);
  }, (error) => {
    console.error(JSON.stringify({ phase: "derivative_worker_stopped", reason: String(error?.message ?? error).slice(0, 120) }));
    process.exit(1);
  });
}
