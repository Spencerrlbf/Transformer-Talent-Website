// The Inbox: every communication a recruiter owes today, in one list.
//
// Items are DERIVED from what the app already records — nothing here is a
// second copy of the truth:
//   arrivals  website_applications (applied / resume drop / referred / asked)
//   emails    candidate_email_log threads where the candidate spoke last
//   tasks     tasks due today or earlier (email / call / message / other)
//   fdue      website_applications.follow_up_at that has come due
// The only state this module owns is inbox_items: per-seat seen/handled
// marks for arrivals and threads. Tasks complete through the tasks route;
// follow-ups clear through the followup route; a stage move clears an
// application by itself. Those routes call noteXxx() below so the Done view
// can say why something cleared.
//
// Every lookup is scoped to the org, lists are paged rather than capped,
// and long id lists are chunked so no URL can outgrow the gateway.
import { sbRest } from "./supabase";
import { clearFollowUp } from "./candidates-unified";
import { orgEmailVisibility, viewerMailboxEmails } from "./email-compose";
import { getRoles } from "@/lib/roles";
import { daysBetween } from "@/lib/reminders";

export type InboxKind =
  | "mail" | "temail" | "tcall" | "tmsg" | "ttask" | "remind"
  | "app" | "drop" | "ref" | "ask" | "fdue";
export type InboxSection = "emails" | "calls" | "messages" | "new" | "fdue" | "other";
export type InboxScope = "me" | "team";

export type InboxItem = {
  /** Stable key: arr:<appId> | mail:<threadId> | task:<taskId> | fdue:<appId> */
  id: string;
  kind: InboxKind;
  section: InboxSection;
  candidateKey: string | null;
  candidateName: string;
  title: string;
  detail: string;
  /** ISO instant used for ordering (arrival time / due datetime). */
  at: string;
  /** Tasks + follow-ups: the due day/time as stored. */
  dueDate: string | null;
  dueTime: string | null;
  overdue: boolean;
  seen: boolean;
  /** Who this is for (mailbox owner / task creator / page owner); null = unattributed (owners). */
  forEmail: string | null;
  /** Landing hints for the drawer. */
  jobId: string | null;
  threadId: string | null;
  taskId: string | null;
  subject: string | null;
  extra: string | null;
  /** One row per person: the person's other open items ride along here. */
  also?: AlsoItem[];
};

export type AlsoItem = {
  id: string;
  kind: InboxKind;
  title: string;
  taskId: string | null;
  threadId: string | null;
  jobId: string | null;
  overdue: boolean;
};

export type InboxDone = {
  id: string;
  kind: InboxKind | "task";
  title: string;
  candidateKey: string | null;
  candidateName: string;
  reason: string;
  at: string;
  forEmail: string | null;
};

export type InboxData = {
  scope: InboxScope;
  today: string;
  items: InboxItem[];
  upcoming: { day: string; items: InboxItem[] }[];
  done: InboxDone[];
  counts: { today: number; overdue: number; upcoming: number; done: number };
  emailVisibility: "private" | "team";
};

export const SECTION_ORDER: InboxSection[] = ["emails", "calls", "messages", "new", "fdue", "other"];
const SECTION_OF: Record<InboxKind, InboxSection> = {
  mail: "emails", temail: "emails", tcall: "calls", tmsg: "messages", ttask: "other", remind: "emails",
  app: "new", drop: "new", ref: "new", ask: "new", fdue: "fdue",
};
const KIND_TITLE: Record<string, string> = {
  app: "Applied", drop: "Dropped a resume", ref: "Referred", ask: "Asked to hear from you later",
};

const KEY_RE = /^(app|src)_[0-9a-f-]{36}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Subjects mail clients generate on the candidate's behalf. */
const AUTO_REPLY = /^\s*(?:(?:accepted|declined|tentative|tentatively accepted):\s|automatic reply|auto(?:-| )?reply|autoreply|out of (?:the )?office)/i;
const ARRIVAL_WINDOW_DAYS = 45;
const DONE_WINDOW_DAYS = 7;
const PAGE = 1000;
const CHUNK = 100;

type Member = { orgId: string; email: string; userId: string; memberRole: string; orgSlug?: string };

