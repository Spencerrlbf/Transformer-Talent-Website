// Home: the numbers a recruiter sees first. Everything here is counted
// from tables the app already writes — nothing is tracked for the sake of
// the dashboard. Period = this week (7 days) or 30 days, each compared to
// the period before it. Scope "me" uses the same attribution rule as the
// Inbox: my mailbox, my tasks, my page, my links; unattributed arrivals
// belong to owners. Stage moves, sourcing and credits are org-wide.
import { sbRest, sbRpc } from "./supabase";
import { listInbox, type InboxScope } from "./inbox";

export type Period = "week" | "month";
type Member = { orgId: string; email: string; userId: string; memberRole: string; orgSlug?: string };

const STAGES = ["new", "contacted", "replied", "interviewing", "offer", "hired"] as const;
type StageKey = (typeof STAGES)[number];
const STAGE_LABEL: Record<string, string> = {
  new: "New", contacted: "Contacted", replied: "Replied", interviewing: "Interviewing", offer: "Offer", hired: "Hired",
};

export type HomeData = {
  scope: InboxScope;
  period: Period;
  today: string;
  strip: {
    toDo: number;
    overdue: number;
    overdueTitle: string | null;
    awaiting: number;
    awaitingNames: string[];
    followUpsDue: number;
    followUpName: string | null;
  };
  kpis: {
    applications: { n: number; prev: number };
    sent: { n: number; prev: number };
    replies: { n: number; prev: number; rate: number | null };
    tasksDone: { n: number; prev: number };
    moves: { n: number; prev: number; by: Partial<Record<StageKey, number>> };
    credits: { used: number; prev: number; available: number; searches: number };
  };
  roles: {
    id: string;
    title: string;
    company: string | null;
    applicants: number;
    newInPeriod: number;
    pipe: Record<StageKey, number>;
    furthest: { stage: string; n: number } | null;
    updatedDays: number;
  }[];
  funnel: Record<StageKey, number> & { total: number };
  medianReplyMinutes: number | null;
  series: { day: string; sent: number; replies: number; apps: number }[];
  page: {
    views: number; viewsPrev: number; roleOpens: number; appsViaPage: number; bookingClicks: number;
    linksSent: number; linksOpened: number; referrals: number;
  };
  sourcing: {
    available: number; usedPeriod: number; usedPrev: number; imported: number; runsDone: number;
    inProgress: { title: string; status: string }[];
  };
  team: { email: string; sent: number; replies: number; tasksDone: number; overdue: number; appsViaPage: number }[] | null;
};

