// Throwaway organizations for the cross-organization leak test.
//
// Builds two client companies (A and B) and a Transformer Talent side, fills
// them with fake records, and signs a test login into each. Every value an
// organization owns carries a marker token, so a response can be scanned for
// data that should never have reached the caller:
//
//   zzlk<run>a-*  A's private data        zzlk<run>c-*  A's name + job titles
//   zzlk<run>b-*  B's private data        zzlk<run>d-*  B's name + job titles
//   zzlk<run>t-*  TT's private data       zzlk<run>s-*  the person TT sends to A
//   zzlk<run>r-*  the person TT sends to B (and the names of the requirements
//                 TT's report card finds missing, which B's reason may name)
//   zzlk<run>u-*  B's open job that never asked TT for help: public on B's
//                 board, but never in TT's dashboard (link picker, copies)
//   zzlk<run>p-*  public LinkedIn data both clients hold (shared by design)
//
// Nothing here touches real records: the only writes to shared tables are two
// fake pool people and one fake TT job, all removed by teardown().
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
try {
  for (const line of fs.readFileSync(path.join(root, ".env.scripts"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

export const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ANON = process.env.SUPABASE_ANON_KEY || "";
if (!SB_URL || !SERVICE || !ANON)
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required (.env.scripts)");

export const TT_SLUG = "transformer-talent";
export const SLUG_PREFIX = "leaktest-";
export const EMAIL_PREFIX = "leaktest+";
export const POOL_SOURCE = "leaktest";
const SVC_H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };

/** Service-role PostgREST call. Throws on failure unless opts.soft. */
export async function svc(p, init = {}, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${p}`, {
    ...init,
    headers: { ...SVC_H, ...(init.prefer ? { Prefer: init.prefer } : {}), ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    if (opts.soft) return null;
    throw new Error(`${init.method || "GET"} ${p.split("?")[0]} ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}
const insert = (table, rows) =>
  svc(table, { method: "POST", body: JSON.stringify(rows), prefer: "return=representation" });
const del = (p) => svc(p, { method: "DELETE", prefer: "return=minimal" }, { soft: true });

async function authAdmin(p, init = {}) {
  const res = await fetch(`${SB_URL}/auth/v1/${p}`, { ...init, headers: { ...SVC_H, ...(init.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`auth ${p} ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Create a confirmed auth user and return a live session for it (no email is sent). */
async function testLogin(email) {
  const user = await authAdmin("admin/users", {
    method: "POST",
    body: JSON.stringify({ email, email_confirm: true }),
  });
  const link = await authAdmin("admin/generate_link", {
    method: "POST",
    body: JSON.stringify({ type: "magiclink", email }),
  });
  const tokenHash = link.hashed_token || link.properties?.hashed_token;
  const res = await fetch(`${SB_URL}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token_hash: tokenHash }),
  });
  const session = await res.json();
  if (!res.ok || !session.access_token) throw new Error(`verify ${res.status}: no session for ${email}`);
  return { userId: user.id, email, token: session.access_token };
}

// The smallest valid PDF, so resume endpoints have a real object to sign.
const PDF = Buffer.from(
  "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj " +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
);
async function uploadResume(objectPath) {
  const res = await fetch(`${SB_URL}/storage/v1/object/resumes/${objectPath}`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/pdf", "x-upsert": "true" },
    body: PDF,
  });
  if (!res.ok) throw new Error(`resume upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export function newRun() {
  const id = Date.now().toString(36).slice(-5) + crypto.randomBytes(2).toString("hex");
  const T = (cls) => `zzlk${id}${cls}`;
  // TT job numbers run to the low hundreds; 99xxx cannot collide with a real one.
  const ttJob = String(99000 + crypto.randomInt(500));
  const ttJob2 = String(99500 + crypto.randomInt(500));
  return { id, T, ttJob, ttJob2, tokens: { a: T("a"), b: T("b"), c: T("c"), d: T("d"), t: T("t"), s: T("s"), r: T("r"), u: T("u"), p: T("p") } };
}

const today = () => new Date().toISOString().slice(0, 10);

/** One client company with a member, a job, an applicant, sourced people and the side records. */
async function seedClient(run, x /* "a" | "b" */) {
  const priv = run.T(x); // private token
  const cat = run.T(x === "a" ? "c" : "d"); // name + titles token (the TT link picker may show these)
  const shared = run.T("p");
  const slug = `${SLUG_PREFIX}${run.id}-${x}`;
  const [org] = await insert("organizations", [{ slug, name: `Leak Test ${x.toUpperCase()} ${cat}-org` }]);

  const login = await testLogin(`${EMAIL_PREFIX}${run.id}-${x}@example.com`);
  await insert("org_members", [
    { organization_id: org.id, user_id: login.userId, email: login.email, member_role: "owner" },
  ]);

  // Both clients use job number 9001, so any lookup by job number that skips
  // the organization filter can land on the other company's job.
  const [role] = await insert("org_roles", [
    {
      organization_id: org.id,
      external_id: "9001",
      title: `Engineer ${cat}-role`,
      description: `${cat}-jd`,
      status: "open",
      source: "dashboard",
      salary: "$150k-$200k",
      locations: ["San Francisco"],
      target_companies: [{ name: `${priv}-target` }],
      scorecard: {
        v: 1,
        draftedBy: "user",
        draftedAt: new Date().toISOString(),
        criteria: [{ id: "r1", tier: "required", label: `${priv}-cardrow`, good: `${priv}-cardgood` }],
      },
      interview_stages: [{ id: "s1", label: `${priv}-stage` }],
      sourcing_requested: true,
      sourcing_requested_at: new Date().toISOString(),
    },
  ]);
  // B also has an open job that never asked TT for help: public on B's
  // board, never listed, linked or copied by TT.
  if (x === "b")
    await insert("org_roles", [
      { organization_id: org.id, external_id: "9002", title: `Engineer ${run.T("u")}-unrequested`, description: `${run.T("u")}-jd`, status: "open", source: "dashboard", sourcing_requested: false },
    ]);

  const resumePath = `leaktest/${run.id}/${x}-applicant.pdf`;
  await uploadResume(resumePath);
  const [app] = await insert("website_applications", [
    {
      organization_id: org.id,
      name: `Applicant ${priv}-applicant`,
      email: `${priv}-applicant@example.com`,
      linkedin_url: `https://www.linkedin.com/in/${priv}-applicantli`,
      linkedin_username: `${priv}-applicantli`,
      role_ids: ["9001"],
      role_titles: [`Engineer ${cat}-role (#9001)`],
      status: "processed",
      source: "website_applicant",
      resume_path: resumePath,
      resume_text: `${priv}-resumetext`,
      parsed_profile: { current_title: `${priv}-apptitle`, current_company: `${priv}-appcompany` },
      screening: [{ job_id: "9001", qualified: true, reason: `${priv}-appverdict` }],
      contact: { email: `${priv}-appcontact@example.com`, phone: "+1 555 0100" },
    },
  ]);
  const appKey = `app_${app.id}`;

  const [runRow] = await insert("sourcing_runs", [
    {
      organization_id: org.id,
      org_role_id: role.id,
      created_by: login.userId,
      search_params: { keywords: [`${priv}-search`] },
      status: "done",
      provider_mode: "mock",
      imported_count: 2,
      screened_count: 2,
    },
  ]);
  // The same LinkedIn person sourced by both clients: the public profile is
  // shared by design, each company's contact edit is private.
  const [sharedSrc, ownSrc] = await insert("sourced_candidates", [
    {
      organization_id: org.id,
      first_run_id: runRow.id,
      linkedin_username: `${shared}-sharedli`,
      linkedin_url: `https://www.linkedin.com/in/${shared}-sharedli`,
      full_name: `Shared Person ${shared}-sharedname`,
      headline: `${shared}-sharedheadline`,
      current_title: "Staff Engineer",
      current_company: "Example Corp",
      contact: { email: `${priv}-sharedcontact@example.com` },
    },
    {
      organization_id: org.id,
      first_run_id: runRow.id,
      linkedin_username: `${priv}-sourcedli`,
      linkedin_url: `https://www.linkedin.com/in/${priv}-sourcedli`,
      full_name: `Sourced ${priv}-sourced`,
      headline: `${priv}-sourcedheadline`,
      current_title: "Engineer",
      current_company: "Example Corp",
      contact: null,
    },
  ]);
  const src = await insert("sourcing_run_candidates", [
    { run_id: runRow.id, sourced_candidate_id: sharedSrc.id, organization_id: org.id, screen_status: "done", tag: "yes", reason: `${priv}-srcreason`, rank: 1, verdict: { reason: `${priv}-srcverdict` } },
    { run_id: runRow.id, sourced_candidate_id: ownSrc.id, organization_id: org.id, screen_status: "done", tag: "strong_yes", reason: `${priv}-srcreason2`, rank: 2, verdict: { reason: `${priv}-srcverdict2` } },
  ]);
  const sharedKey = `src_${sharedSrc.id}`;

  await insert("candidate_role_statuses", [
    { organization_id: org.id, candidate_key: appKey, job_id: "9001", status: "interviewing", reason: `${priv}-statusreason` },
  ]);
  await insert("stage_events", [
    { organization_id: org.id, candidate_key: appKey, job_id: "9001", from_status: "new", to_status: "interviewing", reason: `${priv}-stagereason`, moved_by_email: login.email },
  ]);
  const [note] = await insert("candidate_notes", [
    { organization_id: org.id, candidate_key: appKey, kind: "note", body: `${priv}-note`, author_id: login.userId, author_email: login.email },
  ]);
  const [task] = await insert("tasks", [
    { organization_id: org.id, candidate_key: appKey, candidate_name: `${priv}-taskname`, kind: "task", title: `${priv}-task`, due_date: today(), status: "open", created_by: login.userId, created_by_email: login.email, job_id: "9001" },
  ]);
  const [list] = await insert("candidate_lists", [
    { organization_id: org.id, name: `${priv}-list`, created_by: login.userId, created_by_email: login.email },
  ]);
  await insert("candidate_list_members", [
    { list_id: list.id, organization_id: org.id, candidate_key: appKey, added_by: login.userId, added_by_email: login.email },
  ]);
  await insert("role_attachments", [
    { organization_id: org.id, candidate_key: sharedKey, job_id: "9001", added_by: login.userId, added_by_email: login.email },
  ]);
  const [link] = await insert("tracked_links", [
    { organization_id: org.id, candidate_key: appKey, token: `${priv}tl`.replace(/[^a-z0-9]/g, ""), target_path: `/board/${slug}`, created_by: login.userId },
  ]);
  const [tpl] = await insert("email_templates", [
    { organization_id: org.id, name: `${priv}-tpl`, subject: `${priv}-tplsubject`, body_html: `<p>${priv}-tplbody</p>`, created_by_email: login.email },
  ]);
  await insert("candidate_email_log", [
    { organization_id: org.id, candidate_key: appKey, direction: "out", member_email: login.email, address: `${priv}-applicant@example.com`, subject: `${priv}-emailsubject`, snippet: `${priv}-emailsnippet`, body_text: `${priv}-emailbody`, thread_id: `${priv}-thread`, message_id: `${priv}-msg` },
  ]);
  await insert("inbox_items", [
    { organization_id: org.id, member_email: login.email, item_key: `${priv}-inbox`, kind: "reply", label: `${priv}-inboxlabel`, candidate_key: appKey },
  ]);
  await insert("credit_grants", [{ organization_id: org.id, credits: 7, reason: `${priv}-grant`, created_by: "leaktest" }]);
  const [profile] = await insert("recruiter_profiles", [
    { organization_id: org.id, user_id: login.userId, slug: `${SLUG_PREFIX}${run.id}-${x}-me`, display_name: `${priv}-recruiter`, bio: `${priv}-bio`, contact_email: `${priv}-recruiter@example.com`, published: false },
  ]);
  await insert("page_events", [
    { recruiter_profile_id: profile.id, event: "view", referrer: `${priv}-referrer`, visitor_hash: `${priv}-visitor`, day: today() },
  ]);
  await insert("referrals", [
    { organization_id: org.id, recruiter_profile_id: profile.id, referrer_name: `${priv}-referrer`, referrer_email: `${priv}-referrer@example.com`, candidate_linkedin: `https://www.linkedin.com/in/${priv}-referredli`, candidate_email: `${priv}-referred@example.com`, amount: 1000, status: "pending" },
  ]);
  await insert("no_reply_marks", [{ organization_id: org.id, candidate_key: appKey, marked_by_email: login.email, job_id: "9001" }]);
  await insert("goal_targets", [{ organization_id: org.id, member_email: login.email, emails: 17 }]);
  await insert("verdict_feedback", [
    { organization_id: org.id, org_role_id: role.id, candidate_key: appKey, kind: "override", criterion_id: "r1", note: `${priv}-feedback`, member_email: login.email },
  ]);
  await insert("candidate_profiles", [{ organization_id: org.id, candidate_key: appKey, confirmed_facts: { note: `${priv}-facts` } }]);
  await insert("verdict_cache", [
    { organization_id: org.id, org_role_id: role.id, candidate_key: appKey, input_hash: `${priv}-hash`, judge_version: "leaktest", model: "none", verdict: { reason: `${priv}-cache` } },
  ]);

  return {
    x, org, slug, login, role, app, appKey, resumePath,
    run: runRow, sharedSrc, ownSrc, sharedKey, ownKey: `src_${ownSrc.id}`, runCands: src,
    note, task, list, link, tpl, profile, priv, cat,
  };
}

