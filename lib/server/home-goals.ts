// Home: the Goals card (this week against targets, per seat) and the Needs
// attention card (the exceptions the Jobs table can't show). Both are
// derived from what the app already records; home-metrics.ts fetches the
// rows once and hands them here. Anyone the Inbox already owns — an open
// task or reminder, an open check-back, a live no-reply mark — is left out,
// and a person with a follow-up due soon is listed there and nowhere else.
import { sbRest } from "./supabase";
import type { InboxItem } from "./inbox";
import {
  GOAL_KEYS, RULE_KEYS, paceFraction, weekStart, workingDaysLeft,
  type AttentionRules, type GoalKey, type RuleKey, type Targets,
} from "@/lib/goals";

const DAY = 86400_000;
const SITE = "https://www.transformertalent.com";
const CHUNK = 100;

export type GoalsData = {
  weekStart: string;
  pace: number;
  daysLeft: number;
  rows: { key: GoalKey; n: number; target: number; split: { name: string; n: number }[] | null }[];
  targets: { mine: Targets | null; defaults: Targets };
  seats: number;
};

export type AttentionRow = {
  id: string;
  kind: RuleKey;
  candidateKey: string | null;
  name: string;
  jobId: string | null;
  jobTitle: string | null;
  /** Days the row has been waiting (or, for follow-ups, days until due). */
  days: number;
  hot: boolean;
  ladder: string | null;
  threadId: string | null;
  subject: string | null;
  /** Inbox item id, for reply rows. */
  inboxId: string | null;
  /** Roles: public link and whether Close role is possible here. */
  url: string | null;
  closable: boolean;
  dueDay: string | null;
};

export type AttentionData = {
  rules: AttentionRules;
  groups: { key: RuleKey; total: number; rows: AttentionRow[] }[];
};

type Member = { user_id: string; email: string; member_role: string };
type LogRow = { direction: "out" | "in"; member_email: string; candidate_key: string; thread_id: string; subject?: string; created_at: string };
type TaskRow = { kind: string; candidate_key: string | null; created_by_email: string; completed_at?: string | null; status?: string };
type MoveRow = { to_status: string; from_status: string | null; moved_by_email: string | null; created_at: string };
type RoleRow = { id: string; external_id: string; title: string; status: string; updated_at: string; source: string | null };
type StatusRow = { job_id: string; candidate_key: string; status: string; updated_at: string };
type AppRow = { id: string; name: string | null; created_at: string; role_ids: string[] | null; follow_up_at: string | null; recruiter_profile_id: string | null };
type RunRow = { finished_at: string | null; imported_count: number | null; org_role_id: string | null };

const authorName = (email: string) => {
  const local = email.split("@")[0] || "Teammate";
  return local.charAt(0).toUpperCase() + local.slice(1);
};
const inList = (ids: string[]) => ids.map((s) => `"${s.replace(/"/g, "")}"`).join(",");
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const daysSince = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / DAY));
const roleSlugFor = (title: string, jobId: string) =>
  `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)}-${jobId}`;

/** Display names for candidate keys, org-scoped, in 100-id chunks. */
export async function namesFor(orgId: string, keys: Iterable<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const all = [...new Set(keys)];
  const appIds = all.filter((k) => k.startsWith("app_")).map((k) => k.slice(4));
  const srcIds = all.filter((k) => k.startsWith("src_")).map((k) => k.slice(4));
  for (let i = 0; i < appIds.length; i += CHUNK) {
    const res = await sbRest(`website_applications?organization_id=eq.${orgId}&id=in.(${inList(appIds.slice(i, i + CHUNK))})&select=id,name`);
    for (const r of res.ok ? ((await res.json()) as { id: string; name: string | null }[]) : []) out.set(`app_${r.id}`, str(r.name) || "Candidate");
  }
  for (let i = 0; i < srcIds.length; i += CHUNK) {
    const res = await sbRest(`sourced_candidates?organization_id=eq.${orgId}&id=in.(${inList(srcIds.slice(i, i + CHUNK))})&select=id,full_name`);
    for (const r of res.ok ? ((await res.json()) as { id: string; full_name: string | null }[]) : []) out.set(`src_${r.id}`, str(r.full_name) || "Candidate");
  }
  return out;
}

