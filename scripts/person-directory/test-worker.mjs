import assert from "node:assert/strict";
import { test } from "node:test";
let worker;
try {
  worker = await import("./worker.mjs");
} catch (e) {
  if (e.code !== "ERR_MODULE_NOT_FOUND") throw e;
}
await test("normalized directory worker exists", () =>
  assert.equal(typeof worker?.runDirectory, "function"));
if (!worker) throw Error("directory_worker_missing");
const fixture = () => {
  const state = { calls: [], cursor: "0", read: 0, staged: 0, complete: false };
  const lib = {
    TT_ORG_ID: "tt",
    directoryDocuments: () => [],
    claimDirectoryScan: async () => ({
      status: "claimed",
      token: "lease",
      cursor: state.cursor,
    }),
    stageDirectory: async (a) => {
      state.calls.push("stage");
      state.staged++;
      return {
        receiptId: String(state.staged),
        phase: "ready",
        projected: false,
      };
    },
    saveDirectory: async (a) => {
      state.calls.push("save");
      return { status: "done", candidateId: a.receiptId, reviewCount: 0 };
    },
    checkpointDirectoryScan: async (a) => {
      state.calls.push("checkpoint");
      state.cursor = a.cursor;
      state.complete = !!a.complete;
    },
  };
  const reader = {
    page: async (cursor) => (cursor === "0" ? ["1", "2"] : []),
    snapshots: async (ids) => {
      state.read++;
      return new Map(ids.map((id) => [id, { board: { contact_id: id } }]));
    },
  };
  return { state, lib, reader };
};
await test("each snapshot is durably staged before save and cursor advances after bounded limit", async () => {
  const f = fixture();
  const result = await worker.runDirectory({
    ...f,
    workspaceId: "ws",
    mode: "live",
    limit: 1,
  });
  assert.deepEqual(f.state.calls, ["stage", "save", "checkpoint"]);
  assert.equal(f.state.cursor, "1");
  assert.equal(f.state.complete, false);
  assert.equal(result.read, 1);
});
await test("save failure leaves receipt retryable and cursor before the failed contact", async () => {
  const f = fixture();
  f.lib.saveDirectory = async () => {
    throw Error("synthetic_failure");
  };
  await assert.rejects(
    worker.runDirectory({ ...f, workspaceId: "ws", mode: "live", limit: 2 }),
    /synthetic_failure/,
  );
  assert.equal(f.state.staged, 1);
  assert.equal(f.state.cursor, "0");
});
await test("dry run opens no website scan or write and respects limit", async () => {
  const f = fixture();
  for (const key of [
    "claimDirectoryScan",
    "stageDirectory",
    "saveDirectory",
    "checkpointDirectoryScan",
  ])
    f.lib[key] = async () => {
      throw Error("unexpected_write");
    };
  const result = await worker.runDirectory({
    ...f,
    workspaceId: "ws",
    mode: "live",
    dry: true,
    limit: 1,
  });
  assert.equal(result.read, 1);
  assert.equal(f.state.staged, 0);
});
await test("unchanged completed live receipt skips saving; shadow receipt still projects", async () => {
  const f = fixture();
  f.lib.stageDirectory = async () => ({
    receiptId: "same",
    phase: "done",
    projected: true,
  });
  f.lib.saveDirectory = async () => {
    throw Error("unnecessary_save");
  };
  assert.equal(
    (
      await worker.runDirectory({
        ...f,
        workspaceId: "ws",
        mode: "live",
        limit: 1,
      })
    ).unchanged,
    1,
  );
  const g = fixture();
  g.lib.stageDirectory = async () => ({
    receiptId: "same",
    phase: "done",
    projected: false,
  });
  await worker.runDirectory({
    ...g,
    workspaceId: "ws",
    mode: "live",
    limit: 1,
  });
  assert.ok(g.state.calls.includes("save"));
});
await test("expired/busy scanner performs no external source read", async () => {
  const f = fixture();
  f.lib.claimDirectoryScan = async () => ({ status: "busy" });
  assert.equal(
    (
      await worker.runDirectory({
        ...f,
        workspaceId: "ws",
        mode: "live",
        limit: 2,
      })
    ).status,
    "busy",
  );
  assert.equal(f.state.read, 0);
});
await test("embedding fanout is capped and failure cannot relabel a saved profile", async () => {
  let calls = 0,
    saves = 0;
  const lib = {
    TT_ORG_ID: "tt",
    pendingDirectoryEmbeddings: async () =>
      Array.from({ length: 100 }, (_, i) => String(i)),
    claimDirectoryEmbedding: async () => ({
      status: "claimed",
      token: "t",
      text: "Synthetic",
    }),
    embedTexts: async () => {
      calls++;
      if (calls === 2) throw Error("synthetic");
      return [[0.1]];
    },
    saveDirectoryEmbedding: async () => {
      saves++;
      return { status: "saved" };
    },
  };
  const out = await worker.drainDirectoryEmbeddings({
    lib,
    workspaceId: "ws",
    limit: 3,
  });
  assert.equal(calls, 3);
  assert.equal(saves, 2);
  assert.equal(out.failed, 1);
  await assert.rejects(
    worker.drainDirectoryEmbeddings({ lib, workspaceId: "ws", limit: 51 }),
    /limit/,
  );
});
await test("resume consumes its immutable pending receipt before accepting a new snapshot", async () => {
  const f = fixture();
  let staged = 0;
  f.lib.stageDirectory = async () => ({
    receiptId: ++staged === 1 ? "original" : "new",
    phase: "ready",
    projected: false,
    pendingPrevious: staged === 1,
  });
  const saved = [];
  f.lib.saveDirectory = async (a) => {
    saved.push(a.receiptId);
    return { status: "done", reviewCount: 0 };
  };
  const result = await worker.runDirectory({
    ...f,
    workspaceId: "ws",
    mode: "live",
    limit: 1,
  });
  assert.deepEqual(saved, ["original", "new"]);
  assert.equal(result.read, 1);
});
await test("unchanged pages avoid per-person staging while retaining review counts", async () => {
  const f = fixture();
  f.lib.inspectDirectoryPage = async () => [
    {
      contactId: "1",
      receiptId: "existing",
      phase: "done",
      projected: true,
      reviewCount: 2,
    },
  ];
  f.lib.stageDirectory = async () => {
    throw Error("unexpected_stage");
  };
  f.lib.saveDirectory = async () => {
    throw Error("unexpected_save");
  };
  const result = await worker.runDirectory({
    ...f,
    workspaceId: "ws",
    mode: "live",
    limit: 1,
  });
  assert.equal(result.unchanged, 1);
  assert.equal(result.review, 2);
});
await test("recovery drains durable receipts even when the external contact has disappeared", async () => {
  const f = fixture();
  let pending = true;
  f.reader.page = async () => [];
  f.lib.pendingDirectoryReceipts = async () =>
    pending ? ["missing-contact-receipt"] : [];
  f.lib.saveDirectory = async (a) => {
    assert.equal(a.receiptId, "missing-contact-receipt");
    pending = false;
    return { status: "suppressed" };
  };
  const result = await worker.runDirectory({
    ...f,
    workspaceId: "ws",
    mode: "live",
    limit: 2,
  });
  assert.equal(pending, false);
  assert.equal(result.recovered, 1);
  assert.equal(result.suppressed, 1);
  assert.equal(result.read, 0);
});
