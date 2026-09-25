#!/usr/bin/env node
// Each company's daily review allowance (lib/server/review-budget.ts) and the
// nightly queue (lib/server/review-queue.ts), against a throwaway company in
// the shared database. Runs with every paid key removed, so it cannot spend:
// with the allowance used up an application is kept as "queued" and nothing
// else happens; with room, the queue reviews it and it ends "processed"; a
// second company is never held up by the first. Everything is removed at the end.
//
//   node scripts/test-review-queue.mjs
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { svc } from "./tenancy/fixture.mjs";

for (const k of ["OPENAI_API_KEY", "HARVEST_API_KEY", "LLAMA_CLOUD_API_KEY", "RESEND_API_KEY", "TYPESAFE_API_KEY", "NOTION_TOKEN"])
  delete process.env[k];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "scripts/dist/review-queue-entry.ts");
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(
  entry,
  `export { runApplicantPipeline } from "@/lib/server/applicant-pipeline";
export { reviewQueued } from "@/lib/server/review-queue";
`
);
execFileSync("npx", ["--yes", "esbuild@0.28.2", entry, "--bundle", "--platform=node", "--format=esm",
  `--alias:@=${root}`, "--outfile=scripts/dist/review-queue-test.mjs", "--log-level=warning"], { cwd: root, stdio: "inherit" });
const { runApplicantPipeline, reviewQueued } = await import(path.join(root, "scripts/dist/review-queue-test.mjs"));

const run = Date.now().toString(36) + crypto.randomBytes(2).toString("hex");
const post = (t, rows) => svc(t, { method: "POST", body: JSON.stringify(rows), prefer: "return=representation" });
const patch = (p, body) => svc(p, { method: "PATCH", body: JSON.stringify(body), prefer: "return=minimal" });
const statusOf = async (id) => (await svc(`website_applications?id=eq.${id}&select=status`))[0]?.status;
const fails = [];
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !extra ? "" : `  (${extra})`}`);
  if (!ok) fails.push(name);
};

const orgs = await post("organizations", [
  { slug: `leaktest-${run}-q1`, name: `Queue test one ${run}`, daily_review_limit: 0 },
  { slug: `leaktest-${run}-q2`, name: `Queue test two ${run}`, daily_review_limit: 5 },
]);
const [one, two] = orgs;
const app = async (org) =>
  (await post("website_applications", [{
    organization_id: org.id, name: "Queue Test", email: `leaktest+${run}@example.com`,
    linkedin_url: `https://www.linkedin.com/in/zzlk${run}queue`, linkedin_username: `zzlk${run}queue`,
    role_ids: [], role_titles: [], status: "processing", source: "speculative",
  }]))[0];
const input = (a, org) => ({
  submissionId: a.id, name: "Queue Test", email: a.email, linkedin: a.linkedin_url, visa: "", preferredLocations: [],
  roleIds: [], speculative: true, resumeBuf: null, resumeSafeName: "resume.pdf", resumePath: null,
  boardOrg: { id: org.id, slug: org.slug, name: org.name }, orgId: org.id, applicationType: "Speculative",
});

try {
  // Company one: allowance used up (0 a day).
  const a1 = await app(one);
  await runApplicantPipeline(input(a1, one));
  check("over the allowance: kept, marked queued", (await statusOf(a1.id)) === "queued", await statusOf(a1.id));

  // Company two still has room: its application is reviewed at once.
  const a2 = await app(two);
  await runApplicantPipeline(input(a2, two));
  check("another company is not held up", (await statusOf(a2.id)) === "processed", await statusOf(a2.id));

  // The nightly queue waits while company one has no room...
  const scope = { orgIds: [one.id, two.id] };
  const dry = await reviewQueued({ max: 50, deadline: Date.now() + 60_000, ...scope });
  check("the queue leaves it while the allowance is used up", (await statusOf(a1.id)) === "queued", `reviewed ${dry.reviewed}`);

  // ...and reviews it once the company has room.
  await patch(`organizations?id=eq.${one.id}`, { daily_review_limit: 5 });
  const r = await reviewQueued({ max: 50, deadline: Date.now() + 60_000, ...scope });
  check("with room, the queue reviews it", (await statusOf(a1.id)) === "processed", `${JSON.stringify(r)} status ${await statusOf(a1.id)}`);
  const used = await svc(`rate_limit_events?bucket=eq.review:${one.id}&select=id`);
  check("the review came out of company one's own allowance", used.length === 1, `${used.length} taken`);
} finally {
  for (const o of orgs) {
    await svc(`rate_limit_events?bucket=eq.review:${o.id}`, { method: "DELETE", prefer: "return=minimal" }, { soft: true });
    await svc(`match_verdicts?organization_id=eq.${o.id}`, { method: "DELETE", prefer: "return=minimal" }, { soft: true });
    await svc(`candidate_enrichments?organization_id=eq.${o.id}`, { method: "DELETE", prefer: "return=minimal" }, { soft: true });
    await svc(`website_applications?organization_id=eq.${o.id}`, { method: "DELETE", prefer: "return=minimal" }, { soft: true });
    await svc(`organizations?id=eq.${o.id}`, { method: "DELETE", prefer: "return=minimal" }, { soft: true });
  }
  fs.rmSync(entry, { force: true });
  const left = await svc(`organizations?slug=like.leaktest-${run}-*&select=id`);
  console.log(`cleanup: ${left.length ? "LEFTOVER" : "removed"}`);
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
