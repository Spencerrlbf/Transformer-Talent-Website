// Armed-controller mode for the cross-organization leak test (RR-14 adaptation).
//
// The fixture seeds its three fake pool people with raw service-role inserts, the
// way the pool was filled before the controller existed. An armed controller
// rightly refuses raw candidate writes (candidate_mutation_frame), so the sweep used
// to crash at setup. This module keeps the fixture's seeding and teardown in the
// controller's DISABLED state and puts the controller through its supported
// operator sequence around the probes:
//
//   preflight (target + identity + controller disabled, before any fixture write)
//   -> setup (disabled) -> baseline reconcile of the fixture people -> anchors
//   -> arm (open) -> [the sweep's authenticated route probes run armed]
//   -> drain -> seal -> disarm -> teardown (disabled)
//
// Only the probes are the armed-state acceptance; seeding/teardown are labelled
// disabled. Requires the whole release chain in the target database and a direct
// PostgreSQL URL for the operator steps (PERSON_PUBLISH_DATABASE_URL, 5432),
// validated against PERSON_TARGET_PROJECT_REF like every other operator CLI.
//
// Ownership (R2-02). Every controller change this module makes is a compare-and-set
// against the exact revision/generation produced by its own previous change
// (person_private.transition_set). Cleanup requires that ownership record; without
// one, or when another operator has moved the controller since, nothing is changed
// and the unresolved state is reported. Only maintenance windows opened under this
// sweep's run id may be closed. A lost acknowledgement is resolved only from the
// durable transition_events row this sweep's unique reason code wrote, never guessed
// from `enabled=true`.
import { pathToFileURL } from "node:url";
import { openDatabase } from "../person-publish/lib.mjs";
import { transitionStatus, waitDrained } from "../person-transition.mjs";
import { openAnchorDatabase } from "../person-audit/database.mjs";
import { prepareAnchors } from "../person-audit-anchors.mjs";
import { checkTargetEnvironment, verifyRuntimeIdentity, IDENTITY_SQL } from "../person-target.mjs";

const PIN = "c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc";
const RUN = /^[a-zA-Z0-9_-]{1,100}$/;
const DIGITS = /^[0-9]{1,19}$/;
const CONTROL_SQL = "select enabled,phase,revision::text revision,generation::text generation from person_private.transition_control where singleton";
const fail = (code, detail) => Object.assign(Error(detail ? `${code}:${detail}` : code), { code });

async function runner() {
  // The historical pinned runner when its checkout is available (as in production),
  // otherwise the current code: both are the supported normalization path.
  const pinned = process.env.PINNED_RUNNER_DIR;
  const from = (rel) => (pinned ? import(pathToFileURL(`${pinned}/scripts/${rel}`).href) : import(`../${rel}`));
  // The translator (reconcilePage + its worker library) is the pinned one; the
  // PostgreSQL access shim is always the current pgSite, a superset of the pinned one
  // (optional `limit`) whose pool handles idle-connection errors (review R2-05).
  const { pgSite } = await import("../person-trial.mjs");
  const { reconcilePage } = await from("person-reconcile.mjs");
  const lib = await from("dist/worker-lib.mjs");
  // Anchors are prepared by the current audit code (the pinned translator predates them).
  const current = await import("../dist/worker-lib.mjs");
  return { pgSite, reconcilePage, lib, current, pinned: !!pinned };
}

/** The hardened operational adapter (R2-05): pool error listener, checkout-time
 * statement timeout, broken-client disposal, bounded connection waits; the URL is
 * validated against the selection before the pool exists. */
export function operatorPool(env = process.env) {
  return openDatabase(env, "tt-tenancy-armed");
}

/** The sweep's own reason codes: unique per run and action so a lost acknowledgement
 * can be resolved from transition_events without guessing. */
