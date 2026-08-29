"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDash } from "@/components/dashboard/DashShell";
import ClientRequestsBlock from "@/components/dashboard/ClientRequestsBlock";

type Pipe = {
  total: number;
  screening: number;
  replied: number;
  interview: number;
  offer: number;
  hired: number;
};

type Job = {
  id: string;
  title: string;
  status: string;
  salary: string;
  locations: string[];
  workplace: string;
  yoe: string;
  applicants: number;
  linked?: boolean;
  company?: string;
  updatedAt?: string;
  pipeline?: Pipe;
};

const STAGE_SEGS = [
  ["screening", "Screening"],
  ["replied", "Replied"],
  ["interview", "Interview"],
  ["offer", "Offer"],
] as const;

// "Furthest stage reached" summary after the bar.
function furthest(p: Pipe | undefined, applicants: number): string {
  if (!p || p.total === 0) return applicants > 0 ? "new" : "—";
  if (p.hired > 0) return `${p.hired} hired`;
  if (p.offer > 0) return `${p.offer} at offer`;
  if (p.interview > 0) return `${p.interview} interviewing`;
  if (p.replied > 0) return `${p.replied} replied`;
  if (p.screening > 0) return `${p.screening} contacted`;
  return "new";
}

function PipeCell({
  job,
  flip,
}: {
  job: Job;
  flip: boolean;
}) {
  const [tip, setTip] = useState(false);
  const p = job.pipeline;
  const total = p?.total ?? 0;
  // Offer segment folds hired in — the bar reads "how far people have got".
  const segs = p
    ? [p.screening, p.replied, p.interview, p.offer + p.hired]
    : [0, 0, 0, 0];
  const none = Math.max(0, total - segs.reduce((a, b) => a + b, 0));
  return (
    <div
      className="dash-pipe"
      onMouseEnter={() => setTip(true)}
      onMouseLeave={() => setTip(false)}
    >
      <div className="track" aria-hidden="true">
        {total > 0 &&
          segs.map((n, i) =>
            n > 0 ? (
              <i
                key={i}
                className={`seg-${STAGE_SEGS[i][0]}`}
                style={{ width: `${(n / total) * 100}%` }}
              />
            ) : null
          )}
      </div>
      <span className="furthest">{furthest(p, job.applicants)}</span>
      {tip && p && total > 0 && (
        <div className={`dash-pipe-tip${flip ? " flip" : ""}`}>
          <div className="tt">
            {total} candidate{total === 1 ? "" : "s"} · {job.title}
          </div>
          {STAGE_SEGS.map(([key, label], i) =>
            segs[i] > 0 ? (
              <div className="row" key={key}>
                <span className={`sw seg-${key}`} />
                {label}
                <b className="n">{segs[i]}</b>
              </div>
            ) : null
          )}
          <div className="row none">
            <span className="sw" style={{ background: "rgba(255,255,255,.25)" }} />
            Not contacted yet
            <b className="n">{none}</b>
          </div>
        </div>
      )}
    </div>
  );
}

