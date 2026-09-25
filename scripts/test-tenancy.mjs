#!/usr/bin/env node
// Cross-organization leak test.
//
// Creates two throwaway client companies (A, B) and a Transformer Talent test
// login, fills them with marked fake records, sends one fake TT pool person to
// A the way the Network page does, then signs in as each and calls the real
// dashboard API: its own lists and searches, the other companies' records
// opened by id, and edits/deletes aimed at them. It fails when a response
// carries a marker the caller must not see (see scripts/tenancy/fixture.mjs),
// when a TT-only endpoint answers a client, or when a cross-company edit
// changed the other company's data. Everything it created is deleted at the end.
//
//   node scripts/test-tenancy.mjs --base https://transformer-talent-preview.vercel.app
//   node scripts/test-tenancy.mjs --base http://localhost:3000 --keep   (leave the data for debugging)
//   node scripts/test-tenancy.mjs --cleanup                              (remove leftovers of a crashed run)
//
// Needs .env.scripts with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and
// SUPABASE_ANON_KEY. Response bodies are scanned in memory and never printed.
import { newRun, setup, teardown, leftovers, svc } from "./tenancy/fixture.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i > -1 ? args[i + 1] : null;
};

if (flag("--cleanup")) {
  console.log("removed:", await teardown({ sweep: true }));
  process.exit(0);
}
const BASE = (opt("--base") || "").replace(/\/$/, "");
if (!/^https?:\/\//.test(BASE)) {
  console.error("usage: node scripts/test-tenancy.mjs --base <deployment url> [--keep] | --cleanup");
  process.exit(1);
}

const run = newRun();
const TOKEN_RE = new RegExp(`zzlk${run.id}([abcdtspru])-([a-z0-9-]+)`, "g");
const findings = []; // { kind, actor, what, detail }
const calls = []; // every probe, for the summary
const labels = new Map(); // uuid -> readable label for printing
const seenBy = new Map(); // actor name -> marker classes seen in any response

const label = (s) => {
  let out = s;
  for (const [id, name] of labels) out = out.split(id).join(`{${name}}`);
  return out;
};
const tokensIn = (text) => {
  const seen = new Map();
  for (const m of (text || "").toLowerCase().matchAll(TOKEN_RE)) seen.set(`${m[1]}-${m[2]}`, m[1]);
  return seen;
};

/**
 * One API call as an actor. Scans the body for markers outside the actor's
 * allowed classes; `deny` marks calls that must be refused (TT-only endpoints
 * called by a client, another company's record opened by id).
 */