export function sweepReason(action, runId) {
  if (!RUN.test(runId)) throw fail("tenancy_armed_run");
  const suffix = runId.toLowerCase().replace(/[^a-z0-9]/g, "_");
  const reason = `tenancy_sweep_${action}_${suffix}`;
  if (!/^[a-z0-9_]{1,80}$/.test(reason)) throw fail("tenancy_armed_run");
  return reason;
}

const control = async (db) => (await db.query(CONTROL_SQL)).rows[0];
const phaseOf = (c) => (c.enabled ? c.phase : "disabled");
const publicState = (c) => ({ enabled: c.enabled, phase: c.phase, revision: c.revision, generation: c.generation });

/** The database this sweep is about to write to, proved through both of the
 * fixture's clients: the PostgreSQL URL and the REST URL must name the selected
 * project offline and report the same cluster at run time. Does not attest the
 * deployed server, which has its own configuration. */
export async function verifySweepTarget(env = process.env, { svc } = {}) {
  const url = env.LOCAL_DATABASE_URL ?? env.PERSON_PUBLISH_DATABASE_URL;
  const report = checkTargetEnvironment(env, { restUrl: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, databaseUrls: [url], ports: ["5432"] });
  const db = await operatorPool(env);
  try {
    const identity = await verifyRuntimeIdentity({
      readDatabase: async () => (await db.query(IDENTITY_SQL)).rows[0].identity,
      readRest: svc ? () => svc("rpc/person_target_identity", { method: "POST", body: "{}" }) : undefined,
    });
    return { target: report.ref, local: report.local, system_identifier: identity.system_identifier, rest_checked: !!svc };
  } finally {
    await db.end();
  }
}

/** Everything that must hold BEFORE the fixture writes a row: the target is proved
 * (above) and the controller is disabled with no unresolved maintenance work that
 * this sweep would otherwise have to touch. Returns the target proof and the
 * controller state observed, so the arm can be compared against it. */
export async function preflightArmedSweep(env = process.env, { svc } = {}) {
  const target = await verifySweepTarget(env, { svc });
  const db = await operatorPool(env);
  try {
    const status = await transitionStatus(db);
    if (status.enabled) throw fail("tenancy_armed_precondition", "controller_enabled");
    if (status.windows.length) throw fail("tenancy_armed_precondition", "maintenance_windows");
    // Deferred (parked) work counts as resolved for the controller, as for seal/disarm.
    if (status.unresolved.some((u) => u.status !== "deferred")) throw fail("tenancy_armed_precondition", "unresolved_work");
    const c = await control(db);
    return { ...target, controller: publicState(c) };
  } finally {
    await db.end();
  }
}

/** One owned controller change: the CAS uses exactly the revision/generation this
 * sweep recorded; the post-change values are read in the same transaction (the
 * function's advisory lock is held until commit, so they are ours). A lost commit
 * acknowledgement is resolved from the durable event row or reported unresolved. */
async function ownedTransition(db, ownership, action) {
  const reason = sweepReason(action, ownership.run);
  const client = await db.connect();
  let committed = false, inDoubt = false;
  try {
    await client.query("begin");
    await client.query("select person_private.transition_set($1,$2::bigint,$3::bigint,$4)", [action, ownership.revision, ownership.generation, reason]);
    const after = await control(client);
    try { await client.query("commit"); committed = true; } catch (error) { inDoubt = true; throw error; }
    return advance(ownership, after, action);
  } catch (error) {
    if (!committed && !inDoubt) await client.query("rollback").catch(() => {});
    if (/^transition_(stale|state|unresolved|isolation|input)$/.test(error?.message ?? "")) throw fail("tenancy_armed_ownership", error.message.replace("transition_", ""));
    if (inDoubt) {
      const recovered = await recoverFromEvents(db, ownership, action).catch(() => null);
      if (recovered) return recovered;
      throw fail("tenancy_armed_ownership", `in_doubt_${action}`);
    }
    throw error;
  } finally {
    client.release(inDoubt ? Error("in_doubt") : undefined);
  }
}
function advance(ownership, after, action) {
  if (!DIGITS.test(after.revision) || !DIGITS.test(after.generation)) throw fail("tenancy_armed_ownership", "revision");
  return { ...ownership, revision: after.revision, generation: after.generation, phase: phaseOf(after), last_action: action };
}
/** Durable evidence of this sweep's own change: exactly one transition_events row
 * with the sweep's unique reason code. Anything else is unresolved. */
