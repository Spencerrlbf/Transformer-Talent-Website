// Armed-controller mode for the cross-organization leak test (RR-14 adaptation).
//
// The fixture seeds its three fake pool people with raw service-role inserts, the
// way the pool was filled before the controller existed. An armed controller
// rightly refuses raw candidate writes (candidate_mutation_frame), so the sweep used
// to crash at setup. This module keeps the fixture's seeding and teardown in the
// controller's DISABLED state and puts the controller through its supported
// operator sequence around the probes:
//
//   setup (disabled) -> baseline reconcile of the fixture people -> anchors
//   -> arm (open) -> [the sweep's authenticated route probes run armed]
//   -> drain -> seal -> disarm -> teardown (disabled)
//
// Only the probes are the armed-state acceptance; seeding/teardown are labelled
// disabled. Requires the whole release chain in the target database and a direct
// PostgreSQL URL for the operator steps (PERSON_PUBLISH_DATABASE_URL, 5432),
// validated against PERSON_TARGET_PROJECT_REF like every other operator CLI.
import { pathToFileURL } from "node:url";
import pg from "pg";
import { databaseConfig } from "../person-publish/lib.mjs";
import { transitionStatus, setTransition, openWindow, closeWindow, waitDrained } from "../person-transition.mjs";
import { openAnchorDatabase } from "../person-audit/database.mjs";
import { prepareAnchors } from "../person-audit-anchors.mjs";

const PIN = "c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc";
const RUN = /^[a-zA-Z0-9_-]{1,100}$/;

async function runner() {
  // The historical pinned runner when its checkout is available (as in production),
  // otherwise the current code: both are the supported normalization path.
  const pinned = process.env.PINNED_RUNNER_DIR;
  const from = (rel) => (pinned ? import(pathToFileURL(`${pinned}/scripts/${rel}`).href) : import(`../${rel}`));
  const { pgSite } = await from("person-trial.mjs");
  const { reconcilePage } = await from("person-reconcile.mjs");
  const lib = await from("dist/worker-lib.mjs");
  return { pgSite, reconcilePage, lib, pinned: !!pinned };
}

export function operatorPool(env = process.env) {
  const config = databaseConfig(env, "tt-tenancy-armed"); // selected-project checks included
  return new pg.Pool({ ...config, max: 2 });
}

/** Normalize and anchor the fixture's pool people while disabled, then arm. */
export async function armForSweep({ runId, candidateIds }, env = process.env) {
  if (!RUN.test(runId)) throw Error("tenancy_armed_run");
  if (!Array.isArray(candidateIds) || !candidateIds.length) throw Error("tenancy_armed_people");
  const pool = operatorPool(env);
  const report = { controller: null, reconciled: 0, anchored: 0, pinned: false };
  try {
    const status = await transitionStatus(pool);
    if (status.enabled) throw Error("tenancy_armed_precondition:controller_enabled");
    // 1. Baseline reconciliation of exactly the fixture people (queue scope covers the
    //    captured inserts; a 'leaktest' source is a legacy import like any other).
    const r = await runner();
    report.pinned = r.pinned;
    const url = env.LOCAL_DATABASE_URL ?? env.PERSON_PUBLISH_DATABASE_URL;
    const site = await r.pgSite(url);
    try {
      const run = `tenancy-${runId}`;
      await site.rpc("person_reconcile_start", { p_run: run, p_commit: PIN, p_limit: 1000, p_batch: 100, p_resume: false, p_scope: "queue", p_external_hash: "1".repeat(32) });
      let page;
      while ((page = await site.rpc("person_reconcile_page", { p_run: run, p_size: 100 }))?.length) {
        await r.reconcilePage({ site, lib: r.lib, config: { run, dry: false }, page });
      }
      const verified = (await pool.query("select count(*)::int n from person_reconcile_people where run_id=$1 and status='verified' and candidate_id=any($2::uuid[])", [run, candidateIds])).rows[0].n;
      if (verified !== candidateIds.length) throw Error(`tenancy_armed_reconcile:${verified}/${candidateIds.length}`);
      report.reconciled = verified;
    } finally {
      await site.end?.();
    }
    // 2. Anchors (the audit's immutable before-images) for the same people.
    const anchors = await openAnchorDatabase(env);
    try {
      const result = await prepareAnchors({ site: anchors, prepare: r.lib.prepareLegacyAuditAnchor, options: { save: true, limit: 100000, batch: 50, after: null, maxSeconds: 600, maxBytes: 1e12 }, onProgress: () => {} });
      report.anchored = result.created ?? 0;
    } finally {
      await anchors.end();
    }
    const missing = (await pool.query("select count(*)::int n from unnest($1::uuid[]) id where not exists(select 1 from person_audit_anchors a where a.candidate_id=id)", [candidateIds])).rows[0].n;
    if (missing) throw Error(`tenancy_armed_anchors:${missing}`);
    // 3. Arm. The probes run with the controller enabled and open.
    await setTransition(pool, "arm", "tenancy_sweep_arm", "disabled");
    report.controller = await transitionStatus(pool);
    if (!report.controller.enabled || report.controller.phase !== "open") throw Error("tenancy_armed_state");
    return report;
  } finally {
    await pool.end();
  }
}

/** Drain, seal and disarm so the fixture's raw teardown is admitted again. Every
 * window the probes may have left open is closed explicitly first. */
export async function disarmAfterSweep(env = process.env) {
  const pool = operatorPool(env);
  try {
    const status = await transitionStatus(pool);
    if (!status.enabled) return { controller: status, skipped: true };
    if (status.phase === "open") await setTransition(pool, "drain", "tenancy_sweep_drain", "open");
    for (const w of (await transitionStatus(pool)).windows) await closeWindow(pool, w.work_id, "tenancy_sweep_close");
    const drained = await waitDrained(pool, { maxSeconds: 60 });
    if (!drained.drained) throw Error(`tenancy_armed_drain:${JSON.stringify(drained.unresolved)}`);
    if ((await transitionStatus(pool)).phase === "draining") await setTransition(pool, "seal", "tenancy_sweep_seal", "draining");
    await setTransition(pool, "disarm", "tenancy_sweep_disarm", "held");
    return { controller: await transitionStatus(pool), skipped: false };
  } finally {
    await pool.end();
  }
}

/** The controller as the deployment sees it, through REST (service role). */
export async function controllerViaRest(svc) {
  return svc("rpc/person_transition_status", { method: "POST", body: "{}" });
}
