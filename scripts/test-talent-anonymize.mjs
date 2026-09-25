#!/usr/bin/env node
// The public /talent teaser shows strangers a few people from TT's pool. Feeds
// the anonymizer rows written the way real profiles are (employer in the title,
// in the headline, under another spelling in past jobs) and checks that no
// employer survives, that no per-person "applied" or "engaged" flag goes out,
// and that anyone marked Do Not Contact or not interested is dropped. No
// database, no network.
//
//   node scripts/test-talent-anonymize.mjs
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "scripts/dist/talent-anonymize-entry.ts");
const fs = await import("node:fs");
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(
  entry,
  `export { publicTitle, publicPriorEmployers, employerKey, employerSegment, isOptedOut, keepContactable, rankAndAnonymize, fitProfileText } from "@/lib/server/matcher";
`
);
execFileSync("npx", ["--yes", "esbuild@0.28.2", entry, "--bundle", "--platform=node", "--format=esm",
  `--alias:@=${root}`, "--outfile=scripts/dist/talent-anonymize.mjs", "--log-level=warning"], { cwd: root, stdio: "inherit" });
const m = await import(path.join(root, "scripts/dist/talent-anonymize.mjs"));

const fails = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `  (got ${JSON.stringify(detail)})`}`);
  if (!ok) fails.push(name);
};
// An employer "survives" when its name shows as a whole word, any case.
const names = (text, employer) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${employer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(text);

// ---------- Titles ----------
const titles = [
  // [current_title, current_company, expected]
  [null, "Stripe", "Software Engineer"],
  ["Staff Engineer at Stripe", null, "Staff Engineer"],
  ["ML Engineer @ OpenAI", "OpenAI", "ML Engineer"],
  ["ML Engineer @OpenAI", null, "ML Engineer"],
  ["Head of AI | Anthropic", "Anthropic", "Head of AI"],
  ["Head of AI | Anthropic", null, "Head of AI"],
  ["Founding Engineer • Acme", null, "Founding Engineer"],
  ["Research Scientist · DeepMind", null, "Research Scientist"],
  ["Stripe Staff Engineer", "Stripe", "Staff Engineer"],
  ["Staff Engineer, Stripe", "Stripe, Inc.", "Staff Engineer"],
  ["Senior Engineer (Stripe)", "Stripe", "Senior Engineer"],
  ["Senior Engineer - STRIPE", "stripe", "Senior Engineer"],
  // "Scale" is a common word: only the whole word goes, "Scaling" stays.
  ["Scale ML Engineer", "Scale", "ML Engineer"],
  ["ML Engineer, Scaling Systems", "Scale", "ML Engineer, Scaling Systems"],
  ["Engineer at Scale", "Scale", "Engineer"],
  ["Nestlé Data Scientist", "Nestlé S.A.", "Data Scientist"],
  ["Acme Engineer", "Acme L.L.C.", "Engineer"],
  ["C++ Engineer", "Jane Street", "C++ Engineer"],
  ["Sr. Engineer", "Stripe", "Sr. Engineer"],
  ["Stripe", "Stripe", "Software Engineer"],
  ["at Stripe", null, "Software Engineer"],
  ["", "Stripe", "Software Engineer"],
];
for (const [title, company, want] of titles) {
  const got = m.publicTitle(title, company);
  check(`title ${JSON.stringify(title)} / ${JSON.stringify(company)} -> ${JSON.stringify(want)}`, got === want, got);
}

// ---------- Employer keys and segments ----------
check("key: Stripe, Inc. = stripe", m.employerKey("Stripe, Inc.") === "stripe", m.employerKey("Stripe, Inc."));
check("key: Goldman Sachs & Co. LLC = goldman sachs", m.employerKey("Goldman Sachs & Co. LLC") === "goldman sachs", m.employerKey("Goldman Sachs & Co. LLC"));
check("key: Nestlé S.A. = nestle", m.employerKey("Nestlé S.A.") === "nestle", m.employerKey("Nestlé S.A."));
check("key: McDonald's Corp = mcdonalds", m.employerKey("McDonald's Corp") === "mcdonalds", m.employerKey("McDonald's Corp"));
check("key: Siemens GmbH = siemens", m.employerKey("Siemens GmbH") === "siemens", m.employerKey("Siemens GmbH"));
check("segment: headline 'Staff Engineer at Stripe | ex-Google' = Stripe", m.employerSegment("Staff Engineer at Stripe | ex-Google") === "Stripe", m.employerSegment("Staff Engineer at Stripe | ex-Google"));
check("segment: 'ML Engineer @ OpenAI, ex-Meta' = OpenAI", m.employerSegment("ML Engineer @ OpenAI, ex-Meta") === "OpenAI", m.employerSegment("ML Engineer @ OpenAI, ex-Meta"));
check("segment: no ' at ' or '@' = null", m.employerSegment("Head of AI | Anthropic") === null, m.employerSegment("Head of AI | Anthropic"));
check("segment: 'Data' is not ' at '", m.employerSegment("Data Engineer") === null, m.employerSegment("Data Engineer"));

// ---------- Past employers ----------
const prior = (row) => m.publicPriorEmployers({ current_title: null, headline: null, ...row });
{
  const got = prior({ current_company: "Stripe", previous_companies: ["Stripe, Inc.", "Google", "Stripe Payments", "STRIPE"] });
  check("prior: current Stripe drops Stripe, Inc. / Stripe Payments / STRIPE", got.every((c) => !names(c, "Stripe")), got);
  check("prior: current Stripe keeps Google", got.includes("Google"), got);
}
{
  const got = prior({ current_company: "Google DeepMind", previous_companies: ["Google", "Meta"] });
  check("prior: current Google DeepMind drops Google (contained in)", !got.includes("Google") && got.includes("Meta"), got);
}
{
  const got = prior({ current_company: "OpenAI", previous_companies: ["Open AI", "Anthropic"] });
  check("prior: current OpenAI drops Open AI (squashed spelling)", got.length === 1 && got[0] === "Anthropic", got);
}
{
  const got = prior({ current_company: "X", previous_companies: ["Dropbox", "X Corp."] });
  check("prior: a one-letter current company drops only itself", got.length === 1 && got[0] === "Dropbox", got);
}
{
  const got = prior({ current_company: null, headline: "Staff Engineer at Stripe", previous_companies: ["Stripe, Inc.", "Google"] });
  check("prior: no current company, headline 'at Stripe' drops Stripe, Inc.", got.length === 1 && got[0] === "Google", got);
}
{
  const got = prior({ current_company: null, current_title: "ML Engineer @ OpenAI", previous_companies: ["OpenAI", "Meta"] });
  check("prior: no current company, title '@ OpenAI' drops OpenAI", got.length === 1 && got[0] === "Meta", got);
}
{
  // Only the employer segment counts: "Payments" and "Google" in the headline's
  // tagline must not knock out real past employers.
  const got = prior({ current_company: null, headline: "Engineer at Stripe | Payments | ex-Google", previous_companies: ["Google", "Payments Co", "Stripe"] });
  check("prior: headline segment only, not every token", got.includes("Google") && got.includes("Payments Co") && !got.includes("Stripe"), got);
}
{
  const got = prior({ current_company: "Acme", previous_companies: ["Google", "Google LLC", "Meta", "Amazon", "Apple"] });
  check("prior: same employer twice shows once, at most three", got.length === 3 && got.filter((c) => /google/i.test(c)).length === 1, got);
}

// ---------- Do Not Contact ----------
check("status: Do Not Contact is opted out", m.isOptedOut("Do Not Contact"));
check("status: do not contact (lowercase) is opted out", m.isOptedOut("do not contact"));
check("status: Not Interested is opted out", m.isOptedOut("Not Interested"));
check("status: engaged is fine", !m.isOptedOut("engaged"));
check("status: none on record is fine", !m.isOptedOut(null));
{
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
  const statuses = new Map([["a", "engaged"], ["b", "Do Not Contact"], ["c", "not interested"], ["d", null]]);
  const kept = m.keepContactable(rows, statuses).map((r) => r.id);
  check("filter: keeps engaged and no-status, drops DNC, not interested, and anyone unchecked", JSON.stringify(kept) === JSON.stringify(["a", "d"]), kept);
}

// ---------- The whole teaser ----------
const jd = { title: "ML Engineer", seniority: "senior", min_years: null, max_years: null, locations: [], remote_ok: true, skills: ["python", "pytorch"], embedding_summary: "" };
const base = { location: "San Francisco", years_experience: 7, education_schools: ["MIT"], education_degrees: ["BS"], education_fields: null, top_skills: ["Python", "PyTorch"] };
const rows = [
  { ...base, id: "1", current_title: null, current_company: null, headline: "Staff Engineer at Stripe", previous_companies: ["Stripe, Inc.", "Google"], source: "website_applicant", similarity: 0.9 },
  { ...base, id: "2", current_title: "Senior Engineer", current_company: "Stripe", headline: "Senior Engineer at Stripe", previous_companies: ["Stripe, Inc.", "Square"], source: "directory", similarity: 0.85 },
  { ...base, id: "3", current_title: "ML Engineer @ OpenAI", current_company: "OpenAI", headline: null, previous_companies: ["OpenAI", "Meta"], source: "airtable_sync", similarity: 0.8 },
  { ...base, id: "4", current_title: "Head of AI | Anthropic", current_company: "Anthropic", headline: "Head of AI at Anthropic", previous_companies: ["Anthropic PBC", "Cohere"], source: "harvest", similarity: 0.75 },
  { ...base, id: "5", current_title: "Scale ML Engineer", current_company: "Scale", headline: "ML Engineer at Scale", previous_companies: ["Scale AI", "Scaleway", "Lyft"], source: null, similarity: 0.7 },
  { ...base, id: "6", current_title: "Engineer", current_company: "Acme", headline: null, previous_companies: [], source: "directory", similarity: 0.1 },
];
const EMPLOYER_OF = { 1: "Stripe", 2: "Stripe", 3: "OpenAI", 4: "Anthropic", 5: "Scale" };
const out = m.rankAndAnonymize(rows, jd, 5);
check("teaser: five matches", out.matches.length === 5, out.matches.length);
check("teaser: no applied field on any match", out.matches.every((x) => !("applied" in x)), out.matches.map((x) => Object.keys(x)));
check("teaser: no engaged field on any match", out.matches.every((x) => !("engaged" in x)), out.matches.map((x) => Object.keys(x)));
check("teaser: only the public fields go out", out.matches.every((x) => JSON.stringify(Object.keys(x).sort()) === JSON.stringify(["education", "location", "previousCompanies", "ref", "score", "skills", "title", "yearsExperience"])), Object.keys(out.matches[0]));
check("teaser: in-network count covers the shown five only (3 of 5)", out.inNetwork === 3, out.inNetwork);
out.matches.forEach((x, i) => {
  const employer = EMPLOYER_OF[i + 1];
  check(`teaser ${x.ref}: title "${x.title}" names no ${employer}`, !names(x.title, employer), x.title);
  check(`teaser ${x.ref}: past employers name no ${employer}`, x.previousCompanies.every((c) => !names(c, employer)), x.previousCompanies);
  const text = m.fitProfileText(x);
  check(`teaser ${x.ref}: fit model text names no ${employer}`, !names(text, employer), text);
});
check("teaser: null title never falls back to the headline", out.matches[0].title === "Software Engineer", out.matches[0].title);
check("teaser: Scale's person keeps Lyft", out.matches[4].previousCompanies.includes("Lyft"), out.matches[4].previousCompanies);
check("teaser: nobody in network gives 0", m.rankAndAnonymize(rows.map((r) => ({ ...r, source: "harvest" })), jd, 5).inNetwork === 0);

// Opted-out people never reach ranking: filtered rows go in, they never come out.
{
  const statuses = new Map(rows.map((r) => [r.id, r.id === "2" ? "Do Not Contact" : r.id === "3" ? "Not interested" : "engaged"]));
  const shown = m.rankAndAnonymize(m.keepContactable(rows, statuses), jd, 5);
  // Person 2 is the only one who worked at Square, person 3 the only one at Meta.
  const shownPrior = shown.matches.flatMap((x) => x.previousCompanies);
  check("teaser after filter: DNC and not-interested people are gone", shown.matches.length === 4 && !shownPrior.includes("Square") && !shownPrior.includes("Meta"), shownPrior);
  check("teaser after filter: in-network count drops with them (2)", shown.inNetwork === 2, shown.inNetwork);
}

console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
