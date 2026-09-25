#!/usr/bin/env node
// Who gets the lead email (lib/server/lead-notify.ts leadRecipients), against
// a throwaway company in the shared database: the job's recruiter, the
// company's chosen teammates, never someone who has left or belongs to
// another company, and the owners when nobody else applies. Everything it
// creates is removed at the end.
//
//   node scripts/test-lead-recipients.mjs
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { svc } from "./tenancy/fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync("npx", ["--yes", "esbuild@0.28.2", "lib/server/lead-notify.ts", "--bundle", "--platform=node", "--format=esm",
  `--alias:@=${root}`, "--outfile=scripts/dist/lead-notify.mjs", "--log-level=warning"], { cwd: root, stdio: "inherit" });
const { leadRecipients } = await import(path.join(root, "scripts/dist/lead-notify.mjs"));

const run = Date.now().toString(36) + crypto.randomBytes(2).toString("hex");
const id = () => crypto.randomUUID();
const email = (who) => `leaktest+${run}-${who}@example.com`;
const post = (t, rows) => svc(t, { method: "POST", body: JSON.stringify(rows), prefer: "return=representation" });
const patch = (p, body) => svc(p, { method: "PATCH", body: JSON.stringify(body), prefer: "return=minimal" });

const fails = [];
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const check = (name, got, want) => {
  const ok = same(got, want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${got.join(", ") || "nobody"})`}`);
  if (!ok) fails.push(name);
};

const [org] = await post("organizations", [{ slug: `leaktest-${run}-n`, name: `Lead routing test ${run}` }]);
const [other] = await post("organizations", [{ slug: `leaktest-${run}-o`, name: `Other company ${run}` }]);
const U = { owner: id(), recruiter: id(), teammate: id(), gone: id(), outsider: id() };
try {
  await post("org_members", [
    { organization_id: org.id, user_id: U.owner, email: email("owner"), member_role: "owner" },
    { organization_id: org.id, user_id: U.recruiter, email: email("recruiter"), member_role: "member" },
    { organization_id: org.id, user_id: U.teammate, email: email("teammate"), member_role: "member" },
    { organization_id: other.id, user_id: U.outsider, email: email("outsider"), member_role: "owner" },
  ]);
  const [job] = await post("org_roles", [
    { organization_id: org.id, external_id: "9001", title: "Routing test", status: "open", source: "dashboard", created_by: U.recruiter },
  ]);
  await post("org_roles", [
    { organization_id: org.id, external_id: "9002", title: "Routing test 2", status: "open", source: "dashboard", created_by: U.gone },
  ]);
  const [page] = await post("recruiter_profiles", [{ organization_id: org.id, user_id: U.teammate, slug: `leaktest-${run}-page`, published: false }]);
  const [otherPage] = await post("recruiter_profiles", [{ organization_id: other.id, user_id: U.outsider, slug: `leaktest-${run}-opage`, published: false }]);

  check("job's recruiter by default", await leadRecipients({ recruiterProfileId: null, orgId: org.id, jobIds: ["9001"] }), [email("recruiter")]);
  check("plus the recruiter whose page they came through", await leadRecipients({ recruiterProfileId: page.id, orgId: org.id, jobIds: ["9001"] }), [email("recruiter"), email("teammate")]);
  check("a job whose creator has left: the owners", await leadRecipients({ recruiterProfileId: null, orgId: org.id, jobIds: ["9002"] }), [email("owner")]);
  check("no job (general application): the owners", await leadRecipients({ recruiterProfileId: null, orgId: org.id, jobIds: [] }), [email("owner")]);
  check("another company's recruiter page is ignored", await leadRecipients({ recruiterProfileId: otherPage.id, orgId: org.id, jobIds: [] }), [email("owner")]);

  await patch(`org_roles?id=eq.${job.id}`, { notify_user_ids: [U.teammate, U.gone, U.outsider] });
  check("the company's chosen list, current teammates only", await leadRecipients({ recruiterProfileId: null, orgId: org.id, jobIds: ["9001"] }), [email("teammate")]);
  await patch(`org_roles?id=eq.${job.id}`, { notify_user_ids: [] });
  check("an empty list: the owners", await leadRecipients({ recruiterProfileId: null, orgId: org.id, jobIds: ["9001"] }), [email("owner")]);
  await patch(`org_roles?id=eq.${job.id}`, { notify_user_ids: [U.teammate, U.recruiter] });
  check("two jobs, one email each person", await leadRecipients({ recruiterProfileId: null, orgId: org.id, jobIds: ["9001", "9002", "9001"] }), [email("teammate"), email("recruiter")]);
  check("a job number with junk in it is ignored", await leadRecipients({ recruiterProfileId: null, orgId: org.id, jobIds: ['9001",x'] }), [email("owner")]);
} finally {
  for (const o of [org, other]) {
    await svc(`recruiter_profiles?organization_id=eq.${o.id}`, { method: "DELETE", prefer: "return=minimal" }, { soft: true });
    await svc(`org_roles?organization_id=eq.${o.id}`, { method: "DELETE", prefer: "return=minimal" }, { soft: true });
    await svc(`org_members?organization_id=eq.${o.id}`, { method: "DELETE", prefer: "return=minimal" }, { soft: true });
    await svc(`organizations?id=eq.${o.id}`, { method: "DELETE", prefer: "return=minimal" }, { soft: true });
  }
  const left = await svc(`organizations?slug=like.leaktest-${run}-*&select=id`);
  console.log(`cleanup: ${left.length ? "LEFTOVER" : "removed"}`);
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
