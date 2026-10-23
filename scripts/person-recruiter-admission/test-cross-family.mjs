// All existing application/directory/refresh tests run under recruiter dispatchers.
import "../person-refresh-save/test-cross-family.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  pool,
  org,
  phase,
  fixture,
  run,
  use,
} from "../person-directory-execution/test-execution.mjs";
import {
  app,
  processApp,
} from "../person-application-enrichment/test-tt-enrichment.mjs";
import * as lib from "../dist/worker-lib.mjs";
import { planAudit } from "../person-audit/postcutover.mjs";
const contact = (candidateId, requestId = randomUUID()) => ({
  organizationId: org,
  candidateId,
  actorId: randomUUID(),
  requestId,
  mode: "live",
  contact: {
    email: "recruiter-" + requestId + "@example.test",
    otherEmails: [],
  },
});
test("recruiter and directory share a UUID without borrowing authority and preserve later application audit", async () => {
  const f = await fixture((s) => {
    s.board.name = "Synthetic";
  });
  await phase();
  process.env.PERSON_TRANSITION_SUPPORT = "on";
  const edit = contact(f.id, f.args.executionId);
  await use((c) => lib.saveRecruiterContactOnConnection(c, edit));
  f.args.mode = "live";
  const directory = await run(f);
  assert.equal(directory.status, "done");
  const application = await processApp(
    await app(
      { email: randomUUID() + "@example.test" },
      f.before.linkedin_username,
    ),
  );
  assert.equal(application.status, "processed", application.error?.message);
  assert.equal(
    (await use((c) => lib.saveRecruiterContactOnConnection(c, edit))).replayed,
    true,
  );
  assert.deepEqual(await run(f), directory);
  const s = (
    await pool.query(
      "select person_postcutover_audit_inputs_with_witness($1::jsonb) r",
      [JSON.stringify([f.id])],
    )
  ).rows[0].r[0];
  const proof = planAudit(s, lib, {
    complete: true,
    rows: new Map([[f.snapshot.board.contact_id, f.snapshot]]),
  });
  assert.equal(proof.status, "verified", proof.reason);
});
test("receipt-created applicant accepts recruiter contact without replacing its creator anchor", async () => {
  const application = await processApp(
    await app({ email: randomUUID() + "@example.test" }),
  );
  assert.equal(application.status, "processed", application.error?.message);
  const id = application.result.candidateId;
  const before = (
    await pool.query(
      "select to_jsonb(a) r from person_audit_anchors a where candidate_id=$1",
      [id],
    )
  ).rows[0].r;
  const edit = contact(id);
  const out = await use((c) => lib.saveRecruiterContactOnConnection(c, edit));
  assert.equal(out.contact.email, edit.contact.email);
  assert.deepEqual(
    (
      await pool.query(
        "select to_jsonb(a) r from person_audit_anchors a where candidate_id=$1",
        [id],
      )
    ).rows[0].r,
    before,
  );
  const s = (
    await pool.query(
      "select person_postcutover_audit_inputs_with_witness($1::jsonb) r",
      [JSON.stringify([id])],
    )
  ).rows[0].r[0];
  const proof = planAudit(s, lib);
  assert.equal(proof.status, "verified", proof.reason);
});
