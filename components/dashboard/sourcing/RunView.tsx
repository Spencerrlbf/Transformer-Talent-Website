"use client";
// A sourcing run's workspace (Option A, state 3): progress while active,
// then the ranked table with screening tags streaming in. Drives the run
// forward by calling /advance in a sequential loop while the page is open —
// the engine is resumable, so closing the tab only pauses the run.
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
  const [filter, setFilter] = useState<"all" | "strong" | "shortlisted">("all");
  const [reviewingMore, setReviewingMore] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const auth = { Authorization: `Bearer ${token}` };

  const loadRun = useCallback(async (): Promise<RunSummary | null> => {
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

  // Advance loop: sequential, only while the run is active. The server's
  // heartbeat lock makes a second open tab harmlessly observe instead.
  useEffect(() => {
    let stopped = false;
    (async () => {
      let current = await loadRun();
      await loadRows(1, filter);
      while (!stopped && alive.current && current && ACTIVE.has(current.status)) {
        try {
          const res = await fetch(`/api/dashboard/sourcing/runs/${runId}/advance`, { method: "POST", headers: auth });
          const d = res.ok ? await res.json() : { busy: true };
          if (d.busy) await new Promise((r) => setTimeout(r, 5000));
        } catch {
          await new Promise((r) => setTimeout(r, 5000));
        }
        current = await loadRun();
        await loadRows(page, filter);
      }
    })();
    return () => { stopped = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, reviewingMore]);

  // Live counters: an advance call can hold the connection for up to 40s
  // while the engine works, so poll status/rows independently — progress
  // ticks and screening chips flip in near-real-time.
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

  async function reviewMore() {
    const res = await fetch(`/api/dashboard/sourcing/runs/${runId}/screen-more`, { method: "POST", headers: auth }).catch(() => null);
    if (res?.ok) setReviewingMore((x) => !x); // re-arms the advance loop
  }

  if (!run) return <p className="dash-muted">Loading run…</p>;

  const active = ACTIVE.has(run.status);
  const totalToImport = run.match_estimate ?? 0;
  const importedSoFar = run.imported_count + run.duplicate_count;
  const stage =
    run.status === "importing" || run.status === "previewed"
      ? `Importing candidates… ${importedSoFar.toLocaleString()} of ~${totalToImport.toLocaleString()}`
      : run.status === "ranking"
        ? `Ranking ${importedSoFar.toLocaleString()} candidates…`
        : run.status === "screening"
          ? `Reviewing top candidates… ${run.screened_count} of ${run.screen_target}`
          : null;
  const pct =
    run.status === "screening"
      ? run.screen_target ? Math.round((run.screened_count / run.screen_target) * 100) : 0
      : totalToImport ? Math.min(100, Math.round((importedSoFar / totalToImport) * 100)) : 0;

  const pages = Math.max(1, Math.ceil(total / 25));

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

      {(run.status === "done" || run.status === "screening" || run.status === "ranking") && (
        <>
          <div className="dash-src-filters">
            {(["all", "strong", "shortlisted"] as const).map((f) => (
              <button
                key={f}
                className={`dash-src-fchip ${filter === f ? "on" : ""}`}
                onClick={() => { setFilter(f); setPage(1); }}
              >
                {f === "all" ? `All ${total || importedSoFar}` : f === "strong" ? "Strong fit" : "Shortlisted ★"}
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
                    </td>
                    <td>
                      {r.tag ? (
                        <>
                          <span className={`dash-tag ${TAG_UI[r.tag].cls}`}>{TAG_UI[r.tag].label}</span>
                          {r.reason && <div className="dash-src-reason">{r.reason}</div>}
                        </>
                      ) : r.screenStatus === "pending" || (active && r.rank != null && r.rank <= run.screen_target) ? (
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
              {run.status === "done" && run.screened_count >= run.screen_target && total > run.screen_target && (
                <button className="dash-btn dash-btn-2" onClick={reviewMore}>Review 50 more</button>
              )}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
