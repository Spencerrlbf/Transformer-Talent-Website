"use client";
// Home: today's work at the top, the period's numbers, then the state of
// every open role. All counts come from /api/dashboard/home; nothing here
// is tracked for its own sake.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDash } from "@/components/dashboard/DashShell";

type Stage = "new" | "contacted" | "replied" | "interviewing" | "offer" | "hired";
type Data = {
  scope: "me" | "team";
  period: "week" | "month";
  today: string;
  strip: { toDo: number; overdue: number; overdueTitle: string | null; awaiting: number; awaitingNames: string[]; followUpsDue: number; followUpName: string | null };
  kpis: {
    applications: { n: number; prev: number };
    sent: { n: number; prev: number };
    replies: { n: number; prev: number; rate: number | null };
    tasksDone: { n: number; prev: number };
    moves: { n: number; prev: number; by: Partial<Record<Stage, number>> };
    credits: { used: number; prev: number; available: number; searches: number };
  };
  roles: { id: string; title: string; company: string | null; applicants: number; newInPeriod: number; pipe: Record<Stage, number>; furthest: { stage: string; n: number } | null; updatedDays: number }[];
  funnel: Record<Stage, number> & { total: number };
  medianReplyMinutes: number | null;
  series: { day: string; sent: number; replies: number; apps: number }[];
  page: { views: number; viewsPrev: number; roleOpens: number; appsViaPage: number; bookingClicks: number; linksSent: number; linksOpened: number; referrals: number };
  sourcing: { available: number; usedPeriod: number; usedPrev: number; imported: number; runsDone: number; inProgress: { title: string; status: string }[] };
  team: { email: string; sent: number; replies: number; tasksDone: number; overdue: number; appsViaPage: number }[] | null;
};

