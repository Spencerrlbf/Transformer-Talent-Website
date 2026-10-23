import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as lib from "../dist/worker-lib.mjs";
import { validDocument } from "../person-audit/evidence.mjs";
const cid = "d6000000-0000-4000-8000-000000000001",
  contact = "d6000000-0000-4000-8000-000000000002",
  sid = "d6000000-0000-4000-8000-000000000003";
const snapshot = () => ({
  board: {
    contact_id: contact,
    name: "Synthetic",
    linkedin_url: "https://www.linkedin.com/in/synthetic-admission",
    title: "Engineer",
  },
  harvest: {
    fetched_at: "2026-08-01",
    public_identifier: "synthetic-admission",
    current_title: "Staff Engineer",
  },
  exps: [
    {
      title: "Staff Engineer",
      company_name: "Synthetic Co",
      start_year: 2020,
      is_current: true,
    },
  ],
  edus: [],
  emails: [],
  phones: [],
  facts: [],
  identifiers: [],
});
const input = (extra = {}) => ({
  version: "directory-admission-1",
  parserVersion: "person-v3",
  candidateId: cid,
  receiptId: "10",
  snapshot: snapshot(),
  sources: [],
  header: {},
  prior: null,
  ...extra,
});
const prior = (s = snapshot(), reviews = []) => ({
  receiptId: "9",
  candidateId: cid,
  hasDocuments: true,
  snapshot: s,
  sourceReviews: reviews,
});
const historical = (s) => {
  const d = lib.fromDirectory(
    s.board,
    s.harvest,
    s.exps,
    s.edus,
    s.emails,
    s.phones,
    cid,
  );
  return {
    id: sid,
    payload_hash: d.source.payload_hash,
    parser_version: d.source.parser_version,
    fetched_at: d.source.fetched_at,
  };
};
const evaluate = (e) => lib.evaluateDirectoryAdmission(e);
const hasHistory = (r) =>
  r.docs.some((d) => d.source.source_ref.endsWith(":harvest"));
const hasBoard = (r) =>
  r.docs.some((d) => d.source.source_ref.includes(":board:"));
test("decision contracts exist", () => {
  for (const fn of [
    "captureDirectoryAdmissionEvidence",
    "evaluateDirectoryAdmission",
    "directoryAdmissionMatches",
  ])
    assert.equal(typeof lib[fn], "function");
});
test("fresh inputs admit their exact source documents without reviews", () => {
  const e = input(),
    r = evaluate(e);
  assert.deepEqual(r.docs, lib.directoryDocuments(e.snapshot, cid));
  assert.deepEqual(r.reviews, []);
  assert.equal(lib.directoryAdmissionMatches(e, r), true);
});
test("exact historical-v3 baseline excludes board/history components", () => {
  const e = input();
  e.sources = [historical(e.snapshot)];
  const r = evaluate(e);
  assert.equal(hasHistory(r), false);
  assert.equal(hasBoard(r), false);
  assert.ok(r.docs.length);
});
for (const date of ["2026-08-01", "2026-09-01"])
  test(`history equal/older than baseline needs review: ${date}`, () => {
    const e = input();
    e.sources = [
      { ...historical(e.snapshot), payload_hash: "changed", fetched_at: date },
    ];
    const r = evaluate(e);
    assert.equal(hasHistory(r), false);
    assert.deepEqual(r.reviews, [
      { component: "harvest", reason: "directory_history_chronology" },
    ]);
  });