export async function recoverFromEvents(db, ownership, action) {
  const reason = sweepReason(action, ownership.run);
  const rows = (await db.query("select revision::text revision,generation::text generation from person_private.transition_events where action=$1 and reason_code=$2", [action, reason])).rows;
  if (rows.length !== 1) return null;
  const c = await control(db);
  // The event proves our change happened; the control row tells whether anyone moved
  // it since (then the ownership is stale and cleanup must stop).
  if (c.revision !== rows[0].revision) return null;
  return advance(ownership, c, action);
}

/** Normalize and anchor the fixture's pool people while disabled, then arm. The
 * ownership record is handed to `onOwnership` the moment the arm commits, before
 * any later step can fail, so the caller can always undo exactly what it did. */
export async function armForSweep({ runId, candidateIds, preflight, onOwnership }, env = process.env) {
  if (!RUN.test(runId)) throw fail("tenancy_armed_run");
  if (!Array.isArray(candidateIds) || !candidateIds.length) throw fail("tenancy_armed_people");
  sweepReason("arm", runId);
  const db = await operatorPool(env);
  const report = { controller: null, reconciled: 0, anchored: 0, pinned: false, ownership: null };
  try {
    const identity = (await db.query(IDENTITY_SQL)).rows[0].identity?.system_identifier ?? null;
    if (preflight && String(preflight.system_identifier) !== String(identity)) throw fail("tenancy_armed_precondition", "database_changed");
    let c = await control(db);
    if (c.enabled) throw fail("tenancy_armed_precondition", "controller_enabled");
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
      const verified = (await db.query("select count(*)::int n from person_reconcile_people where run_id=$1 and status='verified' and candidate_id=any($2::uuid[])", [run, candidateIds])).rows[0].n;
      if (verified !== candidateIds.length) throw fail("tenancy_armed_reconcile", `${verified}/${candidateIds.length}`);
      report.reconciled = verified;
    } finally {
      await site.end?.();
    }
    // 2. Anchors (the audit's immutable before-images) for the same people.
    const anchors = await openAnchorDatabase(env);
    try {
      const result = await prepareAnchors({ site: anchors, prepare: r.current.prepareLegacyAuditAnchor, options: { save: true, limit: 100000, batch: 50, after: null, maxSeconds: 600, maxBytes: 1e12 }, onProgress: () => {} });
      report.anchored = result.created ?? 0;
    } finally {
      await anchors.end();
    }
    const missing = (await db.query("select count(*)::int n from unnest($1::uuid[]) id where not exists(select 1 from person_audit_anchors a where a.candidate_id=id)", [candidateIds])).rows[0].n;
    if (missing) throw fail("tenancy_armed_anchors", String(missing));
    // 3. Arm, as a CAS against the disabled state read a moment ago; a controller
    //    somebody enabled meanwhile fails the CAS and nothing is changed.
    c = await control(db);
    if (c.enabled) throw fail("tenancy_armed_precondition", "controller_enabled");
    const ownership = await ownedTransition(db, { database: identity, run: runId, revision: c.revision, generation: c.generation, phase: "disabled" }, "arm");
    report.ownership = ownership;
    onOwnership?.(ownership);
    report.controller = await transitionStatus(db);
    if (!report.controller.enabled || report.controller.phase !== "open") throw fail("tenancy_armed_state");
    return report;
  } finally {
    await db.end();
  }
}

/** When the arm's acknowledgement was lost before the caller recorded ownership:
 * the durable event this sweep's unique reason wrote proves the arm happened, and
 * the control row must still carry exactly that revision. Returns the ownership
 * record, `null` when this sweep never armed (no event), or throws when the event
 * exists but the controller has moved since (unresolved: nothing may be changed). */
