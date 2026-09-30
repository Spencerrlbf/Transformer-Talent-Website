import assert from "node:assert/strict";
import { test } from "node:test";
import * as lib from "../dist/worker-lib.mjs";
const email = (value, rank, extra = {}) => ({
  kind: "email",
  value_normalized: value,
  rank,
  status: "active",
  quality: null,
  result: null,
  never_primary: false,
  ...extra,
});
test("database ranks including all-null are authoritative; translator-only input can rank", () => {
  const contacts = [email("manual@example.test", null, { is_manual: true })];
  const data = { jobs: [], educations: [], skills: [], contacts };
  assert.equal(
    lib.project({ ...data, contact_ranks_authoritative: true }).email,
    null,
  );
  assert.equal(lib.project(data).email, "manual@example.test");
});
test("effective contacts exclude negatives and do not claim manual emails are verified", () => {
  assert.equal(typeof lib.effectivePoolContact, "function");
  const rows = [
    email("bad@example.test", 1, { quality: "bad" }),
    email("manual@example.test", 2, { is_manual: true }),
    email("verified@example.test", 3, { quality: "good", result: "ok" }),
    {
      kind: "phone",
      value_normalized: "+12025550111",
      status: "bounced",
      rank: 1,
    },
  ];
  const view = lib.effectivePoolContact(rows, {
    email: "bad@example.test",
    phone: "+12025550111",
  });
  assert.equal(view.contact.email, "manual@example.test");
  assert.equal(view.contact.phone, null);
  assert.deepEqual(view.emails, [
    { email: "manual@example.test", verified: false },
    { email: "verified@example.test", verified: true },
  ]);
});
test("explicit curation preserves order, normalizes duplicates and filters primary/ineligible", () => {
  const rows = [
    email("main@example.test", 1),
    email("a@example.test", 2),
    email("b@example.test", 3),
    email("bad@example.test", null, { status: "invalid" }),
  ];
  assert.deepEqual(
    lib.effectivePoolContact(rows, {
      otherEmails: [
        "B@example.test",
        "MAIN@example.test",
        "b@example.test",
        "bad@example.test",
        "a@example.test",
      ],
    }).contact.otherEmails,
    ["b@example.test", "a@example.test"],
  );
  assert.deepEqual(
    lib.effectivePoolContact(rows, { otherEmails: [] }).contact.otherEmails,
    [],
  );
  assert.deepEqual(lib.effectivePoolContact(rows, {}).contact.otherEmails, [
    "a@example.test",
    "b@example.test",
  ]);
});
test("normalized read failures propagate instead of yielding a legacy fallback", async () => {
  await assert.rejects(
    lib.publishedPoolContactsOnConnection(
      {
        query: async () => {
          throw Error("read_unavailable");
        },
      },
      ["d2000000-0000-4000-8000-000000000001"],
    ),
    /read_unavailable/,
  );
});