async function call(actor, method, path, body, { allow = null, deny = false, group = "" } = {}) {
  const headers = {};
  if (actor.token) headers.Authorization = `Bearer ${actor.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let status = 0;
  let text = "";
  try {
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(90_000),
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    status = -1;
    text = "";
  }
  const allowed = allow || actor.allowed;
  const found = tokensIn(text);
  const seen = seenBy.get(actor.name) || new Set();
  for (const cls of found.values()) seen.add(cls);
  seenBy.set(actor.name, seen);
  const leaked = [...found].filter(([, cls]) => !allowed.has(cls)).map(([tok]) => tok);
  const what = `${actor.name} ${method} ${label(path)}`;
  calls.push({ what, status, group });
  if (leaked.length) findings.push({ kind: "READ LEAK", actor: actor.name, what, detail: `${status} carried ${[...new Set(leaked)].join(", ")}` });
  if (deny && status >= 200 && status < 300 && !leaked.length)
    findings.push({ kind: "NOT REFUSED", actor: actor.name, what, detail: `${status}, no marked data in the body` });
  if (status >= 500 || status === -1) findings.push({ kind: "ERROR", actor: actor.name, what, detail: `${status}` });
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status, text, json };
}

/* ---- snapshots: what a cross-company edit must never change ---------------- */

const q = (p) => svc(p, {}, { soft: true });
// Only rows about the company's own people and records are compared: a caller
// may legitimately write rows into its OWN company that mention a foreign key
// (step 5 does so on purpose); whether those rows then expose foreign data is
// what the marker scan checks.
async function snapshotClient(C, ownKeys) {
  const o = `organization_id=eq.${C.org.id}`;
  const k = `candidate_key=in.(${ownKeys.join(",")})`;
  return {
    org: await q(`organizations?id=eq.${C.org.id}&select=slug,name,website,referral_amount,interview_stages,company_profile,company_page_published,logo_path,email_visibility,attention_rules`),
    members: await q(`org_members?${o}&select=user_id,email,member_role&order=email`),
    role: await q(`org_roles?id=eq.${C.role.id}&select=title,description,status,salary,scorecard,target_companies,company_name,linked_org_role,interview_stages,sourcing_requested,skills,notify_user_ids`),
    roles: await q(`org_roles?${o}&select=external_id,title&order=external_id`),
    apps: await q(`website_applications?${o}&select=id,name,email,contact,resume_path,follow_up_at,role_ids,status&order=id`),
    statuses: await q(`candidate_role_statuses?${o}&${k}&select=candidate_key,job_id,status,interview_stage,reason&order=candidate_key,job_id`),
    notes: await q(`candidate_notes?${o}&${k}&select=id,body,kind&order=id`),
    task: await q(`tasks?id=eq.${C.task.id}&select=title,status,due_date,kind,candidate_key`),
    list: await q(`candidate_lists?id=eq.${C.list.id}&select=name`),
    listMembers: await q(`candidate_list_members?list_id=eq.${C.list.id}&${k}&select=candidate_key&order=candidate_key`),
    attachments: await q(`role_attachments?${o}&${k}&select=candidate_key,job_id&order=candidate_key,job_id`),
    links: await q(`tracked_links?${o}&${k}&select=candidate_key,token&order=candidate_key`),
    template: await q(`email_templates?id=eq.${C.tpl.id}&select=name,subject,body_html`),
    runs: await q(`sourcing_runs?${o}&select=id,status,screened_count,imported_count&order=id`),
    runCands: await q(`sourcing_run_candidates?${o}&select=id,tag,reason,screen_status,hidden,shortlisted&order=id`),
    sourced: await q(`sourced_candidates?${o}&select=id,contact,resume_path,full_name&order=id`),
    noReply: await q(`no_reply_marks?${o}&${k}&select=candidate_key,cleared_at,check_back_at&order=candidate_key`),
    inbox: await q(`inbox_items?${o}&item_key=eq.${C.priv}-inbox&select=item_key,seen_at,handled_at,label`),
    goals: await q(`goal_targets?${o}&select=member_email,emails,calls,interviewing,placements&order=member_email`),
    snoozes: await q(`attention_snoozes?${o}&select=item_key,until&order=item_key`),
    credits: await q(`credit_grants?${o}&select=credits,reason&order=created_at`),
    usage: (await q(`usage_events?${o}&select=id`))?.length,
    profile: await q(`recruiter_profiles?${o}&select=slug,display_name,bio,published,contact_email,booking_url`),
    feedback: await q(`verdict_feedback?${o}&${k}&select=candidate_key,kind,criterion_id,note,status&order=candidate_key`),
    verdicts: await q(`match_verdicts?${o}&select=id,candidate_id&order=id`),
  };
}
async function snapshotTT(W) {
  const o = `organization_id=eq.${W.TT.tt.id}`;
  return {
    role: await q(`org_roles?id=in.(${W.TT.role.id},${W.TT.role2.id})&select=id,title,description,status,scorecard,linked_org_role,target_companies&order=id`),
    pool: await q(`candidates?id=in.(${W.TT.sent.id},${W.TT.unsent.id},${W.TT.second.id})&select=id,full_name,email,contact,notes,follow_up_at&order=id`),
    verdicts: await q(`match_verdicts?${o}&org_role_id=in.(${W.TT.role.id},${W.TT.role2.id})&select=candidate_id,verdict,outcome&order=candidate_id`),
    members: await q(`org_members?${o}&select=user_id,member_role&order=user_id`),
  };
}
function diff(before, after, who) {
  for (const k of Object.keys(before)) {
    const a = JSON.stringify(before[k]);
    const b = JSON.stringify(after[k]);
    if (a !== b) findings.push({ kind: "WRITE LEAK", actor: "(db check)", what: `${who}.${k} changed`, detail: "a cross-company call changed this company's data" });
  }
}

/* ---- the probes ------------------------------------------------------------ */

const ymd = new Date().toISOString().slice(0, 10);

/** Everything a member reads on their own dashboard, scanned for foreign markers. */
async function ownViews(X, C, extra = {}) {
  const g = { group: "own views" };
  const job = extra.jobId || "9001";
  const paths = [
    "/api/dashboard/me",
    "/api/dashboard/org",
    "/api/dashboard/jobs",
    `/api/dashboard/jobs/${job}`,
    `/api/dashboard/jobs/${job}/stages`,
    `/api/dashboard/rolecard/${job}`,
    `/api/dashboard/jobs/${job}/candidates`,
    `/api/dashboard/jobs/${job}/shortlist`,
    "/api/dashboard/candidates",
    "/api/dashboard/candidates/v2?pageSize=100",
    "/api/dashboard/candidates/v2?pageSize=100&past=1",
    `/api/dashboard/candidates/v2?pageSize=100&job=${job}`,
    `/api/dashboard/candidates/v2?pageSize=100&job=${job}&past=1`,
    `/api/dashboard/candidates/v2?pageSize=100&q=zzlk${run.id}`,
    `/api/dashboard/candidates/v2?pageSize=100&q=Applicant`,
    `/api/dashboard/candidates/v2?pageSize=100&q=Shared`,
    `/api/dashboard/candidates/v2?pageSize=100&q=Sent`,
    "/api/dashboard/tasks",
    "/api/dashboard/lists",
    "/api/dashboard/email/templates",
    "/api/dashboard/email/templates/buttons",
    "/api/dashboard/email/account",
    `/api/dashboard/inbox?scope=me&today=${ymd}`,
    `/api/dashboard/inbox?scope=team&today=${ymd}`,
    `/api/dashboard/inbox?count=1&scope=team&today=${ymd}`,
    `/api/dashboard/home?scope=me&period=week&today=${ymd}`,
    `/api/dashboard/home?scope=team&period=month&today=${ymd}`,
    "/api/dashboard/home/goals",
    "/api/dashboard/credits",
    "/api/dashboard/team",
    "/api/dashboard/my-page",
    "/api/dashboard/company-page",
    `/api/dashboard/sourcing/runs?jobId=${job}`,
    "/api/dashboard/eval/verdicts",
    "/api/dashboard/companies?slugs=google",
  ];
  for (const p of paths) await call(X, "GET", p, undefined, g);
  for (const key of extra.keys || []) {
    for (const sub of ["", "/timeline", "/contact", "/followup", "/no-reply", "/resume", "/status"])
      await call(X, "GET", `/api/dashboard/candidates/v2/${key}${sub}`, undefined, g);
    await call(X, "GET", `/api/dashboard/email/threads?key=${key}`, undefined, g);
    await call(X, "GET", `/api/dashboard/email/threads?key=${key}&summary=1`, undefined, g);
    await call(X, "POST", "/api/dashboard/email/context", { candidateKey: key }, g);
  }
  if (C) {
    await call(X, "GET", `/api/dashboard/lists/${C.list.id}`, undefined, g);
    await call(X, "GET", `/api/dashboard/lists/${C.list.id}/members`, undefined, g);
    await call(X, "GET", `/api/dashboard/email/templates/${C.tpl.id}`, undefined, g);
    await call(X, "GET", `/api/dashboard/sourcing/runs/${C.run.id}`, undefined, g);
    await call(X, "GET", `/api/dashboard/sourcing/runs/${C.run.id}/candidates`, undefined, g);
  }
}

/** X opens and edits Y's records by id. Every one of these must be refused. */
async function crossRecords(X, Y, xTok) {
  const g = { group: `${X.name} -> ${Y.name} records`, deny: true };
  for (const key of [Y.appKey, Y.sharedKey, Y.ownKey, Y.sentKey].filter(Boolean)) {
    for (const sub of ["", "/timeline", "/contact", "/followup", "/no-reply", "/resume", "/status"])
      await call(X, "GET", `/api/dashboard/candidates/v2/${key}${sub}`, undefined, g);
    await call(X, "GET", `/api/dashboard/email/threads?key=${key}`, undefined, g);
    await call(X, "GET", `/api/dashboard/email/threads?key=${key}&summary=1`, undefined, g);
    await call(X, "POST", "/api/dashboard/email/context", { candidateKey: key }, g);
    await call(X, "PUT", `/api/dashboard/candidates/v2/${key}/contact`, { email: `${xTok}-hijack@example.com`, phone: null, github: null, otherEmails: [] }, g);
    await call(X, "PUT", `/api/dashboard/candidates/v2/${key}/status`, { jobId: "9001", status: "rejected" }, g);
    await call(X, "POST", `/api/dashboard/candidates/v2/${key}/timeline`, { kind: "note", body: `${xTok}-plantednote` }, g);
    await call(X, "POST", `/api/dashboard/candidates/v2/${key}/followup`, {}, g);
    await call(X, "PATCH", `/api/dashboard/candidates/v2/${key}/followup`, { at: ymd, dateOnly: true }, g);
    await call(X, "POST", `/api/dashboard/candidates/v2/${key}/no-reply`, { jobId: "9001" }, g);
    await call(X, "DELETE", `/api/dashboard/candidates/v2/${key}/no-reply`, undefined, g);
  }
  if (Y.task) {
    await call(X, "PATCH", `/api/dashboard/tasks/${Y.task.id}`, { title: `${xTok}-hijacktask`, status: "done" }, g);
    await call(X, "DELETE", `/api/dashboard/tasks/${Y.task.id}`, undefined, g);
  }
  if (Y.note) {
    await call(X, "PATCH", `/api/dashboard/notes/${Y.note.id}`, { body: `${xTok}-hijacknote` }, g);
    await call(X, "DELETE", `/api/dashboard/notes/${Y.note.id}`, undefined, g);
  }
  if (Y.list) {
    await call(X, "GET", `/api/dashboard/lists/${Y.list.id}`, undefined, g);
    await call(X, "GET", `/api/dashboard/lists/${Y.list.id}/members`, undefined, g);
    await call(X, "PATCH", `/api/dashboard/lists/${Y.list.id}`, { name: `${xTok}-hijacklist` }, g);
    await call(X, "POST", `/api/dashboard/lists/${Y.list.id}/members`, { keys: [X.appKey].filter(Boolean) }, g);
    await call(X, "DELETE", `/api/dashboard/lists/${Y.list.id}/members`, { keys: [Y.appKey] }, g);
    await call(X, "DELETE", `/api/dashboard/lists/${Y.list.id}`, undefined, g);
  }
  if (Y.tpl) {
    await call(X, "GET", `/api/dashboard/email/templates/${Y.tpl.id}`, undefined, g);
    await call(X, "PATCH", `/api/dashboard/email/templates/${Y.tpl.id}`, { name: `${xTok}-hijacktpl`, subject: "x", bodyHtml: "x" }, g);
    await call(X, "DELETE", `/api/dashboard/email/templates/${Y.tpl.id}`, undefined, g);
  }
  if (Y.run) {
    await call(X, "GET", `/api/dashboard/sourcing/runs/${Y.run.id}`, undefined, g);
    await call(X, "GET", `/api/dashboard/sourcing/runs/${Y.run.id}/candidates`, undefined, g);
    await call(X, "GET", `/api/dashboard/sourcing/runs/${Y.run.id}/call-hint`, undefined, g);
    await call(X, "PATCH", `/api/dashboard/sourcing/runs/${Y.run.id}/candidates`, { membershipId: Y.runCands[0].id, hidden: true, shortlisted: true }, g);
    await call(X, "POST", `/api/dashboard/sourcing/runs/${Y.run.id}/advance`, {}, g);
    await call(X, "POST", `/api/dashboard/sourcing/runs/${Y.run.id}/rereview`, {}, g);
  }
  // Y's job by number: the same number exists in X's company for the two
  // clients, so these must answer with X's own job (or 404), never Y's.
  if (Y.jobId && Y.jobId !== "9001") {
    const jg = { group: g.group, deny: true };
    await call(X, "GET", `/api/dashboard/jobs/${Y.jobId}`, undefined, jg);
    await call(X, "GET", `/api/dashboard/jobs/${Y.jobId}/stages`, undefined, jg);
    await call(X, "GET", `/api/dashboard/rolecard/${Y.jobId}`, undefined, jg);
    await call(X, "GET", `/api/dashboard/jobs/${Y.jobId}/candidates`, undefined, jg);
    await call(X, "GET", `/api/dashboard/candidates/v2?pageSize=100&job=${Y.jobId}`, undefined, jg);
    await call(X, "GET", `/api/dashboard/sourcing/runs?jobId=${Y.jobId}`, undefined, jg);
    await call(X, "PATCH", `/api/dashboard/jobs/${Y.jobId}`, { title: `${xTok}-hijackjob` }, jg);
    await call(X, "PUT", `/api/dashboard/jobs/${Y.jobId}/stages`, { stages: null }, jg);
  }
}

/**
 * X files Y's candidate keys into X's own containers (list, task, attachment,
 * tracked link, inbox), then re-reads its own views: Y's data must not come
 * back through X's containers.
 */
async function smuggle(X, C, Y, xTok) {
  const g = { group: `${X.name} files ${Y.name}'s people` };
  const keys = [Y.appKey, Y.sharedKey, Y.ownKey, Y.sentKey].filter(Boolean);
  if (C?.list) await call(X, "POST", `/api/dashboard/lists/${C.list.id}/members`, { keys }, g);
  await call(X, "POST", "/api/dashboard/lists/shortlist/members", { keys }, g);
  await call(X, "POST", "/api/dashboard/attachments", { keys, jobId: X.jobId || "9001" }, g);
  await call(X, "POST", "/api/dashboard/tracked-links", { keys }, g);
  for (const key of keys) {
    await call(X, "POST", "/api/dashboard/tasks", { candidateKey: key, candidateName: "", kind: "task", title: `${xTok}-smuggletask`, dueDate: ymd }, g);
    await call(X, "POST", "/api/dashboard/inbox/mark", { id: `${xTok}-smuggle-${key.slice(0, 12)}`, candidateKey: key, seen: true }, g);
  }
}

