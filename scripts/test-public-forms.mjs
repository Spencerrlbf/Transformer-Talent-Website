#!/usr/bin/env node
// Public forms can't prove who is typing. Checks the rules that follow from
// that, with no database and no network (every request goes to a stub):
// the one canonical form of a LinkedIn address, a LinkedIn profile used for
// a pool person only when it is that person's own, a duplicate needing both
// email and LinkedIn, and a submission joining a pool person only when its
// email is one TT already has for them (otherwise it stands on its own, writes
// nothing to them, and its Airtable review row is linked to no one).
//
//   node scripts/test-public-forms.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "scripts/dist/public-forms-entry.ts");
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(
  entry,
  `export {
  canonicalLinkedin, linkedinUsername, harvestIdentity, harvestIsFor, usernameForms, formulaText,
  sameSubmitter, recentSameSubmitter, tenantPersonId, fillPoolFollowUp, promoteToCandidatePool,
} from "@/lib/server/applicants";
export { normalEmail, contactEmails, emailIsKnown, poolPersonHasEmail } from "@/lib/server/pool-emails";
export { runApplicantPipeline } from "@/lib/server/applicant-pipeline";
`
);
execFileSync("npx", ["--yes", "esbuild@0.28.2", entry, "--bundle", "--platform=node", "--format=esm",
  `--alias:@=${root}`, "--outfile=scripts/dist/public-forms.mjs", "--log-level=warning"], { cwd: root, stdio: "inherit" });
const m = await import(path.join(root, "scripts/dist/public-forms.mjs"));