test("unchanged rejected components retain complete prior reviews", () => {
  const e = input({
    prior: prior(snapshot(), [
      {
        component: "harvest",
        reason: "directory_history_chronology",
        extra: { retained: true },
      },
    ]),
  });
  const r = evaluate(e);
  assert.equal(hasHistory(r), false);
  assert.deepEqual(r.reviews, e.prior.sourceReviews);
});
test("newer history clears old review while equal-date changed history does not", () => {
  const old = snapshot(),
    reviews = [
      { component: "harvest", reason: "directory_history_chronology" },
    ];
  for (const date of ["2026-08-01", "2026-08-02"]) {
    const e = input({ prior: prior(old, reviews) });
    e.snapshot.harvest.current_title = "Changed";
    e.snapshot.harvest.fetched_at = date;
    const r = evaluate(e);
    assert.equal(hasHistory(r), date === "2026-08-02");
    assert.equal(
      r.reviews.some((x) => x.component === "harvest"),
      date === "2026-08-01",
    );
  }
});
test("prior candidate-wide selection matters even from another contact", () => {
  const e = input(),
    other = snapshot();
  other.board.contact_id = "d6000000-0000-4000-8000-000000000004";
  e.sources = [
    {
      ...historical(e.snapshot),
      payload_hash: "changed",
      fetched_at: "2026-09-01",
    },
  ];
  assert.equal(hasHistory(evaluate(e)), false);
  e.prior = prior(other);
  assert.equal(hasHistory(evaluate(e)), true);
});
test("an equal current header returns before clearing its prior review", () => {
  const old = snapshot();
  old.board.title = "Old";
  const e = input({
    prior: prior(old, [
      {
        component: "current_title",
        reason: "directory_header_chronology",
        note: "retained",
      },
    ]),
    header: {
      current_title: { value: "Engineer", source_id: sid, at: "2026-09-01" },
    },
  });
  assert.deepEqual(evaluate(e).reviews, e.prior.sourceReviews);
});
test("matching baseline header source at equal date holds changed board fact; newer evidence clears it", () => {
  const old = snapshot();
  old.board.title = "Old";
  for (const date of ["2026-08-01", "2026-08-02"]) {
    const e = input({
      prior: prior(old, [
        { component: "current_title", reason: "directory_header_chronology" },
      ]),
      header: {
        current_title: { value: "Old", source_id: sid, at: "2026-08-01" },
      },
    });
    e.sources = [{ ...historical(e.snapshot), payload_hash: "changed" }];
    e.snapshot.facts = [
      {
        field: "title",
        value: "Engineer",
        recorded_at: date,
        provenance: "manual",
      },
    ];
    const r = evaluate(e);
    assert.equal(
      r.reviews.some((x) => x.component === "current_title"),
      date === "2026-08-01",
    );
  }
});
test("prior review duplicates retain last value and first-key order with extra fields", () => {
  const reviews = [
      { component: "x", reason: "old" },
      { component: "y", reason: "other", extra: 2 },
      { component: "x", reason: "last", extra: 1 },
    ],
    e = input({ prior: prior(snapshot(), reviews) });
  assert.deepEqual(evaluate(e).reviews, [reviews[2], reviews[1]]);
});
test("retained evidence and returned results are isolated from later mutations", () => {
  const original = input({
      prior: prior(snapshot(), [
        { component: "harvest", reason: "held", extra: { a: 1 } },
      ]),
    }),
    e = lib.captureDirectoryAdmissionEvidence(original),
    expected = evaluate(e);
  original.snapshot.board.title = "Changed";
  original.prior.sourceReviews[0].extra.a = 9;
  original.header.current_title = {
    value: "New",
    at: "2030-01-01",
    source_id: sid,
  };
  assert.deepEqual(evaluate(e), expected);
  const changed = evaluate(e);
  changed.reviews[0].extra.a = 22;
  assert.deepEqual(evaluate(e), expected);
});
test("Postgres date objects are captured as stable ISO evidence", () => {
  const e = input();
  e.sources = [
    { ...historical(e.snapshot), fetched_at: new Date("2026-08-01") },
  ];
  const captured = lib.captureDirectoryAdmissionEvidence(e);
  assert.equal(typeof captured.sources[0].fetched_at, "string");
  assert.deepEqual(evaluate(captured), evaluate(JSON.parse(JSON.stringify(e))));
});
for (const mutation of [
  "self-hashed invention",
  "newer date",
  "missing doc",
  "extra doc",
  "omitted reviews",
  "cleared review",
  "extra review",
])
  test(`reconstruction rejects ${mutation}`, () => {
    const e = input({
        sources: [
          {
            ...historical(snapshot()),
            payload_hash: "changed",
            fetched_at: "2026-09-01",
          },
        ],
      }),
      r = structuredClone(evaluate(e));
    if (mutation === "self-hashed invention") {
      r.docs[0].header = { current_title: "Invented" };
      const { source, ...content } = r.docs[0];
      r.docs[0].source.payload_hash = createHash("sha256")
        .update(
          lib.stableStringify({
            content,
            source: source.source,
            ref: source.source_ref,
            at: source.fetched_at,
            v: lib.PARSER_VERSION,
          }),
        )
        .digest("hex");
      assert.equal(validDocument(r.docs[0], cid, lib), true);
    }
    if (mutation === "newer date")
      r.docs[0].source.fetched_at = "2030-01-01T00:00:00.000Z";
    if (mutation === "missing doc") r.docs.pop();
    if (mutation === "extra doc") r.docs.push(structuredClone(r.docs[0]));
    if (mutation === "omitted reviews") delete r.reviews;
    if (mutation === "cleared review") r.reviews = [];
    if (mutation === "extra review")
      r.reviews.push({ component: "unproven", reason: "invented" });
    assert.equal(lib.directoryAdmissionMatches(e, r), false);
  });
