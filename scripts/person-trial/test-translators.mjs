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
check("directory: no Harvest copy preserves headers without asserting list keys", () => {
  const d = fromDirectory(board, null, [], [], emails, [], CID);
  assert.equal(d.mode, "replace_lists");
  assert.ok(!("jobs" in d) && !("educations" in d) && !("skills" in d));
});
check("directory: statuses by exact value", () => {
  const c = lib.directoryCheck;
  assert.deepEqual(c("Unverified"), { status: "active", quality: null, result: null, mapped: true });
  assert.deepEqual(c("Unavailable"), { status: "active", quality: null, result: null, mapped: true });
  assert.equal(c("Failed").status, "invalid");
  assert.equal(c("Failed", { provider_result: "disposable" }).result, "disposable");
  assert.deepEqual(c("Replied"), { status: "active", quality: "good", result: "replied", mapped: true });
  assert.deepEqual(c("Risky", { provider_result: "catch_all" }), { status: "active", quality: "risky", result: "catch_all", mapped: true });
  assert.equal(c("Verified", { provider_result: "ok" }).quality, "good");
  assert.equal(c("Bounced").status, "bounced");
  assert.equal(c("Risky", { can_use: false }).status, "active");
  assert.equal(c("Something new").mapped, false);
});
check("directory: the board's fallback primary is not the directory's primary", () => {
  const fallback = [{ normalized: "first@example.org", classification: "personal", verification: { status: "Failed", provider_result: "invalid" } }];
  const d = fromDirectory({ ...board, primary_email: "first@example.org" }, null, [], [], fallback, [], CID);
  const e = d.contacts.find((x) => x.value_normalized === "first@example.org");
  assert.equal(e.source_detail, "directory");
  assert.equal(e.status, "invalid");
  const unv = [{ normalized: "first@example.org", verification: { status: "Unverified" } }];
  assert.equal(fromDirectory({ ...board, primary_email: "first@example.org" }, null, [], [], unv, [], CID).contacts[0].source_detail, "directory");
  const marked = [{ normalized: "first@example.org", verification: { status: "Unverified", primary: true } }];
  assert.equal(fromDirectory({ ...board, primary_email: "first@example.org" }, null, [], [], marked, [], CID).contacts[0].source_detail, "directory_primary");
});
check("directory: phones read under any column name", () => {
  const d = fromDirectory(board, null, [], [], [], [{ value_text: "4155550134" }, { number: "+44 20 7946 0000" }], CID);
  assert.deepEqual(d.contacts.filter((c) => c.kind === "phone").map((c) => c.value_normalized).sort(), ["+14155550134", "+442079460000"]);
});

