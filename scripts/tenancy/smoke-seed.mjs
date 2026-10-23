#!/usr/bin/env node
// Realistic SYNTHETIC data for the browser smoke on the disposable local stack
// (scripts/tenancy/DISPOSABLE.md). Loopback only; refuses hosted URLs. Creates a TT
// login, two open TT roles, one pool person with a full profile (experience,
// education, skills) linked to a TT application for the first role, and a report-card
// verdict for the second role (the drawer's "Also a match"); then normalizes and
// anchors the person the supported way (reconcile + anchors, controller disabled),
// arms the controller, publishes the person through the publish CLI inside a
// publication window, and leaves the controller armed/open as it is in production.
//
//   PERSON_TARGET_PROJECT_REF=local SUPABASE_URL=http://127.0.0.1:<api> SUPABASE_SERVICE_ROLE_KEY=… \
//   SUPABASE_ANON_KEY=… LOCAL_DATABASE_URL=postgresql://postgres:…@127.0.0.1:<pg>/postgres \
//   node scripts/tenancy/smoke-seed.mjs            # prints the sign-in link and the keys
import pg from "pg";
import { randomUUID } from "node:crypto";
import { svc } from "./fixture.mjs";
import { operatorPool, sweepReason } from "./armed.mjs";
import { setTransition, transitionStatus, openWindow, closeWindow } from "../person-transition.mjs";
import { runPublish, SPEC as PUBLISH } from "../person-publish.mjs";
import { parseOptions } from "../person-publish/lib.mjs";
import { openAnchorDatabase } from "../person-audit/database.mjs";
import { prepareAnchors } from "../person-audit-anchors.mjs";
import { checkTargetEnvironment } from "../person-target.mjs";

const env = process.env;
const url = env.LOCAL_DATABASE_URL;
const t = checkTargetEnvironment(env, { restUrl: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, databaseUrls: [url] });
if (!t.local) throw Error("smoke_seed:local_only");
const pool = new pg.Pool({ connectionString: url, max: 3 }); pool.on("error", () => {});
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
const insert = (table, rows) => svc(table, { method: "POST", body: JSON.stringify(rows), prefer: "return=representation" });

async function login(email) {
  const SB = env.SUPABASE_URL;
  const r = await fetch(`${SB}/auth/v1/admin/users`, { method: "POST", headers: H, body: JSON.stringify({ email, email_confirm: true }) });
  const u = await r.json();
  const uid = u.id ?? (await (await fetch(`${SB}/auth/v1/admin/users?page=1&per_page=200`, { headers: H })).json()).users.find((x) => x.email === email).id;
  const link = await (await fetch(`${SB}/auth/v1/admin/generate_link`, { method: "POST", headers: H, body: JSON.stringify({ type: "magiclink", email, options: { redirect_to: "http://127.0.0.1:3400/dashboard" } }) })).json();
  return { uid, actionLink: link.action_link };
}

