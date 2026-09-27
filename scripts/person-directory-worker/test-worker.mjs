import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import "../person-directory-readmission/test-readmission.mjs";
import {
  pool,
  org,
  rpc,
  phase,
  run,
  fixture,
  use,
} from "../person-directory-execution/test-execution.mjs";
import { fresh } from "../person-directory-creation/test-creation.mjs";
import { row } from "../person-directory-suppression/test-suppression.mjs";
import {
  app,
  processApp,
} from "../person-application-enrichment/test-tt-enrichment.mjs";
import * as lib from "../dist/worker-lib.mjs";
import {
  runDirectory,
  drainDirectoryEmbeddings,
} from "../person-directory/worker.mjs";
const current = (f) =>
  use((c) =>
    lib.readCertifiedDirectoryCurrentOnConnection(c, {
      organizationId: org,
      workspaceId: f.args.workspaceId,
      receiptId: f.args.receiptId,
    }),
  );
const receipt = (f) =>
  use(async (c) => {
    await c.query(
      "begin;set local timezone='UTC';set local datestyle='ISO,YMD'",
    );
    return (
      await c.query(
        "select to_jsonb(r) r from person_directory_receipts r where id=$1",
        [f.args.receiptId],
      )
    ).rows[0].r;
  });
async function changeReceipt(f, patch) {
  const before = await receipt(f);
  await use(async (c) => {
    await c.query(
      "begin;set local timezone='UTC';set local datestyle='ISO,YMD'",
    );
    await rpc(c, "person_private.directory_mutate", [
      "person_directory_receipts",
      before,
      { ...before, ...patch },
    ]);
    await c.query("commit");
  });
}
async function release(f) {
  await use((c) =>
    lib.checkpointDirectoryScanOnConnection(c, {
      organizationId: org,
      workspaceId: f.args.workspaceId,
      token: f.token,
      cursor: "00000000-0000-0000-0000-000000000000",
      release: true,
    }),
  );
}
function worker(f, { snapshot = f.snapshot, hook } = {}) {
  const calls = [];
  const bridge = {
    ...lib,
    saveDirectory: async () => {
      throw Error("legacy_writer_used");
    },
  };
  for (const name of [
    "claimDirectoryScan",
    "checkpointDirectoryScan",
    "pendingDirectoryReceipts",
    "inspectDirectoryPage",
    "stageDirectory",
    "readCertifiedDirectoryCurrent",
  ])
    bridge[name] = (a) => use((c) => lib[name + "OnConnection"](c, a));
  bridge.saveCertifiedDirectory = (a) => {
    calls.push(a);
    return use((c) =>
      lib.saveCertifiedDirectoryOnConnection(
        hook
          ? {
              query: async (sql, v) => {
                await hook(sql, v, c);
                return c.query(sql, v);
              },
            }
          : c,
        a,
      ),
    );
  };
  const id = snapshot.board.contact_id,
    reader = {
      page: async (cursor) => (cursor < id ? [id] : []),
      snapshots: async () => new Map([[id, snapshot]]),
    };
  return {
    calls,
    bridge,
    reader,
    run: (mode) =>
      runDirectory({
        lib: bridge,
        reader,
        workspaceId: f.args.workspaceId,
        mode,
        limit: 5,
      }),
  };
}
test("current result distinguishes pristine ready and certified completion without writes", async () => {
  const f = await fixture(),
    before = await receipt(f);
  assert.deepEqual(await current(f), { status: "ready" });
  assert.deepEqual(await receipt(f), before);
  const out = await run(f),
    after = await receipt(f);
  assert.deepEqual(await current(f), {
    status: "completed",
    mode: "shadow",
    disposition: "normalized",
    result: out,
  });
  assert.deepEqual(await receipt(f), after);
});
test("real worker recovers a ready receipt once and then skips its source-page overlap", async () => {
  const f = await fixture();
  await release(f);
  const w = worker(f),
    out = await w.run("live");
  assert.equal(out.status, "done");
  assert.equal(out.recovered, 1);
  assert.equal(out.saved, 1);
  assert.equal(w.calls.length, 1);
  assert.equal((await receipt(f)).phase, "done");
  assert.equal((await row(f.id)).source, "directory");
});
test("worker promotes a newly created shadow person despite its projected flag", async () => {
  const f = await fresh("shadow");
  await release(f);
  const w = worker(f);
  await w.run("shadow");
  const first = await receipt(f);
  assert.equal(first.projected, true);
  assert.equal(first.created_person, true);
  const id = first.candidate_id;
  const live = worker(f);
  await live.run("live");
  assert.equal(live.calls.length, 1);
  assert.equal((await current(f)).mode, "live");
  assert.equal((await receipt(f)).candidate_id, id);
  const again = worker(f);
  assert.equal((await again.run("live")).unchanged, 1);
  assert.equal(again.calls.length, 0);
});
test("worker reconsiders a completed review at most once per invocation", async () => {
  const f = await fresh("live", (s) => {
    s.board.linkedin_url = null;
  });
  const original = await run(f);
  await release(f);
  const w = worker(f),
    out = await w.run("live");
  assert.equal(out.review, 1);
  assert.equal(w.calls.length, 1);
  // Legacy ownerless reviews retain zero attempts; UUID history proves one retry.
  assert.equal((await receipt(f)).attempts, 0);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from person_private.directory_executions where receipt_id=$1",
        [f.args.receiptId],
      )
    ).rows[0].n,
    2,
  );
  assert.deepEqual(await run(f), original);
});
test("current result remains valid after a later genuine application changes the person", async () => {
  const f = await fixture();
  f.args.mode = "live";
  const out = await run(f);
  const appResult = await processApp(
    await app(
      { email: randomUUID() + "@example.test" },
      f.snapshot.board.linkedin_url.split("/").at(-1),
    ),
  );
  assert.equal(appResult.status, "processed", appResult.error?.message);
  assert.deepEqual((await current(f)).result, out);
});
for (const damage of ["audit", "head", "public"])
  test(`current-result check rejects altered ${damage} evidence before worker skip`, async () => {
    const f = await fixture();
    f.args.mode = "live";
    await run(f);
    if (damage === "audit")
      await pool.query(
        "delete from person_private.directory_audit_operations where execution_id=$1",
        [f.args.executionId],
      );
    if (damage === "head") {
      await pool.query(
        "alter table person_private.directory_heads disable trigger all",
      );
      try {
        await pool.query(
          "delete from person_private.directory_heads where receipt_id=$1",
          [f.args.receiptId],
        );
      } finally {
        await pool.query(
          "alter table person_private.directory_heads enable trigger all",
        );
      }
    }
    if (damage === "public") await changeReceipt(f, { attempts: 99 });
    await assert.rejects(current(f), /directory_current_proof/);
  });
