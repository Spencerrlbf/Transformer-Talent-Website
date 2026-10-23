import test from "node:test";
import assert from "node:assert/strict";
import {
  runDirectory,
  requireDirectoryExecution,
} from "../person-directory/worker.mjs";
const saved = process.env.PERSON_TRANSITION_SUPPORT;
test.beforeEach(() => {
  process.env.PERSON_TRANSITION_SUPPORT = "on";
});
test.after(() => {
  if (saved === undefined) delete process.env.PERSON_TRANSITION_SUPPORT;
  else process.env.PERSON_TRANSITION_SUPPORT = saved;
});
function fixture() {
  const calls = [],
    checkpoints = [],
    contact = "10000000-0000-4000-8000-000000000001",
    snapshot = { board: { contact_id: contact } },
    key = { organizationId: "tt", workspaceId: "ws" };
  const lib = {
    TT_ORG_ID: "tt",
    directoryDocuments: () => [],
    claimDirectoryScan: async () => ({
      status: "claimed",
      token: "lease",
      cursor: "0",
    }),
    checkpointDirectoryScan: async (a) => checkpoints.push(a),
    pendingDirectoryReceipts: async () => [],
    inspectDirectoryPage: async () => [
      { contactId: contact, receiptId: "1", phase: "ready" },
    ],
    stageDirectory: async () => ({ receiptId: "1", phase: "ready" }),
    readCertifiedDirectoryCurrent: async () => ({ status: "ready" }),
    saveDirectory: async () => {
      throw Error("legacy_write");
    },
    saveCertifiedDirectory: async (a) => {
      calls.push(a);
      return { status: "done", candidateId: "person", reviewCount: 0 };
    },
  };
  const reader = {
    page: async (cursor) => (cursor === "0" ? [contact] : []),
    snapshots: async () => new Map([[contact, snapshot]]),
  };
  return { lib, reader, calls, checkpoints, contact, key };
}
test("support-on dry run calls no website functions and no paid provider", async () => {
  const f = fixture();
  for (const name of Object.keys(f.lib))
    if (!["TT_ORG_ID", "directoryDocuments"].includes(name))
      f.lib[name] = async () => {
        throw Error("unexpected_write");
      };
  assert.equal(
    (
      await runDirectory({
        ...f,
        workspaceId: "ws",
        mode: "live",
        dry: true,
        limit: 1,
      })
    ).read,
    1,
  );
  assert.equal(f.calls.length, 0);
});
test("recovered review and changed-source overlap execute each receipt only once", async () => {
  const f = fixture();
  let pending = 0;
  f.lib.pendingDirectoryReceipts = async () => (pending++ ? [] : ["1"]);
  f.lib.inspectDirectoryPage = async () => [
    {
      contactId: f.contact,
      receiptId: "1",
      phase: "ready",
      pendingPrevious: true,
    },
  ];
  f.lib.stageDirectory = async () => ({ receiptId: "2", phase: "ready" });
  f.lib.saveCertifiedDirectory = async (a) => {
    f.calls.push(a);
    return a.receiptId === "1"
      ? { status: "review", reason: "held" }
      : { status: "done", reviewCount: 0 };
  };
  const out = await runDirectory({
    ...f,
    workspaceId: "ws",
    mode: "live",
    limit: 5,
  });
  assert.deepEqual(
    f.calls.map((x) => x.receiptId),
    ["1", "2"],
  );
  assert.notEqual(f.calls[0].executionId, f.calls[1].executionId);
  assert.equal(f.calls[0].workspaceId, "ws");
  assert.equal(out.review, 1);
  assert.equal(out.saved, 1);
  assert.equal(out.read, 1);
  assert.equal(f.checkpoints.at(-1).cursor, f.contact);
});
test("certified save failure cannot advance the source cursor", async () => {
  const f = fixture();
  f.lib.saveCertifiedDirectory = async () => {
    throw Error("synthetic_save_failure");
  };
  await assert.rejects(
    runDirectory({ ...f, workspaceId: "ws", mode: "live", limit: 2 }),
    /synthetic_save_failure/,
  );
  assert.equal(f.checkpoints.at(-1).cursor, "0");
  assert.equal(f.checkpoints.at(-1).complete, false);
});
test("persistent pending predecessor stops after bounded staging without duplicate execution", async () => {
  const f = fixture();
  f.lib.inspectDirectoryPage = async () => [
    {
      contactId: f.contact,
      receiptId: "1",
      phase: "ready",
      pendingPrevious: true,
    },
  ];
  let stages = 0;
  f.lib.stageDirectory = async () => {
    stages++;
    return { receiptId: "1", phase: "ready", pendingPrevious: true };
  };
  await assert.rejects(
    runDirectory({ ...f, workspaceId: "ws", mode: "live", limit: 2 }),
    /person_directory_pending_receipt/,
  );
  assert.equal(stages, 2);
  assert.equal(f.calls.length, 1);
  assert.equal(f.checkpoints.at(-1).cursor, "0");
});
test("held scan makes no source read or execution", async () => {
  const f = fixture();
  f.lib.claimDirectoryScan = async () => ({ status: "held" });
  f.reader.page = async () => {
    throw Error("source_read");
  };
  assert.deepEqual(
    await runDirectory({ ...f, workspaceId: "ws", mode: "live" }),
    { status: "held" },
  );
  assert.equal(f.calls.length, 0);
});
test("support-on legacy and malformed configuration fail closed", () => {
  assert.throws(
    () => requireDirectoryExecution("legacy"),
    /person_directory_execution_unavailable/,
  );
  process.env.PERSON_TRANSITION_SUPPORT = "yes";
  assert.throws(
    () => requireDirectoryExecution("live"),
    /transition_configuration/,
  );
});