const profile = {
  firstName: "Jordan", lastName: "Avery", headline: "Senior Backend Engineer at Northwind Analytics",
  location: { linkedinText: "Austin, Texas, United States" },
  about: "Backend engineer with nine years building data platforms and APIs in TypeScript and Go. Led the ingestion rewrite at Northwind Analytics; mentor and on-call lead.",
  experience: [
    { title: "Senior Backend Engineer", companyName: "Northwind Analytics", companyLinkedinUrl: "https://www.linkedin.com/company/northwind-analytics", startDate: { year: 2021, month: 3 }, endDate: null, description: "Owns the ingestion platform (TypeScript, Postgres, Kafka); cut p95 latency by 40%.", location: "Austin, TX" },
    { title: "Backend Engineer", companyName: "Harbor Logistics", startDate: { year: 2017, month: 6 }, endDate: { year: 2021, month: 2 }, description: "Built the dispatch API in Go; introduced contract tests." },
    { title: "Software Engineer", companyName: "Lakeside Software", startDate: { year: 2015, month: 8 }, endDate: { year: 2017, month: 5 } },
  ],
  education: [
    { schoolName: "State University", degree: "Bachelor of Science", fieldOfStudy: "Computer Science", period: "2011 - 2015" },
    { schoolName: "Community College of Travis County", degree: "Associate", fieldOfStudy: "Mathematics", period: "2009 - 2011" },
  ],
  skills: ["TypeScript", "Go", "PostgreSQL", "Kafka", "Distributed Systems", "API Design", "Kubernetes", "Terraform", "Observability", "Mentoring"],
};
const scorecard = (rows) => ({ v: 1, draftedBy: "user", draftedAt: new Date().toISOString(), criteria: rows.map(([id, label, good]) => ({ id, tier: "required", label, good })) });
const card = (label, paragraph) => ({ v: 2, label, paragraph, missing: [], ask: ["Ask about on-call rotation preferences"], betterSuited: null,
  requirements: [{ label: "Five or more years of backend experience", status: "yes", evidence: "Nine years across three companies" }],
  tech: { now: ["TypeScript", "PostgreSQL", "Kafka"], before: ["Go"], gaps: [] },
  card: { rows: [{ id: "r1", label: "Backend experience in TypeScript or Go", tier: "required", status: "yes", ai: "yes", evidence: "Senior Backend Engineer, Northwind Analytics (2021-)", quote: "Owns the ingestion platform (TypeScript, Postgres, Kafka)" }] },
  model: "smoke", at: new Date().toISOString() });