const fails = [];
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !extra ? "" : `  (${extra})`}`);
  if (!ok) fails.push(name);
};
const noThrow = (fn) => {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, value: String(err) };
  }
};

// ---------- canonicalLinkedin ----------
const good = [
  ["https://www.linkedin.com/in/jane-doe", "jane-doe"],
  ["linkedin.com/in/Jane-Doe/", "jane-doe"],
  ["www.linkedin.com/in/jane-doe?originalSubdomain=uk", "jane-doe"],
  ["http://uk.linkedin.com/in/jane-doe", "jane-doe"],
  ["https://de.linkedin.com/in/jane-doe/details/experience/", "jane-doe"],
  ["https://m.linkedin.com/in/jane-doe#about", "jane-doe"],
  ["HTTPS://WWW.LINKEDIN.COM/IN/JANE-DOE", "jane-doe"],
  ["https://www.linkedin.com./in/jane-doe", "jane-doe"],
  ["  https://www.linkedin.com/in/jane_doe.42  ", "jane_doe.42"],
  ["https://www.linkedin.com/in/j%C3%B6rg-m%C3%BCller-12ab3c", "jörg-müller-12ab3c"],
  ["https://www.linkedin.com/in/jörg-müller", "jörg-müller"],
  ["https://www.linkedin.com/in/%C3%96LAF", "ölaf"],
  ["https://cn.linkedin.com/in/王伟", "王伟"],
  ["https://www.linkedin.com/in/jane-doe/?trk=public_profile&x=/in/someone-else", "jane-doe"],
];
for (const [raw, username] of good) {
  const r = noThrow(() => m.canonicalLinkedin(raw));
  const want = `https://www.linkedin.com/in/${encodeURIComponent(username)}`;
  check(`canonical: ${JSON.stringify(raw)} -> ${username}`,
    r.ok && r.value?.username === username && r.value?.url === want, JSON.stringify(r.value));
}
const bad = [
  "", "   ",
  "https://evil.com/in/jane-doe",
  "https://linkedin.com.evil.com/in/jane-doe",
  "https://evillinkedin.com/in/jane-doe",
  "https://evil.com/?next=https://www.linkedin.com/in/jane-doe",
  "https://evil.com/redirect#/in/jane-doe",
  "https://www.linkedin.com/feed/?u=/in/jane-doe",
  "https://www.linkedin.com/company/in/jane-doe",
  "https://www.linkedin.com/pub/jane-doe/1/2/3",
  "https://www.linkedin.com/in/",
  "https://www.linkedin.com/in//jane-doe",
  "https://www.linkedin.com/in/%E0%A4%A",
  "https://www.linkedin.com/in/%",
  "https://www.linkedin.com/in/jane%2Fdoe",
  "https://www.linkedin.com/in/jane%20doe",
  "https://www.linkedin.com/in/jane<script>",
  "https://www.linkedin.com/in/%2E%2E",
  "https://www.linkedin.com/in/...",
  `https://www.linkedin.com/in/${"a".repeat(201)}`,
  "javascript:alert(1)//linkedin.com/in/jane-doe",
  "ftp://linkedin.com/in/jane-doe",
  "mailto:x@linkedin.com/in/jane-doe",
  "https://linkedin.com@evil.com/in/jane-doe",
  "https://evil.com@linkedin.com/in/jane-doe",
  "jane-doe",
];
for (const raw of bad) {
  const r = noThrow(() => m.canonicalLinkedin(raw));
  check(`canonical rejects ${JSON.stringify(raw.length > 60 ? raw.slice(0, 60) + "..." : raw)}`, r.ok && r.value === null, JSON.stringify(r.value));
}
// Member-id links are case-sensitive at LinkedIn: the key is lowercased like
// any name, the address keeps the case typed so the lookup still finds them.
const memberIds = [
  ["https://www.linkedin.com/in/ACoAAB1cdEfGhIjKlMnOp", "acoaab1cdefghijklmnop", "https://www.linkedin.com/in/ACoAAB1cdEfGhIjKlMnOp"],
  ["linkedin.com/in/ACwAAB1cdEfGhIjKlMnOp/?miniProfileUrn=x", "acwaab1cdefghijklmnop", "https://www.linkedin.com/in/ACwAAB1cdEfGhIjKlMnOp"],
  ["https://www.linkedin.com/in/acoaab1cdefghijklmnop", "acoaab1cdefghijklmnop", "https://www.linkedin.com/in/acoaab1cdefghijklmnop"],
  ["https://www.linkedin.com/in/ACoAAB-short", "acoaab-short", "https://www.linkedin.com/in/acoaab-short"],
  ["https://www.linkedin.com/in/Acme-Engineering-Lead-1234567", "acme-engineering-lead-1234567", "https://www.linkedin.com/in/acme-engineering-lead-1234567"],
];
for (const [raw, username, url] of memberIds) {
  const r = noThrow(() => m.canonicalLinkedin(raw));
  check(`canonical member id: ${JSON.stringify(raw)} -> key ${username}, address ${url}`,
    r.ok && r.value?.username === username && r.value?.url === url, JSON.stringify(r.value));
}

