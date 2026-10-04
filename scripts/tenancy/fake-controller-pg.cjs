// Test double for `pg` that behaves like the transition controller's SQL surface
// (person_private.transition_set CAS rules, transition_events, maintenance windows,
// person_target_identity) without any socket. Installed into require.cache before
// the code under test imports `pg`, in-process or through --require in a sealed
// child. Every controller mutation is appended to the action log so a test can
// assert "zero unauthorized transitions". Everything here is synthetic.
const { EventEmitter } = require("node:events");
const fs = require("node:fs");

let current = null, hooks = {}, installed = false;
const log = (line) => { current.actions.push(line); if (hooks.logFile) fs.appendFileSync(hooks.logFile, line + "\n"); };
const status = () => ({ enabled: current.control.enabled, phase: current.control.phase, generation: Number(current.control.generation), revision: Number(current.control.revision), active: 0, expired: 0, uncertain: 0 });

function transitionSet(action, revision, generation, reason) {
  const c = current.control;
  if (String(revision) !== c.revision || String(generation) !== c.generation) throw Object.assign(Error("transition_stale"), { code: "P0001" });
  let phase = c.phase, enabled = c.enabled, gen = BigInt(c.generation);
  if (action === "arm" && !c.enabled && c.phase === "open") { enabled = true; gen += 1n; }
  else if (action === "drain" && c.enabled && c.phase === "open") phase = "draining";
  else if (action === "seal" && c.enabled && c.phase === "draining") { phase = "held"; gen += 1n; }
  else if (action === "reopen" && c.enabled && ["held", "draining"].includes(c.phase)) { phase = "open"; gen += 1n; }
  else if (action === "disarm" && c.enabled && c.phase === "held") { phase = "open"; enabled = false; gen += 1n; }
  else throw Object.assign(Error("transition_state"), { code: "P0001" });
  if (action !== "drain" && current.unresolved.some((u) => u.status !== "deferred")) throw Object.assign(Error("transition_unresolved"), { code: "P0001" });
  const rev = (BigInt(c.revision) + 1n).toString();
  current.control = { enabled, phase, revision: rev, generation: gen.toString() };
  current.events.push({ action, reason_code: reason, revision: rev, generation: gen.toString() });
  log(`transition_set ${action} ${revision} ${generation} ${reason}`);
  return status();
}

class FakeClient extends EventEmitter {
  constructor(pool) { super(); this.pool = pool; this.tx = null; }
  async query(text, values = []) {
    const sql = typeof text === "string" ? text : text.text;
    (hooks.onQuery ?? current.onQuery)?.(sql, values);
    if (/^\s*select 1\s*$/i.test(sql)) return { rows: [{ "?column?": 1 }] };
    if (/^\s*set /i.test(sql)) return { rows: [] };
    if (/^\s*begin/i.test(sql)) { this.tx = { snapshot: JSON.stringify(current) }; return { rows: [] }; }
    if (/^\s*commit/i.test(sql)) {
      this.tx = null;
      if (current.failCommits > 0) { current.failCommits--; log("commit_ack_lost"); current.onLostCommit?.(current); throw Object.assign(Error("connection terminated"), { code: "08006" }); }
      return { rows: [] };
    }
    if (/^\s*rollback/i.test(sql)) {
      if (this.tx) { const restore = JSON.parse(this.tx.snapshot); current.control = restore.control; current.events = restore.events; current.windows = restore.windows; log("rollback"); }
      this.tx = null; return { rows: [] };
    }
    if (sql.includes("person_target_identity()")) return { rows: [{ identity: { system_identifier: current.identity } }] };
    if (sql.includes("from person_private.transition_control where singleton")) return { rows: [{ ...current.control }] };
    if (sql.includes("person_transition_status()")) return { rows: [{ s: status() }] };
    if (sql.includes("maintenance_events e on e.work_id")) return { rows: current.windows.map((w) => ({ ...w })) };
    if (sql.includes("scope='tt_person' and status<>'completed' group by")) return { rows: current.unresolved.map((u) => ({ ...u })) };
    if (sql.includes("person_private.transition_set(")) return { rows: [{ r: transitionSet(values[0], values[1], values[2], values[3]) }] };
    if (sql.includes("person_private.maintenance_close(")) {
      const [workId, reason] = values;
      current.windows = current.windows.filter((w) => w.work_id !== workId);
      log(`maintenance_close ${workId} ${reason}`);
      return { rows: [{ r: { status: "completed" } }] };
    }
    if (sql.includes("from person_private.transition_events where action='arm' and reason_code=")) {
      return { rows: current.events.filter((e) => e.action === "arm" && e.reason_code === values[0]).map((e) => ({ revision: e.revision, generation: e.generation })) };
    }
    if (sql.includes("from person_private.transition_events where action=")) {
      const [action, reason] = values;
      return { rows: current.events.filter((e) => e.action === action && e.reason_code === reason).map((e) => ({ revision: e.revision, generation: e.generation })) };
    }
    log(`unexpected_sql ${sql.slice(0, 60).replace(/\s+/g, " ")}`);
    throw Object.assign(Error("fake_pg_unexpected_sql"), { code: "42601" });
  }
  release(error) { if (error) { this.destroyed = true; return; } this.pool.idle.push(this); } // pg destroys a client released with an error
}
class FakePool extends EventEmitter {
  constructor(config) { super(); this.config = config; this.idle = []; this.ended = false; current.pools++; current.lastConfig = config; current.lastPool = this; }
  async connect() { if (this.ended) throw Error("pool_ended"); const c = this.idle.pop() ?? new FakeClient(this); current.lastClient = c; return c; }
  async query(...args) { const c = await this.connect(); try { return await c.query(...args); } finally { c.release(); } }
  async end() { this.ended = true; }
}
const pg = { Pool: FakePool, Client: FakeClient };

function install({ state, logFile = process.env.SIM_LOG, onQuery } = {}) {
  const sim = state ?? JSON.parse(process.env.SIM_STATE ?? "{}");
  current = sim; hooks = { logFile, onQuery };
  sim.identity ??= "7000000000000000001";
  sim.control ??= { enabled: false, phase: "open", revision: "1", generation: "1" };
  sim.windows ??= [];
  sim.events ??= [];
  sim.unresolved ??= [];
  sim.actions = [];
  sim.pools = 0;
  sim.failCommits = sim.failCommits ?? 0; // commits whose acknowledgement is "lost" after applying
  if (!installed) {
    const id = require.resolve("pg");
    require.cache[id] = { id, filename: id, loaded: true, exports: Object.assign(pg, { default: pg }) };
    installed = true;
  }
  return sim;
}
module.exports = { install };