async function publicPages(W) {
  const pub = (allow) => ({ name: "public", token: null, allowed: new Set(allow) });
  const g = { group: "public pages" };
  await call(pub(["c"]), "GET", `/board/${W.A.slug}`, undefined, g);
  await call(pub(["d", "u"]), "GET", `/board/${W.B.slug}`, undefined, g);
  await call(pub([]), "GET", "/board/transformer-talent", undefined, g);
  await call(pub([]), "GET", `/r/${W.A.profile.slug}`, undefined, g); // unpublished: must not render
  await call(pub([]), "GET", "/roles", undefined, g);
  await call(pub([]), "GET", "/", undefined, g);
  await call(pub([]), "GET", `/l/${W.A.link.token}`, undefined, g);
  // Every dashboard endpoint refuses a caller with no login.
  for (const p of ["/api/dashboard/jobs", "/api/dashboard/candidates/v2", `/api/dashboard/candidates/v2/${W.A.appKey}`, "/api/dashboard/network", "/api/dashboard/client-orgs", "/api/dashboard/team"])
    await call(pub([]), "GET", p, undefined, { group: "no login", deny: true });
}

/* ---- main ------------------------------------------------------------------ */

let W = null;
const started = Date.now();
try {
  console.log(`run ${run.id} against ${BASE}`);
  W = await setup(run);
  const { A, B, TT } = W;
  for (const [n, id] of [
    ["A org", A.org.id], ["B org", B.org.id], ["TT org", TT.tt.id],
    ["A applicant", A.app.id], ["B applicant", B.app.id],
    ["A shared sourced", A.sharedSrc.id], ["B shared sourced", B.sharedSrc.id],
    ["A own sourced", A.ownSrc.id], ["B own sourced", B.ownSrc.id],
    ["A task", A.task.id], ["B task", B.task.id], ["A note", A.note.id], ["B note", B.note.id],
    ["A list", A.list.id], ["B list", B.list.id], ["A template", A.tpl.id], ["B template", B.tpl.id],
    ["A run", A.run.id], ["B run", B.run.id], ["pool: sent", TT.sent.id], ["pool: unsent", TT.unsent.id], ["pool: sent to B", TT.second.id],
  ])
    labels.set(id, n);

  const actor = (name, login, allow, extra) => ({ name, token: login.token, allowed: new Set(allow), ...extra });
  const XA = actor("A", A.login, ["a", "c", "p", "s"], { appKey: A.appKey, sharedKey: A.sharedKey, ownKey: A.ownKey, jobId: "9001", task: A.task, note: A.note, list: A.list, tpl: A.tpl, run: A.run, runCands: A.runCands });
  const XB = actor("B", B.login, ["b", "d", "p", "r", "u"], { appKey: B.appKey, sharedKey: B.sharedKey, ownKey: B.ownKey, jobId: "9001", task: B.task, note: B.note, list: B.list, tpl: B.tpl, run: B.run, runCands: B.runCands });
  const XT = actor("TT", TT.login, ["t", "s", "r", "c", "d"], { jobId: run.ttJob, netKeys: [`net_${TT.sent.id}`, `net_${TT.unsent.id}`, `net_${TT.second.id}`] });

  // 1. The one allowed bridge: TT sends its pool person to A's linked job.
  const sendDeny = { group: "send bridge", deny: true };
  await call(XA, "POST", "/api/dashboard/network/send", { candidateId: TT.sent.id, jobId: "9001" }, sendDeny);
  await call(XB, "POST", "/api/dashboard/network/send", { candidateId: TT.sent.id, jobId: "9001" }, sendDeny);
  const sent = await call(XT, "POST", "/api/dashboard/network/send", { candidateId: TT.sent.id, jobId: run.ttJob }, { group: "send bridge" });
  if (sent.status !== 200 || !sent.json?.applicationId) {
    findings.push({ kind: "SETUP", actor: "TT", what: "network send", detail: `send failed (${sent.status}); send-bridge checks are incomplete` });
  } else {
    XA.sentKey = `app_${sent.json.applicationId}`;
    W.sentKey = XA.sentKey;
    labels.set(sent.json.applicationId, "A's copy of the sent person");
    // A works the person it received: private note + stage.
    await call(XA, "POST", `/api/dashboard/candidates/v2/${XA.sentKey}/timeline`, { kind: "note", body: `${run.tokens.a}-sentnote` }, { group: "setup" });
    await call(XA, "PUT", `/api/dashboard/candidates/v2/${XA.sentKey}/status`, { jobId: "9001", status: "interviewing" }, { group: "setup" });
  }
  // A second send, to B, of someone TT judged with a report card only.
  const sent2 = await call(XT, "POST", "/api/dashboard/network/send", { candidateId: TT.second.id, jobId: run.ttJob2 }, { group: "send bridge" });
  if (sent2.status !== 200 || !sent2.json?.applicationId) {
    findings.push({ kind: "SETUP", actor: "TT", what: "network send to B", detail: `send failed (${sent2.status})` });
  } else {
    XB.sentKey = `app_${sent2.json.applicationId}`;
    W.sentKeyB = XB.sentKey;
    labels.set(sent2.json.applicationId, "B's copy of the person sent to B");
  }
  // A sent person arrives with the client-safe tag and reason, not "Screening…".
  for (const [X, key] of [[XA, XA.sentKey], [XB, XB.sentKey]]) {
    if (!key) continue;
    const d = await call(X, "GET", `/api/dashboard/candidates/v2/${key}`, undefined, { group: "send bridge" });
    const first = d.json?.pipeline?.[0];
    if (!first?.tag || !first?.reason)
      findings.push({ kind: "BROKEN", actor: X.name, what: `the person TT sent to ${X.name}`, detail: "arrived without a tag and reason" });
    if (first?.verdict)
      findings.push({ kind: "READ LEAK", actor: X.name, what: `the person TT sent to ${X.name}`, detail: "a report card came across with them" });
  }

  const ownA = [XA.appKey, XA.sharedKey, XA.ownKey, XA.sentKey].filter(Boolean);
  const ownB = [XB.appKey, XB.sharedKey, XB.ownKey, XB.sentKey].filter(Boolean);

  // 2. Each company's own views carry only what it may see. (Reading can
  // mint a company's own tracked links, so the snapshot comes after this.)
  await ownViews(XA, A, { keys: ownA });
  await ownViews(XB, B, { keys: ownB });
  await ownViews(XT, null, { jobId: run.ttJob, keys: XT.netKeys });
  await call(XT, "GET", "/api/dashboard/network", undefined, { group: "TT views" });
  await call(XT, "GET", `/api/dashboard/network?job=${run.ttJob}`, undefined, { group: "TT views" });
  await call(XT, "GET", "/api/dashboard/client-orgs", undefined, { group: "TT views" });
  await call(XT, "GET", "/api/dashboard/client-requests", undefined, { group: "TT views" });

  const before = { A: await snapshotClient(A, ownA), B: await snapshotClient(B, ownB), TT: await snapshotTT(W) };

  // 3. A works the person it received: clearing its own follow-up must not
  // reach TT's record of that person (the TT snapshot watches follow_up_at).
  if (XA.sentKey) await call(XA, "POST", `/api/dashboard/candidates/v2/${XA.sentKey}/followup`, {}, { group: "client work on a sent person" });

  // 4. TT-only endpoints refuse clients.
  for (const X of [XA, XB]) {
    const d = { group: "TT-only endpoints", deny: true };
    await call(X, "GET", "/api/dashboard/network", undefined, d);
    await call(X, "GET", `/api/dashboard/network?job=${run.ttJob}`, undefined, d);
    await call(X, "GET", "/api/dashboard/client-orgs", undefined, d);
    await call(X, "GET", "/api/dashboard/client-requests", undefined, d);
    await call(X, "POST", "/api/dashboard/client-requests", { orgId: A.org.id, jobId: "9001" }, d);
    // The verdict comparison tool is TT's own calibration page, and the
    // shortlist is TT's pool.
    await call(X, "GET", "/api/dashboard/jobs/9001/shortlist", undefined, d);
    await call(X, "POST", "/api/dashboard/eval/verdicts", { action: "build" }, d);
    await call(X, "GET", "/api/dashboard/eval/verdicts", undefined, d);
    for (const k of XT.netKeys) {
      await call(X, "GET", `/api/dashboard/candidates/v2/${k}`, undefined, d);
      await call(X, "PUT", `/api/dashboard/candidates/v2/${k}/contact`, { email: `${X === XA ? run.tokens.a : run.tokens.b}-hijack@example.com` }, d);
    }
  }

  // TT may link and copy only jobs whose company asked for help: B's 9002 never did.
  {
    const g = { group: "TT -> unrequested client job", deny: true };
    await call(XT, "PATCH", `/api/dashboard/jobs/${run.ttJob2}`, { linkedOrgRole: { orgId: B.org.id, jobId: "9002" } }, g);
    await call(XT, "POST", "/api/dashboard/client-requests", { orgId: B.org.id, jobId: "9002" }, g);
    const copies = await q(`org_roles?organization_id=eq.${TT.tt.id}&title=like.*${run.tokens.u}*&select=id`);
    if (copies?.length) findings.push({ kind: "WRITE LEAK", actor: "TT", what: "copy of B's unrequested job", detail: "TT copied a job B never asked for help with" });
  }

  // A job's lead emails: its own teammates only, listed and chosen.
  for (const [X, C, Y] of [[XA, A, B], [XB, B, A]]) {
    const j = await call(X, "GET", "/api/dashboard/jobs/9001", undefined, { group: "lead emails" });
    const team = (j.json?.job?.leadEmails?.team || []).map((t) => t.email);
    if (team.some((e) => e !== C.login.email))
      findings.push({ kind: "READ LEAK", actor: X.name, what: "job lead-email teammates", detail: "listed someone outside the company" });
    await call(X, "PATCH", "/api/dashboard/jobs/9001", { notifyUserIds: [Y.login.userId] }, { group: "lead emails", deny: true });
  }

  // TT has no job 9001: asking for it must not return a client's job 9001.
  for (const p of ["/api/dashboard/jobs/9001", "/api/dashboard/jobs/9001/stages", "/api/dashboard/rolecard/9001", "/api/dashboard/jobs/9001/candidates", "/api/dashboard/candidates/v2?pageSize=100&job=9001", "/api/dashboard/sourcing/runs?jobId=9001"])
    await call(XT, "GET", p, undefined, { group: "TT -> client job numbers", deny: true });
  await call(XT, "PUT", "/api/dashboard/jobs/9001/stages", { stages: null }, { group: "TT -> client job numbers", deny: true });

  // 5. Records opened and edited across companies.
  await crossRecords(XA, XB, run.tokens.a);
  await crossRecords(XB, XA, run.tokens.b);
  await crossRecords(XT, XA, run.tokens.t);
  await crossRecords(XT, XB, run.tokens.t);
  await crossRecords(XA, XT, run.tokens.a);
  await crossRecords(XB, XT, run.tokens.b);

  // 6. Other companies' people filed into one's own containers.
  await smuggle(XA, A, XB, run.tokens.a);
  await smuggle(XB, B, XA, run.tokens.b);
  await smuggle(XT, null, XA, run.tokens.t);

  // Optional: an admin of A invites B's login (sends a real invite email
  // when the invite is wrongly accepted, so it is off unless asked for).
  if (flag("--probe-invite")) {
    await call(XA, "POST", "/api/dashboard/team/invite", { email: B.login.email }, { group: "team invite", deny: true });
    const rows = await q(`org_members?organization_id=eq.${A.org.id}&user_id=eq.${B.login.userId}&select=id`);
    if (rows?.length) findings.push({ kind: "WRITE LEAK", actor: "A", what: "team invite of B's login", detail: "B's login now also belongs to A" });
  }

  // 7. Nothing a cross-company call did changed another company's data.
  const after = { A: await snapshotClient(A, ownA), B: await snapshotClient(B, ownB), TT: await snapshotTT(W) };
  diff(before.A, after.A, "A");
  diff(before.B, after.B, "B");
  diff(before.TT, after.TT, "TT");

  // 8. Re-read everything: what step 6 filed must not bring foreign data back.
  await ownViews(XA, A, { keys: ownA });
  await ownViews(XB, B, { keys: ownB });
  await ownViews(XT, null, { jobId: run.ttJob, keys: XT.netKeys });

  // 9. Public pages and logged-out calls.
  await publicPages(W);

  // 10. Positive controls: a run that saw nothing proves nothing.
  const expect = { A: ["a", "c", "p", "s"], B: ["b", "d", "p", "r", "u"], TT: ["t", "s", "r"] };
  for (const [who, classes] of Object.entries(expect)) {
    const seen = seenBy.get(who) || new Set();
    const missing = classes.filter((c) => !seen.has(c));
    if (missing.length) findings.push({ kind: "BLIND", actor: who, what: `${who} own data`, detail: `never saw its own marker class(es) ${missing.join(", ")}: the probes may not be reading data` });
  }
} catch (e) {
  findings.push({ kind: "CRASH", actor: "-", what: "test run", detail: e.message });
} finally {
  if (!flag("--keep")) {
    const td = await teardown({ runId: run.id, keys: collectKeys(W) });
    const left = await leftovers(run.id);
    console.log(`cleanup: ${JSON.stringify(td)}${left.length ? ` LEFTOVERS: ${left.join("; ")}` : " (nothing left)"}`);
  } else {
    console.log(`--keep: data left in place; remove with: node scripts/test-tenancy.mjs --cleanup`);
  }
}