test("forged public done without completion history cannot bypass the writer", async () => {
  const f = await fixture();
  await changeReceipt(f, { phase: "done", result: {}, projected: true });
  await release(f);
  const w = worker(f);
  await assert.rejects(w.run("live"), /directory_current_proof/);
  assert.equal(w.calls.length, 0);
});
test("support-on direct legacy save and paid embedding consumer stay blocked", async () => {
  const f = await fixture();
  await assert.rejects(
    use((c) =>
      lib.saveDirectoryOnConnection(c, {
        organizationId: org,
        receiptId: f.args.receiptId,
        mode: "live",
      }),
    ),
    /person_directory_execution_unavailable/,
  );
  await assert.rejects(
    drainDirectoryEmbeddings({
      lib: new Proxy(
        {},
        {
          get() {
            throw Error("paid_consumer_called");
          },
        },
      ),
      workspaceId: f.args.workspaceId,
    }),
    /person_directory_execution_unavailable/,
  );
});
test("unknown suppressed receipt is reconsidered after genuine application admission", async () => {
  const f = await fresh("live", (s) => {
    s.board.do_not_contact = true;
  });
  await release(f);
  const first = worker(f);
  assert.equal((await first.run("live")).suppressed, 1);
  assert.equal((await receipt(f)).candidate_id, null);
  const a = await processApp(
    await app({ email: randomUUID() + "@example.test" }, f.username),
  );
  assert.equal(a.status, "processed", a.error?.message);
  const next = worker(f);
  assert.equal((await next.run("live")).suppressed, 1);
  assert.equal(next.calls.length, 1);
  assert.equal((await row(a.result.candidateId)).status, "Do Not Contact");
  assert.equal((await receipt(f)).candidate_id, a.result.candidateId);
});
test("worker restart after lost committed response verifies completion without another execution", async () => {
  const f = await fixture();
  await release(f);
  const first = worker(f);
  const save = first.bridge.saveCertifiedDirectory;
  first.bridge.saveCertifiedDirectory = async (a) => {
    await save(a);
    throw Error("synthetic_response_lost");
  };
  await assert.rejects(first.run("live"), /synthetic_response_lost/);
  const before = await receipt(f);
  assert.equal(before.phase, "done");
  const next = worker(f),
    out = await next.run("live");
  assert.equal(out.unchanged, 1);
  assert.equal(next.calls.length, 0);
  assert.deepEqual(await receipt(f), before);
});
test("worker restart after failed checkpoint preserves the completed receipt and candidate", async () => {
  const f = await fresh("live");
  await release(f);
  const first = worker(f);
  first.bridge.checkpointDirectoryScan = async () => {
    throw Error("synthetic_checkpoint_lost");
  };
  await assert.rejects(first.run("live"), /synthetic_checkpoint_lost/);
  const before = await receipt(f);
  assert.equal(before.phase, "done");
  const s = (
    await pool.query(
      "select token,cursor from person_directory_scans where workspace_id=$1",
      [f.args.workspaceId],
    )
  ).rows[0];
  await use((c) =>
    lib.checkpointDirectoryScanOnConnection(c, {
      organizationId: org,
      workspaceId: f.args.workspaceId,
      token: s.token,
      cursor: s.cursor,
      release: true,
    }),
  );
  const next = worker(f);
  await next.run("live");
  assert.equal(next.calls.length, 0);
  assert.deepEqual(await receipt(f), before);
});
for (const patch of [
  { attempts: 1 },
  { source_reviews: [{ code: "unproved" }] },
  { derivative_text: "unproved" },
  { derivative_done: true },
])
  test(`current reader rejects nonpristine ready operational data ${JSON.stringify(patch)}`, async () => {
    const f = await fixture();
    await changeReceipt(f, patch);
    await assert.rejects(current(f), /directory_current_proof/);
  });
