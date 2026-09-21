"use client";
// A sourcing run's workspace: progress while active, ranked table with
// review tags streaming in. Review-all: every imported candidate gets
// reviewed. Drives the run via /advance in a sequential loop — the engine's
// lease makes concurrent drivers harmless, and the run resumes from any
// device (or the scheduled resumer) if this tab closes.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useDash } from "../DashShell";
import { TAG_UI, type CandidateRow, type RunSummary, summarizeParams } from "./types";
import VerdictCard from "../candidates/VerdictCard";
import { isCareerYearsRow, type Criterion } from "@/lib/rolecard";

const ACTIVE = new Set(["previewed", "importing", "ranking", "screening"]);

export default function RunView({
  runId, jobId, onBack, onDuplicate,
}: {
  runId: string;
  /** The role this run sourced for: a checked-off scorecard row is kept
   *  against the person and this role. */
  jobId: string;
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
  // "Review again": a two-step button, no native dialog.
  const [reviewAgainArmed, setReviewAgainArmed] = useState(false);
  const [reviewAgainBusy, setReviewAgainBusy] = useState(false);
  // The role's scorecard, to notice a Required row that profiles cannot answer.
  const [criteria, setCriteria] = useState<Criterion[] | null>(null);
  const [callBusy, setCallBusy] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`/api/dashboard/rolecard/${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setCriteria(d?.scorecard?.criteria ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [jobId, token]);
  // Rows opened to their full verdict (paragraph, strip, questions).
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const toggleOpen = (id: string) =>
    setOpenIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
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

  // Judge every visible person again with the current verdict; no new import.
  async function reviewAgain() {
    if (reviewAgainBusy) return;
    setReviewAgainBusy(true);
    const res = await fetch(`/api/dashboard/sourcing/runs/${runId}/rereview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ all: true }),
    }).catch(() => null);
    setReviewAgainBusy(false);
    setReviewAgainArmed(false);
    if (res?.ok) {
      setRows([]);
      setPage(1);
      setRereviewing((x) => !x); // re-arms the advance loop
    }
  }

  // A Required row that almost no profile here answers holds everyone at
  // "Worth a message". It is the recruiter's call to make it a question for
  // the call instead; the label then says what is left to confirm.
  const judgedRows = rows.filter((r) => r.verdict?.card?.rows.length);
  const silent = (criteria || [])
    .filter((c) => c.tier === "required" && !c.confirmOnCall && !isCareerYearsRow(c.label))
    .map((c) => {
      const marks = judgedRows.map((r) => r.verdict!.card!.rows.find((x) => x.id === c.id)?.status).filter(Boolean);
      return { c, judged: marks.length, unknown: marks.filter((m) => m === "unknown").length };
    })
    .find((x) => x.judged >= 8 && x.unknown / x.judged >= 0.8);

  async function makeCallQuestion(id: string) {
    if (!criteria || callBusy) return;
    setCallBusy(true);
    const next = criteria.map((c) => (c.id === id ? { ...c, confirmOnCall: true } : c));
    const res = await fetch(`/api/dashboard/rolecard/${encodeURIComponent(jobId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ scorecard: { criteria: next } }),
    }).catch(() => null);
    setCallBusy(false);
    if (!res?.ok) return;
    setCriteria(next);
    // Nobody is judged again: saved verdicts are re-labelled under the new setting.
    await reviewAgain();
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
        <div className="dash-run-progress">
          <div className="dash-src-progtop">
            <b>{stage}</b>
            <span>
              {run.duplicate_count > 0 && `${run.duplicate_count} already in your pool (free) · `}
              started {new Date(run.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
          </div>
          <div className="bar"><i style={{ width: `${pct}%` }} /></div>
        </div>
      )}

      {run.status === "done" && (
        <div className="dash-src-again">
          {reviewAgainArmed ? (
            <>
              <span>
                Judge all {(total || importedSoFar).toLocaleString()} people again with the current verdict. No new import; a few cents of AI per person.
              </span>
              <button className="dash-btn" onClick={reviewAgain} disabled={reviewAgainBusy}>
                {reviewAgainBusy ? "Starting…" : "Yes, review again"}
              </button>
              <button className="dash-btn dash-btn-2" onClick={() => setReviewAgainArmed(false)} disabled={reviewAgainBusy}>
                Cancel
              </button>
            </>
          ) : (
            <button className="dash-btn dash-btn-2" onClick={() => setReviewAgainArmed(true)} title="Judge everyone in this run again with the current verdict">
              Review again
            </button>
          )}
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
          <div className="dash-seg dash-src-seg" role="tablist" aria-label="Review filter">
            {(["all", "strong", "yes", "message", "shortlisted"] as const).map((f) => (
              <button
                key={f}
                className={filter === f ? "on" : ""}
                onClick={() => { setFilter(f); setPage(1); }}
              >
                {f === "all" ? `All ${total || importedSoFar}`
                  : f === "strong" ? "Contact now"
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
            <>
            {silent && !active && (
              <div className="dash-src-callhint">
                <span>
                  <b>{silent.c.label}</b>: {silent.unknown} of {silent.judged} profiles here do not say. LinkedIn rarely does, and it is holding people at Worth a message.
                </span>
                <button type="button" className="dash-btn dash-btn-2" disabled={callBusy || reviewAgainBusy} onClick={() => makeCallQuestion(silent.c.id)}>
                  {callBusy ? "Saving…" : "Make it a question for the call"}
                </button>
              </div>
            )}
            <table className="dash-src-table">
              <thead>
                <tr><th></th><th>Candidate</th><th>Review</th><th></th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.membershipId}>
                  <tr className={r.hidden ? "is-hidden" : ""}>
                    <td className="rk">{r.rank ?? "–"}</td>
                    <td>
                      <span className="nm">{r.name}</span>
                      <div className="sub">{[r.title, r.company, r.location].filter(Boolean).join(" · ")}</div>
                      {(r.years != null || r.priorCompanies.length > 0 || (!r.verdict && r.topSkills.length > 0)) && (
                        <div className="dash-src-snapshot">
                          {[
                            r.years != null ? `${r.years} yrs` : null,
                            r.priorCompanies.length ? `prev: ${r.priorCompanies.join(", ")}` : null,
                            // The verdict's chips replace LinkedIn's self-declared skill list.
                            !r.verdict && r.topSkills.length
                              ? r.topSkills.join(", ") + (r.skillCount > r.topSkills.length ? ` +${r.skillCount - r.topSkills.length}` : "")
                              : null,
                          ].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </td>
                    <td>
                      {r.verdict ? (
                        <>
                          <VerdictCard view={r.verdict} compact />
                          <button type="button" className="dash-src-fullbtn" onClick={() => toggleOpen(r.membershipId)}>
                            {openIds.has(r.membershipId) ? "Hide full verdict ▴" : "Full verdict ▾"}
                          </button>
                        </>
                      ) : r.tag ? (
                        <>
                          <span className={`dash-tag ${TAG_UI[r.tag]?.cls || "t-pending"}`}>{TAG_UI[r.tag]?.label || r.tag}</span>
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
                  {r.verdict && openIds.has(r.membershipId) && (
                    <tr className={`dash-src-full${r.hidden ? " is-hidden" : ""}`}>
                      <td></td>
                      <td colSpan={4}>
                        <VerdictCard
                          view={r.verdict}
                          feedback={{
                            candidateKey: r.candidateKey,
                            jobId,
                            membershipId: r.membershipId,
                            onChanged: (view) =>
                              setRows((rs) => rs.map((x) => (x.membershipId === r.membershipId ? { ...x, verdict: view, tag: view.label } : x))),
                          }}
                        />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            </>
          )}

          <div className="dash-src-tfoot">
            <span>
              {total > 0 && `Showing ${(page - 1) * 25 + 1}–${Math.min(page * 25, total)} of ${total} · best fit first: by label, then how strongly the scorecard is met`}
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
