#!/usr/bin/env node
// Self-test for the person translators (lib/server/person/) on SYNTHETIC
// people only: no database, no network, no real names or addresses.
//   node scripts/build-worker-lib.mjs && node scripts/person-trial/test-translators.mjs
// Prints each check and exits 1 on the first failure.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const lib = await import(path.join(root, "scripts/dist/worker-lib.mjs"));
const { fromLegacyImport, fromHarvest, fromDirectory, fromApplication, project, normalizePhone, normalizeEmail, skillKeyOf, splitSkill, degreeLevel, companyOf, schoolOf, TT_ORG_ID } = lib;

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}: ${err.message}`);
    process.exit(1);
  }
};

const CID = "00000000-0000-4000-8000-000000000001";

// ---------- normalisation ----------
check("phone: 10 digits become +1", () => assert.equal(normalizePhone("(415) 555-0134"), "+14155550134"));
check("phone: +44 kept", () => assert.equal(normalizePhone("+44 20 7946 0000"), "+442079460000"));
check("phone: extension dropped", () => assert.equal(normalizePhone("415.555.0134 x22"), "+14155550134"));
check("phone: short junk is null", () => assert.equal(normalizePhone("12"), null));
check("email: mailto and case", () => assert.equal(normalizeEmail(" MailTo:Test.Person@Example.COM "), "test.person@example.com"));
check("email: not an address", () => assert.equal(normalizeEmail("n/a"), null));
check("email: '@' text that is not an address is kept as invalid", () => {
  const d = fromLegacyImport({ id: CID, created_at: "2025-10-05T00:00:00Z", email: "Test Person@example.org" }, [], []);
  assert.equal(d.contacts.length, 1);
  assert.equal(d.contacts[0].status, "invalid");
  assert.equal(d.contacts[0].result, "not_an_address");
});
check("skill: 'Name : 12' splits", () => assert.deepEqual(splitSkill("SQL : 12"), { name: "SQL", endorsements: 12 }));
check("skill key: qualifier stripped", () => assert.equal(skillKeyOf("Rust (Programming Language)"), skillKeyOf("rust")));
check("degree levels", () => {
  assert.equal(degreeLevel("Bachelor of Science - BS"), "bachelor");
  assert.equal(degreeLevel("Master of Science (MS)"), "master");
  assert.equal(degreeLevel("MBA"), "mba");
  assert.equal(degreeLevel("Doctor of Philosophy - PhD"), "doctorate");
  assert.equal(degreeLevel("High School"), "high_school");
  assert.equal(degreeLevel(null), null);
});
check("company identity order: id, username, url, name", () => {
  assert.equal(companyOf({ name: "Acme", linkedin_id: 123, linkedin_url: "https://www.linkedin.com/company/acme/" }).identity, "li:123");
  assert.equal(companyOf({ name: "Acme", linkedin_url: "https://www.linkedin.com/company/acme/" }).identity, "u:acme");
  assert.equal(companyOf({ name: "Acme", linkedin_url: "https://www.linkedin.com/company/4242/" }).identity, "li:4242");
  assert.equal(companyOf({ name: "Acme, Inc.", linkedin_url: "https://www.linkedin.com/search/results/all/?keywords=Acme" }).identity, "n:acme");
  assert.equal(companyOf({ name: "Stealth Startup" }).is_placeholder, true);
  assert.equal(companyOf({ name: "Self-Employed" }).identity, "n:self employed");
});
check("school identity", () => {
  assert.equal(schoolOf({ name: "Example State University", linkedin_org_id: "999" }).identity, "li:999");
  assert.equal(schoolOf({ name: "Example State University" }).identity, "n:example state university");
  assert.equal(schoolOf({ name: "" }), null);
});

// ---------- the old import, both job shapes ----------
const legacyA = {
  id: CID,
  created_at: "2025-10-05T00:00:00Z",
  source: "LinkedIn",
  full_name: "Test Person",
  linkedin_username: "test-person-000",
  linkedin_enrichment_date: "2025-10-06T00:00:00Z",
  email: "Test.Person@example.org",
  phone: "4155550134",
  work_experience: [
    { title: "Board Member", company: "Example Council", is_current: true, start_date: { year: 2023, month: "Jan" } },
    { title: "Senior Engineer", company: "Acme", company_id: "123", company_linkedin_url: "https://www.linkedin.com/company/123/", is_current: true, start_date: { year: 2021, month: "Mar" }, employment_type: "Full-time", skills: ["Go (Programming Language)", "Kubernetes and +2 skills"] },
    { title: "Engineer", company: "Beta Labs", start_date: { year: 2018, month: "Jun" }, end_date: { year: 2021, month: "Feb" } },
    { title: "Engineer", company: "Beta Labs", start_date: { year: 2018, month: "Jun" }, end_date: { year: 2021, month: "Feb" } },
  ],
  education: "Example State University - Bachelor of Science - BS in Computer Science",
  top_skills: ["Python", "SQL : 3"],
  all_skills_text: "Python, SQL : 3, Go, None",
  linkedin_data: {
    success: true,
    data: {
      basic_info: { urn: "ACoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", public_identifier: "test-person-000", email: "scraped@example.net", top_skills: ["Python"], location: { country_code: "US", full: "Example City" } },
      experience: [{ title: "Engineer", company: "Beta Labs", company_id: "777", company_linkedin_url: "https://www.linkedin.com/company/777/", start_date: { year: 2018, month: "Jun" } }],
      education: [{ school: "Example State University", school_id: "999", degree_name: "Bachelor of Science - BS", field_of_study: "Computer Science", start_date: { year: 2014 }, end_date: { year: 2018 } }],
    },
  },
};
const legacyEmails = [
  { id: "00000000-0000-4000-8000-0000000000e1", email_address: "test.person@example.org", email_type: "personal", email_source: "primary", quality: "good", result: "ok", verification_date: "2025-10-20T00:00:00Z" },
  { id: "00000000-0000-4000-8000-0000000000e2", email_address: "tp@acme.example", email_type: "business", email_source: "pas", quality: "bad", result: "invalid", verification_date: "2025-10-20T00:00:00Z" },
];
const v2Emails = [{ id: "00000000-0000-4000-8000-0000000000f1", email_normalized: "tp2@acme.example", email_type: "work", email_source: "pas", quality: "risky", result: "catch_all", is_primary: true }];
const docA = fromLegacyImport(legacyA, legacyEmails, v2Emails);
check("legacy: real job first, side role after", () => {
  assert.equal(docA.jobs[0].title, "Senior Engineer");
  assert.equal(docA.jobs[1].is_side_role, true);
});
check("legacy: exact duplicate dropped", () => assert.equal(docA.jobs.length, 3));
check("legacy: company id restored from the raw JSON", () => assert.equal(docA.jobs.find((j) => j.company.name === "Beta Labs").company.identity, "li:777"));
check("legacy: every job with a company has an identity", () => assert.ok(docA.jobs.every((j) => !j.company.name || j.company.identity)));
check("legacy: school with id and years from the raw JSON", () => {
  assert.equal(docA.educations.length, 1);
  assert.equal(docA.educations[0].school.identity, "li:999");
  assert.equal(docA.educations[0].end_year, 2018);
  assert.equal(docA.educations[0].degree_level, "bachelor");
});
check("legacy: skills split, filler dropped, job skills in", () => {
  const keys = docA.skills.map((s) => s.key);
  assert.ok(keys.includes("sql") && keys.includes("python") && keys.includes("go") && keys.includes("kubernetes"));
  assert.ok(!keys.includes("none"));
  assert.equal(docA.skills.find((s) => s.key === "sql").endorsements, 3);
  assert.equal(docA.skills.find((s) => s.key === "python").is_top, true);
});
check("legacy: identities", () => {
  const kinds = docA.identities.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ["linkedin_urn", "linkedin_username"]);
});
check("legacy: contacts merged, invalid kept, scraped never primary", () => {
  const e = (v) => docA.contacts.find((c) => c.value_normalized === v);
  assert.equal(docA.contacts.filter((c) => c.value_normalized === "test.person@example.org").length, 1);
  assert.equal(e("test.person@example.org").legacy_email_id, legacyEmails[0].id);
  assert.equal(e("tp@acme.example").status, "invalid");
  assert.equal(e("tp2@acme.example").label, "business");
  assert.equal(e("scraped@example.net").never_primary, true);
  assert.equal(docA.contacts.find((c) => c.kind === "phone").value_normalized, "+14155550134");
});
check("legacy: fetched_at is the import date", () => assert.equal(docA.source.fetched_at, "2025-10-06T00:00:00.000Z"));
check("legacy: same input, same doc and hash", () => assert.equal(fromLegacyImport(legacyA, legacyEmails, v2Emails).source.payload_hash, docA.source.payload_hash));

const legacyB = {
  id: CID,
  created_at: "2025-12-10T00:00:00Z",
  source: "LinkedIn",
  linkedin_username: "test-person-001",
  work_experience: [
    { title: "Staff Engineer", companyName: "Gamma", companyId: 555, companyUsername: "gamma", start: { year: 2022, month: 4, day: 0 }, end: { year: 0, month: 0, day: 0 }, employmentType: "Full-time" },
    { title: "Engineer", companyName: "Delta", companyId: 556, start: { year: 2019, month: 1 }, end: { year: 2022, month: 3 } },
  ],
  linkedin_data: { urn: "ACoAABBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", username: "test-person-001", educations: [{ schoolName: "Example Tech", schoolId: "4242", start: { year: 2015 }, end: { year: 2019 }, degree: "Master's degree" }], skills: [{ name: "Rust", endorsementsCount: 4 }] },
};
const docB = fromLegacyImport(legacyB, [], []);
check("legacy shape 2: current from end year 0, ids kept", () => {
  assert.equal(docB.jobs[0].is_current, true);
  assert.equal(docB.jobs[0].company.identity, "li:555");
  assert.equal(docB.jobs[0].employment_type, "Full-time");
  assert.equal(docB.educations[0].school.identity, "li:4242");
  assert.equal(docB.skills.find((s) => s.key === "rust").endorsements, 4);
});

// ---------- Harvest ----------
const harvest = {
  id: "ACoAACCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  publicIdentifier: "test-person-002",
  firstName: "Test",
  lastName: "Person",
  headline: "Engineer",
  location: { linkedinText: "Example City", countryCode: "US" },
  experience: [
    { position: "Advisor", companyName: "Example Fund", startDate: { year: 2024, month: "Jan", text: "Jan 2024" }, endDate: { text: "Present" } },
    { position: "Principal Engineer", companyName: "Acme", companyId: "123", companyUniversalName: "acme", companyLinkedinUrl: "https://www.linkedin.com/company/acme/", employmentType: "Full-time", startDate: { year: 2020, month: "May", text: "May 2020" }, endDate: { text: "Present" }, skills: ["TypeScript"] },
  ],
  education: [{ schoolName: "Example State University", schoolId: "999", schoolLinkedinUrl: "https://www.linkedin.com/company/999/", degree: "Bachelor of Engineering (B.E.)", startDate: { year: 2012 }, endDate: { year: 2016 }, period: "2012 - 2016" }],
  skills: [{ name: "TypeScript", endorsements: "9 endorsements" }, { name: "Go" }],
  topSkills: ["Distributed Systems"],
  emails: [],
};
const docH = fromHarvest(harvest, { id: "00000000-0000-4000-8000-00000000a001", candidate_id: CID, created_at: "2026-09-20T08:00:00Z" });
check("harvest: real job first, company id kept", () => {
  assert.equal(docH.jobs[0].title, "Principal Engineer");
  assert.equal(docH.jobs[0].company.identity, "li:123");
  assert.equal(docH.jobs[0].employment_type, "Full-time");
  assert.equal(docH.jobs[1].is_side_role, true);
});
check("harvest: agrees with harvestToPoolRecord on order and current title", () => {
  const rec = lib.harvestToPoolRecord(harvest);
  assert.deepEqual(docH.jobs.map((j) => j.title), rec.work_experience.map((p) => p.title));
  assert.equal(project(docH).current_title, rec.current_title);
});
check("harvest: school with years, skills with endorsements and top", () => {
  assert.equal(docH.educations[0].start_year, 2012);
  assert.equal(docH.skills.find((s) => s.key === "typescript").endorsements, 9);
  assert.equal(docH.skills.find((s) => s.key === "distributed systems").is_top, true);
  assert.equal(docH.contacts.length, 0);
  assert.equal(docH.source.fetched_at, "2026-09-20T08:00:00.000Z");
});
check("harvest: more than 25 positions all kept", () => {
  const many = { ...harvest, experience: Array.from({ length: 30 }, (_, i) => ({ position: `Role ${i}`, companyName: `Company ${i}`, startDate: { year: 2020 - i }, endDate: { year: 2021 - i } })) };
  const d = fromHarvest(many, { id: "x", candidate_id: CID, created_at: "2026-09-20T08:00:00Z" });
  assert.equal(d.jobs.length, 30);
  assert.equal(d.jobs.filter((j) => j.is_current).length, 0);
});

// ---------- the directory ----------
const board = { contact_id: "00000000-0000-4000-8000-00000000d001", name: "Test Person", primary_email: "test.person@example.org", linkedin_url: "https://www.linkedin.com/in/test-person-003", airtable_record_ids: ["recAAAAAAAAAAAAA1"], updated_at: "2026-09-24T00:00:00Z" };
const hrow = { contact_id: board.contact_id, fetched_at: "2026-06-01T00:00:00Z", public_identifier: "test-person-003", headline: "Engineer", skills: ["Python", "SQL : 0"] };
const exps = [
  { title: "Engineer", company_name: "Acme", company_linkedin_url: "https://www.linkedin.com/company/acme/", start_year: 2021, start_month: 3, is_current: true, sort_order: 0 },
];
const edus = [{ school_name: "Example State University", degree: "BS", field_of_study: "Math", start_year: 2014, end_year: 2018, sort_order: 0 }];
const emails = [
  { normalized: "test.person@example.org", original_value: "Test.Person@example.org", classification: "personal", verification: { status: "Verified", primary: true, provider: "millionverifier", checked_at: "2026-05-01T00:00:00Z" } },
  { normalized: "tp@acme.example", classification: "business", verification: { status: "Bounced", bounced_at: "2026-05-02T00:00:00Z" } },
];
const docD = fromDirectory(board, hrow, exps, edus, emails, [{ value: "4155550134", provenance: "source" }], CID);
check("directory: lists, identities, contacts", () => {
  assert.equal(docD.mode, "replace_lists");
  assert.equal(docD.jobs[0].company.identity, "u:acme");
  assert.equal(docD.educations[0].end_year, 2018);
  assert.deepEqual(docD.identities.map((i) => i.kind).sort(), ["airtable_id", "directory_contact_id", "linkedin_username"]);
  assert.equal(docD.contacts.find((c) => c.value_normalized === "test.person@example.org").source_detail, "directory_primary");
  assert.equal(docD.contacts.find((c) => c.value_normalized === "tp@acme.example").status, "bounced");
  assert.equal(docD.contacts.find((c) => c.kind === "phone").value_normalized, "+14155550134");
  assert.equal(docD.source.fetched_at, "2026-06-01T00:00:00.000Z");
});
check("directory: no Harvest copy means contacts only", () => {
  const d = fromDirectory(board, null, [], [], emails, [], CID);
  assert.equal(d.mode, "contacts_only");
  assert.equal(d.jobs.length + d.educations.length + d.skills.length, 0);
});

// ---------- an application ----------
const app = { id: "00000000-0000-4000-8000-00000000b001", organization_id: TT_ORG_ID, candidate_id: CID, created_at: "2026-09-01T00:00:00Z", name: "Test Person", email: "typed@example.org", contact: { phone: "4155550199" } };
check("application: typed contacts are claimed unless it created the person", () => {
  const d = fromApplication(app, false);
  assert.equal(d.mode, "fill_gaps");
  assert.ok(d.contacts.every((c) => c.status === "claimed"));
  assert.ok(fromApplication(app, true).contacts.every((c) => c.status === "active"));
});
check("application: other organizations refused", () => assert.throws(() => fromApplication({ ...app, organization_id: "00000000-0000-4000-8000-00000000c001" }, false)));

// ---------- the projection ----------
check("project: shapes and years", () => {
  const p = project(docA);
  assert.equal(p.current_title, "Senior Engineer");
  assert.equal(p.work_experience.length, 3);
  assert.equal(p.education_schools.length, p.education_degrees.length);
  assert.ok(p.top_skills.length > 0);
  assert.equal(p.email, "test.person@example.org");
  assert.equal(typeof p.career_years, "number");
});

console.log(`\n${passed} checks passed`);