/** The Transformer Talent side: a test login, jobs linked to A's and B's job 9001, three fake pool people. */
async function seedTT(run, A, B) {
  const t = run.tokens.t;
  const s = run.tokens.s;
  const r = run.tokens.r;
  const [tt] = await svc(`organizations?slug=eq.${TT_SLUG}&select=id,slug,name`);
  if (!tt) throw new Error("Transformer Talent org not found");
  const login = await testLogin(`${EMAIL_PREFIX}${run.id}-tt@example.com`);
  await insert("org_members", [{ organization_id: tt.id, user_id: login.userId, email: login.email, member_role: "member" }]);

  // Closed, so no nightly job or public page picks it up while it exists.
  const [role] = await insert("org_roles", [
    {
      organization_id: tt.id,
      external_id: run.ttJob,
      title: `TT job ${t}-role`,
      description: `${t}-jd`,
      status: "closed",
      source: "dashboard",
      scorecard: { v: 1, draftedBy: "user", draftedAt: new Date().toISOString(), criteria: [{ id: "r1", tier: "required", label: `${t}-cardrow`, good: `${t}-cardgood` }] },
      linked_org_role: { orgId: A.org.id, jobId: "9001" },
    },
  ]);
  const [role2] = await insert("org_roles", [
    {
      organization_id: tt.id,
      external_id: run.ttJob2,
      title: `TT job ${t}-role2`,
      description: `${t}-jd2`,
      status: "closed",
      source: "dashboard",
      scorecard: { v: 1, draftedBy: "user", draftedAt: new Date().toISOString(), criteria: [{ id: "r1", tier: "required", label: `${r}-techrow`, good: `${t}-cardgood2` }] },
      linked_org_role: { orgId: B.org.id, jobId: "9001" },
    },
  ]);

  const [sent, unsent] = await insert("candidates", [
    {
      full_name: `Sent Person ${s}-name`,
      linkedin_username: `${s}-li`,
      linkedin_url: `https://www.linkedin.com/in/${s}-li`,
      email: `${s}-email@example.com`,
      current_title: `${s}-title`,
      current_company: "Example Corp",
      source: POOL_SOURCE,
      notes: `${t}-poolnotes`,
      ai_summary: `${t}-aisummary`,
      contact: { email: `${s}-email@example.com` },
      follow_up_at: "2031-01-01",
    },
    {
      full_name: `Unsent Person ${t}-unsent`,
      linkedin_username: `${t}-unsentli`,
      linkedin_url: `https://www.linkedin.com/in/${t}-unsentli`,
      email: `${t}-unsentemail@example.com`,
      current_title: `${t}-unsenttitle`,
      current_company: "Example Corp",
      source: POOL_SOURCE,
      notes: `${t}-poolnotes2`,
      ai_summary: null,
      contact: null,
      follow_up_at: null,
    },
  ]);
  const [second] = await insert("candidates", [
    {
      full_name: `Second Sent ${r}-name`,
      linkedin_username: `${r}-li`,
      linkedin_url: `https://www.linkedin.com/in/${r}-li`,
      email: `${r}-email@example.com`,
      current_title: `${r}-title`,
      current_company: "Example Corp",
      source: POOL_SOURCE,
      notes: `${t}-poolnotes3`,
    },
  ]);

  // A verdict in the shape the nightly matcher writes: the client-safe parts
  // (tier, years, stack counts, gaps) and the internal trail (reason, the
  // evidence behind each scope answer) carry different tokens.
  const scorecard = (tok) => ({
    tier: "STRONG",
    reason: `${t}-internalreason`,
    stack: { items: [{ term: "TypeScript", evidenced: true, source: "dated" }], matched: 1, total: 1 },
    years: { required: 5, actual: 8, met: true },
    seniority: { level: "senior", signals: [{ question: `${t}-question`, answer: "yes", evidence: `${t}-evidence` }] },
    gaps: [`${tok}-gap`],
  });
  const now = new Date().toISOString();
  const reportCard = {
    v: 2,
    label: "contact",
    paragraph: `${t}-paragraph`,
    missing: [],
    ask: [`${t}-ask`],
    betterSuited: `${t}-bettersuited`,
    requirements: [{ label: `${t}-requirement`, status: "yes", evidence: `${t}-reqevidence` }],
    tech: { now: [], before: [], gaps: [] },
    card: {
      rows: [
        {
          id: "r1",
          label: `${t}-cardrow`,
          tier: "required",
          status: "yes",
          ai: "yes",
          evidence: `${t}-rowevidence`,
          quote: `${t}-quote`,
          quotes: [{ text: `${t}-quote2`, source: "Resume" }],
          confirmed: { by: `${t}-recruiter`, at: now, note: `${t}-confirmnote` },
        },
      ],
    },
    model: "leaktest",
    at: now,
  };
  await insert("match_verdicts", [
    { organization_id: tt.id, candidate_id: sent.id, org_role_id: role.id, candidate_hash: `${t}-ch1`, role_hash: `${t}-rh`, verdict: { qualified: true, scorecard: scorecard(s), notes: `${t}-verdictnotes`, answers: [{ question: `${t}-question2`, answer: "yes", evidence: `${t}-answerevidence` }], v2: reportCard }, model: "leaktest", source: "worker" },
    { organization_id: tt.id, candidate_id: unsent.id, org_role_id: role.id, candidate_hash: `${t}-ch2`, role_hash: `${t}-rh`, verdict: { qualified: true, scorecard: scorecard(t) }, model: "leaktest", source: "worker" },
  ]);
  // The scorecard judge's shape: a report card only, no older scorecard.
  // Requirement names may reach B (as the reason's "worth probing"); the
  // paragraph, evidence, quotes and check-off never may.
  await insert("match_verdicts", [
    {
      organization_id: tt.id,
      candidate_id: second.id,
      org_role_id: role2.id,
      candidate_hash: `${t}-ch3`,
      role_hash: `${t}-rh2`,
      model: "leaktest",
      source: "shortlist",
      verdict: {
        v2: {
          v: 2,
          label: "message",
          paragraph: `${t}-paragraph2`,
          missing: [`${t}-missing2`],
          ask: [`${t}-ask2`],
          betterSuited: `${t}-bettersuited2`,
          requirements: [{ label: `${t}-requirement2`, status: "yes", evidence: `${t}-reqevidence2` }],
          tech: { now: [], before: [], gaps: [] },
          card: {
            rows: [
              { id: "r1", label: `${r}-techrow`, tier: "required", kind: "tech", status: "yes", ai: "yes", evidence: `${t}-rowevidence2`, quote: `${t}-quote3` },
              { id: "r2", label: `${r}-gaprow`, tier: "required", kind: "judgment", status: "unknown", ai: "unknown", evidence: `${t}-rowevidence3`, confirmed: { by: `${t}-recruiter2`, at: now, note: `${t}-confirmnote2` } },
            ],
          },
          model: "leaktest",
          at: now,
        },
      },
    },
  ]);
  await insert("candidate_enrichments", [
    { organization_id: tt.id, candidate_id: sent.id, linkedin_username: `${s}-li`, provider: "leaktest", operation: "full_profile", status: "completed", cache_status: "miss", raw_payload: { firstName: "Sent", lastName: `${s}-last`, headline: `${s}-harvestheadline` } },
  ]);

  return { tt, login, role, role2, sent, unsent, second };
}