function collectKeys(W) {
  if (!W) return [];
  const k = [W.A?.appKey, W.B?.appKey, W.A?.sharedKey, W.B?.sharedKey, W.A?.ownKey, W.B?.ownKey, W.sentKey, W.sentKeyB];
  if (W.TT) k.push(`net_${W.TT.sent.id}`, `net_${W.TT.unsent.id}`, `net_${W.TT.second.id}`);
  return k.filter(Boolean);
}

/* ---- report ------------------------------------------------------------------ */

const byGroup = new Map();
for (const c of calls) byGroup.set(c.group, (byGroup.get(c.group) || 0) + 1);
console.log(`\n${calls.length} calls in ${Math.round((Date.now() - started) / 1000)}s: ${[...byGroup].map(([g, n]) => `${g || "other"} ${n}`).join(" · ")}`);
const order = ["CRASH", "SETUP", "BLIND", "BROKEN", "WRITE LEAK", "READ LEAK", "NOT REFUSED", "ERROR"];
findings.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
if (!findings.length) {
  console.log("PASS: no cross-organization reads or writes found.");
} else {
  console.log(`\n${findings.length} finding(s):`);
  for (const f of findings) console.log(`${f.kind.padEnd(11)} ${f.what}  ->  ${f.detail}`);
}
// NOT REFUSED and ERROR are reported for follow-up; leaks and crashes fail the run.
process.exit(findings.some((f) => !["NOT REFUSED", "ERROR"].includes(f.kind)) ? 1 : 0);