// ---- goals -------------------------------------------------------------------
export function computeGoals(args: {
  today: string;
  weekStartIso: string;
  scope: "me" | "team";
  viewer: string;
  isOwner: boolean;
  members: Member[];
  logs: LogRow[];
  done: TaskRow[];
  moves: MoveRow[];
  targets: { defaults: Targets; bySeat: Map<string, Targets> };
}): GoalsData {
  const { today, weekStartIso, scope, viewer, members, targets } = args;
  const thisWeek = (iso: string | null | undefined) => Boolean(iso) && iso! >= weekStartIso;
  const counts = new Map<string, Targets>();
  const bump = (email: string | null, k: GoalKey) => {
    const who = email || "";
    const c = counts.get(who) || { emails: 0, calls: 0, interviewing: 0, placements: 0 };
    c[k] += 1;
    counts.set(who, c);
  };
  for (const l of args.logs) if (l.direction === "out" && thisWeek(l.created_at)) bump(l.member_email, "emails");
  for (const t of args.done) if (t.kind === "call" && thisWeek(t.completed_at)) bump(t.created_by_email, "calls");
  for (const m of args.moves) {
    if (!thisWeek(m.created_at)) continue;
    if (m.to_status === "interviewing" && m.from_status !== "interviewing") bump(m.moved_by_email, "interviewing");
    if (m.to_status === "hired" && m.from_status !== "hired") bump(m.moved_by_email, "placements");
  }

  const seatTargets = (email: string) => targets.bySeat.get(email) || targets.defaults;
  const seats = members.filter((m) => m.email);
  const rows = GOAL_KEYS.map((key) => {
    if (scope === "me") {
      return { key, n: counts.get(viewer)?.[key] || 0, target: seatTargets(viewer)[key], split: null };
    }
    // Team: every seat plus anything unattributed (older moves, other mailboxes).
    let n = 0;
    const split: { name: string; n: number }[] = [];
    for (const [who, c] of counts) {
      n += c[key];
      if (!c[key]) continue;
      const seat = seats.find((m) => m.email === who);
      split.push({ name: seat ? authorName(seat.email) : "Other", n: c[key] });
    }
    split.sort((a, b) => b.n - a.n);
    const target = seats.reduce((sum, m) => sum + seatTargets(m.email)[key], 0);
    return { key, n, target, split: args.isOwner ? split : null };
  });

  return {
    weekStart: weekStart(today),
    pace: paceFraction(today),
    daysLeft: workingDaysLeft(today),
    rows,
    targets: { mine: targets.bySeat.get(viewer) || null, defaults: targets.defaults },
    seats: seats.length,
  };
}

