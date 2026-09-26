import assert from "node:assert/strict";
import { test } from "node:test";
import { runNormalizedRefresh } from "./worker.mjs";
const org = "801865a7-6533-41d2-9c45-e4a90e6ad51a";
async function run({
  needsHarvest = false,
  saveFails = false,
  harvestFails = false,
  derivativeFails = false,
  phase = "claimed",
  mode = "live",
  organizationId = org,
} = {}) {
  const calls = [];
  const lib = {
    TT_ORG_ID: org,
    pickRefreshRows: async (a) => {
      assert.equal(a.organizationId, org);
      calls.push(["pick", a]);
      return a.status === "queued"
        ? [{ id: "queue", candidate_id: "person" }]
        : [];
    },
    claimRefresh: async (a) => {
      calls.push(["claim", a]);
      return {
        status: phase,
        token: "token",
        queueId: "queue",
        candidateId: "person",
        needsHarvest,
        linkedinUrl: "https://www.linkedin.com/in/synthetic",
      };
    },
    storeRefreshPayload: async (a) => calls.push(["store", a]),
    saveRefresh: async (a) => {
      calls.push(["save", a]);
      if (saveFails) throw Error("private source detail");
      return { status: "done", semanticChanged: true };
    },
    failRefresh: async (a) => calls.push(["fail", a]),
    claimRefreshDerivatives: async (a) => {
      calls.push(["derivativeClaim", a]);
      return mode === "live" ? { candidateId: "person" } : null;
    },
    poolProfileText: (c) => c.headline,
    syncCandidateEmbeddings: async (id, payload) => {
      calls.push(["embed", { id, payload }]);
      if (derivativeFails) throw Error("private source detail");
    },
  };
  const rest = async (path) => {
    calls.push(["rest", path]);
    if (path.startsWith("refresh_queue?")) {
      assert.ok(path.includes(`organization_id=eq.${org}`));
      return path.includes("status=eq.queued")
        ? [{ id: "queue", candidate_id: "person" }]
        : [];
    }
    if (path.startsWith("candidates?"))
      return [{ id: "person", headline: "Canonical winning profile" }];
    throw Error("unexpected path");
  };
  const stats = await runNormalizedRefresh({
    lib,
    rest,
    organizationId,
    mode,
    dailyCap: 0,
    allowPaid: true,
    noTopup: true,
    concurrency: 2,
    harvestProfile: async () => {
      calls.push(["harvest"]);
      if (harvestFails) throw Error("private source detail");
      return { headline: "Fresh fetch" };
    },
    log: () => {},
    warn: () => {},
  });
  return { calls, stats };
}
test("free cached work still saves with no paid budget and scopes the queue", async () => {
  const { calls, stats } = await run();
  assert.equal(stats.refreshed, 1);
  assert.equal(calls.filter((c) => c[0] === "harvest").length, 0);
  assert.deepEqual(calls.find((c) => c[0] === "embed")[1].payload, {
    linkedin_profile: "Canonical winning profile",
  });
});
test("fresh payload persists before normalization, and failed saves use durable recovery", async () => {
  const { calls, stats } = await run({ needsHarvest: true, saveFails: true });
  assert.equal(stats.failed, 1);
  const names = calls.map((c) => c[0]);
  assert.ok(names.indexOf("store") < names.indexOf("save"));
  assert.ok(names.indexOf("save") < names.indexOf("fail"));
  assert.equal(names.filter((n) => n === "harvest").length, 1);
  assert.equal(names.includes("embed"), false);
});
test("uncertain enrichment requests do not retry the paid call in orchestration", async () => {
  const { calls, stats } = await run({
    needsHarvest: true,
    harvestFails: true,
  });
  assert.equal(stats.failed, 1);
  assert.equal(calls.filter((c) => c[0] === "harvest").length, 1);
  assert.equal(calls.filter((c) => c[0] === "fail").length, 1);
});
test("completed and shadow receipts avoid repeated paid derivative work", async () => {
  assert.equal(
    (await run({ phase: "done" })).calls.some(
      (c) => c[0] === "save" || c[0] === "embed",
    ),
    false,
  );
  assert.equal(
    (await run({ mode: "shadow" })).calls.some((c) => c[0] === "embed"),
    false,
  );
});
test("derivative failure leaves an already committed profile done", async () => {
  const { calls, stats } = await run({ derivativeFails: true });
  assert.equal(stats.refreshed, 1);
  assert.equal(stats.failed, 0);
  assert.equal(stats.derivativeFailed, 1);
  assert.equal(
    calls.some((c) => c[0] === "fail"),
    false,
  );
});
test("another organization cannot invoke pool refresh", async () => {
  await assert.rejects(run({ organizationId: "tenant" }));
});