test("current reader binds organization workspace and input and stays private", async () => {
  const f = await fixture();
  for (const a of [
    {
      organizationId: randomUUID(),
      workspaceId: f.args.workspaceId,
      receiptId: f.args.receiptId,
    },
    {
      organizationId: org,
      workspaceId: randomUUID(),
      receiptId: f.args.receiptId,
    },
  ])
    await assert.rejects(
      use((c) => lib.readCertifiedDirectoryCurrentOnConnection(c, a)),
      /directory_current_input/,
    );
  for (const role of ["anon", "authenticated", "service_role"])
    assert.equal(
      (
        await pool.query(
          "select has_function_privilege($1,'person_private.directory_current(uuid,uuid,bigint)','execute') allowed",
          [role],
        )
      ).rows[0].allowed,
      false,
    );
});
test("created-person completion remains skippable after later application facts", async () => {
  const f = await fresh("live"),
    out = await run(f);
  const a = await processApp(
    await app({ email: randomUUID() + "@example.test" }, f.username),
  );
  assert.equal(a.status, "processed", a.error?.message);
  assert.deepEqual((await current(f)).result, out);
});
test("expired actual scan lease stops before recovery execution and source acknowledgement", async () => {
  const f = await fixture();
  await release(f);
  const w = worker(f),
    claim = w.bridge.claimDirectoryScan;
  w.bridge.claimDirectoryScan = async (a) => {
    const out = await claim(a);
    await use(async (c) => {
      await c.query(
        "begin;set local timezone='UTC';set local datestyle='ISO,YMD'",
      );
      const before = (
        await c.query(
          "select to_jsonb(s) s from person_directory_scans s where workspace_id=$1",
          [f.args.workspaceId],
        )
      ).rows[0].s;
      await rpc(c, "person_private.directory_mutate", [
        "person_directory_scans",
        before,
        { ...before, lease_until: "2000-01-01T00:00:00+00:00" },
      ]);
      await c.query("commit");
    });
    return out;
  };
  await assert.rejects(w.run("live"), /directory_input_lease/);
  assert.equal(w.calls.length, 0);
  assert.equal((await receipt(f)).phase, "ready");
});
