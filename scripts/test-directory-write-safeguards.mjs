import assert from "node:assert/strict";
import { test } from "node:test";
import { patchFor, needsEmbedding, syncHash, persistDirectoryUpdate } from "./sync-directory.mjs";

const previous = {
  linkedin_enrichment_date: "2026-09-25T12:00:00Z",
  email: "kept@example.test",
  follow_up_at: "2026-10-01",
  matching_embedding: "[0.1]",
  embedding_type: "airtable_sync",
};
const mapped = {
  directory_contact_id: "00000000-0000-4000-8000-000000000001",
  source: "directory", status: "engaged",
  email: null, follow_up_at: null,
  current_title: "Old title", current_company: "Old employer",
  headline: "Old headline", profile_summary: "Old summary", location: "Old location",
  work_experience: [{ title: "Old title" }], education: "Old school",
  education_schools: ["Old school"], education_degrees: ["Old degree"], education_fields: ["Old field"],
  top_skills: ["Old skill"], all_skills_text: "Old skill", calculated_experience_years: 8,
  linkedin_enrichment_date: "2026-09-24T12:00:00Z",
};
const historyFields = ["current_title", "current_company", "headline", "profile_summary", "location",
  "work_experience", "education", "education_schools", "education_degrees", "education_fields",
  "top_skills", "all_skills_text", "calculated_experience_years", "linkedin_enrichment_date"];

test("empty directory email and follow-up never clear the website values", () => {
  for (const value of [null, undefined, "", "   "]) {
    const patch = patchFor({ ...mapped, email: value, follow_up_at: value }, previous);
    assert.equal("email" in patch, false);
    assert.equal("follow_up_at" in patch, false);
  }
});
test("older directory history is held while non-empty contacts and status propagate", () => {
  const patch = patchFor({ ...mapped, email: "new@example.test", follow_up_at: "2026-10-02", status: "contacted" }, previous);
  for (const key of historyFields) assert.equal(key in patch, false, key);
  assert.equal(patch.email, "new@example.test");
  assert.equal(patch.follow_up_at, "2026-10-02");
  assert.equal(patch.status, "contacted");
  assert.equal(patch.source, "directory");
  assert.equal(patch.directory_contact_id, mapped.directory_contact_id);
});
test("newer and equal dated directory history still updates", () => {
  for (const date of ["2026-09-25T12:00:00Z", "2026-09-26T12:00:00Z"]) {
    assert.equal(patchFor({ ...mapped, linkedin_enrichment_date: date }, previous).current_title, "Old title");
  }
});
test("undated and invalid-date copies cannot replace a dated website refresh", () => {
  for (const date of [null, "", "not-a-date"]) {
    assert.equal("work_experience" in patchFor({ ...mapped, linkedin_enrichment_date: date }, previous), false);
  }
  assert.equal(patchFor(mapped, { linkedin_enrichment_date: null }).current_title, "Old title");
});
test("empty history values do not erase populated columns even on a newer source", () => {
  const patch = patchFor({ ...mapped, linkedin_enrichment_date: "2026-09-26T12:00:00Z", education: "", top_skills: [] }, previous);
  assert.equal("education" in patch, false);
  assert.equal("top_skills" in patch, false);
});
test("an old directory copy is not used to replace the matching embedding", () => {
  assert.equal(needsEmbedding(previous, mapped), false);
  assert.equal(needsEmbedding({ ...previous, matching_embedding: null }, mapped), false);
  assert.equal(needsEmbedding(previous, { ...mapped, linkedin_enrichment_date: "2026-09-26T12:00:00Z" }), true);
});
test("building a guarded patch does not mutate the source or its sync hash", () => {
  const before = syncHash(mapped, mapped.linkedin_enrichment_date);
  patchFor(mapped, previous);
  assert.equal(syncHash(mapped, mapped.linkedin_enrichment_date), before);
  assert.equal(mapped.current_title, "Old title");
});

// Model the REST boundary's equality predicate, including a refresh that lands
// after the directory lookup. The production function constructs the real query.
function database(row) {
  return async (path, init) => {
    const filter = new URL(path, "http://localhost").searchParams.get("linkedin_enrichment_date");
    if (filter === "is.null" && row.linkedin_enrichment_date != null) return [];
    if (filter?.startsWith("eq.") && Date.parse(row.linkedin_enrichment_date) !== Date.parse(filter.slice(3))) return [];
    assert.equal(init.method, "PATCH");
    Object.assign(row, JSON.parse(init.body));
    return [{ id: row.id }];
  };
}
test("a refresh arriving after lookup prevents the directory PATCH and sync hash change", async () => {
  const row = { id: "test-id", linkedin_enrichment_date: "2026-09-26T12:00:00Z", current_title: "Newest title", directory_sync_hash: "old-hash" };
  const saved = await persistDirectoryUpdate(database(row), { id: row.id, expectedEnrichmentDate: previous.linkedin_enrichment_date, current_title: "Older title", directory_sync_hash: "new-hash" });
  assert.equal(saved, false);
  assert.equal(row.current_title, "Newest title");
  assert.equal(row.directory_sync_hash, "old-hash");
});
test("the first website refresh is protected when the lookup had no fetch date", async () => {
  const row = { id: "test-id", linkedin_enrichment_date: "2026-09-26T12:00:00Z", current_title: "Newest title" };
  assert.equal(await persistDirectoryUpdate(database(row), { id: row.id, expectedEnrichmentDate: null, current_title: "Older title" }), false);
  assert.equal(row.current_title, "Newest title");
});
test("an unchanged fetch date allows the save without sending guard metadata as a column", async () => {
  const row = { id: "test-id", linkedin_enrichment_date: previous.linkedin_enrichment_date };
  assert.equal(await persistDirectoryUpdate(database(row), { id: row.id, expectedEnrichmentDate: previous.linkedin_enrichment_date, current_title: "New directory title" }), true);
  assert.equal(row.current_title, "New directory title");
  assert.equal("expectedEnrichmentDate" in row, false);
});
test("Do Not Contact still propagates when a concurrent profile refresh happened", async () => {
  const row = { id: "test-id", linkedin_enrichment_date: "2026-09-26T12:00:00Z", current_title: "Newest title" };
  assert.equal(await persistDirectoryUpdate(database(row), { id: row.id, status: "Do Not Contact" }), true);
  assert.equal(row.status, "Do Not Contact");
  assert.equal(row.current_title, "Newest title");
});
