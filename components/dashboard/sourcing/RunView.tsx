"use client";
// A sourcing run's workspace: progress while active, ranked table with
// review tags streaming in. Review-all: every imported candidate gets
// reviewed. Drives the run via /advance in a sequential loop — the engine's
// lease makes concurrent drivers harmless, and the run resumes from any
// device (or the scheduled resumer) if this tab closes.
import { useCallback, useEffect, useRef, useState } from "react";
import { useDash } from "../DashShell";
import { TAG_UI, type CandidateRow, type RunSummary, summarizeParams } from "./types";

const ACTIVE = new Set(["previewed", "importing", "ranking", "screening"]);

export default function RunView({
  runId, onBack, onDuplicate,
}: {
  runId: string;
  onBack: () => void;
  onDuplicate: (params: Record<string, unknown>) => void;
}) {
  const { token } = useDash();
  const [run, setRun] = useState<RunSummary | null>(null);
  const [rows, setRows] = useState<CandidateRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<"all" | "strong" | "yes" | "message" | "shortlisted">("all");
  const [rereviewing, setRereviewing] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true; // StrictMode remounts reuse the ref — re-arm it
    return () => { alive.current = false; };
  }, []);

  const auth = { Authorization: `Bearer ${token}` };

  const loadRun = useCallback(async (): Promise<RunSummary | null> => {
    // Transient failures return null — callers RETRY, never give up.
    const res = await fetch(`/api/dashboard/sourcing/runs/${runId}`, { headers: auth }).catch(() => null);
    if (!res?.ok) return null;
    const d = await res.json();
    if (alive.current) setRun(d.run);
    return d.run;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, token]);

  const loadRows = useCallback(async (p = page, f = filter) => {
    const res = await fetch(
      `/api/dashboard/sourcing/runs/${runId}/candidates?page=${p}&filter=${f}`,
      { headers: auth }
    ).catch(() => null);
    if (!res?.ok) return;
    const d = await res.json();
    if (alive.current) { setRows(d.candidates); setTotal(d.total); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, token, page, filter]);

  // Advance loop: strictly sequential; a busy response (another driver, or
  // a persisted pacing pause) waits it out; transient blips retry.
  useEffect(() => {
    let stopped = false;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      let current: RunSummary | null = null;
      for (let i = 0; i < 5 && !current; i++) {
        current = await loadRun();
        if (!current) await sleep(3000);
      }
      await loadRows(1, filter);
      while (!stopped && alive.current && current && ACTIVE.has(current.status)) {
        try {
          const res = await fetch(`/api/dashboard/sourcing/runs/${runId}/advance`, { method: "POST", headers: auth });
          const d = res.ok ? await res.json() : { busy: true };
          if (d.busy) await sleep(Math.min(d.retryAfterMs ?? 5000, 60_000));
        } catch {
          await sleep(8000);
        }
        current = (await loadRun()) ?? current; // a failed poll never kills the driver
        await loadRows(page, filter);
      }
    })();
    return () => { stopped = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, rereviewing]);

  // Live counters, independent of the (long-blocking) advance calls.
  useEffect(() => {
    if (!run || !ACTIVE.has(run.status)) return;
    const t = setInterval(() => { loadRun(); loadRows(page, filter); }, 4000);
    return () => clearInterval(t);
  }, [run, page, filter, loadRun, loadRows]);

  useEffect(() => { loadRows(page, filter); }, [page, filter, loadRows]);

  async function rowAction(row: CandidateRow, patch: { shortlisted?: boolean; hidden?: boolean }) {
    setRows((rs) => rs.map((r) => (r.membershipId === row.membershipId ? { ...r, ...patch } : r)));
    await fetch(`/api/dashboard/sourcing/runs/${runId}/candidates`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ membershipId: row.membershipId, ...patch }),
    }).catch(() => {});
    if (patch.hidden) loadRows(page, filter);
  }

  async function rereviewFailed() {
    const res = await fetch(`/api/dashboard/sourcing/runs/${runId}/rereview`, { method: "POST", headers: auth }).catch(() => null);
    if (res?.ok) setRereviewing((x) => !x); // re-arms the advance loop
  }

  if (!run) return <p className="dash-muted">Loading run…</p>;

  const active = ACTIVE.has(run.status);
  const totalToImport = run.match_estimate ?? 0;
  const importedSoFar = run.imported_count + run.duplicate_count;
  const reviewTotal = run.screen_target || importedSoFar;
  const stage =
    run.status === "importing" || run.status === "previewed"
      ? `Importing candidates… ${importedSoFar.toLocaleString()} of ~${totalToImport.toLocaleString()}`
      : run.status === "ranking"
        ? `Ranking ${importedSoFar.toLocaleString()} candidates…`
        : run.status === "screening"
          ? `Reviewing every candidate… ${run.screened_count.toLocaleString()} of ${reviewTotal.toLocaleString()}`
          : null;
  const pct =
    run.status === "screening"
      ? reviewTotal ? Math.round((run.screened_count / reviewTotal) * 100) : 0
      : totalToImport ? Math.min(100, Math.round((importedSoFar / totalToImport) * 100)) : 0;

  const pages = Math.max(1, Math.ceil(total / 25));
  const unreviewable = run.unreviewable ?? 0;

  return (
    <div>
      <div className="dash-src-runhead">
        <button className="dash-src-back" onClick={onBack}>← All searches</button>
        <button className="dash-btn dash-btn-2" onClick={() => onDuplicate(run.search_params)}>Duplicate search</button>
      </div>
      <p className="dash-src-summary">{summarizeParams(run.search_params)}</p>

      {run.status === "failed" && (
        <div className="dash-src-preview broad">
          <b>This run hit a problem and stopped</b>
          <p>{run.error || "Unknown error."} Your imported candidates are safe — duplicate the search to continue; already-imported people aren&apos;t charged again.</p>
        </div>
      )}

      {active && stage && (
        <div className="dash-src-prog">
          <div className="dash-src-progtop">
            <b>{stage}</b>
            <span>
              {run.duplicate_count > 0 && `${run.duplicate_count} already in your pool (free) · `}
              started {new Date(run.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
          </div>
          <div className="dash-src-bar"><i style={{ width: `${pct}%` }} /></div>
        </div>
      )}

      {run.status === "done" && unreviewable > 0 && (
        <div className="dash-src-preview broad">
          <b>{unreviewable} candidate{unreviewable === 1 ? "" : "s"} couldn&apos;t be reviewed</b>
          <p>
            Usually a temporary AI hiccup or an empty LinkedIn profile.{" "}
            <button className="dash-btn dash-btn-2" onClick={rereviewFailed}>Retry review</button>
          </p>
        </div>
      )}

      {(run.status === "done" || run.status === "screening" || run.status === "ranking") && (
        <>
          <div className="dash-src-filters">
            {(["all", "strong", "yes", "message", "shortlisted"] as const).map((f) => (
              <button
                key={f}
                className={`dash-src-fchip ${filter === f ? "on" : ""}`}
                onClick={() => { setFilter(f); setPage(1); }}
              >
                {f === "all" ? `All ${total || importedSoFar}`
                  : f === "strong" ? "Strong yes"
                  : f === "yes" ? "Yes"
                  : f === "message" ? "Worth a message"
                  : "Shortlisted ★"}
              </button>
            ))}
          </div>

          {rows.length === 0 ? (
            <p className="dash-muted">
              {run.status === "ranking" ? "Ranking — results appear in a moment…" : "Nothing here yet."}
            </p>
          ) : (
            <table className="dash-src-table">
              <thead>
                <tr><th></th><th>Candidate</th><th>Review</th><th></th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.membershipId} className={r.hidden ? "is-hidden" : ""}>
                    <td className="rk">{r.rank ?? "–"}</td>
                    <td>
                      <span className="nm">{r.name}</span>
                      <div className="sub">{[r.title, r.company, r.location].filter(Boolean).join(" · ")}</div>
                      {(r.years != null || r.priorCompanies.length > 0 || r.topSkills.length > 0) && (
                        <div className="dash-src-snapshot">
                          {[
                            r.years != null ? `${r.years} yrs` : null,
                            r.priorCompanies.length ? `prev: ${r.priorCompanies.join(", ")}` : null,
                            r.topSkills.length
                              ? r.topSkills.join(", ") + (r.skillCount > r.topSkills.length ? ` +${r.skillCount - r.topSkills.length}` : "")
                              : null,
                          ].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </td>
                    <td>
                      {r.tag ? (
                        <>
                          <span className={`dash-tag ${TAG_UI[r.tag].cls}`}>{TAG_UI[r.tag].label}</span>
                          {r.reason && <div className="dash-src-reason">{r.reason}</div>}
                        </>
                      ) : r.screenStatus === "failed" && !active ? (
                        <span className="dash-src-unreviewed">couldn&apos;t review</span>
                      ) : active ? (
                        <span className="dash-tag t-pending">Reviewing…</span>
                      ) : (
                        <span className="dash-src-unreviewed">—</span>
                      )}
                    </td>
                    <td>
                      {r.linkedinUrl && (
                        <a className="dash-src-li" href={r.linkedinUrl} target="_blank" rel="noreferrer">LinkedIn ↗</a>
                      )}
                    </td>
                    <td className="dash-src-rowact">
                      <button
                        title={r.shortlisted ? "Remove from shortlist" : "Shortlist"}
                        className={r.shortlisted ? "on" : ""}
                        onClick={() => rowAction(r, { shortlisted: !r.shortlisted })}
                      >★</button>
                      <button title="Hide" onClick={() => rowAction(r, { hidden: true })}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="dash-src-tfoot">
            <span>
              {total > 0 && `Showing ${(page - 1) * 25 + 1}–${Math.min(page * 25, total)} of ${total} · ranked best match first`}
            </span>
            <span className="dash-src-pager">
              {page > 1 && <button className="dash-btn dash-btn-2" onClick={() => setPage(page - 1)}>← Prev</button>}
              {page < pages && <button className="dash-btn dash-btn-2" onClick={() => setPage(page + 1)}>Next →</button>}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