for (const patch of [
  { version: "unknown" },
  { parserVersion: "person-v9" },
  { receiptId: "bad" },
  { prior: { ...prior(), receiptId: "11" } },
  { prior: { ...prior(), candidateId: contact } },
  { prior: { ...prior(), hasDocuments: false } },
  {
    sources: [
      {
        id: sid,
        payload_hash: "a",
        parser_version: "person-v3",
        fetched_at: "bad",
      },
    ],
  },
])
  test(`malformed/unsupported decision evidence refuses: ${Object.keys(patch).join(",")}`, () => {
    assert.throws(() => evaluate(input(patch)), /directory_admission_/);
    assert.equal(
      lib.directoryAdmissionMatches(input(patch), { docs: [], reviews: [] }),
      false,
    );
  });

test("undated negative contact retains explicit chronology review across later observations", () => {
  const e = input();
  e.snapshot.emails = [
    {
      normalized: "synthetic@example.test",
      verification: { status: "Invalid" },
    },
  ];
  const first = evaluate(e);
  assert.ok(
    first.reviews.some(
      (x) =>
        x.component === "email:synthetic@example.test" &&
        x.reason === "directory_contact_chronology",
    ),
  );
  const next = input({ prior: prior(e.snapshot, first.reviews) });
  next.snapshot.emails = [
    {
      normalized: "synthetic@example.test",
      verification: { status: "Verified", checked_at: "2026-10-01" },
    },
  ];
  assert.ok(
    evaluate(next).reviews.some(
      (x) => x.component === "email:synthetic@example.test",
    ),
  );
});
test("frozen translator keeps unavailable jobs unspecified without altering populated education", () => {
  const e = input();
  e.snapshot.harvest = null;
  e.snapshot.exps = [];
  const absent = evaluate(e);
  assert.equal(hasHistory(absent), false);
  e.snapshot.harvest = { fetched_at: "2026-08-01" };
  const history = evaluate(e).docs.find((d) =>
    d.source.source_ref.endsWith(":harvest"),
  );
  assert.equal(history.mode, "replace_lists");
  assert.equal(Object.hasOwn(history, "jobs"), false);
  e.snapshot.edus = [
    { school_name: "Synthetic School", degree_name: "Synthetic degree" },
  ];
  const withEducation = evaluate(e).docs.find((d) =>
    d.source.source_ref.endsWith(":harvest"),
  );
  assert.equal(Object.hasOwn(withEducation, "jobs"), false);
  assert.equal(withEducation.educations.length, 1);
});
for (const location of ["current", "prior"])
  test(`existing string-phone snapshots remain supported: ${location}`, () => {
    const e = input();
    if (location === "current") e.snapshot.phones = ["+12025550123"];
    else {
      const s = snapshot();
      s.phones = ["+12025550123"];
      e.prior = prior(s);
    }
    assert.doesNotThrow(() => evaluate(e));
    if (location === "current")
      assert.ok(
        evaluate(e).docs.some((d) =>
          d.contacts.some((c) => c.value_normalized === "+12025550123"),
        ),
      );
  });