async function main() {
  const [tt] = await svc("organizations?slug=eq.transformer-talent&select=id");
  if (!tt) throw Error("smoke_seed:tt_missing");
  const status = await transitionStatus(pool);
  if (status.enabled) throw Error("smoke_seed:controller_enabled");
  const who = await login("smoke+tt@example.com");
  await svc("org_members", { method: "POST", prefer: "return=minimal", body: JSON.stringify([{ organization_id: tt.id, user_id: who.uid, email: "smoke+tt@example.com", member_role: "owner" }]) }).catch(() => {});
  const [role1] = await insert("org_roles", [{ organization_id: tt.id, external_id: "99101", title: "Senior Backend Engineer", description: "Own the ingestion platform for a growing analytics product. TypeScript or Go, PostgreSQL, event streaming.", status: "open", source: "dashboard", salary: "$170k-$210k", locations: ["Austin", "Remote (US)"], company_name: "Northwind Analytics", scorecard: scorecard([["r1", "Backend experience in TypeScript or Go", "Five or more years"], ["r2", "Event streaming in production", "Kafka or equivalent"]]) }]);
  const [role2] = await insert("org_roles", [{ organization_id: tt.id, external_id: "99102", title: "Staff Platform Engineer", description: "Platform team lead for a fintech scale-up. Kubernetes, Terraform, observability.", status: "open", source: "dashboard", salary: "$200k-$240k", locations: ["Remote (US)"], company_name: "Meridian Pay", scorecard: scorecard([["r1", "Platform leadership", "Led a platform or infrastructure team"]]) }]);
  const cid = randomUUID();
  await pool.query(`insert into candidates(id,full_name,linkedin_username,linkedin_url,email,phone,current_title,current_company,location,source,contact,created_at)
    values($1,'Jordan Avery','jordan-avery-smoke','https://www.linkedin.com/in/jordan-avery-smoke','jordan.avery@example.test','+15125550142','Senior Backend Engineer','Northwind Analytics','Austin, TX','leaktest',$2::jsonb,'2025-02-01')`,
    [cid, JSON.stringify({ email: "jordan.avery@example.test", phone: "+15125550142" })]);
  await pool.query("insert into candidate_emails(candidate_id,email_address,email_type,quality,result) values($1,'jordan.avery@example.test','personal','good','ok'),($1,'javery.old@example.test','personal','good','ok')", [cid]);
  await insert("candidate_enrichments", [{ organization_id: tt.id, candidate_id: cid, linkedin_username: "jordan-avery-smoke", provider: "smoke", operation: "full_profile", status: "completed", cache_status: "miss", raw_payload: profile }]);
  const [app] = await insert("website_applications", [{ organization_id: tt.id, name: "Jordan Avery", email: "jordan.avery@example.test", linkedin_url: "https://www.linkedin.com/in/jordan-avery-smoke", linkedin_username: "jordan-avery-smoke", candidate_id: cid,
    role_ids: ["99101"], role_titles: ["Senior Backend Engineer (#99101)"], status: "processed", source: "website_applicant",
    parsed_profile: { current_title: "Senior Backend Engineer", current_company: "Northwind Analytics", location: "Austin, TX" }, harvest_profile: profile,
    screening: [{ job_id: "99101", qualified: true, reason: "Nine years of backend work in TypeScript and Go; runs an ingestion platform today." }],
    contact: { email: "jordan.avery@example.test", phone: "+15125550142" } }]);
  await insert("match_verdicts", [
    { organization_id: tt.id, candidate_id: cid, org_role_id: role1.id, candidate_hash: "smoke-c1", role_hash: "smoke-r1", model: "smoke", source: "worker", verdict: { v2: card("contact", "Strong fit: nine years of backend work, currently owning a TypeScript and Kafka ingestion platform.") } },
    { organization_id: tt.id, candidate_id: cid, org_role_id: role2.id, candidate_hash: "smoke-c1", role_hash: "smoke-r2", model: "smoke", source: "worker", verdict: { v2: card("message", "Worth a message: platform depth (Kubernetes, Terraform, observability) though no formal team lead title yet.") } },
  ]);
  // Normalize + anchor the supported way (the catch-up's translator on the current tree).
  const { pgSite } = await import("../person-trial.mjs"); const { reconcilePage } = await import("../person-reconcile.mjs"); const lib = await import("../dist/worker-lib.mjs");
  const site = await pgSite(url); const run = `smoke-${cid.slice(0, 8)}`;
  try { await site.rpc("person_reconcile_start", { p_run: run, p_commit: "c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc", p_limit: 1000, p_batch: 100, p_resume: false, p_scope: "queue", p_external_hash: "1".repeat(32) });
    let page; while ((page = await site.rpc("person_reconcile_page", { p_run: run, p_size: 100 }))?.length) await reconcilePage({ site, lib, config: { run, dry: false }, page }); }
  finally { await site.end?.(); }
  const rec = (await pool.query("select status from person_reconcile_people where run_id=$1 and candidate_id=$2", [run, cid])).rows[0];
  if (rec?.status !== "verified") throw Error(`smoke_seed:reconcile:${rec?.status}`);
  const anchors = await openAnchorDatabase(env);
  try { await prepareAnchors({ site: anchors, prepare: lib.prepareLegacyAuditAnchor, options: { save: true, limit: 1000, batch: 50, after: null, maxSeconds: 120, maxBytes: 1e12 }, onProgress: () => {} }); } finally { await anchors.end(); }
  // Arm, publish inside a window (the operator sequence), leave armed/open.
  const op = await operatorPool(env);
  try {
    await setTransition(op, "arm", sweepReason("arm", run), "disabled");
    // Publication windows are opened in the open phase (catch-up/anchors need held).
    const w = await openWindow(op, "publish", run, 30, "smoke_publish", "open");
    const options = parseOptions([`--run-id=${run}`, "--mode=publish", `--ids=${cid}`, "--review=publish", "--max-seconds=120"], PUBLISH);
    const s = await runPublish({ pool: op, lib, options, onProgress: () => {} });
    await closeWindow(op, w.work_id, "smoke_publish_done");
    const published = (await pool.query("select count(*)::int n from person_projection_state where candidate_id=$1", [cid])).rows[0].n;
    console.log(JSON.stringify({ seeded: true, candidate_id: cid, application_key: `app_${app.id}`, roles: ["99101", "99102"], publish: { projected: s.projected, unchanged: s.unchanged, reviewed: s.reviewed ?? 0 }, published: published === 1, controller: await transitionStatus(op).then((c) => ({ enabled: c.enabled, phase: c.phase })) }));
    console.log(`SIGN_IN_LINK ${who.actionLink}`);
  } finally { await op.end(); }
}
main().then(() => pool.end()).catch(async (e) => { console.error(e?.message ?? e); await pool.end(); process.exit(1); });