const localDay = () => new Date().toLocaleDateString("en-CA");
// First name from the recruiter page when set; otherwise nothing — an email
// local part like "spencerrlbf" is no greeting.
const firstName = (name: string) => (name.trim().split(/\s+/)[0] || "").trim();
const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};
const delta = (n: number, prev: number) => {
  const d = n - prev;
  if (d === 0) return { text: "no change", cls: "flat" };
  return { text: `${d > 0 ? "+" : ""}${d}`, cls: d > 0 ? "up" : "dn" };
};
const mins = (m: number | null) => {
  if (m === null) return "—";
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / (60 * 24))}d ${Math.floor((m % (60 * 24)) / 60)}h`;
};
const STAGE_COLOR: Record<Stage, string> = {
  new: "var(--hair)", contacted: "var(--stage-screening)", replied: "var(--stage-replied)",
  interviewing: "var(--stage-interview)", offer: "var(--stage-offer)", hired: "#155A37",
};
const STAGE_LABEL: Record<Stage, string> = { new: "New", contacted: "Contacted", replied: "Replied", interviewing: "Interviewing", offer: "Offer", hired: "Hired" };
const authorName = (email: string) => {
  const local = email.split("@")[0] || "Teammate";
  return local.charAt(0).toUpperCase() + local.slice(1);
};

export default function HomePage() {
  const { token, role, name } = useDash();
  const router = useRouter();
  const [scope, setScope] = useState<"me" | "team">("me");
  const [period, setPeriod] = useState<"week" | "month">("week");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState(false);
  // Orgs with a big open list (the TT site syncs ~100 roles) get the busiest few, expandable.
  const [allRoles, setAllRoles] = useState(false);
  const ROLE_CAP = 8;

  useEffect(() => {
    try {
      if (localStorage.getItem("tt-inbox-scope") === "team") setScope("team");
    } catch {
      /* no storage */
    }
  }, []);

  const load = useCallback(() => {
    fetch(`/api/dashboard/home?scope=${scope}&period=${period}&today=${localDay()}&tz=${new Date().getTimezoneOffset()}&_=${Date.now()}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<Data>;
      })
      .then((d) => {
        setData(d);
        setError(false);
      })
      .catch(() => setError(true));
  }, [scope, period, token]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const periodLabel = period === "week" ? "this week" : "last 30 days";
  const prevLabel = period === "week" ? "vs last week" : "vs the 30 days before";
  const k = data?.kpis;
  const maxSeries = data ? Math.max(1, ...data.series.map((s) => Math.max(s.sent, s.replies, s.apps))) : 1;

  return (
    <>
      <div className="tk-head">
        <div>
          <h1 className="dash-h1">
            {greeting()}
            {firstName(name) ? `, ${firstName(name)}` : ""}
          </h1>
          <p className="dash-sub">
            {new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} ·{" "}
            {scope === "me" ? "your numbers" : "whole team"}
          </p>
        </div>
        <div className="ib-headright">
          <span className="dash-tabs tk-seg ib-scope" role="group" aria-label="Whose numbers">
            <button className={scope === "me" ? "on" : ""} onClick={() => setScope("me")}>
              Me
            </button>
            <button className={scope === "team" ? "on" : ""} onClick={() => setScope("team")}>
              Team
            </button>
          </span>
          <span className="dash-tabs tk-seg" role="group" aria-label="Period">
            <button className={period === "week" ? "on" : ""} onClick={() => setPeriod("week")}>
              This week
            </button>
            <button className={period === "month" ? "on" : ""} onClick={() => setPeriod("month")}>
              30 days
            </button>
          </span>
        </div>
      </div>

      {error && <p className="cv2d-err">Couldn&apos;t load your numbers. Refresh to try again.</p>}
      {!data && !error && <p className="dash-muted">Loading…</p>}

      {data && (
        <>
          <div className="hm-today">
            <Link href="/dashboard/inbox" className="hm-tcard pri">
              <span className="n">{data.strip.toDo}</span>
              <span className="l">
                <b>To do today</b>
                {data.strip.toDo
                  ? [
                      data.strip.awaiting ? `${data.strip.awaiting} email${data.strip.awaiting === 1 ? "" : "s"}` : null,
                      data.strip.followUpsDue ? `${data.strip.followUpsDue} follow-up${data.strip.followUpsDue === 1 ? "" : "s"}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "tasks and new people"
                  : "Inbox clear"}
              </span>
              <span className="go">Open Inbox ›</span>
            </Link>
            <div className="hm-tcard">
              <span className={`n${data.strip.overdue ? " bad" : ""}`}>{data.strip.overdue}</span>
              <span className="l">
                <b>Overdue</b>
                {data.strip.overdueTitle || "Nothing overdue"}
              </span>
            </div>
            <div className="hm-tcard">
              <span className="n">{data.strip.awaiting}</span>
              <span className="l">
                <b>Awaiting your reply</b>
                {data.strip.awaitingNames.join(", ") || "No replies waiting"}
              </span>
            </div>
            <div className="hm-tcard">
              <span className="n">{data.strip.followUpsDue}</span>
              <span className="l">
                <b>Follow-ups due</b>
                {data.strip.followUpName || "None due"}
              </span>
            </div>
          </div>

          <div className="tk-day-h hm-sec">
            Activity <span className="hm-why">{periodLabel} {prevLabel}</span>
          </div>
          {k && (
            <div className="hm-kpis">
              {(
                [
                  ["Applications", k.applications.n, delta(k.applications.n, k.applications.prev), null],
                  ["Emails sent", k.sent.n, delta(k.sent.n, k.sent.prev), null],
                  ["Replies received", k.replies.n, null, k.replies.rate === null ? "no outreach yet" : `${k.replies.rate}% reply rate`],
                  ["Tasks done", k.tasksDone.n, delta(k.tasksDone.n, k.tasksDone.prev), null],
                  [
                    "Stage moves",
                    k.moves.n,
                    null,
                    Object.entries(k.moves.by)
                      .map(([s, n]) => `${n} ${STAGE_LABEL[s as Stage].toLowerCase()}`)
                      .join(" · ") || "team-wide, none yet",
                  ],
                  ["Credits used", k.credits.used, null, `${k.credits.searches} search${k.credits.searches === 1 ? "" : "es"} · ${k.credits.available} left`],
                ] as [string, number, { text: string; cls: string } | null, string | null][]
              ).map(([label, n, d, sub]) => (
                <div className="hm-kpi" key={label}>
                  <div className="l">{label}</div>
                  <div className="n">{n}</div>
                  {d && (
                    <div className="d">
                      <b className={d.cls}>{d.text}</b> {prevLabel}
                    </div>
                  )}
                  {sub && <div className="s">{sub}</div>}
                </div>
              ))}
            </div>
          )}

          <div className="tk-day-h hm-sec">
            Open roles <span className="hm-why">applicants, what&apos;s new, how far the pipeline has got</span>
          </div>
          <div className="hm-grid2">
            <div className="hm-card">
              <h4>
                {data.roles.length} open role{data.roles.length === 1 ? "" : "s"}
              </h4>
              <p className="cs">Sorted by new applicants {periodLabel}. Click a row to open the job.</p>
              {data.roles.length === 0 ? (
                <p className="tk-empty">No open roles. <Link href="/dashboard/jobs/new">Post one</Link>.</p>
              ) : (
                <div className="board-scroll">
                  <table className="hm-table">
                    <thead>
                      <tr>
                        <th>Role</th>
                        <th>Applicants</th>
                        <th>New</th>
                        <th>Pipeline</th>
                        <th>Furthest</th>
                        <th>Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(allRoles ? data.roles : data.roles.slice(0, ROLE_CAP)).map((r) => {
                        const total = Object.values(r.pipe).reduce((a, b) => a + b, 0) || 1;
                        return (
                          <tr key={r.id} className="hm-click" onClick={() => router.push(`/dashboard/jobs/${r.id}`)}>
                            <td className="rt">
                              {r.title}
                              <span>{[r.company, `#${r.id}`].filter(Boolean).join(" · ")}</span>
                            </td>
                            <td>{r.applicants}</td>
                            <td>{r.newInPeriod ? <span className="new">+{r.newInPeriod}</span> : "0"}</td>
                            <td>
                              <span className="hm-bar" title={Object.entries(r.pipe).map(([s, n]) => `${STAGE_LABEL[s as Stage]} ${n}`).join(" · ")}>
                                {(["contacted", "replied", "interviewing", "offer", "hired"] as Stage[]).map((s) =>
                                  r.pipe[s] > 0 ? <i key={s} style={{ width: `${(r.pipe[s] / total) * 100}%`, background: STAGE_COLOR[s] }} /> : null
                                )}
                              </span>
                            </td>
                            <td>
                              {r.furthest ? (
                                <span className={`hm-fur ${r.furthest.stage === "Offer" || r.furthest.stage === "Hired" ? "o" : r.furthest.stage === "Interviewing" ? "i" : "s"}`}>
                                  {r.furthest.stage} · {r.furthest.n}
                                </span>
                              ) : (
                                <span className="hm-fur s">New</span>
                              )}
                            </td>
                            <td>
                              <span className={`hm-age${r.updatedDays > 30 ? " old" : ""}`}>{r.updatedDays}d ago</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {data.roles.length > ROLE_CAP && (
                    <button type="button" className="hm-more" onClick={() => setAllRoles((v) => !v)}>
                      {allRoles ? "Show the busiest 8" : `Show all ${data.roles.length} roles`}
                    </button>
                  )}
                </div>
              )}
              <div className="hm-legend">
                {(["contacted", "replied", "interviewing", "offer", "hired"] as Stage[]).map((s) => (
                  <span key={s}>
                    <i style={{ background: STAGE_COLOR[s] }} />
                    {STAGE_LABEL[s]}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="hm-grid3">
            <div className="hm-card">
              <h4>Pipeline across open roles</h4>
              <p className="cs">Where the {data.funnel.total} {data.funnel.total === 1 ? "person" : "people"} attached to open roles are right now.</p>
              <div className="hm-funnel">
                {(["new", "contacted", "replied", "interviewing", "offer", "hired"] as Stage[]).map((s) => (
                  <div className="fr" key={s}>
                    <span className="fl">{STAGE_LABEL[s]}</span>
                    <span className="fb" style={{ width: `${data.funnel.total ? Math.max(2, (data.funnel[s] / data.funnel.total) * 100) : 2}%`, background: STAGE_COLOR[s] }} />
                    <span className="fn">{data.funnel[s]}</span>
                  </div>
                ))}
              </div>
              <div className="hm-mini">
                <div className="mr">
                  <span>Moved {periodLabel}</span>
                  <b>
                    {Object.entries(k?.moves.by || {}).length
                      ? Object.entries(k!.moves.by)
                          .map(([s, n]) => `${n} ${STAGE_LABEL[s as Stage].toLowerCase()}`)
                          .join(" · ")
                      : "none"}
                  </b>
                </div>
                <div className="mr">
                  <span>Reply rate on outreach</span>
                  <b>
                    {k?.replies.rate === null ? "—" : `${k?.replies.rate}%`}
                    <small>
                      {k?.replies.n} of {k?.sent.n}
                    </small>
                  </b>
                </div>
                <div className="mr">
                  <span>Median time to reply to a candidate</span>
                  <b>{mins(data.medianReplyMinutes)}</b>
                </div>
              </div>
            </div>
            <div className="hm-card">
              <h4>Emails and applications, last 14 days</h4>
              <p className="cs">Sent, replies received, applications arrived.</p>
              <svg className="hm-chart" viewBox="0 0 560 150" preserveAspectRatio="none" aria-label="14 day activity">
                <g stroke="var(--hair)" strokeWidth="1">
                  <line x1="0" y1="30" x2="560" y2="30" />
                  <line x1="0" y1="70" x2="560" y2="70" />
                  <line x1="0" y1="110" x2="560" y2="110" />
                </g>
                {data.series.map((s, i) => {
                  const slot = 560 / 14;
                  const x = i * slot + 6;
                  const w = (slot - 12) / 2;
                  const h = (v: number) => (v / maxSeries) * 120;
                  return (
                    <g key={s.day}>
                      <rect x={x} y={140 - h(s.sent)} width={w} height={h(s.sent)} fill="var(--accent)" rx="2" />
                      <rect x={x + w + 2} y={140 - h(s.replies)} width={w} height={h(s.replies)} fill="var(--stage-interview)" rx="2" />
                    </g>
                  );
                })}
                <path
                  d={data.series.map((s, i) => `${i ? "L" : "M"}${i * (560 / 14) + 560 / 28} ${140 - (s.apps / maxSeries) * 120}`).join(" ")}
                  fill="none"
                  stroke="var(--pos)"
                  strokeWidth="2"
                />
                {data.series.map((s, i) => (
                  <circle key={s.day} cx={i * (560 / 14) + 560 / 28} cy={140 - (s.apps / maxSeries) * 120} r="2.5" fill="var(--pos)" />
                ))}
              </svg>
              <div className="hm-legend">
                <span>
                  <i style={{ background: "var(--accent)" }} />
                  Emails sent
                </span>
                <span>
                  <i style={{ background: "var(--stage-interview)" }} />
                  Replies
                </span>
                <span>
                  <i style={{ background: "var(--pos)" }} />
                  Applications
                </span>
              </div>
            </div>
            <div className="hm-card">
              <h4>{scope === "me" ? "Your page and links" : "Pages and links"}</h4>
              <p className="cs">Recruiter page traffic and tracked-link opens, {periodLabel}.</p>
              <div className="hm-mini">
                <div className="mr">
                  <span>Page views</span>
                  <b>
                    {data.page.views}
                    <small className={delta(data.page.views, data.page.viewsPrev).cls}>{delta(data.page.views, data.page.viewsPrev).text}</small>
                  </b>
                </div>
                <div className="mr">
                  <span>Role opens</span>
                  <b>{data.page.roleOpens}</b>
                </div>
                <div className="mr">
                  <span>Applications via page</span>
                  <b>{data.page.appsViaPage}</b>
                </div>
                <div className="mr">
                  <span>Booking clicks</span>
                  <b>{data.page.bookingClicks}</b>
                </div>
                <div className="mr">
                  <span>Tracked links opened</span>
                  <b>
                    {data.page.linksOpened}
                    <small>of {data.page.linksSent} sent</small>
                  </b>
                </div>
                <div className="mr">
                  <span>Referrals received</span>
                  <b>{data.page.referrals}</b>
                </div>
              </div>
            </div>
            <div className="hm-card">
              <h4>Sourcing and credits</h4>
              <p className="cs">Org-wide. Balance is computed from the ledger, never stored.</p>
              <div className="hm-mini">
                <div className="mr">
                  <span>Credits available</span>
                  <b>{data.sourcing.available}</b>
                </div>
                <div className="mr">
                  <span>Used {periodLabel}</span>
                  <b>
                    {data.sourcing.usedPeriod}
                    <small>{k?.credits.searches} search{k?.credits.searches === 1 ? "" : "es"}</small>
                  </b>
                </div>
                <div className="mr">
                  <span>Used the period before</span>
                  <b>{data.sourcing.usedPrev}</b>
                </div>
                <div className="mr">
                  <span>Candidates imported</span>
                  <b>{data.sourcing.imported}</b>
                </div>
                <div className="mr">
                  <span>Searches finished</span>
                  <b>{data.sourcing.runsDone}</b>
                </div>
                <div className="mr">
                  <span>Runs in progress</span>
                  <b>
                    {data.sourcing.inProgress.length}
                    {data.sourcing.inProgress[0] && (
                      <small>
                        {data.sourcing.inProgress[0].title} · {data.sourcing.inProgress[0].status}
                      </small>
                    )}
                  </b>
                </div>
              </div>
            </div>
          </div>

          {data.team && role === "owner" && (
            <>
              <div className="tk-day-h hm-sec">
                Team {periodLabel} <span className="hm-why">the same numbers per person</span>
              </div>
              <div className="hm-card">
                <div className="board-scroll">
                  <table className="hm-table team">
                    <thead>
                      <tr>
                        <th>Member</th>
                        <th>Emails sent</th>
                        <th>Replies</th>
                        <th>Tasks done</th>
                        <th>Overdue</th>
                        <th>Applications via page</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.team.map((m) => (
                        <tr key={m.email}>
                          <td className="rt">
                            <span className="av">{authorName(m.email)[0]}</span>
                            {authorName(m.email)}
                            <span>{m.email}</span>
                          </td>
                          <td>{m.sent}</td>
                          <td>{m.replies}</td>
                          <td>{m.tasksDone}</td>
                          <td>{m.overdue ? <span className="hm-age old">{m.overdue}</span> : 0}</td>
                          <td>{m.appsViaPage}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