// ---------- linkedinUsername: never throws, same answer as before for valid input ----------
const oldLinkedinUsername = (url) => {
  const x = url.toLowerCase().match(/\/in\/([^/?#]+)/);
  return x ? decodeURIComponent(x[1]) : null;
};
for (const raw of ["https://www.linkedin.com/in/Jane-Doe/", "linkedin.com/in/j%C3%B6rg", "https://uk.linkedin.com/in/jane?x=1",
  "https://evil.com/in/jane", "no profile here", "https://www.linkedin.com/in/王伟"]) {
  const r = noThrow(() => m.linkedinUsername(raw));
  check(`linkedinUsername unchanged for ${JSON.stringify(raw)}`, r.ok && r.value === oldLinkedinUsername(raw), JSON.stringify(r.value));
}
for (const raw of ["https://www.linkedin.com/in/%E0%A4%A", "https://www.linkedin.com/in/%", "/in/%zz%"]) {
  const r = noThrow(() => m.linkedinUsername(raw));
  check(`linkedinUsername does not throw on ${JSON.stringify(raw)}`, r.ok && typeof r.value === "string", r.value);
}

// ---------- harvestIsFor: a cached profile is used only for its own person ----------
const throwing = {};
Object.defineProperty(throwing, "publicIdentifier", { get() { throw new Error("boom"); } });
const harvestCases = [
  ["publicIdentifier matches", { publicIdentifier: "jane-doe" }, "jane-doe", true],
  ["publicIdentifier any case", { publicIdentifier: "Jane-Doe" }, "jane-doe", true],
  ["publicIdentifier encoded", { publicIdentifier: "j%C3%B6rg" }, "jörg", true],
  ["username encoded", { publicIdentifier: "jörg" }, "j%C3%B6rg", true],
  ["publicIdentifier wins over the url", { publicIdentifier: "someone-else", linkedinUrl: "https://www.linkedin.com/in/jane-doe" }, "jane-doe", false],
  ["linkedinUrl when no publicIdentifier", { linkedinUrl: "https://www.linkedin.com/in/jane-doe/" }, "jane-doe", true],
  ["url when no linkedinUrl", { url: "https://uk.linkedin.com/in/Jane-Doe" }, "jane-doe", true],
  ["another person's profile", { publicIdentifier: "attacker", linkedinUrl: "https://www.linkedin.com/in/attacker" }, "jane-doe", false],
  ["a url on another site", { linkedinUrl: "https://evil.com/in/jane-doe" }, "jane-doe", false],
  ["no identity at all", { firstName: "Jane" }, "jane-doe", false],
  ["non-string fields", { publicIdentifier: 5, linkedinUrl: 7 }, "jane-doe", false],
  ["malformed escape", { publicIdentifier: "%E0%A4%A" }, "jane-doe", false],
  ["a getter that throws", throwing, "jane-doe", false],
  ["null payload", null, "jane-doe", false],
  ["string payload", "jane-doe", "jane-doe", false],
  ["array payload", ["jane-doe"], "jane-doe", false],
  ["no username", { publicIdentifier: "jane-doe" }, null, false],
  ["the same name in another Unicode spelling", { publicIdentifier: "jo\u0308rg" }, "j\u00f6rg", true],
  ["a look-alike in full-width letters", { publicIdentifier: "jane" }, "\uff4a\uff41\uff4e\uff45", false],
  ["a member id answered with the person's name", { publicIdentifier: "jane-doe" }, "acoaab1cdefghijklmnop", false],
];
for (const [label, payload, username, want] of harvestCases) {
  const r = noThrow(() => m.harvestIsFor(payload, username));
  check(`harvestIsFor: ${label}`, r.ok && r.value === want, String(r.value));
}
// harvestIdentity: what a profile says its own name is (null when it names none)
for (const [label, payload, want] of [
  ["publicIdentifier", { publicIdentifier: " Jane-Doe " }, "jane-doe"],
  ["linkedinUrl", { linkedinUrl: "https://uk.linkedin.com/in/Jane-Doe/" }, "jane-doe"],
  ["url on another site", { url: "https://evil.com/in/jane-doe" }, null],
  ["nothing", { firstName: "Jane" }, null],
  ["a getter that throws", throwing, null],
  ["null", null, null],
]) {
  const r = noThrow(() => m.harvestIdentity(payload));
  check(`harvestIdentity: ${label}`, r.ok && r.value === want, JSON.stringify(r.value));
}

// ---------- usernameForms: the spellings older pool records may carry ----------
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
check("forms: a plain name is only itself", sameSet(m.usernameForms("jane-doe"), ["jane-doe"]));
check("forms: an escaped capital is looked up too", sameSet(m.usernameForms("\u00f6laf"), ["\u00f6laf", "\u00d6laf"]));
check("forms: letters without case add nothing", sameSet(m.usernameForms("\u738b\u4f1f"), ["\u738b\u4f1f"]));
check("forms: a letter whose capital is two letters adds nothing", sameSet(m.usernameForms("stra\u00dfe"), ["stra\u00dfe"]));
check("forms: at most 16", m.usernameForms("\u00e4\u00f6\u00fc\u00e9\u00e8\u00ea").length === 16);

// ---------- formulaText: typed text stays text inside an Airtable formula ----------
check("formula: quotes and backslashes escaped", m.formulaText('a"),TRUE(),("\\x@y.co') === '"a\\"),TRUE(),(\\"\\\\x@y.co"');
check("formula: plain text untouched", m.formulaText("jane@example.com") === '"jane@example.com"');

// ---------- the duplicate rule: both identifiers ----------
const row = { email: "Jane@Example.com", linkedin_username: "jane-doe" };
check("duplicate: same email (any case) and same LinkedIn", m.sameSubmitter(row, "jane@example.com", "jane-doe"));
check("duplicate: email trimmed", m.sameSubmitter(row, "  jane@example.com ", "jane-doe"));
check("not a duplicate: same email, other LinkedIn", !m.sameSubmitter(row, "jane@example.com", "someone-else"));
check("not a duplicate: same LinkedIn, other email", !m.sameSubmitter(row, "stranger@example.com", "jane-doe"));
check("not a duplicate: row without an email", !m.sameSubmitter({ email: null, linkedin_username: "jane-doe" }, "jane@example.com", "jane-doe"));
check("not a duplicate: nothing typed", !m.sameSubmitter({ email: "", linkedin_username: "" }, "", ""));

// ---------- email trust: the pure part ----------
check("normalEmail trims and lowercases", m.normalEmail("  Jane@Example.COM ") === "jane@example.com");
check("normalEmail of a non-string is empty", m.normalEmail(42) === "" && m.normalEmail(null) === "");
check("contactEmails: primary and other emails",
  JSON.stringify(m.contactEmails({ email: " A@B.co ", otherEmails: ["x@y.co", 5, null, ""] })) === JSON.stringify(["a@b.co", "x@y.co"]));
check("contactEmails: odd shapes give nothing",
  [null, undefined, "a@b.co", ["a@b.co"], { otherEmails: "a@b.co" }].every((c) => m.contactEmails(c).length === 0));
check("emailIsKnown: any case, trimmed", m.emailIsKnown(" Jane@Example.com ", ["x@y.co", "jane@example.COM"]));
check("emailIsKnown: not among them", !m.emailIsKnown("jane@example.com", [null, "", "other@example.com"]));
check("emailIsKnown: nothing typed never matches", !m.emailIsKnown("", ["", null]));

// ---------- the database side, against a stub (no network) ----------
for (const k of ["OPENAI_API_KEY", "HARVEST_API_KEY", "AIRTABLE_API_TOKEN", "AIRTABLE_BASE_ID"]) delete process.env[k];
process.env.SUPABASE_URL = "http://stub.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
let routes = [];
let calls = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = decodeURIComponent(String(url).replace("http://stub.invalid/rest/v1/", ""));
  const method = init.method || "GET";
  calls.push({ method, path: u, body: init.body ? JSON.parse(init.body) : null });
  for (const [test, reply] of routes) if (test(method, u)) return reply(u, init);
  return json({ message: "no stub" }, 500);
};
const stub = (r) => { routes = r; calls = []; };
const writes = () => calls.filter((c) => c.method !== "GET");
const get = (prefix, body, status) => [(meth, u) => meth === "GET" && u.startsWith(prefix), () => json(body, status)];

// poolPersonHasEmail
stub([get("candidate_emails?", []), get("candidate_emails_v2?", [])]);
check("trust: candidates.email", await m.poolPersonHasEmail("p1", "Jane@Example.com", { email: "jane@example.com", contact: null }));
stub([get("candidate_emails?", []), get("candidate_emails_v2?", [])]);
check("trust: an address in candidates.contact",
  await m.poolPersonHasEmail("p1", "jane@home.org", { email: "jane@work.com", contact: { otherEmails: ["Jane@Home.org"] } }));
stub([get("candidate_emails_v2?", [{ email: "old@example.com" }]), get("candidate_emails?", [{ email: "Jane@Example.com" }])]);
check("trust: candidate_emails", await m.poolPersonHasEmail("p1", "jane@example.com", { email: "x@y.co", contact: null }));
stub([get("candidate_emails_v2?", [{ email: "jane@example.com" }]), get("candidate_emails?", [])]);
check("trust: candidate_emails_v2", await m.poolPersonHasEmail("p1", "jane@example.com", { email: null, contact: null }));
stub([get("candidates?id=eq.p1", [{ email: "jane@example.com", contact: null }])]);
check("trust: reads the candidates row when not given", await m.poolPersonHasEmail("p1", "jane@example.com"));
stub([get("candidate_emails_v2?", { message: "denied" }, 403), [(meth, u) => u.startsWith("candidate_emails?"), () => { throw new Error("network"); }]]);
check("no trust: the email tables fail to read",
  !(await m.poolPersonHasEmail("p1", "jane@example.com", { email: "real@example.com", contact: null })));
stub([get("candidate_emails?", []), get("candidate_emails_v2?", [])]);
check("no trust: a stranger's email", !(await m.poolPersonHasEmail("p1", "stranger@example.com", { email: "real@example.com", contact: null })));

// promoteToCandidatePool
const poolRow = { id: "pool-1", matching_embedding: null, contact: null, email: "real@example.com", resume_text: null, current_title: "Engineer" };
const promoteArgs = (email) => ({
  submissionId: "sub-1", name: "Jane Doe", email, linkedinUrl: "https://uk.linkedin.com/in/Jane-Doe/?x=1",
  resumeText: "Resume text of the person typing", parsed: null, allSkills: ["Go"],
});
stub([get("candidates?linkedin_username=eq.jane-doe", [poolRow]), get("candidate_emails?", []), get("candidate_emails_v2?", [])]);
{
  const r = await m.promoteToCandidatePool(promoteArgs("stranger@example.com"));
  check("untrusted: keyed by the submission itself", r.candidateId === "sub-1" && r.standalone === true && r.resumeIsTheirs === false, JSON.stringify(r));
  check("untrusted: writes nothing to the pool person", writes().length === 0, JSON.stringify(writes()));
}
stub([get("candidates?linkedin_username=eq.jane-doe", [poolRow]), get("candidate_emails?", [{ email: "Stranger@Example.com" }]),
  get("candidate_emails_v2?", []), [(meth, u) => meth === "PATCH" && u.startsWith("candidates?id=eq.pool-1"), () => new Response(null, { status: 204 })]]);
{
  const r = await m.promoteToCandidatePool(promoteArgs("stranger@example.com"));
  check("trusted: linked to the pool person", r.candidateId === "pool-1" && r.standalone === false, JSON.stringify(r));
  check("trusted: first resume makes the resume theirs", r.resumeIsTheirs === true);
  const patch = writes()[0]?.body || {};
  check("trusted: fills only empty fields", writes().length === 1 && "resume_text" in patch && !("current_title" in patch) && !("email" in patch), JSON.stringify(patch));
}
stub([get("candidates?linkedin_username=eq.jane-doe", [{ ...poolRow, resume_text: "their own resume" }]),
  get("candidate_emails?", []), get("candidate_emails_v2?", []),
  [(meth) => meth === "PATCH", () => new Response(null, { status: 204 })]]);
{
  const r = await m.promoteToCandidatePool(promoteArgs("real@example.com"));
  check("trusted with a resume on file: resume and summary stay theirs", r.candidateId === "pool-1" && r.resumeIsTheirs === false, JSON.stringify(r));
}
stub([get("candidates?linkedin_username=eq.jane-doe", []),
  [(meth, u) => meth === "POST" && u === "candidates", () => json([{ id: "new-1" }], 201)]]);
{
  const r = await m.promoteToCandidatePool(promoteArgs("jane@example.com"));
  const body = writes()[0]?.body || {};
  check("new person: created and theirs", r.candidateId === "new-1" && !r.standalone && r.resumeIsTheirs, JSON.stringify(r));
  check("new person: canonical LinkedIn stored",
    body.linkedin_url === "https://www.linkedin.com/in/jane-doe" && body.linkedin_username === "jane-doe", JSON.stringify(body));
}
stub([]);
{
  const r = await m.promoteToCandidatePool({ ...promoteArgs("jane@example.com"), linkedinUrl: "https://evil.com/in/jane-doe" });
  check("not a LinkedIn profile: no pool lookup at all", r.candidateId === null && calls.length === 0, JSON.stringify(r));
}
stub([get("candidates?linkedin_username=eq.jane-doe", { message: "timeout" }, 503)]);
{
  const r = await m.promoteToCandidatePool(promoteArgs("jane@example.com"));
  check("pool read fails: stands on its own, creates no record", r.candidateId === "sub-1" && r.standalone && writes().length === 0,
    JSON.stringify({ r, writes: writes() }));
}
// An older record keyed with the escaped capital (\u00d6laf) is still found.
const olafRow = { ...poolRow, id: "pool-olaf" };
stub([[(meth, u) => meth === "GET" && u.startsWith('candidates?linkedin_username=in.("\u00f6laf","\u00d6laf")'), () => json([olafRow])],
  get("candidate_emails?", []), get("candidate_emails_v2?", [])]);
{
  const r = await m.promoteToCandidatePool({ ...promoteArgs("stranger@example.com"), linkedinUrl: "https://www.linkedin.com/in/%C3%B6laf" });
  check("older spelling found: a stranger stands on its own", r.candidateId === "sub-1" && r.standalone && writes().length === 0,
    JSON.stringify({ r, calls: calls.map((c) => c.path) }));
  check("older spelling found: its emails were checked", calls.some((c) => c.path.startsWith("candidate_emails?candidate_id=eq.pool-olaf")),
    JSON.stringify(calls.map((c) => c.path)));
}
// Two records for one name: the one whose email was typed is the person.
stub([[(meth, u) => meth === "GET" && u.startsWith("candidates?linkedin_username=in."), () => json([olafRow, { ...poolRow, id: "pool-olaf-2", email: "olaf@example.com" }])],
  get("candidate_emails?", []), get("candidate_emails_v2?", []), [(meth) => meth === "PATCH", () => new Response(null, { status: 204 })]]);
{
  const r = await m.promoteToCandidatePool({ ...promoteArgs("olaf@example.com"), linkedinUrl: "https://www.linkedin.com/in/%C3%B6laf" });
  check("two records: linked to the one that has the email", r.candidateId === "pool-olaf-2" && !r.standalone,
    JSON.stringify({ r, writes: writes().map((w) => w.path) }));
  check("two records: only that one is written", writes().every((w) => w.path.startsWith("candidates?id=eq.pool-olaf-2")), JSON.stringify(writes().map((w) => w.path)));
}

// tenantPersonId and recentSameSubmitter: both identifiers
const appRows = [
  { id: "a1", email: "stranger@example.com", linkedin_username: "jane-doe" },
  { id: "a2", email: "Jane@Example.com", linkedin_username: "jane-doe" },
];
stub([get("website_applications?", appRows)]);
check("client person key: the earlier application with both identifiers", (await m.tenantPersonId("org-1", "jane-doe", "jane@example.com", "sub-9")) === "a2");
stub([get("website_applications?", appRows.slice(0, 1))]);
check("client person key: LinkedIn alone is a new person", (await m.tenantPersonId("org-1", "jane-doe", "jane@example.com", "sub-9")) === "sub-9");
stub([get("website_applications?", appRows)]);
{
  const rows = await m.recentSameSubmitter("org-1", "jane@example.com", "jane-doe", "id");
  check("duplicate lookup keeps only rows with both identifiers", rows.length === 1 && rows[0].id === "a2", JSON.stringify(rows));
  check("duplicate lookup is scoped to the org and 14 days",
    calls[0]?.path.includes("organization_id=eq.org-1") && calls[0]?.path.includes("created_at=gte."), calls[0]?.path);
}

// fillPoolFollowUp: fills gaps only
stub([get("candidates?id=eq.p1", [{ follow_up_at: "2026-01-01", role_preferences: { roles: [], locations: [], workplace: [], salary: null }, visa_status: "" }]),
  [(meth) => meth === "PATCH", () => new Response(null, { status: 204 })]]);
await m.fillPoolFollowUp("p1", { followUpAt: "2027-03-01", rolePreferences: { roles: ["Backend"] }, visa: "Citizen" });
{
  const body = writes()[0]?.body || {};
  check("follow-up: an existing date stays", !("follow_up_at" in body), JSON.stringify(body));
  check("follow-up: empty preferences and visa are filled", body.role_preferences?.roles?.[0] === "Backend" && body.visa_status === "Citizen", JSON.stringify(body));
}
stub([get("candidates?id=eq.p1", [{ follow_up_at: "2026-01-01", role_preferences: { roles: ["ML"] }, visa_status: "Needs sponsorship" }])]);
await m.fillPoolFollowUp("p1", { followUpAt: "2027-03-01", rolePreferences: { roles: ["Backend"] }, visa: "Citizen" });
check("follow-up: nothing written when the record has it all", writes().length === 0, JSON.stringify(writes()));

// ---------- the pipeline, end to end against the stub ----------
// A TT applicant (no resume, no model key: no screening), reviewed as if from
// the nightly queue so no allowance or lead email is involved. Harvest and
// Airtable answer from the stub too.
process.env.HARVEST_API_KEY = "stub";
process.env.AIRTABLE_API_TOKEN = "stub";
process.env.AIRTABLE_BASE_ID = "appStub";
for (const k of ["NOTION_TOKEN", "NOTION_DATABASE_ID", "LLAMA_CLOUD_API_KEY", "RESEND_API_KEY"]) delete process.env[k];
const HARVEST = "https://api.harvestapi.io/";
const AIRTABLE = "https://api.airtable.com/v0/appStub/";
const pipelineStub = (extra, profile) => stub([
  get("organizations?slug=eq.transformer-talent", [{ id: "tt-org" }]),
  ...extra,
  [(meth, u) => u.startsWith(HARVEST), () => json({ element: profile })],
  [(meth, u) => meth === "GET" && u.startsWith(`${AIRTABLE}Candidates?`), () => json({ records: [{ id: "recRealPerson" }] })],
  [(meth, u) => u.startsWith(AIRTABLE), () => json({ records: [{ id: "recNew" }] })],
  [(meth) => meth === "GET", () => json([])],
  [() => true, () => json([], 201)],
]);
const runPipeline = (email, linkedin) => m.runApplicantPipeline({
  submissionId: "sub-1", name: "Jane Doe", email, linkedin, visa: "", preferredLocations: [], roleIds: [],
  speculative: true, resumeBuf: null, resumeSafeName: "resume.pdf", resumePath: null, boardOrg: null,
  orgId: "tt-org", applicationType: "Speculative", fromQueue: true,
});
const poolTouches = () => calls.filter((c) => c.path.startsWith("candidates") || c.path.startsWith("candidate_experiences") || c.path.startsWith("candidate_embeddings"));
const appPatch = () => calls.filter((c) => c.method === "PATCH" && c.path.startsWith("website_applications?id=eq.sub-1")).map((c) => c.body).find((b) => b && "candidate_id" in b) || {};
const reviewRow = () => calls.find((c) => c.method === "POST" && c.path.startsWith(`${AIRTABLE}Website Applications`))?.body?.records?.[0]?.fields || null;
const candidateLookups = () => calls.filter((c) => c.path.startsWith(`${AIRTABLE}Candidates`));
const ledger = () => calls.filter((c) => c.method === "POST" && c.path === "candidate_enrichments").map((c) => c.body);
const janeUrl = m.canonicalLinkedin("linkedin.com/in/jane-doe").url;

// LinkedIn answers the address with another person's profile.
pipelineStub([], { publicIdentifier: "someone-else", firstName: "Someone", experience: [{ position: "CTO", companyName: "Acme" }] });
await runPipeline("jane@example.com", janeUrl);
check("pipeline, profile is another person's: nothing read or written in the pool", poolTouches().length === 0, JSON.stringify(poolTouches().map((c) => c.method + " " + c.path)));
check("pipeline, profile is another person's: the application stands on its own", appPatch().candidate_id === "sub-1", JSON.stringify(appPatch()));
check("pipeline, profile is another person's: the spend is kept, under no one", ledger().length === 1 && ledger()[0].candidate_id === null && ledger()[0].cost_credits === 1, JSON.stringify(ledger()));
check("pipeline, profile is another person's: review row kept, linked to no one",
  reviewRow() && !("Candidate" in reviewRow()) && candidateLookups().length === 0, JSON.stringify({ row: reviewRow(), lookups: candidateLookups().length }));

// A member-id link is fetched as typed and answered with the person's name.
const memberUrl = m.canonicalLinkedin("https://www.linkedin.com/in/ACoAAB1cdEfGhIjKlMnOp").url;
pipelineStub([], { publicIdentifier: "jane-doe", firstName: "Jane" });
await runPipeline("jane@example.com", memberUrl);
check("pipeline, member id: LinkedIn is asked with the case kept",
  calls.some((c) => c.path.startsWith(HARVEST) && c.path.endsWith("/in/ACoAAB1cdEfGhIjKlMnOp")), JSON.stringify(calls.filter((c) => c.path.startsWith(HARVEST)).map((c) => c.path)));
check("pipeline, member id: stands on its own, pool untouched", appPatch().candidate_id === "sub-1" && poolTouches().length === 0,
  JSON.stringify({ patch: appPatch(), pool: poolTouches().map((c) => c.path) }));

// A pool person under this name, and an email TT doesn't have for them.
pipelineStub([get("candidates?linkedin_username=eq.jane-doe", [poolRow])], { publicIdentifier: "jane-doe", firstName: "Jane" });
await runPipeline("stranger@example.com", janeUrl);
check("pipeline, unknown email: nothing written to the pool person", poolTouches().every((c) => c.method === "GET"), JSON.stringify(poolTouches().map((c) => c.method + " " + c.path)));
check("pipeline, unknown email: stands on its own", appPatch().candidate_id === "sub-1", JSON.stringify(appPatch()));
check("pipeline, unknown email: review row linked to no one, no Candidates record made",
  reviewRow() && !("Candidate" in reviewRow()) && candidateLookups().length === 0, JSON.stringify({ row: reviewRow(), lookups: candidateLookups().length }));

// A new person whose profile is their own: joins the pool as before.
pipelineStub([get("candidates?linkedin_username=eq.jane-doe", []), [(meth, u) => meth === "POST" && u === "candidates", () => json([{ id: "new-1" }], 201)]],
  { publicIdentifier: "jane-doe", firstName: "Jane" });
await runPipeline("jane@example.com", janeUrl);
check("pipeline, new person: joins the pool", appPatch().candidate_id === "new-1" && calls.some((c) => c.method === "POST" && c.path === "candidates"), JSON.stringify(appPatch()));
check("pipeline, new person: review row linked to their Candidates record", reviewRow()?.Candidate?.[0] === "recRealPerson", JSON.stringify(reviewRow()));

// The pipeline fails before it knows who this is: the review row stays unlinked.
pipelineStub([[(meth, u) => u.startsWith("website_applications?linkedin_username="), () => { throw new Error("network"); }]], { publicIdentifier: "jane-doe" });
{
  const logError = console.error;
  console.error = () => {}; // the pipeline logs the failure this case sets up
  await runPipeline("jane@example.com", janeUrl);
  console.error = logError;
}
check("pipeline fails early: review row kept, linked to no one",
  reviewRow() && !("Candidate" in reviewRow()) && candidateLookups().length === 0 && poolTouches().length === 0,
  JSON.stringify({ row: reviewRow(), lookups: candidateLookups().length }));

fs.rmSync(entry, { force: true });
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