export async function recoverArmOwnership({ runId, database }, env = process.env) {
  if (!RUN.test(runId)) throw fail("tenancy_armed_run");
  const db = await operatorPool(env);
  try {
    const identity = (await db.query(IDENTITY_SQL)).rows[0].identity?.system_identifier ?? null;
    if (database !== undefined && String(identity) !== String(database)) throw fail("tenancy_armed_ownership", "database");
    const rows = (await db.query("select revision::text revision,generation::text generation from person_private.transition_events where action='arm' and reason_code=$1", [sweepReason("arm", runId)])).rows;
    if (!rows.length) return null;
    const c = await control(db);
    if (rows.length !== 1 || c.revision !== rows[0].revision) throw fail("tenancy_armed_ownership", `unresolved_arm:${phaseOf(c)}:${c.revision}:${c.generation}`);
    return { database: identity, run: runId, revision: c.revision, generation: c.generation, phase: phaseOf(c), last_action: "arm" };
  } finally {
    await db.end();
  }
}

/** Drain, seal and disarm the controller THIS sweep armed, so the fixture's raw
 * teardown is admitted again. Requires the ownership record from `armForSweep`;
 * every step is a CAS on that record. Windows are closed only when this sweep's run
 * opened them. Any foreign change, foreign window or unresolved work stops the
 * sequence and is reported; nothing is forced. */
export async function disarmAfterSweep({ ownership } = {}, env = process.env) {
  if (!ownership || !RUN.test(ownership.run ?? "") || !DIGITS.test(ownership.revision ?? "") || !DIGITS.test(ownership.generation ?? "") || !ownership.database)
    throw fail("tenancy_armed_ownership", "missing");
  const db = await operatorPool(env);
  const steps = [];
  try {
    const identity = (await db.query(IDENTITY_SQL)).rows[0].identity?.system_identifier ?? null;
    if (String(identity) !== String(ownership.database)) throw fail("tenancy_armed_ownership", "database");
    let own = ownership;
    let c = await control(db);
    // Our last acknowledged change must be the current state; anything else means
    // another operator moved the controller since, and this sweep owns nothing now.
    if (c.revision !== own.revision || c.generation !== own.generation) throw fail("tenancy_armed_ownership", `stale:${phaseOf(c)}:${c.revision}:${c.generation}`);
    if (!c.enabled) return { controller: await transitionStatus(db), steps, skipped: true, ownership: own };
    const run = `tenancy-${own.run}`;
    const status = await transitionStatus(db);
    const foreign = status.windows.filter((w) => w.run_id !== run);
    if (foreign.length) throw fail("tenancy_armed_ownership", `foreign_windows:${foreign.length}`);
    if (phaseOf(c) === "open") { own = await ownedTransition(db, own, "drain"); steps.push("drain"); }
    for (const w of status.windows) {
      await db.query("select person_private.maintenance_close($1,$2)", [w.work_id, sweepReason("close", own.run)]);
      steps.push(`close:${w.work_id}`);
    }
    const drained = await waitDrained(db, { maxSeconds: 60 });
    if (!drained.drained) throw fail("tenancy_armed_drain", JSON.stringify(drained.stuck ?? drained.live));
    c = await control(db);
    if (phaseOf(c) === "draining") { own = await ownedTransition(db, own, "seal"); steps.push("seal"); }
    own = await ownedTransition(db, own, "disarm"); steps.push("disarm");
    return { controller: await transitionStatus(db), steps, skipped: false, ownership: own };
  } catch (error) {
    error.steps = steps;
    throw error;
  } finally {
    await db.end();
  }
}

/** The controller as the deployment sees it, through REST (service role). */
export async function controllerViaRest(svc) {
  return svc("rpc/person_transition_status", { method: "POST", body: "{}" });
}