const DAY = 86400_000;
const PAGE = 1000;
const inList = (ids: string[]) => ids.map((s) => `"${s.replace(/"/g, "")}"`).join(",");
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
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function homeMetrics(member: Member, scope: InboxScope, period: Period, todayIn?: string | null, tzOffsetMin = 0): Promise<HomeData> {
  const today = todayIn && /^\d{4}-\d{2}-\d{2}$/.test(todayIn) ? todayIn : new Date().toISOString().slice(0, 10);
  const org = member.orgId;
  const viewer = member.email;
  const isOwner = member.memberRole === "owner";
  const days = period === "week" ? 7 : 30;
  const now = Date.now();
  const since = now - days * DAY;
  const prevSince = now - 2 * days * DAY;
  const sinceIso = new Date(since).toISOString();
  const prevIso = new Date(prevSince).toISOString();
  const inPeriod = (iso: string | null) => Boolean(iso) && Date.parse(iso!) >= since;
  const inPrev = (iso: string | null) => Boolean(iso) && Date.parse(iso!) >= prevSince && Date.parse(iso!) < since;
  // The viewer's local calendar day for an instant (tzOffsetMin = Date#getTimezoneOffset()).
  const localDay = (iso: string) => new Date(Date.parse(iso) - tzOffsetMin * 60_000).toISOString().slice(0, 10);

  const [
    inbox, membersRes, profilesRes, rolesRes, statuses, apps, logs, done, open, moves,
    links, refs, credit, usage, runsRes,
  ] = await Promise.all([
    listInbox(member, scope, today, { lean: true }),
    sbRest(`org_members?organization_id=eq.${org}&select=user_id,email,member_role`),
    sbRest(`recruiter_profiles?organization_id=eq.${org}&select=id,user_id`),
    sbRest(`org_roles?organization_id=eq.${org}&select=id,external_id,title,company_name,status,updated_at&order=title.asc`),
    pageAll<{ job_id: string; candidate_key: string; status: string }>((l, o) => `candidate_role_statuses?organization_id=eq.${org}&select=job_id,candidate_key,status&order=id.asc&limit=${l}&offset=${o}`),
    pageAll<{ id: string; created_at: string; role_ids: string[] | null; source: string | null; recruiter_profile_id: string | null }>((l, o) => `website_applications?organization_id=eq.${org}&select=id,created_at,role_ids,source,recruiter_profile_id&order=created_at.desc&limit=${l}&offset=${o}`),
    pageAll<{ direction: "out" | "in"; member_email: string; candidate_key: string; thread_id: string; created_at: string }>((l, o) => `candidate_email_log?organization_id=eq.${org}&created_at=gte.${prevIso}&select=direction,member_email,candidate_key,thread_id,created_at&order=created_at.desc&limit=${l}&offset=${o}`),
    pageAll<{ completed_at: string; created_by_email: string }>((l, o) => `tasks?organization_id=eq.${org}&status=eq.done&completed_at=gte.${prevIso}&select=completed_at,created_by_email&order=completed_at.desc&limit=${l}&offset=${o}`),
    pageAll<{ due_date: string; created_by_email: string }>((l, o) => `tasks?organization_id=eq.${org}&status=eq.open&select=due_date,created_by_email&order=due_date.asc&limit=${l}&offset=${o}`),
    pageAll<{ to_status: string; created_at: string }>((l, o) => `stage_events?organization_id=eq.${org}&created_at=gte.${prevIso}&select=to_status,created_at&order=created_at.desc&limit=${l}&offset=${o}`),
    // Only links that could count: minted or opened inside the two periods.
    pageAll<{ created_by: string | null; created_at: string; last_opened_at: string | null; open_count: number }>((l, o) => `tracked_links?organization_id=eq.${org}&or=(created_at.gte.${prevIso},last_opened_at.gte.${prevIso})&select=created_by,created_at,last_opened_at,open_count&order=created_at.desc&limit=${l}&offset=${o}`),
    pageAll<{ recruiter_profile_id: string | null; created_at: string }>((l, o) => `referrals?organization_id=eq.${org}&created_at=gte.${prevIso}&select=recruiter_profile_id,created_at&order=created_at.desc&limit=${l}&offset=${o}`),
    sbRpc<{ available: number }[]>("org_credit_summary", { p_org: org }).catch(() => [] as { available: number }[]),
    pageAll<{ credits: number; created_at: string; run_id: string | null }>((l, o) => `usage_events?organization_id=eq.${org}&credits=gt.0&created_at=gte.${prevIso}&select=credits,created_at,run_id&order=created_at.desc&limit=${l}&offset=${o}`),
    sbRest(`sourcing_runs?organization_id=eq.${org}&select=status,created_at,finished_at,imported_count,org_role_id&order=created_at.desc&limit=200`),
  ]);
  // Thread pairing below walks oldest → newest.
  logs.sort((a, b) => a.created_at.localeCompare(b.created_at));

  const members = membersRes.ok ? ((await membersRes.json()) as { user_id: string; email: string; member_role: string }[]) : [];
  const profiles = profilesRes.ok ? ((await profilesRes.json()) as { id: string; user_id: string }[]) : [];
  const roles = rolesRes.ok ? ((await rolesRes.json()) as { id: string; external_id: string; title: string; company_name: string | null; status: string; updated_at: string }[]) : [];
  const available = Number(credit?.[0]?.available ?? 0);
  const runs = runsRes.ok ? ((await runsRes.json()) as { status: string; created_at: string; finished_at: string | null; imported_count: number | null; org_role_id: string | null }[]) : [];

  const emailByUser = new Map(members.map((m) => [m.user_id, m.email]));
  const profileOwner = new Map(profiles.map((p) => [p.id, emailByUser.get(p.user_id) || null]));
  const myProfiles = new Set(profiles.filter((p) => p.user_id === member.userId).map((p) => p.id));
  const mineApp = (a: { recruiter_profile_id: string | null }) => {
    const owner = a.recruiter_profile_id ? profileOwner.get(a.recruiter_profile_id) || null : null;
    return owner ? owner === viewer : isOwner;
  };
  const me = scope === "me";

  // Page events for the profiles in scope (mine, or the whole org's).
  const profileIds = me ? [...myProfiles] : profiles.map((p) => p.id);
  const events: { event: string; created_at: string }[] = [];
  for (let i = 0; i < profileIds.length; i += 100) {
    const list = inList(profileIds.slice(i, i + 100));
    events.push(
      ...(await pageAll<{ event: string; created_at: string }>(
        (l, o) => `page_events?recruiter_profile_id=in.(${list})&created_at=gte.${prevIso}&select=event,created_at&order=created_at.desc&limit=${l}&offset=${o}`
      ))
    );
  }

  // ---- KPIs ----------------------------------------------------------------
  const scopedApps = apps.filter((a) => !me || mineApp(a));
  const isApplication = (a: { role_ids: string[] | null; source: string | null }) => (a.role_ids || []).length > 0 && !/^referral:/.test(a.source || "");
  const appsN = scopedApps.filter((a) => isApplication(a) && inPeriod(a.created_at)).length;
  const appsPrev = scopedApps.filter((a) => isApplication(a) && inPrev(a.created_at)).length;

  const scopedLogs = logs.filter((l) => !me || l.member_email === viewer);
  const sentN = scopedLogs.filter((l) => l.direction === "out" && inPeriod(l.created_at)).length;
  const sentPrev = scopedLogs.filter((l) => l.direction === "out" && inPrev(l.created_at)).length;
  const repN = scopedLogs.filter((l) => l.direction === "in" && inPeriod(l.created_at)).length;
  const repPrev = scopedLogs.filter((l) => l.direction === "in" && inPrev(l.created_at)).length;

  const scopedDone = done.filter((t) => !me || t.created_by_email === viewer);
  const tasksN = scopedDone.filter((t) => inPeriod(t.completed_at)).length;
  const tasksPrev = scopedDone.filter((t) => inPrev(t.completed_at)).length;

  const movesBy: Partial<Record<StageKey, number>> = {};
  let movesN = 0;
  let movesPrev = 0;
  for (const m of moves) {
    if (m.to_status === "new" || m.to_status === "rejected") continue;
    if (inPeriod(m.created_at)) {
      movesN++;
      const k = m.to_status as StageKey;
      movesBy[k] = (movesBy[k] || 0) + 1;
    } else if (inPrev(m.created_at)) movesPrev++;
  }

  const usedPeriod = usage.filter((u) => inPeriod(u.created_at)).reduce((n, u) => n + (u.credits || 0), 0);
  const usedPrev = usage.filter((u) => inPrev(u.created_at)).reduce((n, u) => n + (u.credits || 0), 0);
  const searches = new Set(usage.filter((u) => inPeriod(u.created_at) && u.run_id).map((u) => u.run_id)).size;

  // ---- open roles + funnel --------------------------------------------------
  const applicantsByRole = new Map<string, number>();
  const newByRole = new Map<string, number>();
  const applicantKeys = new Map<string, Set<string>>();
  for (const a of apps) {
    for (const id of a.role_ids || []) {
      applicantsByRole.set(id, (applicantsByRole.get(id) || 0) + 1);
      if (inPeriod(a.created_at)) newByRole.set(id, (newByRole.get(id) || 0) + 1);
      const set = applicantKeys.get(id) || new Set<string>();
      set.add(`app_${a.id}`);
      applicantKeys.set(id, set);
    }
  }
  const statusByRole = new Map<string, Map<string, string>>();
  for (const s of statuses) {
    const m = statusByRole.get(s.job_id) || new Map<string, string>();
    m.set(s.candidate_key, s.status);
    statusByRole.set(s.job_id, m);
  }
  const emptyPipe = (): Record<StageKey, number> => ({ new: 0, contacted: 0, replied: 0, interviewing: 0, offer: 0, hired: 0 });
  const funnel: Record<StageKey, number> & { total: number } = { ...emptyPipe(), total: 0 };
  const openRoles = roles.filter((r) => r.status === "open");
  const roleRows = openRoles.map((r) => {
    const pipe = emptyPipe();
    const st = statusByRole.get(r.external_id) || new Map<string, string>();
    // Every applicant is in the pipeline (implicit New); sourced people join once they have a row.
    const keys = new Set<string>([...(applicantKeys.get(r.external_id) || []), ...st.keys()]);
    for (const k of keys) {
      const s = (st.get(k) || "new") as string;
      if (s === "rejected") continue;
      if (s in pipe) pipe[s as StageKey]++;
    }
    for (const k of STAGES) funnel[k] += pipe[k];
    let furthest: { stage: string; n: number } | null = null;
    for (let i = STAGES.length - 1; i >= 1; i--) {
      if (pipe[STAGES[i]] > 0) {
        furthest = { stage: STAGE_LABEL[STAGES[i]], n: pipe[STAGES[i]] };
        break;
      }
    }
    return {
      id: r.external_id,
      title: r.title,
      company: str(r.company_name),
      applicants: applicantsByRole.get(r.external_id) || 0,
      newInPeriod: newByRole.get(r.external_id) || 0,
      pipe,
      furthest,
      updatedDays: Math.max(0, Math.floor((now - Date.parse(r.updated_at)) / DAY)),
    };
  });
  funnel.total = STAGES.reduce((n, k) => n + funnel[k], 0);
  roleRows.sort((a, b) => b.newInPeriod - a.newInPeriod || b.applicants - a.applicants);

  // ---- reply time: inbound → next outbound in the same thread ------------
  const byThread = new Map<string, typeof logs>();
  for (const l of logs) {
    const id = l.thread_id || "";
    if (!id) continue;
    byThread.set(id, [...(byThread.get(id) || []), l]);
  }
  const deltas: number[] = [];
  for (const list of byThread.values()) {
    let pendingIn: string | null = null;
    for (const l of list) {
      if (l.direction === "in") pendingIn = pendingIn || l.created_at;
      else if (pendingIn) {
        if (inPeriod(l.created_at) && (!me || l.member_email === viewer)) deltas.push((Date.parse(l.created_at) - Date.parse(pendingIn)) / 60_000);
        pendingIn = null;
      }
    }
  }
  deltas.sort((a, b) => a - b);
  const medianReplyMinutes = deltas.length ? Math.round(deltas[Math.floor(deltas.length / 2)]) : null;

  // ---- 14-day series ---------------------------------------------------------
  const series: { day: string; sent: number; replies: number; apps: number }[] = [];
  const dayIdx = new Map<string, number>();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.parse(today + "T12:00:00Z") - i * DAY).toISOString().slice(0, 10);
    dayIdx.set(d, series.length);
    series.push({ day: d, sent: 0, replies: 0, apps: 0 });
  }
  for (const l of scopedLogs) {
    const i = dayIdx.get(localDay(l.created_at));
    if (i === undefined) continue;
    if (l.direction === "out") series[i].sent++;
    else series[i].replies++;
  }
  for (const a of scopedApps) {
    if (!isApplication(a)) continue;
    const i = dayIdx.get(localDay(a.created_at));
    if (i !== undefined) series[i].apps++;
  }

  // ---- page + links -----------------------------------------------------------
  const count = (ev: string, pred: (iso: string) => boolean) => events.filter((e) => e.event === ev && pred(e.created_at)).length;
  const scopedLinks = links.filter((l) => !me || l.created_by === member.userId);
  const scopedRefs = refs.filter((r) => !me || (r.recruiter_profile_id ? myProfiles.has(r.recruiter_profile_id) : isOwner));
  const page = {
    views: count("view", inPeriod),
    viewsPrev: count("view", inPrev),
    roleOpens: count("role_open", inPeriod),
    appsViaPage: scopedApps.filter((a) => a.recruiter_profile_id && isApplication(a) && inPeriod(a.created_at)).length,
    bookingClicks: count("booking_click", inPeriod),
    linksSent: scopedLinks.filter((l) => inPeriod(l.created_at)).length,
    linksOpened: scopedLinks.filter((l) => inPeriod(l.last_opened_at)).length,
    referrals: scopedRefs.filter((r) => inPeriod(r.created_at)).length,
  };

  // ---- sourcing ----------------------------------------------------------------
  const roleTitleById = new Map(roles.map((r) => [r.id, r.title]));
  const ACTIVE = new Set(["previewed", "importing", "ranking", "screening"]);
  const sourcing = {
    available,
    usedPeriod,
    usedPrev,
    imported: runs.filter((r) => inPeriod(r.finished_at || r.created_at)).reduce((n, r) => n + (r.imported_count || 0), 0),
    runsDone: runs.filter((r) => r.status === "done" && inPeriod(r.finished_at || r.created_at)).length,
    inProgress: runs
      .filter((r) => ACTIVE.has(r.status))
      .slice(0, 5)
      .map((r) => ({ title: (r.org_role_id && roleTitleById.get(r.org_role_id)) || "Search", status: r.status })),
  };

  // ---- team table (owners, Team scope) ------------------------------------
  let team: HomeData["team"] = null;
  if (isOwner && !me) {
    team = members
      .filter((m) => m.email)
      .map((m) => {
        const mine = profiles.filter((p) => p.user_id === m.user_id).map((p) => p.id);
        return {
          email: m.email,
          sent: logs.filter((l) => l.member_email === m.email && l.direction === "out" && inPeriod(l.created_at)).length,
          replies: logs.filter((l) => l.member_email === m.email && l.direction === "in" && inPeriod(l.created_at)).length,
          tasksDone: done.filter((t) => t.created_by_email === m.email && inPeriod(t.completed_at)).length,
          overdue: open.filter((t) => t.created_by_email === m.email && t.due_date < today).length,
          appsViaPage: apps.filter((a) => a.recruiter_profile_id && mine.includes(a.recruiter_profile_id) && isApplication(a) && inPeriod(a.created_at)).length,
        };
      })
      .sort((a, b) => b.sent + b.tasksDone - (a.sent + a.tasksDone));
  }

  // ---- today strip from the Inbox derivation ---------------------------------
  const overdueItem = inbox.items.find((i) => i.overdue);
  const awaitingItems = inbox.items.filter((i) => i.kind === "mail");
  const fdueItems = inbox.items.filter((i) => i.kind === "fdue");

  return {
    scope,
    period,
    today,
    strip: {
      toDo: inbox.counts.today,
      overdue: inbox.counts.overdue,
      overdueTitle: overdueItem ? overdueItem.title : null,
      awaiting: awaitingItems.length,
      awaitingNames: [...new Set(awaitingItems.map((i) => i.candidateName.split(/\s+/)[0]))].slice(0, 3),
      followUpsDue: fdueItems.length,
      followUpName: fdueItems[0]?.candidateName || null,
    },
    kpis: {
      applications: { n: appsN, prev: appsPrev },
      sent: { n: sentN, prev: sentPrev },
      replies: { n: repN, prev: repPrev, rate: sentN ? Math.round((repN / sentN) * 100) : null },
      tasksDone: { n: tasksN, prev: tasksPrev },
      moves: { n: movesN, prev: movesPrev, by: movesBy },
      credits: { used: usedPeriod, prev: usedPrev, available, searches },
    },
    roles: roleRows,
    funnel,
    medianReplyMinutes,
    series,
    page,
    sourcing,
    team,
  };
}