// ---- needs attention ------------------------------------------------------
export async function computeAttention(args: {
  orgId: string;
  orgSlug: string;
  today: string;
  now: number;
  scope: "me" | "team";
  viewer: string;
  isOwner: boolean;
  rules: AttentionRules;
  snoozed: Set<string>;
  /** Candidate keys the Inbox owns: any open task or reminder, live no-reply mark. */
  hidden: Set<string>;
  inboxItems: InboxItem[];
  roles: RoleRow[];
  statuses: StatusRow[];
  apps: AppRow[];
  logs: LogRow[];
  done: TaskRow[];
  notes: { candidate_key: string; created_at: string }[];
  runs: RunRow[];
  /** Threads the viewer may open: org visibility "team", or their own mailbox. */
  canSeeLog: (l: LogRow) => boolean;
  mineApp: (a: AppRow) => boolean;
}): Promise<AttentionData> {
  const { rules, now, today, scope, snoozed, hidden } = args;
  const CAP = 8;
  const openRoles = new Map(args.roles.filter((r) => r.status === "open").map((r) => [r.external_id, r]));
  const groups: AttentionData["groups"] = [];
  const nameNeeded = new Set<string>();

  // Per-candidate activity: latest email either way, latest outbound, latest
  // inbound, latest task done, latest note; and the newest thread the viewer
  // can open, for the row's composer.
  const lastAny = new Map<string, string>();
  const lastIn = new Map<string, string>();
  const outs = new Map<string, string[]>();
  const thread = new Map<string, { id: string; subject: string | null; at: string }>();
  for (const l of args.logs) {
    if (!lastAny.has(l.candidate_key) || l.created_at > lastAny.get(l.candidate_key)!) lastAny.set(l.candidate_key, l.created_at);
    if (l.direction === "in" && (!lastIn.has(l.candidate_key) || l.created_at > lastIn.get(l.candidate_key)!)) lastIn.set(l.candidate_key, l.created_at);
    if (l.direction === "out") outs.set(l.candidate_key, [...(outs.get(l.candidate_key) || []), l.created_at]);
    if (l.thread_id && args.canSeeLog(l)) {
      const cur = thread.get(l.candidate_key);
      if (!cur || l.created_at > cur.at) thread.set(l.candidate_key, { id: l.thread_id, subject: (l.subject || "").replace(/^(re|fwd?):\s*/i, "") || null, at: l.created_at });
    }
  }
  for (const list of outs.values()) list.sort();
  for (const t of args.done) {
    if (!t.candidate_key || !t.completed_at) continue;
    if (!lastAny.has(t.candidate_key) || t.completed_at > lastAny.get(t.candidate_key)!) lastAny.set(t.candidate_key, t.completed_at);
  }
  for (const n of args.notes) {
    if (!lastAny.has(n.candidate_key) || n.created_at > lastAny.get(n.candidate_key)!) lastAny.set(n.candidate_key, n.created_at);
  }
  const outboundSince = (key: string, iso: string) => (outs.get(key) || []).filter((t) => t >= iso);
  const ladder = (n: number, verb: string) => (n <= 0 ? null : n === 1 ? `${verb} once` : n === 2 ? `${verb} twice` : `${verb} ${n}×`);

  // ---- follow-ups due soon (not yet due: the Inbox has those) ----------------
  // Built first: a person with a dated plan this close is listed here only.
  const planned = new Set<string>();
  if (rules.fdue.on) {
    const until = new Date(Date.parse(today + "T12:00:00Z") + rules.fdue.days * DAY).toISOString().slice(0, 10);
    const rows: AttentionRow[] = [];
    for (const a of args.apps) {
      if (!a.follow_up_at || a.follow_up_at <= today || a.follow_up_at > until) continue;
      const key = `app_${a.id}`;
      planned.add(key);
      if (scope === "me" && !args.mineApp(a)) continue;
      const id = `fdue:${key}`;
      if (hidden.has(key) || snoozed.has(id)) continue;
      const days = Math.round((Date.parse(a.follow_up_at + "T12:00:00Z") - Date.parse(today + "T12:00:00Z")) / DAY);
      rows.push({
        id, kind: "fdue", candidateKey: key, name: str(a.name) || "Candidate", jobId: null, jobTitle: null,
        days, hot: false, ladder: null, threadId: thread.get(key)?.id || null, subject: thread.get(key)?.subject || null, inboxId: null,
        url: null, closable: false, dueDay: a.follow_up_at,
      });
    }
    rows.sort((a, b) => a.days - b.days);
    groups.push({ key: "fdue", total: rows.length, rows: rows.slice(0, CAP) });
  }
  const skip = (key: string) => hidden.has(key) || planned.has(key);

  // ---- waiting for your reply (the Inbox's mail items, scope already applied)
  if (rules.reply.on) {
    const rows: AttentionRow[] = [];
    for (const it of args.inboxItems) {
      if (it.kind !== "mail" || !it.candidateKey || skip(it.candidateKey)) continue;
      const days = daysSince(it.at, now);
      if (days < rules.reply.days) continue;
      const id = `reply:${it.candidateKey}`;
      if (snoozed.has(id)) continue;
      rows.push({
        id, kind: "reply", candidateKey: it.candidateKey, name: it.candidateName, jobId: it.jobId, jobTitle: null,
        days, hot: days >= rules.reply.days + 2, ladder: null, threadId: it.threadId, subject: it.subject, inboxId: it.id,
        url: null, closable: false, dueDay: null,
      });
    }
    rows.sort((a, b) => b.days - a.days);
    groups.push({ key: "reply", total: rows.length, rows: rows.slice(0, CAP) });
  }

  // ---- stuck in a stage (org-wide: the pipeline belongs to the team) ------
  const stageGroup = (key: "contacted" | "interviewing" | "offer") => {
    if (!rules[key].on) return;
    const rows: AttentionRow[] = [];
    for (const s of args.statuses) {
      if (s.status !== key) continue;
      const role = openRoles.get(s.job_id);
      if (!role || skip(s.candidate_key)) continue;
      const id = `${key}:${s.candidate_key}:${s.job_id}`;
      if (snoozed.has(id)) continue;
      const entered = s.updated_at;
      let days: number;
      let lad: string | null;
      if (key === "contacted") {
        // Nothing back since they were contacted (a reply would have moved
        // them on), counted from the last email sent to them: a nudge
        // restarts the clock, the same way a reply reminder would.
        if ((lastIn.get(s.candidate_key) || "") > entered) continue;
        const sent = outboundSince(s.candidate_key, entered);
        days = daysSince(sent.length ? sent[sent.length - 1] : entered, now);
        lad = ladder(Math.max(0, sent.length - 1), "nudged");
      } else {
        const last = [entered, lastAny.get(s.candidate_key) || ""].sort().pop()!;
        days = daysSince(last, now);
        lad = ladder(outboundSince(s.candidate_key, entered).length, "checked in");
      }
      if (days < rules[key].days) continue;
      nameNeeded.add(s.candidate_key);
      const t = thread.get(s.candidate_key);
      rows.push({
        id, kind: key, candidateKey: s.candidate_key, name: "", jobId: s.job_id, jobTitle: role.title,
        days, hot: days >= rules[key].days + 2, ladder: lad, threadId: t?.id || null, subject: t?.subject || null, inboxId: null,
        url: null, closable: false, dueDay: null,
      });
    }
    rows.sort((a, b) => b.days - a.days);
    groups.push({ key, total: rows.length, rows: rows.slice(0, CAP) });
  };
  stageGroup("contacted");
  stageGroup("interviewing");
  stageGroup("offer");

  // ---- roles with nothing new -------------------------------------------------
  if (rules.role.on) {
    const lastApp = new Map<string, string>();
    for (const a of args.apps) for (const jid of a.role_ids || []) if ((lastApp.get(jid) || "") < a.created_at) lastApp.set(jid, a.created_at);
    const lastImport = new Map<string, string>();
    for (const r of args.runs) {
      if (!r.org_role_id || !r.finished_at || !(r.imported_count || 0)) continue;
      if ((lastImport.get(r.org_role_id) || "") < r.finished_at) lastImport.set(r.org_role_id, r.finished_at);
    }
    const isTT = args.orgSlug === "transformer-talent";
    const rows: AttentionRow[] = [];
    for (const r of openRoles.values()) {
      const id = `role:${r.external_id}`;
      if (snoozed.has(id)) continue;
      const last = [r.updated_at, lastApp.get(r.external_id) || "", lastImport.get(r.id) || ""].sort().pop()!;
      const days = daysSince(last, now);
      if (days < rules.role.days) continue;
      rows.push({
        id, kind: "role", candidateKey: null, name: r.title, jobId: r.external_id, jobTitle: null,
        days, hot: false, ladder: null, threadId: null, subject: null, inboxId: null,
        url: isTT ? `${SITE}/roles/${roleSlugFor(r.title, r.external_id)}` : `${SITE}/board/${args.orgSlug}`,
        closable: r.source === "dashboard", dueDay: null,
      });
    }
    rows.sort((a, b) => b.days - a.days);
    groups.push({ key: "role", total: rows.length, rows: rows.slice(0, CAP) });
  }

  const names = await namesFor(args.orgId, nameNeeded);
  for (const g of groups) for (const r of g.rows) if (!r.name && r.candidateKey) r.name = names.get(r.candidateKey) || "Candidate";

  // Groups in rule order; empty ones still listed so the card can say "none".
  groups.sort((a, b) => RULE_KEYS.indexOf(a.key) - RULE_KEYS.indexOf(b.key));
  return { rules, groups };
}
