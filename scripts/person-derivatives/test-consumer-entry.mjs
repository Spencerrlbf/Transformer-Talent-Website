// Production legacy consumer entry points must fail before DB/provider activity
// under transition support; producers and the future certified consumer are separate.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
const output = path.resolve("scripts/dist/derivative-entry-test.mjs");
execFileSync("npx", [
  "--yes",
  "esbuild@0.28.2",
  "lib/server/person/derivatives.ts",
  "--bundle",
  "--platform=node",
  "--external:pg",
  "--format=esm",
  "--alias:@=" + process.cwd(),
  "--outfile=" + output,
  "--log-level=warning",
]);
const lib = await import(pathToFileURL(output));
const a = {
  organizationId: "801865a7-6533-41d2-9c45-e4a90e6ad51a",
  candidateId: randomUUID(),
  token: randomUUID(),
  vectors: [],
};
delete process.env.PERSON_DATABASE_URL;
process.env.OPENAI_API_KEY = "synthetic";
globalThis.fetch = () => assert.fail("provider_called");
const c = { query: () => assert.fail("database_called") };
const calls = {
  prepare_connection: () => lib.preparePersonDerivativesOnConnection(c, a),
  complete_connection: () => lib.completePersonDerivativesOnConnection(c, a),
  fail_connection: () => lib.failPersonDerivativesOnConnection(c, a),
  prepare: () => lib.preparePersonDerivatives(a),
  complete: () => lib.completePersonDerivatives(a),
  fail: () => lib.failPersonDerivatives(a),
  process: () => lib.processPersonDerivatives(a),
  drain: () =>
    lib.drainPersonDerivatives({ organizationId: a.organizationId, limit: 1 }),
};
for (const support of ["on", "invalid"])
  for (const [name, call] of Object.entries(calls))
    test(
      support + " refuses legacy " + name + " before DB/provider access",
      async () => {
        process.env.PERSON_TRANSITION_SUPPORT = support;
        await assert.rejects(
          async () => call(),
          support === "on"
            ? /person_derivative_consumer_unavailable/
            : /transition_configuration/,
        );
      },
    );
test("support-off no-key orchestration keeps legacy no-op behavior", async () => {
  process.env.PERSON_TRANSITION_SUPPORT = "off";
  delete process.env.OPENAI_API_KEY;
  assert.deepEqual(await lib.processPersonDerivatives(a), {
    status: "not_configured",
  });
  assert.deepEqual(
    await lib.drainPersonDerivatives({
      organizationId: a.organizationId,
      limit: 1,
    }),
    { processed: 0, retry: 0 },
  );
});
test.after(() => {
  delete process.env.PERSON_TRANSITION_SUPPORT;
  delete process.env.OPENAI_API_KEY;
  rmSync(output, { force: true });
});
