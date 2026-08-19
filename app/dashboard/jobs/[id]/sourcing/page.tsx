"use client";
// Sourcing tab for one job: runs list (home) → guided search builder →
// run workspace. Option A layout with the runs-list spine.
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useDash } from "@/components/dashboard/DashShell";
import SearchBuilder from "@/components/dashboard/sourcing/SearchBuilder";
import RunView from "@/components/dashboard/sourcing/RunView";
import {
  draftFromParams,
  summarizeParams,
  type QueryDraft,
  type RunSummary,
} from "@/components/dashboard/sourcing/types";

type View = { kind: "list" } | { kind: "builder"; initial: QueryDraft | null } | { kind: "run"; runId: string };

const STATUS_LABEL: Record<string, string> = {
  previewed: "Queued",
  importing: "Importing…",
  ranking: "Ranking…",
  screening: "Reviewing…",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export default function SourcingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { token } = useDash();
  const [job, setJob] = useState<{ id: string; title: string; status: string } | null | undefined>(undefined);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });

  const loadRuns = useCallback(() => {
    fetch(`/api/dashboard/sourcing/runs?jobId=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => (r.ok ? r.json() : { runs: [] }))
      .then((d) => setRuns(d.runs))
      .catch(() => setRuns([]));
  }, [id, token]);

  useEffect(() => {
    fetch(`/api/dashboard/jobs/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => setJob(d ? d.job : null))
      .catch(() => setJob(null));
    fetch("/api/dashboard/credits", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => setCredits(d?.summary?.available ?? null))
      .catch(() => {});
    loadRuns();
  }, [id, token, loadRuns, view.kind]);

  if (job === undefined) return <p className="dash-muted">Loading…</p>;
  if (!job)
    return (
      <>
        <p className="dash-muted">Job not found.</p>
        <Link href="/dashboard">← Back to jobs</Link>
      </>
    );

  return (
    <>
      <div className="dash-crumb">
        <Link href="/dashboard">Jobs</Link> / <Link href={`/dashboard/jobs/${job.id}`}>{job.title}</Link> / Sourcing
      </div>
      <div className="dash-jobhead">
        <div>
          <h1 className="dash-h1">Source candidates</h1>
          <p className="dash-sub">{job.title} · #{job.id}</p>
        </div>
        <div className="dash-jobactions">
          {credits !== null && (
            <span className="dash-src-credits">Credits: <b>{credits.toLocaleString()}</b></span>
          )}
          {view.kind === "list" && (
            <button className="dash-btn" onClick={() => setView({ kind: "builder", initial: null })}>
              New search
            </button>
          )}
        </div>
      </div>

      {view.kind === "list" && (
        <>
          {runs === null ? (
            <p className="dash-muted">Loading searches…</p>
          ) : runs.length === 0 ? (
            <div className="dash-src-empty">
              <b>No searches yet for this job.</b>
              <p>
                Describe who you&apos;re looking for — titles, locations, ideal companies — and we&apos;ll import
                everyone on LinkedIn who matches, rank them against this job, and review the best ones.
              </p>
              <button className="dash-btn" onClick={() => setView({ kind: "builder", initial: null })}>
                Start your first search
              </button>
            </div>
          ) : (
            <div className="dash-src-runs">
              {runs.map((r) => (
                <button key={r.id} className="dash-src-runrow" onClick={() => setView({ kind: "run", runId: r.id })}>
                  <div className="when">
                    {new Date(r.created_at).toLocaleDateString([], { day: "numeric", month: "short" })}
                    <small>{new Date(r.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small>
                  </div>
                  <div className="what">
                    <span>{summarizeParams(r.search_params)}</span>
                    <small>
                      {r.imported_count + r.duplicate_count} imported · {r.screened_count} reviewed
                      {r.duplicate_count > 0 && ` · ${r.duplicate_count} already in pool`}
                    </small>
                  </div>
                  <span className={`dash-src-status s-${r.status}`}>{STATUS_LABEL[r.status] || r.status}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {view.kind === "builder" && (
        <SearchBuilder
          jobId={job.id}
          jobTitle={job.title}
          initial={view.initial}
          onStarted={(runId) => { setView({ kind: "run", runId }); loadRuns(); }}
          onCancel={() => setView({ kind: "list" })}
        />
      )}

      {view.kind === "run" && (
        <RunView
          runId={view.runId}
          onBack={() => { setView({ kind: "list" }); loadRuns(); }}
          onDuplicate={(p) => setView({ kind: "builder", initial: draftFromParams(p) })}
        />
      )}
    </>
  );
}
