#!/usr/bin/env node
// Exercise the Candidates v2 unified API against a real org: list (filters,
// pagination, counts), drawer detail, and a contact save round-trip.
//
//   node scripts/test-candidates-unified.mjs [org-slug]   (default: transformer-talent)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const line of fs.readFileSync(path.join(root, ".env.scripts"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

execFileSync("npx", ["--yes", "esbuild@0.28.2", "lib/server/candidates-unified.ts", "--bundle",
  "--platform=node", "--format=esm", `--alias:@=${root}`,
  "--outfile=scripts/dist/candidates-unified-test.mjs", "--log-level=warning"], { cwd: root, stdio: "inherit" });

const { listUnifiedCandidates, unifiedCandidateDetail, saveUnifiedContact } =
  await import("./dist/candidates-unified-test.mjs");

const slug = process.argv[2] || "transformer-talent";
const URL_ = process.env.SUPABASE_URL.trim();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = async (p) =>
  (await fetch(`${URL_}/rest/v1/${p}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })).json();

const [org] = await q(`organizations?slug=eq.${slug}&select=id,name`);
if (!org) throw new Error(`org ${slug} not found`);
console.log(`org: ${org.name} (${org.id})\n`);

const fails = [];
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails.push(name);
};

/* ---- 1. default list ---- */
const list = await listUnifiedCandidates({ orgId: org.id });
console.log(`counts: all=${list.counts.all} applied=${list.counts.applied} sourced=${list.counts.sourced} notNow=${list.counts.notNow} · total=${list.total}\n`);
for (const r of list.items) {
  console.log(
    `${(r.bestTagLabel || "Screening…").padEnd(16)} ${r.source.padEnd(8)} ${r.name.padEnd(26)} ` +
    `${((r.currentTitle || "?") + " @ " + (r.currentCompany || "?")).padEnd(52).slice(0, 52)} ` +
    `${(r.location || "").slice(0, 22).padEnd(22)} ${r.contact.email ? "✉" : "·"}${r.contact.phone ? "☎" : "·"} ${r.linkedinUrl ? "in" : "--"}`
  );
}
check("list returns rows", list.items.length > 0);
check("counts add up", list.counts.all === list.counts.applied + list.counts.sourced);
check("pool view shows everyone", list.total === list.counts.all + list.counts.notNow);
const ranks = { strong_yes: 0, strong: 0, yes: 1, possible: 2, worth_message: 3, stretch: 4, not_now: 5 };
const rk = (t) => (t ? (ranks[t] ?? 6) : 6);
const sorted = list.items.every((r, i, a) => i === 0 || rk(a[i - 1].bestTag) <= rk(r.bestTag));
check("fit-sorted", sorted);
check("sourced rows carry title+company+linkedin", list.items.filter((r) => r.source === "sourced").every((r) => r.currentTitle && r.currentCompany && r.linkedinUrl));
check("applicant email prefilled", list.items.some((r) => r.source === "applied" && r.contact.email));

/* ---- 2. hideNotNow + filters + pagination ---- */
const hidden = await listUnifiedCandidates({ orgId: org.id, hideNotNow: true, pageSize: 100 });
check("hideNotNow filters (job view)", hidden.total === list.counts.all && !hidden.items.some((r) => r.bestTag === "not_now"), `${hidden.total} vs all=${list.counts.all}`);
const appliedOnly = await listUnifiedCandidates({ orgId: org.id, source: "applied" });
check("source filter", appliedOnly.items.every((r) => r.source === "applied"), `${appliedOnly.total} applied`);
const p1 = await listUnifiedCandidates({ orgId: org.id, pageSize: 5, page: 1 });
const p2 = await listUnifiedCandidates({ orgId: org.id, pageSize: 5, page: 2 });
check("pagination distinct", !p2.items.some((r) => p1.items.find((x) => x.key === r.key)) && p1.items.length === 5);
const strong = await listUnifiedCandidates({ orgId: org.id, fit: "strong" });
check("fit filter strong", strong.items.every((r) => ["strong", "strong_yes"].includes(r.bestTag)), `${strong.total} strong`);
const search = await listUnifiedCandidates({ orgId: org.id, q: "wang" });
check("search q=wang", search.items.length > 0 && search.items.every((r) => [r.name, r.currentTitle, r.currentCompany].some((v) => (v || "").toLowerCase().includes("wang"))), `${search.total} hits`);

/* ---- 3. job-scoped list ---- */
const srcRow = list.items.find((r) => r.source === "sourced");
if (srcRow) {
  const jobId = srcRow.roles[0].jobId;
  const scoped = await listUnifiedCandidates({ orgId: org.id, jobId });
  check(`job filter #${jobId}`, scoped.items.every((r) => r.roles.some((x) => x.jobId === jobId)), `${scoped.total} rows`);
}

/* ---- 4. drawer detail: sourced ---- */
if (srcRow) {
  const d = await unifiedCandidateDetail(org.id, srcRow.key);
  console.log(`\ndetail(${srcRow.key.slice(0, 12)}…) ${d.name}`);
  console.log(`  provenance: ${d.provenance}`);
  console.log(`  pipeline: ${d.pipeline.map((x) => `#${x.jobId} ${x.tagLabel} (${x.via})`).join(" · ")}`);
  console.log(`  experience groups: ${d.experience.map((g) => `${g.company} ×${g.roles.length}${g.logoUrl ? " [logo]" : ""}${g.companyLinkedinUrl ? " [link]" : ""}`).join(", ")}`);
  check("company logos resolve", d.experience.some((g) => g.logoUrl));
  check("company links resolve", d.experience.some((g) => g.companyLinkedinUrl));
  console.log(`  education: ${d.education.map((e) => e.school).join(", ")}`);
  console.log(`  skills: ${d.skills.slice(0, 6).join(", ")} (+${Math.max(0, d.skills.length - 6)})`);
  console.log(`  photo: ${d.photoUrl ? "yes" : "no"} · resume: ${d.hasResume ? "yes" : "no"} · contact: ${JSON.stringify(d.contact)}`);
  check("sourced detail", !!d && d.pipeline.length > 0 && d.experience.length > 0);
  check("pipeline has reasons", d.pipeline.every((x) => x.reason == null || typeof x.reason === "string"));
}

/* ---- 5. drawer detail: applicant ---- */
const appRow = list.items.find((r) => r.source === "applied") ||
  (await listUnifiedCandidates({ orgId: org.id, source: "applied", fit: "pending" })).items[0];
if (appRow) {
  const d = await unifiedCandidateDetail(org.id, appRow.key);
  console.log(`\ndetail(${appRow.key.slice(0, 12)}…) ${d.name}`);
  console.log(`  provenance: ${d.provenance}`);
  console.log(`  pipeline: ${d.pipeline.map((x) => `#${x.jobId} ${x.tagLabel ?? "pending"} (${x.via})`).join(" · ") || "(general application)"}`);
  console.log(`  experience groups: ${d.experience.length} · resume: ${d.hasResume ? "signed URL ok" : "none"} · contact: ${JSON.stringify(d.contact)}`);
  check("applicant detail", !!d);
  check("applicant resume signs", !d.hasResume || !!d.resumeUrl);
}

/* ---- 6. contact save round-trip (write, verify, revert) ---- */
if (srcRow) {
  const before = (await unifiedCandidateDetail(org.id, srcRow.key)).contact;
  const saved = await saveUnifiedContact(org.id, srcRow.key, {
    email: "test@example.com", phone: "+1 (555) 010-9999", github: "https://github.com/example",
  });
  const after = (await unifiedCandidateDetail(org.id, srcRow.key)).contact;
  check("contact saves", !saved.error && after.email === "test@example.com" && after.phone === "+1 (555) 010-9999");
  const bad = await saveUnifiedContact(org.id, srcRow.key, { email: "not-an-email" });
  check("contact validates email", bad.error === "invalid_email");
  await saveUnifiedContact(org.id, srcRow.key, { email: before.email, phone: before.phone, github: before.github });
  const reverted = (await unifiedCandidateDetail(org.id, srcRow.key)).contact;
  check("contact reverts", reverted.phone === (before.phone ?? null));
}

console.log(fails.length ? `\n${fails.length} FAILURES: ${fails.join(", ")}` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
