import assert from "node:assert/strict";
import { test } from "node:test";
import * as lib from "../dist/worker-lib.mjs";
const cid = "d0000000-0000-4000-8000-000000000001";
const contact = "d0000000-0000-4000-8000-000000000002";
const snapshot = () => ({
  board: {
    contact_id: contact,
    name: "Synthetic Person",
    linkedin_url: "https://www.linkedin.com/in/board-alias",
    title: "Engineer",
    company: "Original Co",
    primary_email: "one@example.test",
    email_status: "Verified",
    updated_at: "2026-09-25T00:00:00Z",
  },
  harvest: {
    fetched_at: "2026-08-01T00:00:00Z",
    public_identifier: "harvest-alias",
    current_title: "Staff Engineer",
    current_company: "Harvest Co",
    raw: {
      id: "ACoAAAAAAAAAAAAAA",
      linkedinUrl: "https://www.linkedin.com/in/raw-alias",
    },
  },
  exps: [
    {
      title: "Staff Engineer",
      company_name: "Harvest Co",
      start_year: 2020,
      is_current: true,
    },
  ],
  edus: [],
  emails: [
    {
      id: "e1",
      normalized: "one@example.test",
      verification: {
        status: "Verified",
        primary: true,
        checked_at: "2026-07-01T00:00:00Z",
      },
    },
  ],
  phones: [
    { id: "p1", value: "2025550123", recorded_at: "2026-09-20T00:00:00Z" },
  ],
  facts: [],
  identifiers: [
    { kind: "linkedin", value: "https://www.linkedin.com/in/identifier-alias" },
  ],
});
await test("directory source contracts exist", () => {
  for (const fn of [
    "directoryDocuments",
    "directoryIdentities",
    "directorySnapshotHash",
  ])
    assert.equal(typeof lib[fn], "function", fn);
});
if (!lib.directoryDocuments) throw Error("directory_sources_missing");
await test("all strong aliases resolve together; email never becomes identity", () => {
  const ids = lib.directoryIdentities(snapshot());
  assert.deepEqual(
    ids
      .filter((x) => x.kind === "linkedin_username")
      .map((x) => x.value)
      .sort(),
    ["board-alias", "harvest-alias", "identifier-alias", "raw-alias"],
  );
  assert.equal(
    ids.some((x) => x.value.includes("@")),
    false,
  );
});
await test("workflow-only updates do not change any fact document or date", () => {
  const a = snapshot(),
    b = structuredClone(a);
  b.board.updated_at = "2026-10-01";
  b.board.follow_up_status = "Due";
  b.board.status = "Replied";
  assert.deepEqual(
    lib.directoryDocuments(a, cid),
    lib.directoryDocuments(b, cid),
  );
  assert.notEqual(lib.directorySnapshotHash(a), lib.directorySnapshotHash(b));
});
await test("history and every contact retain independent original clocks", () => {
  const docs = lib.directoryDocuments(snapshot(), cid);
  const history = docs.find((d) => d.jobs);
  assert.equal(history.source.fetched_at, "2026-08-01T00:00:00.000Z");
  assert.equal(history.header.current_title, "Staff Engineer");
  assert.equal(
    docs.find((d) => d.contacts.some((c) => c.kind === "phone")).source
      .fetched_at,
    "2026-09-20T00:00:00.000Z",
  );
  assert.equal(
    docs.find((d) => d.contacts.some((c) => c.kind === "email")).source
      .fetched_at,
    "2026-07-01T00:00:00.000Z",
  );
  assert.equal(
    docs.some((d) => d.source.fetched_at.startsWith("2026-09-25")),
    false,
  );
});
await test("undated board header only fills gaps; matching fact supplies its own recorded date", () => {
  const a = snapshot();
  const unknown = lib
    .directoryDocuments(a, cid)
    .find((d) => d.header.current_title === "Engineer");
  assert.equal(unknown.mode, "fill_gaps");
  assert.equal(unknown.source.fetched_at, "1970-01-01T00:00:00.000Z");
  a.facts = [
    {
      id: "f1",
      field: "title",
      value: "Engineer",
      recorded_at: "2026-06-01T00:00:00Z",
      provenance: "manual",
    },
  ];
  const known = lib
    .directoryDocuments(a, cid)
    .find((d) => d.header.current_title === "Engineer");
  assert.equal(known.mode, "replace_lists");
  assert.equal(known.source.fetched_at, "2026-06-01T00:00:00.000Z");
});
await test("primary selection is separate from verification/source chronology", () => {
  const a = snapshot(),
    b = structuredClone(a);
  b.emails[0].verification.primary = false;
  b.board.primary_email = null;
  b.board.email_status = null;
  const ad = lib.directoryDocuments(a, cid).filter((d) => d.contacts.length),
    bd = lib.directoryDocuments(b, cid).filter((d) => d.contacts.length);
  assert.deepEqual(ad, bd);
  assert.equal(
    ad.some((d) =>
      d.contacts.some((c) => c.source_detail === "directory_primary"),
    ),
    false,
  );
});
await test("snapshot order does not create artificial changes", () => {
  const a = snapshot();
  a.emails.push({ id: "e2", normalized: "two@example.test", verification: {} });
  const b = structuredClone(a);
  b.emails.reverse();
  assert.equal(lib.directorySnapshotHash(a), lib.directorySnapshotHash(b));
  assert.deepEqual(
    lib.directoryDocuments(a, cid),
    lib.directoryDocuments(b, cid),
  );
});
await test("undated Harvest only fills gaps and cannot replace dated history", () => {
  const s = snapshot();
  s.harvest.fetched_at = null;
  assert.equal(
    lib.directoryDocuments(s, cid).find((d) => d.jobs).mode,
    "fill_gaps",
  );
});
await test("source or unsupported provenance cannot make an imported title a fresh manual fact", () => {
  for (const provenance of ["source", "unknown", null]) {
    const s = snapshot();
    s.facts = [
      {
        id: "f1",
        field: "title",
        value: "Engineer",
        recorded_at: "2026-09-25",
        provenance,
      },
    ];
    assert.equal(
      lib
        .directoryDocuments(s, cid)
        .find((d) => d.header.current_title === "Engineer").mode,
      "fill_gaps",
    );
  }
});
await test("Postgres Date values hash identically to their durable JSON receipt", () => {
  const s = snapshot();
  s.harvest.fetched_at = new Date(s.harvest.fetched_at);
  s.board.updated_at = new Date(s.board.updated_at);
  s.phones[0].recorded_at = new Date(s.phones[0].recorded_at);
  assert.equal(
    lib.directorySnapshotHash(s),
    lib.directorySnapshotHash(JSON.parse(JSON.stringify(s))),
  );
  const newer = structuredClone(s);
  newer.harvest.fetched_at = new Date("2026-09-01");
  assert.notEqual(
    lib.directorySnapshotHash(s),
    lib.directorySnapshotHash(newer),
  );
});
