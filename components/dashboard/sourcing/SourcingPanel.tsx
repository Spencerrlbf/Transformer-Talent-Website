"use client";
// Sourcing panel for one job, rendered inside the job workspace's Sourcing
// tab: runs list (home) → guided search builder → run workspace.
import { useCallback, useEffect, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import SearchBuilder, { type CreditSummary } from "@/components/dashboard/sourcing/SearchBuilder";
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

export default function SourcingPanel({ jobId, jobTitle }: { jobId: string; jobTitle: string }) {
  const { token } = useDash();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [credits, setCredits] = useState<CreditSummary | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });

  const loadRuns = useCallback(() => {
    fetch(`/api/dashboard/sourcing/runs?jobId=${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => (r.ok ? r.json() : { runs: [] }))
      .then((d) => setRuns(d.runs))
      .catch(() => setRuns([]));
  }, [jobId, token]);

  useEffect(() => {
    fetch("/api/dashboard/credits", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => setCredits(d?.summary ?? null))
      .catch(() => {});
    loadRuns();
  }, [token, loadRuns, view.kind]);

  return (
    <>
      {view.kind === "list" && (
        <>
          <div className="dash-src-panelbar">
            <span className="dash-muted">
              {runs === null
                ? "Loading searches…"
                : runs.length === 0
                  ? ""
                  : `${runs.length} search${runs.length === 1 ? "" : "es"} for this job`}
            </span>
            <span className="spacer" />
            {credits !== null && (
              <span className="dash-src-credits">Credits: <b>{credits.available.toLocaleString()}</b></span>
            )}
            <button className="dash-btn" onClick={() => setView({ kind: "builder", initial: null })}>
              New search
            </button>
          </div>
          {runs !== null && runs.length === 0 && (
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
          )}
          {runs !== null && runs.length > 0 && (
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
          jobId={jobId}
          jobTitle={jobTitle}
          initial={view.initial}
          credits={credits}
          runsCount={runs?.length ?? 0}
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