export async function setup(run) {
  const A = await seedClient(run, "a");
  const B = await seedClient(run, "b");
  const TT = await seedTT(run, A, B);
  return { A, B, TT };
}

/**
 * Remove everything a run created. Safe to call on a half-built run and on
 * leftovers of crashed runs (pass sweep=true to catch every leaktest org).
 */
export async function teardown({ runId = null, sweep = false, keys = [] } = {}) {
  const orgFilter = sweep ? `slug=like.${SLUG_PREFIX}*` : `slug=like.${SLUG_PREFIX}${runId}-*`;
  const orgs = (await svc(`organizations?${orgFilter}&select=id,slug`, {}, { soft: true })) || [];
  const [tt] = (await svc(`organizations?slug=eq.${TT_SLUG}&select=id`, {}, { soft: true })) || [];
  // Encoded: a bare "+" in a query string reads as a space and matches nothing.
  const emailLike = encodeURIComponent(sweep ? `${EMAIL_PREFIX}*` : `${EMAIL_PREFIX}${runId}-*`);
  const tokenLike = sweep ? "zzlk*" : `zzlk${runId}*`;

  // Fake pool people (and everything keyed to them).
  const pool = (await svc(`candidates?source=eq.${POOL_SOURCE}&linkedin_username=like.${tokenLike}&select=id`, {}, { soft: true })) || [];
  for (const { id } of pool) {
    for (const t of ["match_verdicts", "candidate_enrichments", "candidate_embeddings", "candidate_experiences", "refresh_queue", "person_signals", "role_shortlists"])
      await del(`${t}?candidate_id=eq.${id}`);
    for (const o of orgs) await del(`website_applications?organization_id=eq.${o.id}&candidate_id=eq.${id}`);
    await del(`candidates?id=eq.${id}`);
  }

  // The fake TT job and the TT test login's own traces.
  if (tt) {
    const roles = (await svc(`org_roles?organization_id=eq.${tt.id}&title=like.*${tokenLike}&select=id`, {}, { soft: true })) || [];
    for (const { id } of roles) {
      await del(`match_verdicts?org_role_id=eq.${id}`);
      await del(`org_roles?id=eq.${id}`);
    }
    const ttMembers = (await svc(`org_members?organization_id=eq.${tt.id}&email=like.${emailLike}&select=id,email,user_id`, {}, { soft: true })) || [];
    for (const m of ttMembers) {
      for (const t of ["inbox_items", "attention_snoozes", "goal_targets", "email_accounts", "verdict_feedback"])
        await del(`${t}?organization_id=eq.${tt.id}&member_email=eq.${encodeURIComponent(m.email)}`);
      await del(`tasks?organization_id=eq.${tt.id}&created_by=eq.${m.user_id}`);
      await del(`candidate_notes?organization_id=eq.${tt.id}&author_id=eq.${m.user_id}`);
      await del(`recruiter_profiles?organization_id=eq.${tt.id}&user_id=eq.${m.user_id}`);
      await del(`candidate_lists?organization_id=eq.${tt.id}&created_by=eq.${m.user_id}`);
      await del(`org_members?id=eq.${m.id}`);
    }
    // Rows a probe may have written into TT's company about the test people
    // (by candidate key) or the test job (TT test jobs are numbered 99000-99999).
    const keyTables = ["candidate_role_statuses", "stage_events", "candidate_notes", "tasks", "candidate_list_members", "role_attachments", "tracked_links", "no_reply_marks", "inbox_items", "candidate_email_log", "verdict_feedback", "candidate_profiles", "verdict_cache"];
    for (const t of keyTables) for (const k of keys) await del(`${t}?organization_id=eq.${tt.id}&candidate_key=eq.${k}`);
    for (const t of ["candidate_role_statuses", "stage_events", "tasks", "role_attachments", "no_reply_marks"])
      await del(`${t}?organization_id=eq.${tt.id}&job_id=like.99___`);
  }

  // The client companies: children without ON DELETE CASCADE first.
  for (const o of orgs) {
    const q = `organization_id=eq.${o.id}`;
    await del(`referrals?${q}`);
    await del(`usage_events?${q}`);
    await del(`sourcing_run_candidates?${q}`);
    await del(`sourced_candidates?${q}`);
    await del(`sourcing_runs?${q}`);
    await del(`match_verdicts?${q}`);
    await del(`website_applications?${q}`);
    await del(`candidate_role_statuses?${q}`);
    await del(`stage_events?${q}`);
    await del(`credit_grants?${q}`);
    await del(`recruiter_profiles?${q}`);
    for (const t of ["candidate_enrichments", "candidate_embeddings", "candidate_experiences", "refresh_queue"]) await del(`${t}?${q}`);
    await del(`org_roles?${q}`);
    await del(`org_members?${q}`);
    await del(`organizations?id=eq.${o.id}`);
  }

  // Storage objects and auth users.
  const prefix = sweep ? "leaktest/" : `leaktest/${runId}/`;
  const objs = await fetch(`${SB_URL}/storage/v1/object/list/resumes`, {
    method: "POST",
    headers: SVC_H,
    body: JSON.stringify({ prefix: sweep ? "leaktest" : `leaktest/${runId}`, limit: 1000 }),
  }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const names = [];
  for (const o of objs) {
    if (o.id) names.push(sweep ? `leaktest/${o.name}` : `${prefix}${o.name}`);
    else if (sweep) {
      const inner = await fetch(`${SB_URL}/storage/v1/object/list/resumes`, {
        method: "POST", headers: SVC_H, body: JSON.stringify({ prefix: `leaktest/${o.name}`, limit: 1000 }),
      }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
      for (const i of inner) names.push(`leaktest/${o.name}/${i.name}`);
    }
  }
  if (names.length)
    await fetch(`${SB_URL}/storage/v1/object/resumes`, { method: "DELETE", headers: SVC_H, body: JSON.stringify({ prefixes: names }) });

  const users = [];
  for (let page = 1; page < 50; page++) {
    const r = await authAdmin(`admin/users?page=${page}&per_page=200`).catch(() => null);
    const list = r?.users || [];
    for (const u of list) {
      const e = u.email || "";
      if (sweep ? e.startsWith(EMAIL_PREFIX) : e.startsWith(`${EMAIL_PREFIX}${runId}-`)) users.push(u.id);
    }
    if (list.length < 200) break;
  }
  for (const id of users) await authAdmin(`admin/users/${id}`, { method: "DELETE" }).catch(() => {});

  return { orgs: orgs.length, poolPeople: pool.length, files: names.length, users: users.length };
}

/** Rows still carrying this run's tokens anywhere teardown should have reached. */
export async function leftovers(runId) {
  const like = `*zzlk${runId}*`;
  const checks = [
    ["organizations", `name=like.${like}`],
    ["org_roles", `title=like.${like}`],
    ["candidates", `full_name=like.${like}`],
    ["website_applications", `name=like.${like}`],
    ["sourced_candidates", `full_name=like.${like}`],
    ["candidate_notes", `body=like.${like}`],
    ["tasks", `title=like.${like}`],
    ["candidate_lists", `name=like.${like}`],
    ["email_templates", `name=like.${like}`],
    ["candidate_email_log", `subject=like.${like}`],
    ["credit_grants", `reason=like.${like}`],
    ["recruiter_profiles", `bio=like.${like}`],
    ["referrals", `referrer_name=like.${like}`],
    ["match_verdicts", `role_hash=like.${like}`],
    ["candidate_enrichments", `linkedin_username=like.${like}`],
    ["org_members", `email=like.${encodeURIComponent(`${EMAIL_PREFIX}${runId}-*`)}`],
  ];
  const out = [];
  for (const [t, f] of checks) {
    const rows = (await svc(`${t}?${f}&select=*&limit=5`, {}, { soft: true })) || [];
    if (rows.length) out.push(`${t}: ${rows.length}`);
  }
  return out;
}