export default function JobsPage() {
  const { token } = useDash();
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [poolTotal, setPoolTotal] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [scope, setScope] = useState<"open" | "closed" | "linked">("open");

  useEffect(() => {
    fetch("/api/dashboard/jobs", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((data) => setJobs(data.jobs))
      .catch(() => setError(true));
  }, [token, refresh]);

  // Pool size for the sub-line, from the unified candidates list.
  useEffect(() => {
    fetch("/api/dashboard/candidates/v2?pageSize=1", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && typeof data.total === "number") setPoolTotal(data.total);
      })
      .catch(() => {});
  }, [token]);

  const byActivity = (a: Job, b: Job) =>
    (b.updatedAt || "").localeCompare(a.updatedAt || "");
  const open = useMemo(
    () => (jobs ?? []).filter((j) => j.status === "open").sort(byActivity),
    [jobs]
  );
  const closed = useMemo(
    () => (jobs ?? []).filter((j) => j.status !== "open").sort(byActivity),
    [jobs]
  );
  const linked = useMemo(() => (jobs ?? []).filter((j) => j.linked), [jobs]);

  const openRows = scope === "open" ? open : scope === "linked" ? linked.filter((j) => j.status === "open") : [];
  const closedRows =
    scope === "closed" ? closed : scope === "linked" ? linked.filter((j) => j.status !== "open") : closed;
  const showClosedSection = scope !== "open" ? closedRows.length > 0 : closed.length > 0;

  const meta = (j: Job) =>
    [`#${j.id}`, j.workplace || null, j.company || null].filter(Boolean).join(" · ");

  const closedDate = (j: Job) =>
    j.updatedAt
      ? `Closed ${new Date(j.updatedAt).toLocaleDateString([], { day: "numeric", month: "short" })}`
      : "Closed";

  return (
    <>
      <ClientRequestsBlock onCopied={() => setRefresh((n) => n + 1)} />
      <div className="dash-jobhead">
        <div>
          <h1 className="dash-h1">Jobs</h1>
          <p className="dash-sub">
            {jobs
              ? `${open.length} open · ${closed.length} closed` +
                (poolTotal !== null ? ` · ${poolTotal.toLocaleString()} people in the pool` : "")
              : error
                ? "Couldn't load jobs — refresh to retry."
                : "Loading…"}
          </p>
        </div>
        <div className="dash-jobhead-actions">
          <Link className="dash-btn dash-btn-2" href="/dashboard/jobs/new">
            Import a JD
          </Link>
          <Link className="dash-btn" href="/dashboard/jobs/new">
            New job
          </Link>
        </div>
      </div>
      {jobs && jobs.length === 0 && (
        <div className="dash-empty">
          No jobs yet. Job creation from this dashboard is coming next — for
          now, we set roles up for you during onboarding.
        </div>
      )}
      {jobs && jobs.length > 0 && (
        <>
          <div className="dash-fpills">
            <button
              className={`dash-fpill${scope === "open" ? " on" : ""}`}
              onClick={() => setScope("open")}
            >
              Open <span className="n">{open.length}</span>
            </button>
            <button
              className={`dash-fpill${scope === "closed" ? " on" : ""}`}
              onClick={() => setScope("closed")}
            >
              Closed <span className="n">{closed.length}</span>
            </button>
            {linked.length > 0 && (
              <button
                className={`dash-fpill${scope === "linked" ? " on" : ""}`}
                onClick={() => setScope("linked")}
              >
                Linked to a client <span className="n">{linked.length}</span>
              </button>
            )}
            <span className="dash-sortnote">Sorted by newest activity</span>
          </div>
          <div className="dash-legend">
            <span className="lbl">Pipeline</span>
            {STAGE_SEGS.map(([key, label]) => (
              <span key={key}>
                <span className={`sw seg-${key}`} />
                {label}
              </span>
            ))}
            <span>
              <span className="sw" style={{ background: "var(--stage-none)" }} />
              Not contacted yet
            </span>
            <span className="hint">hover a bar for the counts</span>
          </div>
          {(scope === "closed" || openRows.length > 0) && (
            <div className="dash-tablewrap is-tooltip-host">
              <div className="dash-jgrid dash-jhead">
                <span>Role</span>
                <span>Locations</span>
                <span>Salary</span>
                <span>Years</span>
                <span className="num">Applicants</span>
                <span>Pipeline</span>
              </div>
              {(scope === "closed" ? closedRows : openRows).map((j, i, arr) => (
                <div
                  key={j.id}
                  className={`dash-jgrid dash-jrow${j.status !== "open" ? " closed" : ""}`}
                  onClick={() => router.push(`/dashboard/jobs/${j.id}`)}
                >
                  <div>
                    <div className="dash-jname">
                      {j.title}
                      {j.linked && (
                        <span
                          className="dash-linkchip"
                          title="Linked to a client company — network sends land in their pipeline"
                        >
                          linked
                        </span>
                      )}
                    </div>
                    <div className="dash-jmeta">{meta(j)}</div>
                  </div>
                  <span className="jc">{j.locations.join(", ") || "—"}</span>
                  <span className="jc tab">{j.salary || "—"}</span>
                  <span className="jc tab">{j.yoe || "—"}</span>
                  <span className="num strong">{j.applicants}</span>
                  {j.status === "open" ? (
                    <PipeCell job={j} flip={i >= arr.length / 2 && i > 0} />
                  ) : (
                    <span className="jc dim">{closedDate(j)}</span>
                  )}
                </div>
              ))}
              {scope === "closed" && closedRows.length === 0 && (
                <div className="dash-jempty">No closed jobs yet.</div>
              )}
            </div>
          )}
          {scope === "open" && showClosedSection && (
            <>
              <div className="dash-sec">Closed</div>
              <div className="dash-tablewrap">
                {closedRows.map((j) => (
                  <div
                    key={j.id}
                    className="dash-jgrid dash-jrow closed"
                    onClick={() => router.push(`/dashboard/jobs/${j.id}`)}
                  >
                    <div>
                      <div className="dash-jname">{j.title}</div>
                      <div className="dash-jmeta">{meta(j)}</div>
                    </div>
                    <span className="jc">{j.locations.join(", ") || "—"}</span>
                    <span className="jc tab">{j.salary || "—"}</span>
                    <span className="jc tab">{j.yoe || "—"}</span>
                    <span className="num">{j.applicants}</span>
                    <span className="jc dim">{closedDate(j)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