type AppRow = {
  id: string; name: string | null; email: string | null; source: string | null;
  role_ids: string[] | null; role_titles: string[] | null; matched_role_ids: string[] | null;
  created_at: string; follow_up_at: string | null; recruiter_profile_id: string | null;
  status: string | null; resume_path: string | null; location: string | null; visa_status: string | null;
  comp_expectation: string | null; preferred_roles: string[] | null; preferred_workplace: string[] | null;
  preferred_locations: string[] | null; parsed_profile: { current_title?: string | null; current_company?: string | null; location?: string | null } | null;
};
type LogRow = {
  id: string; direction: "out" | "in"; member_email: string; candidate_key: string; subject: string;
  snippet: string; thread_id: string; created_at: string;
};
type TaskRow = {
  id: string; candidate_key: string | null; candidate_name: string; kind: string; title: string;
  due_date: string; due_time: string | null; status: string; created_by_email: string; completed_at: string | null;
  created_at?: string; thread_id?: string | null; ended_reason?: string | null; job_id?: string | null;
};
type StateRow = {
  item_key: string; kind: string | null; label: string | null; candidate_key: string | null;
  seen_at: string | null; handled_at: string | null; handled_by: string | null;
};

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
};
const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
const inList = (ids: string[]) => ids.map((s) => `"${s.replace(/"/g, "")}"`).join(",");
const chunk = <T,>(arr: T[], n = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const monthOf = (iso: string, today: string) => {
  const d = new Date(iso.slice(0, 10) + "T12:00:00");
  const sameYear = iso.slice(0, 4) === today.slice(0, 4);
  return d.toLocaleDateString("en-GB", { month: "long", ...(sameYear ? {} : { year: "numeric" }) });
};
const firstLine = (s: string) => (s || "").split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";

/** PostgREST pages at 1000 rows; walk them so a window is a window. */
async function pageAll<T>(pathFor: (limit: number, offset: number) => string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await sbRest(pathFor(PAGE, offset));
    if (!res.ok) break;
    const batch = (await res.json()) as T[];
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

/** in.() lists in 100-id chunks, results concatenated. */
async function fetchIn<T>(pathFor: (list: string) => string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunk([...new Set(ids)])) {
    const res = await sbRest(pathFor(inList(part)));
    if (res.ok) out.push(...((await res.json()) as T[]));
  }
  return out;
}

/** What kind of arrival an application row is. */
export function arrivalKind(a: { source: string | null; role_ids: string[] | null; follow_up_at: string | null }): "app" | "drop" | "ref" | "ask" {
  const src = a.source || "";
  if (/^referral:/.test(src)) return "ref";
  if (src === "future" || (a.follow_up_at && !(a.role_ids || []).length)) return "ask";
  if ((a.role_ids || []).length) return "app";
  return "drop";
}

export async function listInbox(
  member: Member,
  scope: InboxScope,
  todayIn?: string | null,
  opts: { lean?: boolean } = {}
): Promise<InboxData> {
  const today = todayIn && DATE_RE.test(todayIn) ? todayIn : new Date().toISOString().slice(0, 10);
  const org = member.orgId;
  const viewer = member.email;
  const isOwner = member.memberRole === "owner";
  const lean = Boolean(opts.lean);

  const APP_COLS =
    "id,name,email,source,role_ids,role_titles,matched_role_ids,created_at,follow_up_at,recruiter_profile_id,status," +
    "resume_path,location,visa_status,comp_expectation,preferred_roles,preferred_workplace,preferred_locations,parsed_profile";
  const TASK_COLS = "id,candidate_key,candidate_name,kind,title,due_date,due_time,status,created_by_email,completed_at,created_at,thread_id,ended_reason,job_id";
  const windowIso = ago(ARRIVAL_WINDOW_DAYS);
  const stateIso = ago(ARRIVAL_WINDOW_DAYS + DONE_WINDOW_DAYS);

  const [visibility, aliases, membersRes, profilesRes, rolesRes, apps, dueRows, logs, openTasks, doneTasksRes, stateRows, movedRows] =
    await Promise.all([
      orgEmailVisibility(org),
      viewerMailboxEmails(org, viewer),
      sbRest(`org_members?organization_id=eq.${org}&select=user_id,email,member_role`),
      sbRest(`recruiter_profiles?organization_id=eq.${org}&select=id,user_id`),
      sbRest(`org_roles?organization_id=eq.${org}&select=external_id,title`),
      pageAll<AppRow>((l, o) => `website_applications?organization_id=eq.${org}&created_at=gte.${windowIso}&select=${APP_COLS}&order=created_at.desc&limit=${l}&offset=${o}`),
      pageAll<AppRow>((l, o) => `website_applications?organization_id=eq.${org}&follow_up_at=not.is.null&select=${APP_COLS}&order=follow_up_at.asc&limit=${l}&offset=${o}`),
      pageAll<LogRow>((l, o) => `candidate_email_log?organization_id=eq.${org}&created_at=gte.${windowIso}&select=id,direction,member_email,candidate_key,subject,snippet,thread_id,created_at&order=created_at.desc&limit=${l}&offset=${o}`),
      pageAll<TaskRow>((l, o) => `tasks?organization_id=eq.${org}&status=eq.open&select=${TASK_COLS}&order=due_date.asc,due_time.asc.nullslast,created_at.asc&limit=${l}&offset=${o}`),
      lean
        ? null
        : sbRest(`tasks?organization_id=eq.${org}&status=eq.done&completed_at=gte.${ago(DONE_WINDOW_DAYS)}&select=${TASK_COLS}&order=completed_at.desc&limit=200`),
      // Only marks that can still matter: inside the arrival window (+ the Done week).
      pageAll<StateRow>((l, o) =>
        `inbox_items?organization_id=eq.${org}&member_email=eq.${encodeURIComponent(viewer)}` +
        `&or=(handled_at.gte.${stateIso},seen_at.gte.${stateIso})&select=item_key,kind,label,candidate_key,seen_at,handled_at,handled_by&limit=${l}&offset=${o}`
      ),
      // Every human stage move in the org; intersected in memory (no id list in the URL).
      pageAll<{ candidate_key: string; job_id: string; status: string }>((l, o) =>
        `candidate_role_statuses?organization_id=eq.${org}&status=neq.new&select=candidate_key,job_id,status&limit=${l}&offset=${o}`
      ),
    ]);

  const members = membersRes.ok ? ((await membersRes.json()) as { user_id: string; email: string; member_role: string }[]) : [];
  const profiles = profilesRes.ok ? ((await profilesRes.json()) as { id: string; user_id: string }[]) : [];
  const roles = rolesRes.ok ? ((await rolesRes.json()) as { external_id: string; title: string }[]) : [];
  const doneTasks = doneTasksRes?.ok ? ((await doneTasksRes.json()) as TaskRow[]) : [];
  const state = new Map<string, StateRow>();
  for (const s of stateRows) state.set(s.item_key, s);

  const emailByUser = new Map(members.map((m) => [m.user_id, m.email]));
  const profileOwner = new Map(profiles.map((p) => [p.id, emailByUser.get(p.user_id) || null]));
  const roleTitle = new Map(roles.map((r) => [r.external_id, r.title]));
  if (!lean) {
    // The TT org's own site roles aren't org_roles rows: fill their titles too.
    const wanted = new Set<string>();
    for (const a of [...apps, ...dueRows]) for (const id of [...(a.role_ids || []), ...(a.matched_role_ids || [])]) if (!roleTitle.has(id)) wanted.add(id);
    // Only the TT org's own site roles live outside org_roles.
    if (wanted.size && member.orgSlug === "transformer-talent") {
      const site = await getRoles().catch(() => [] as { jobId: string; title: string }[]);
      for (const r of site) if (wanted.has(r.jobId)) roleTitle.set(r.jobId, r.title);
    }
  }

  // Referral attribution lives on the referrals row, not the application.
  const refIds = apps.filter((a) => /^referral:/.test(a.source || "")).map((a) => a.id);
  const refOwner = new Map<string, string | null>();
  for (const row of await fetchIn<{ application_id: string; recruiter_profile_id: string | null }>(
    (list) => `referrals?organization_id=eq.${org}&application_id=in.(${list})&select=application_id,recruiter_profile_id`,
    refIds
  )) {
    refOwner.set(row.application_id, row.recruiter_profile_id ? profileOwner.get(row.recruiter_profile_id) || null : null);
  }

  // Human stage rows for the arrivals: any move off New clears an application.
  const moved = new Map<string, { jobId: string; status: string }[]>();
  for (const row of movedRows) moved.set(row.candidate_key, [...(moved.get(row.candidate_key) || []), { jobId: row.job_id, status: row.status }]);

  // Outbound emails per candidate — anyone's: org truth for asks, referrals
  // and drops ("someone reached out"). Threads are judged inside the thread.
  const isMine = (owner: string) => aliases.has(owner);
  const lastOutAny = new Map<string, string>();
  const hasThread = new Set<string>();
  for (const l of logs) {
    if (visibility === "team" || isMine(l.member_email)) hasThread.add(l.candidate_key);
    if (l.direction !== "out") continue;
    if (!lastOutAny.has(l.candidate_key)) lastOutAny.set(l.candidate_key, l.created_at);
  }

  const attribution = (a: AppRow): string | null => {
    if (a.recruiter_profile_id) return profileOwner.get(a.recruiter_profile_id) || null;
    if (refOwner.has(a.id)) return refOwner.get(a.id) || null;
    return null;
  };
  const mine = (forEmail: string | null) => (forEmail ? forEmail === viewer : isOwner);
  const titlesOf = (ids: string[] | null) => (ids || []).map((id) => roleTitle.get(id) || `#${id}`);
  const askDetail = (a: AppRow) =>
    [
      (a.preferred_roles || []).join(", "),
      (a.preferred_workplace || []).join(" / "),
      (a.preferred_locations || []).length ? (a.preferred_locations || []).join(", ") : str(a.location),
      str(a.comp_expectation),
      str(a.visa_status) ? `visa: ${a.visa_status}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const headlineOf = (a: AppRow) =>
    [str(a.parsed_profile?.current_title), str(a.parsed_profile?.current_company)].filter(Boolean).join(" @ ");

  const items: InboxItem[] = [];
  const seenOf = (id: string, since?: string) => {
    const s = state.get(id)?.seen_at;
    return Boolean(s && (!since || s >= since));
  };
  const handled = (id: string, since?: string) => {
    const h = state.get(id)?.handled_at;
    return Boolean(h && (!since || h >= since));
  };

  // ---- follow-ups due (and the future ones, for Upcoming) ----------------
  const upcomingFdue: InboxItem[] = [];
  const dueNowIds = new Set<string>();
  for (const a of dueRows) {
    if (!a.follow_up_at) continue;
    const forEmail = attribution(a);
    const due = a.follow_up_at <= today;
    const item: InboxItem = {
      id: `fdue:${a.id}`, kind: "fdue", section: "fdue",
      candidateKey: `app_${a.id}`, candidateName: str(a.name) || "Candidate",
      title: `${due ? "Follow-up due" : "Follow up"} · asked to hear from you in ${monthOf(a.follow_up_at, today)}`,
      detail: askDetail(a) || "Asked to hear from you later",
      at: `${a.follow_up_at}T09:00:00`, dueDate: a.follow_up_at, dueTime: null,
      overdue: a.follow_up_at < today, seen: seenOf(`fdue:${a.id}`), forEmail,
      jobId: null, threadId: null, taskId: null, subject: null, extra: null,
    };
    if (due) {
      dueNowIds.add(a.id);
      if (scope === "team" || mine(forEmail)) items.push(item);
    } else if (!lean) {
      upcomingFdue.push(item);
    }
  }

  // ---- arrivals ----------------------------------------------------------
  for (const a of apps) {
    const kind = arrivalKind(a);
    const id = `arr:${a.id}`;
    if (handled(id)) continue;
    const key = `app_${a.id}`;
    const forEmail = attribution(a);
    if (scope === "me" && !mine(forEmail)) continue;
    const movedRowsFor = moved.get(key) || [];
    const outAfter = (lastOutAny.get(key) || "") > a.created_at;
    if (kind === "app" && movedRowsFor.some((m) => (a.role_ids || []).includes(m.jobId))) continue;
    if ((kind === "drop" || kind === "ref") && (movedRowsFor.length || outAfter)) continue;
    if (kind === "ask" && (!a.follow_up_at || dueNowIds.has(a.id) || outAfter)) continue;

    const base = {
      id, kind, section: "new" as InboxSection, candidateKey: key, candidateName: str(a.name) || "Candidate",
      at: a.created_at, dueDate: null, dueTime: null, overdue: false, seen: seenOf(id), forEmail,
      threadId: null, taskId: null, subject: null,
    };
    if (kind === "app") {
      const titles = (a.role_titles || []).length ? (a.role_titles || []).map((t) => t.replace(/\s*\(#\d+\)\s*$/, "")) : titlesOf(a.role_ids);
      items.push({
        ...base,
        title: `Applied · ${titles[0] || "a role"}`,
        detail: [headlineOf(a), str(a.parsed_profile?.location) || str(a.location), a.resume_path ? "resume attached" : null, a.status === "processing" ? "screening…" : null].filter(Boolean).join(" · "),
        jobId: (a.role_ids || [])[0] || null,
        extra: titles.length > 1 ? `+${titles.length - 1} role${titles.length > 2 ? "s" : ""}` : null,
      });
    } else if (kind === "drop") {
      const titles = titlesOf(a.matched_role_ids);
      items.push({
        ...base,
        title: "Dropped a resume · no role picked",
        detail: [headlineOf(a), str(a.parsed_profile?.location) || str(a.location), titles.length ? `matched to ${titles.join(", ")}` : a.status === "processing" ? "matching…" : "no matches yet"].filter(Boolean).join(" · "),
        jobId: (a.matched_role_ids || [])[0] || null, extra: null,
      });
    } else if (kind === "ref") {
      const m = (a.source || "").match(/^referral: by (.+?) <([^>]+)>/);
      const titles = titlesOf(a.matched_role_ids);
      items.push({
        ...base,
        title: `Referred by ${m ? m[1] : "someone"}`,
        detail: [m ? m[2] : null, headlineOf(a), titles.length ? `matched to ${titles.join(", ")}` : "not matched yet"].filter(Boolean).join(" · "),
        jobId: (a.matched_role_ids || [])[0] || null, extra: null,
      });
    } else {
      items.push({
        ...base,
        title: `Asked to hear from you in ${monthOf(a.follow_up_at!, today)}`,
        detail: askDetail(a) || "Asked to hear from you later",
        jobId: null, extra: null,
      });
    }
  }

  // ---- email threads awaiting a reply -----------------------------------
  const byThread = new Map<string, LogRow[]>();
  for (const l of logs) {
    const tid = l.thread_id || `solo-${l.id}`;
    byThread.set(tid, [...(byThread.get(tid) || []), l]);
  }
  const nameNeeded = new Set<string>();
  const mailItems: { item: InboxItem; key: string }[] = [];
  for (const [tid, list] of byThread) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const last = list[list.length - 1];
    if (last.direction !== "in") continue;
    // Calendar responses and auto-replies are not the candidate waiting on
    // you; they stay in the Email tab but never become an Inbox item.
    if (AUTO_REPLY.test(last.subject || "")) continue;
    const owner = last.member_email;
    if (visibility === "private" && !isMine(owner)) continue;
    if (scope === "me" && !isMine(owner)) continue;
    const id = `mail:${tid}`;
    // Marks are relative to the newest message: a later reply resurfaces the
    // thread. An answer sent while working this item is logged under this
    // thread by the send route, so it shows up here as the last message.
    if (handled(id, last.created_at)) continue;
    const subject = (list[0].subject || "").replace(/^(re|fwd?):\s*/i, "") || "(no subject)";
    nameNeeded.add(last.candidate_key);
    mailItems.push({
      key: last.candidate_key,
      item: {
        id, kind: "mail", section: "emails", candidateKey: last.candidate_key, candidateName: "",
        title: `Replied · ${subject}`,
        detail: firstLine(last.snippet).slice(0, 140),
        at: last.created_at, dueDate: null, dueTime: null, overdue: false, seen: seenOf(id, last.created_at), forEmail: owner,
        jobId: null, threadId: tid, taskId: null, subject, extra: null,
      },
    });
  }

  // Outbound per conversation since the candidate last spoke, for reply
  // reminders: how many unanswered emails are stacked up (the nudge ladder)
  // and when the last one went.
  const outByThread = new Map<string, { n: number; last: string }>();
  for (const l of [...logs].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (!l.thread_id) continue;
    if (l.direction === "in") {
      outByThread.delete(l.thread_id);
      continue;
    }
    const cur = outByThread.get(l.thread_id);
    if (!cur) outByThread.set(l.thread_id, { n: 1, last: l.created_at });
    else {
      cur.n += 1;
      cur.last = l.created_at;
    }
  }

  // ---- tasks --------------------------------------------------------------
  const taskKind = (k: string): InboxKind =>
    k === "email" ? "temail" : k === "call" ? "tcall" : k === "message" ? "tmsg" : k === "reminder" ? "remind" : "ttask";
  const upcomingTasks: InboxItem[] = [];
  for (const t of openTasks) {
    if (scope === "me" && t.created_by_email !== viewer) continue;
    const kind = taskKind(t.kind);
    if (t.candidate_key) nameNeeded.add(t.candidate_key);
    const item: InboxItem = {
      id: `task:${t.id}`, kind, section: SECTION_OF[kind],
      candidateKey: t.candidate_key, candidateName: t.candidate_name || "",
      title: t.title, detail: "",
      at: `${t.due_date}T${t.due_time ? t.due_time.slice(0, 5) : "23:59"}:00`,
      dueDate: t.due_date, dueTime: t.due_time ? t.due_time.slice(0, 5) : null,
      overdue: t.due_date < today, seen: true, forEmail: t.created_by_email,
      jobId: null, threadId: null, taskId: t.id, subject: null, extra: null,
    };
    if (kind === "remind") {
      // "No reply from Ana · 3 days since you emailed · <subject>", with the
      // ladder ("nudged once") from how many emails went out in the thread.
      const out = t.thread_id ? outByThread.get(t.thread_id) : undefined;
      const sentDay = (out?.last || t.created_at || "").slice(0, 10);
      const since = sentDay ? daysBetween(sentDay, today) : null;
      item.title = `No reply from ${t.candidate_name || "them"}`;
      item.detail = [since !== null ? `${since} day${since === 1 ? "" : "s"} since you emailed` : null, t.title].filter(Boolean).join(" · ");
      item.subject = t.title;
      item.threadId = t.thread_id || null;
      item.jobId = t.job_id || null;
      const nudges = Math.max(0, (out?.n || 1) - 1);
      item.extra = nudges === 0 ? null : nudges === 1 ? "nudged once" : nudges === 2 ? "nudged twice" : `nudged ${nudges}×`;
    }
    if (t.due_date <= today) items.push(item);
    else if (!lean) upcomingTasks.push(item);
  }

  // ---- names + contact hints for tasks and threads (org-scoped, chunked) --
  const info = new Map<string, { name: string; phone: string | null; linkedin: string | null }>();
  const loadInfo = async (keys: Iterable<string>, withContact: boolean) => {
    const appIds = [...keys].filter((k) => k.startsWith("app_") && !info.has(k)).map((k) => k.slice(4));
    const srcIds = [...keys].filter((k) => k.startsWith("src_") && !info.has(k)).map((k) => k.slice(4));
    const sel = withContact ? "contact,linkedin_url" : "";
    const [ar, sr] = await Promise.all([
      fetchIn<{ id: string; name: string | null; contact?: { phone?: string | null } | null; linkedin_url?: string | null }>(
        (list) => `website_applications?organization_id=eq.${org}&id=in.(${list})&select=id,name${sel ? "," + sel : ""}`, appIds),
      fetchIn<{ id: string; full_name: string | null; contact?: { phone?: string | null } | null; linkedin_url?: string | null }>(
        (list) => `sourced_candidates?organization_id=eq.${org}&id=in.(${list})&select=id,full_name${sel ? "," + sel : ""}`, srcIds),
    ]);
    for (const r of ar) info.set(`app_${r.id}`, { name: str(r.name) || "Candidate", phone: str(r.contact?.phone), linkedin: str(r.linkedin_url) });
    for (const r of sr) info.set(`src_${r.id}`, { name: str(r.full_name) || "Candidate", phone: str(r.contact?.phone), linkedin: str(r.linkedin_url) });
  };
  // Lean callers (badge, Home strip) still get names — one chunked lookup —
  // but not the contact hints that only the full list decorates rows with.
  await loadInfo(nameNeeded, !lean);

  for (const m of mailItems) {
    m.item.candidateName = info.get(m.key)?.name || "Candidate";
    items.push(m.item);
  }
  const decorateTask = (it: InboxItem) => {
    const i = it.candidateKey ? info.get(it.candidateKey) : null;
    if (i && !it.candidateName) it.candidateName = i.name;
    if (it.kind === "remind") return;
    if (it.kind === "temail") it.detail = it.candidateKey && hasThread.has(it.candidateKey) ? "reply in the open thread" : "no thread yet · opens a new email";
    else if (it.kind === "tcall") it.detail = i?.phone || "no phone on file";
    else if (it.kind === "tmsg") it.detail = i?.linkedin ? i.linkedin.replace(/^https?:\/\/(www\.)?/, "") : "no LinkedIn on file";
    else it.detail = it.candidateKey ? "" : "no candidate · tick when done";
  };
  if (!lean) {
    items.filter((i) => i.taskId).forEach(decorateTask);
    upcomingTasks.forEach(decorateTask);
  }

  // ---- order: section, overdue first, tasks by due time, arrivals newest first
  const secIdx = (s: InboxSection) => SECTION_ORDER.indexOf(s);
  items.sort((a, b) => {
    const s = secIdx(a.section) - secIdx(b.section);
    if (s) return s;
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const aTask = Boolean(a.taskId || a.kind === "fdue");
    const bTask = Boolean(b.taskId || b.kind === "fdue");
    if (aTask && bTask) return a.at.localeCompare(b.at);
    if (aTask !== bTask) return aTask ? -1 : 1;
    return b.at.localeCompare(a.at);
  });

  // ---- one row per person: the most urgent item (section order) leads,
  // the rest ride along as `also`, so one Done clears the lot and the
  // badge counts people. Items with no candidate stay as they are.
  const byPerson = new Map<string, InboxItem>();
  const grouped: InboxItem[] = [];
  for (const it of items) {
    if (!it.candidateKey) {
      grouped.push(it);
      continue;
    }
    const head = byPerson.get(it.candidateKey);
    if (!head) {
      it.also = [];
      byPerson.set(it.candidateKey, it);
      grouped.push(it);
    } else {
      head.also!.push({ id: it.id, kind: it.kind, title: it.title, taskId: it.taskId, threadId: it.threadId, jobId: it.jobId, overdue: it.overdue });
      if (it.overdue) head.overdue = true;
      if (!head.jobId && it.jobId) head.jobId = it.jobId;
    }
  }
  items.splice(0, items.length, ...grouped);

  const counts = { today: items.length, overdue: items.filter((i) => i.overdue).length, upcoming: 0, done: 0 };
  if (lean) return { scope, today, items, upcoming: [], done: [], counts, emailVisibility: visibility };

  // ---- upcoming: dated work later than today, by day ---------------------
  const byDay = new Map<string, InboxItem[]>();
  for (const it of [...upcomingTasks, ...upcomingFdue]) {
    if (scope === "me" && !(it.forEmail ? it.forEmail === viewer : isOwner)) continue;
    const day = it.dueDate!;
    byDay.set(day, [...(byDay.get(day) || []), it]);
  }
  const upcoming = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, list]) => ({ day, items: list.sort((a, b) => a.at.localeCompare(b.at)) }));

  // ---- done: this seat's handled marks + tasks completed this week -------
  const done: InboxDone[] = [];
  const doneSince = ago(DONE_WINDOW_DAYS);
  const doneNames = new Set<string>();
  for (const s of state.values()) if (s.handled_at && s.handled_at >= doneSince && s.candidate_key) doneNames.add(s.candidate_key);
  for (const t of doneTasks) if (t.candidate_key) doneNames.add(t.candidate_key);
  await loadInfo(doneNames, false);

  for (const s of state.values()) {
    if (!s.handled_at || s.handled_at < doneSince) continue;
    done.push({
      id: s.item_key, kind: ((s.kind as InboxKind) || "app"), title: s.label || "",
      candidateKey: s.candidate_key, candidateName: s.candidate_key ? info.get(s.candidate_key)?.name || "Candidate" : "",
      reason: s.handled_by || "done", at: s.handled_at, forEmail: viewer,
    });
  }
  for (const t of doneTasks) {
    if (scope === "me" && t.created_by_email !== viewer) continue;
    const remind = t.kind === "reminder";
    done.push({
      id: `task:${t.id}`, kind: remind ? "remind" : "task",
      title: remind ? `No reply from ${t.candidate_name || "them"} · ${t.title}` : t.title, candidateKey: t.candidate_key,
      candidateName: t.candidate_name || (t.candidate_key ? info.get(t.candidate_key)?.name || "" : ""),
      reason: remind ? `remind:${t.ended_reason || "done"}` : "task_done", at: t.completed_at || "", forEmail: t.created_by_email,
    });
  }
  done.sort((a, b) => b.at.localeCompare(a.at));

  counts.upcoming = upcoming.reduce((n, d) => n + d.items.length, 0);
  counts.done = done.length;
  return { scope, today, items, upcoming, done, counts, emailVisibility: visibility };
}

/** Badge counts only — the same derivation without names, Done or Upcoming. */
export async function inboxCounts(member: Member, scope: InboxScope, today?: string | null): Promise<{ today: number; overdue: number }> {
  const d = await listInbox(member, scope, today, { lean: true });
  return { today: d.counts.today, overdue: d.counts.overdue };
}

// Provider thread ids are opaque (base64-ish, "=" and "/" included).
const ITEM_RE = /^(arr|mail|fdue):\S{1,300}$/;

/** Upsert this seat's mark on an item. handled: reason string to close,
 *  null to reopen, undefined to leave as is. Reopen only undoes a plain
 *  Done — a stage move, a sent email or a reply is history, not a mark. */
export async function markInbox(
  orgId: string,
  viewer: string,
  id: string,
  mark: { seen?: boolean; handled?: string | null; kind?: string; label?: string; candidateKey?: string | null }
): Promise<boolean> {
  if (!ITEM_RE.test(id)) return false;
  const now = new Date().toISOString();
  const row: Record<string, unknown> = { organization_id: orgId, member_email: viewer, item_key: id };
  if (mark.seen) row.seen_at = now;
  if (mark.handled !== undefined) {
    if (mark.handled === null) {
      const res = await sbRest(
        `inbox_items?organization_id=eq.${orgId}&member_email=eq.${encodeURIComponent(viewer)}&item_key=eq.${encodeURIComponent(id)}&handled_by=eq.done`,
        { method: "PATCH", body: JSON.stringify({ handled_at: null, handled_by: null }), prefer: "return=representation" }
      );
      return res.ok && ((await res.json()) as unknown[]).length > 0;
    }
    row.handled_at = now;
    row.handled_by = mark.handled.slice(0, 40);
  }
  if (mark.kind) row.kind = mark.kind;
  if (mark.label !== undefined) row.label = (mark.label || "").slice(0, 300);
  if (mark.candidateKey !== undefined) row.candidate_key = mark.candidateKey;
  const res = await sbRest(`inbox_items?on_conflict=organization_id,member_email,item_key`, {
    method: "POST",
    body: JSON.stringify(row),
    prefer: "resolution=merge-duplicates,return=minimal",
  });
  if (!res.ok) console.error("inbox mark failed", res.status, await res.text().catch(() => ""));
  return res.ok;
}

async function arrivalRow(orgId: string, key: string) {
  const res = await sbRest(
    `website_applications?id=eq.${key.slice(4)}&organization_id=eq.${orgId}&select=id,source,role_ids,follow_up_at,created_at`
  );
  const [a] = res.ok ? ((await res.json()) as { id: string; source: string | null; role_ids: string[] | null; follow_up_at: string | null; created_at: string }[]) : [];
  return a || null;
}

/** Called by the status route: a stage move off New clears the arrival by
 *  derivation; this records the reason for the actor's Done view — only
 *  when the move actually clears it (an applied role, inside the window). */
export async function noteStageMoved(orgId: string, viewer: string, key: string, stageLabel: string, jobId?: string | null): Promise<void> {
  if (!key.startsWith("app_") || !KEY_RE.test(key)) return;
  const a = await arrivalRow(orgId, key);
  if (!a || a.created_at < ago(ARRIVAL_WINDOW_DAYS)) return;
  const kind = arrivalKind(a);
  if (kind === "app" && jobId && !(a.role_ids || []).includes(jobId)) return;
  if (kind === "ask") return;
  await markInbox(orgId, viewer, `arr:${a.id}`, {
    handled: `stage:${stageLabel}`, kind, label: KIND_TITLE[kind], candidateKey: key,
  }).catch(() => {});
}

/** Called by the send route after a successful send: clears asks, drops and
 *  referrals for the sender, records the reply on the thread it answered
 *  (threaded reply, or the Inbox item being worked), and — when the person's
 *  follow-up date has come — counts the email as the follow-up. `today` is
 *  the viewer's local date when the client sent it. */
export async function noteEmailSent(args: {
  orgId: string; viewer: string; key: string; threadId: string | null; subject: string; today?: string | null;
}): Promise<void> {
  const { orgId, viewer, key, threadId, subject } = args;
  if (!KEY_RE.test(key)) return;
  const today = args.today && DATE_RE.test(args.today) ? args.today : new Date().toISOString().slice(0, 10);
  if (threadId) {
    await markInbox(orgId, viewer, `mail:${threadId}`, { handled: "reply", kind: "mail", label: subject, candidateKey: key }).catch(() => {});
  }
  if (!key.startsWith("app_")) return;
  const a = await arrivalRow(orgId, key);
  if (!a) return;
  const kind = arrivalKind(a);
  if (a.follow_up_at && a.follow_up_at <= today) {
    // The follow-up is what this email was: clear the date like Mark contacted.
    await clearFollowUp(orgId, key).catch(() => null);
    await markInbox(orgId, viewer, `fdue:${a.id}`, { handled: "email", kind: "fdue", candidateKey: key, label: subject }).catch(() => {});
  }
  if (kind !== "app") {
    await markInbox(orgId, viewer, `arr:${a.id}`, { handled: "email", kind, candidateKey: key, label: KIND_TITLE[kind] }).catch(() => {});
  }
}

/** Called by the followup route on Mark contacted. */
export async function noteContacted(orgId: string, viewer: string, key: string): Promise<void> {
  if (!key.startsWith("app_") || !KEY_RE.test(key)) return;
  await markInbox(orgId, viewer, `fdue:${key.slice(4)}`, { handled: "contacted", kind: "fdue", candidateKey: key }).catch(() => {});
}