// ---------- review fixes: the old import ----------
check("legacy: a current title and company with no job list become one job", () => {
  const d = fromLegacyImport({ id: CID, created_at: "2025-10-05T00:00:00Z", current_title: "Staff Engineer", current_company: "Example Corp" }, [], []);
  assert.equal(d.jobs.length, 1);
  assert.equal(d.jobs[0].is_current, true);
  assert.equal(d.jobs[0].company.identity, "n:example");
  assert.equal(project(d).current_title, "Staff Engineer");
  assert.ok(!("educations" in d) && !("skills" in d), "empty lists are left out");
});
check("legacy: a newer current title than the list's ended jobs leads", () => {
  const d = fromLegacyImport({ id: CID, created_at: "2025-10-05T00:00:00Z", current_title: "Director", current_company: "New Co",
    work_experience: [{ title: "Engineer", company: "Old Co", start_date: { year: 2015 }, end_date: { year: 2020 } }] }, [], []);
  assert.deepEqual(d.jobs.map((j) => j.title), ["Director", "Engineer"]);
  const same = fromLegacyImport({ id: CID, created_at: "2025-10-05T00:00:00Z", current_title: "Engineer", current_company: "Old Co",
    work_experience: [{ title: "Engineer", company: "Old Co", start_date: { year: 2015 }, end_date: { year: 2020 } }] }, [], []);
  assert.equal(same.jobs.length, 1, "a title the list names adds nothing");
});
check("legacy: username with an address pasted in comes from the URL", () => {
  const d = fromLegacyImport({ id: CID, created_at: "2025-10-05T00:00:00Z", linkedin_username: "test-person-9; someone@example.org", linkedin_url: "https://www.linkedin.com/in/test-person-9/" }, [], []);
  assert.deepEqual(d.identities.filter((i) => i.kind === "linkedin_username").map((i) => i.value), ["test-person-9"]);
  const noUrl = fromLegacyImport({ id: CID, created_at: "2025-10-05T00:00:00Z", linkedin_username: "test-person-9; someone@example.org" }, [], []);
  assert.deepEqual(noUrl.identities.map((i) => i.value), ["test-person-9"]);
});
check("legacy: raw skills joined by line breaks are split", () => {
  const d = fromLegacyImport({ id: CID, created_at: "2025-10-05T00:00:00Z", linkedin_data: { data: { basic_info: {}, experience: [], skills: ["Kubernetes\nTerraform\nSAFe Agilist", "Go"] } } }, [], []);
  assert.deepEqual(d.skills.map((s) => s.key), ["kubernetes", "terraform", "safe agilist", "go"]);
});
check("legacy: camel-shape list shorter than fullPositions uses fullPositions", () => {
  const pos = [{ title: "Engineer", companyName: "Gamma", companyId: 555, start: { year: 2020, month: 1 }, end: { year: 0 } }];
  const full = [...pos, { title: "Intern", companyName: "Gamma", companyId: 555, start: { year: 2019, month: 6 }, end: { year: 2019, month: 9 } }];
  const d = fromLegacyImport({ id: CID, created_at: "2025-12-10T00:00:00Z", work_experience: pos, linkedin_data: { urn: "ACoAABBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", position: pos, fullPositions: full } }, [], []);
  assert.deepEqual(d.jobs.map((j) => j.title), ["Engineer", "Intern"]);
});
check("legacy: a rewritten row's education lines are the list, enriched from the raw JSON", () => {
  const rawEdu = { data: { basic_info: {}, experience: [], education: [
    { school: "Example State University", school_id: "999", degree_name: "Bachelor of Science - BS", start_date: { year: 2014 }, end_date: { year: 2018 } },
    { school: "Old Academy", degree_name: "Certificate" }] } };
  const lines = "Example State University - Bachelor of Science - BS\nExample High School";
  const rewritten = fromLegacyImport({ id: CID, created_at: "2025-10-05T00:00:00Z", source: "directory", education: lines, linkedin_data: rawEdu }, [], []);
  assert.deepEqual(rewritten.educations.map((e) => e.school.name), ["Example State University", "Example High School"]);
  assert.equal(rewritten.educations[0].school.identity, "li:999");
  assert.equal(rewritten.educations[0].end_year, 2018);
  const untouched = fromLegacyImport({ id: CID, created_at: "2025-10-05T00:00:00Z", source: "LinkedIn", linkedin_enrichment_date: "2025-10-06T00:00:00Z", education: lines, linkedin_data: rawEdu }, [], []);
  assert.deepEqual(untouched.educations.map((e) => e.school.name), ["Example State University", "Old Academy", "Example High School"]);
});
check("legacy: rewritten lines: a joined line, a second degree, a longer name", () => {
  const rawEdu = { data: { basic_info: {}, experience: [], education: [
    { school: "Example Institute of Technology", school_id: "901", degree_name: "BS", end_date: { year: 2010 } },
    { school: "Example Accelerator", school_id: "902", end_date: { year: 2015 } },
    { school: "Sample University", school_id: "903", degree_name: "BS", end_date: { year: 2005 } },
    { school: "Sample University", school_id: "903", degree_name: "MS", end_date: { year: 2007 } },
    { school: "Other College", school_id: "904", end_date: { year: 2001 } }] } };
  const lines = "Example Accelerator, Example Institute of Technology\nSample University - MS\nOther College Springfield";
  const d = fromLegacyImport({ id: CID, created_at: "2025-10-05T00:00:00Z", source: "directory", education: lines, linkedin_data: rawEdu }, [], []);
  assert.deepEqual(d.educations.map((e) => e.school.identity), ["li:901", "li:902", "li:903", "li:904", "li:903"]);
  assert.ok(d.educations.every((e) => e.end_year), "every school keeps its years");
  assert.equal(d.educations[2].degree, "MS");
});
check("legacy: a lone education year is the end year", () => {
  const d = fromLegacyImport({ id: CID, created_at: "2025-10-05T00:00:00Z", linkedin_data: { data: { basic_info: {}, experience: [], education: [{ school: "Example U", duration: "2013" }] } } }, [], []);
  assert.equal(d.educations[0].end_year, 2013);
  assert.equal(d.educations[0].start_year, null);
});
check("legacy: an address in the About is kept, never primary", () => {
  const d = fromLegacyImport({ id: CID, created_at: "2025-10-05T00:00:00Z", profile_summary: "Reach me at Test.About@example.org." }, [], []);
  const e = d.contacts.find((c) => c.value_normalized === "test.about@example.org");
  assert.ok(e && e.never_primary && e.source_detail === "profile_about");
});
check("legacy: outreach bounces and replies are checks; old primary flag; raw verifier response", () => {
  const rows = [
    { id: "00000000-0000-4000-8000-0000000000e3", email_address: "bounced@example.org", email_type: "personal", quality: "good", result: "ok", verification_date: "2025-01-01T00:00:00Z", raw_response: '{"result":"ok","free":true,"role":false}' },
    { id: "00000000-0000-4000-8000-0000000000e4", email_address: "replied@example.org", email_type: "personal", email_source: "primary", quality: "risky", result: "catch_all", verification_date: "2025-01-01T00:00:00Z" },
  ];
  const comms = [
    { id: "c1", communication_type: "email", status: "bounced", email_used: rows[0].id, communication_date: "2025-03-01T00:00:00Z" },
    { id: "c2", communication_type: "email", status: "replied", email_used: rows[1].id, communication_date: "2025-03-01T00:00:00Z", response_date: "2025-03-02T00:00:00Z" },
    { id: "c3", communication_type: "email", status: "sent", email_used: rows[1].id, communication_date: "2025-04-01T00:00:00Z" },
  ];
  const d = fromLegacyImport({ id: CID, created_at: "2025-10-05T00:00:00Z" }, rows, [], comms);
  const b = d.contacts.find((c) => c.value_normalized === "bounced@example.org");
  const r = d.contacts.find((c) => c.value_normalized === "replied@example.org");
  assert.equal(b.status, "bounced");
  assert.deepEqual(b.verification_raw, null, "the newest check (the bounce) has no verifier JSON");
  assert.equal(r.quality, "good");
  assert.equal(r.result, "replied");
  assert.equal(r.legacy_primary, true);
  assert.equal(lib.rankedContacts(d.contacts, "email")[0].value_normalized, "replied@example.org");
  const noComms = fromLegacyImport({ id: CID, created_at: "2025-10-05T00:00:00Z" }, rows, []);
  assert.deepEqual(noComms.contacts.find((c) => c.value_normalized === "bounced@example.org").verification_raw, { result: "ok", free: true, role: false });
});
check("ranking: ties go to the old primary, as the SQL does", () => {
  const e = (v, extra) => ({ kind: "email", value_raw: v, value_normalized: v, label: "personal", status: "active", never_primary: false, is_manual: false, source_detail: null, quality: "good", result: "ok", resultcode: null, subresult: null, verifier: null, verified_at: "2025-01-01T00:00:00Z", verification_raw: null, legacy_email_id: null, legacy_email_ids: [], legacy_primary: false, ...extra });
  const order = lib.rankedContacts([e("a@example.org"), e("z@example.org", { legacy_primary: true }), e("b@example.org", { label: "business" })], "email").map((c) => c.value_normalized);
  assert.deepEqual(order, ["z@example.org", "a@example.org", "b@example.org"]);
});

// ---------- review fixes: Harvest, normalisation, side roles ----------
check("harvest: an empty section is left out of the doc", () => {
  const d = fromHarvest({ ...harvest, experience: [], education: [] }, { id: "x", candidate_id: CID, created_at: "2026-09-20T08:00:00Z" });
  assert.ok(!("jobs" in d) && !("educations" in d));
  assert.ok(d.skills.length > 0);
  const none = fromHarvest({ publicIdentifier: "test-person-002" }, { id: "x", candidate_id: CID, created_at: "2026-09-20T08:00:00Z" });
  assert.ok(!("jobs" in none) && !("educations" in none) && !("skills" in none));
});
check("harvest: websites and an About address become contacts", () => {
  const d = fromHarvest({ ...harvest, about: "Write to test.h@example.org", websites: ["https://github.com/test-person", "https://www.example.org/me/"] }, { id: "x", candidate_id: CID, created_at: "2026-09-20T08:00:00Z" });
  assert.equal(d.contacts.find((c) => c.kind === "github").value_normalized, "test-person");
  assert.equal(d.contacts.find((c) => c.kind === "website").value_normalized, "example.org/me");
  assert.equal(d.contacts.find((c) => c.kind === "email").never_primary, true);
});
check("job skills: an array holds whole names; rendered text is split", () => {
  const d = fromHarvest({ ...harvest, experience: [{ position: "Engineer", companyName: "Acme", startDate: { year: 2020 }, endDate: { text: "Present" }, skills: ["Continuous Integration and Continuous Delivery (CI/CD)"] }] }, { id: "x", candidate_id: CID, created_at: "2026-09-20T08:00:00Z" });
  assert.deepEqual(d.jobs[0].skills, ["Continuous Integration and Continuous Delivery (CI/CD)"]);
});
check("phone: a spreadsheet float keeps its digits", () => {
  assert.equal(normalizePhone("14155550134.0"), "+14155550134");
  assert.equal(normalizePhone("4155550134.0"), "+14155550134");
});
check("side roles: judged on the title", () => {
  const side = lib.isSideRoleTitle;
  assert.equal(side("Hardware Engineer", "Mentor Graphics"), false);
  assert.equal(side("Analyst", "The College Board"), false);
  assert.equal(side("Product Director, Membership", "Example Co"), false);
  assert.equal(side("AVP-Business Solutions Advisor", "Example Bank"), false);
  assert.equal(side("Sr. Principal - AI & Cloud Advisory", "Example Co"), false);
  assert.equal(side("Official Member", "Example Technology Council"), true);
  assert.equal(side("Board Member", "Example Co"), true);
  assert.equal(side("VP Engineering, Board Member", "Example Co"), true);
  assert.equal(side("Advisor", "Example Fund"), true);
  assert.equal(side("Member of Technical Staff", "Example Co"), false);
  assert.equal(side(null, "Example Technology Council"), true);
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
