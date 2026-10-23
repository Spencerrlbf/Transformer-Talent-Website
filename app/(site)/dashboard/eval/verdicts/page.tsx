"use client";
// Owner-only: today's fit verdict beside the proposed one-paragraph verdict,
// for the same real people and roles, with a vote per row. The votes decide
// whether the new judge ships; nothing here changes what the product shows.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import type { EvalRow } from "@/lib/server/verdict-eval";
import type { Verdict, VerdictLabel } from "@/lib/server/verdict";

type Data = { rows: EvalRow[]; models: string[]; defaultModel: string };

const OLD_CLASS: Record<string, string> = {
  strong_yes: "t-strong",
  yes: "t-yes",
  worth_message: "t-possible",
  not_now: "t-stretch",
  strong: "t-strong",
  possible: "t-possible",
  stretch: "t-stretch",
};
const NEW_LABEL: Record<VerdictLabel, string> = { contact: "Contact now", message: "Worth a message", pass: "Pass" };
const NEW_CLASS: Record<VerdictLabel, string> = { contact: "t-strong", message: "t-yes", pass: "t-stretch" };

// Stored sourced reasons are "<why> Worth asking: <a · b> → <route>"; show
// them the way the drawer does today.
function splitReason(reason: string): { why: string; probes: string[]; route: string | null } {
  let rest = reason;
  let route: string | null = null;
  const routeIdx = rest.lastIndexOf(" → ");
  if (routeIdx !== -1) {
    route = rest.slice(routeIdx + 3).trim() || null;
    rest = rest.slice(0, routeIdx);
  }
  let probes: string[] = [];
  const probeIdx = rest.indexOf("Worth asking:");
  if (probeIdx !== -1) {
    probes = rest.slice(probeIdx + "Worth asking:".length).split(" · ").map((s) => s.trim()).filter(Boolean);
    rest = rest.slice(0, probeIdx);
  }
  return { why: rest.trim(), probes, route };
}

function OldVerdict({ old }: { old: EvalRow["old"] }) {
  const { why, probes, route } = splitReason(old.reason || "");
  const sc = old.scorecard;
  return (
    <>
      <div className="ve-tagrow">
        {old.tag ? <span className={`dash-tag ${OLD_CLASS[old.tag] || "t-pending"}`}>{old.label}</span> : <span className="dash-tag t-pending">—</span>}
        <span className="ve-engine">{old.engine === "judge" ? "sourcing judge" : "screening checklist"}</span>
      </div>
      {why ? <p className="cv2d-why">{why}</p> : <p className="cv2d-why cv2d-dim">No reason stored.</p>}
      {probes.length > 0 && (
        <div className="cv2d-probe">
          <b>Worth asking about</b>
          <ul>
            {probes.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {route && <div className="cv2d-route">↪ {route}</div>}
      {sc && (
        <p className="ve-fine">
          {sc.reason}
          {sc.gaps?.length ? ` · gaps: ${sc.gaps.slice(0, 3).join("; ")}` : ""}
        </p>
      )}
    </>
  );
}

function NewVerdict({ v }: { v: Verdict | undefined }) {
  const [askOpen, setAskOpen] = useState(false);
  if (!v) return <p className="cv2d-why cv2d-dim">Not run yet for this model.</p>;
  return (
    <>
      <div className="ve-tagrow">
        <span className={`dash-tag ${NEW_CLASS[v.label]}`}>{NEW_LABEL[v.label]}</span>
        <span className="ve-engine">{v.paragraph.split(/\s+/).length} words</span>
      </div>
      <p className="cv2d-why">{v.paragraph}</p>
      {v.missing.length > 0 && (
        <ul className="ve-miss">
          {v.missing.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
      {v.betterSuited && <div className="cv2d-route">↪ {v.betterSuited}</div>}
      {v.ask.length > 0 && (
        <button type="button" className="ve-link" onClick={() => setAskOpen((o) => !o)}>
          {askOpen ? "Hide" : "Show"} questions for a first call ({v.ask.length})
        </button>
      )}
      {askOpen && (
        <div className="cv2d-probe">
          <b>Ask about</b>
          <ul>
            {v.ask.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="ve-fine">
        {v.model} · {(v.ms / 1000).toFixed(1)}s · {v.usage.input + v.usage.output} tokens
      </p>
    </>
  );
}

export default function VerdictEvalPage() {
  const { token } = useDash();
  const auth = useMemo(() => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }), [token]);
  const [data, setData] = useState<Data | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState<"" | "build" | "run">("");
  const [progress, setProgress] = useState("");
  const [kind, setKind] = useState<"all" | "sourced" | "applicant">("all");

  const load = useCallback(async () => {
    const r = await fetch("/api/dashboard/eval/verdicts", { headers: auth, cache: "no-store" }).catch(() => null);
    if (!r) {
      setError("Couldn't load. Refresh to try again.");
      return null;
    }
    if (r.status === 403) {
      setForbidden(true);
      return null;
    }
    const d = (await r.json().catch(() => null)) as Data | null;
    if (!d) {
      setError("Couldn't load. Refresh to try again.");
      return null;
    }
    setData(d);
    setModel((m) => m || d.defaultModel);
    return d;
  }, [auth]);
  useEffect(() => {
    load();
  }, [load]);

  const post = async (body: Record<string, unknown>) => {
    const r = await fetch("/api/dashboard/eval/verdicts", { method: "POST", headers: auth, body: JSON.stringify(body) }).catch(() => null);
    const j = ((await r?.json().catch(() => ({}))) || {}) as Record<string, unknown>;
    return { ok: Boolean(r?.ok && j.ok), j };
  };

  const build = async () => {
    setBusy("build");
    setError("");
    const { ok, j } = await post({ action: "build" });
    setBusy("");
    if (!ok) {
      setError(`Couldn't build the set${j.error ? `: ${String(j.error)}` : ""}.`);
      return;
    }
    setProgress(`${j.added} added · ${j.total} in the set`);
    load();
  };

  const run = async () => {
    setBusy("run");
    setError("");
    let stalled = 0;
    for (let i = 0; i < 40; i++) {
      const { ok, j } = await post({ action: "run", model });
      if (!ok) {
        setError(`Run failed${j.error ? `: ${String(j.error)}` : ""}.`);
        break;
      }
      const remaining = Number(j.remaining || 0);
      const done = Number(j.done || 0);
      setProgress(`${remaining} left for ${model}${Number(j.failed) ? ` · ${j.failed} failed this pass` : ""}`);
      await load();
      if (remaining <= 0) {
        setProgress(`Done for ${model}`);
        break;
      }
      if (done === 0) {
        stalled++;
        if (stalled >= 2) {
          setError(`${remaining} rows could not be judged (no stored profile, or the model errored). The rest are in.`);
          break;
        }
      } else stalled = 0;
    }
    setBusy("");
  };

  const vote = async (id: string, v: "new" | "old" | "neither") => {
    setData((d) => (d ? { ...d, rows: d.rows.map((r) => (r.id === id ? { ...r, votes: { ...r.votes, [model]: v } } : r)) } : d));
    const { ok } = await post({ action: "vote", id, model, vote: v });
    if (!ok) {
      setError("Couldn't save that vote.");
      load();
    }
  };

  if (forbidden) {
    return (
      <div className="ve-wrap">
        <h1>Verdict comparison</h1>
        <p className="ve-intro">This page is for the organization owner.</p>
      </div>
    );
  }

  const rows = (data?.rows || []).filter((r) => kind === "all" || r.kind === kind);
  const withRun = rows.filter((r) => r.runs[model]);
  const tally = { new: 0, old: 0, neither: 0 };
  for (const r of rows) {
    const v = r.votes[model];
    if (v === "new" || v === "old" || v === "neither") tally[v]++;
  }
  const models = data ? [...new Set([data.defaultModel, ...data.models, ...(model ? [model] : [])])] : [];

  return (
    <div className="ve-wrap">
      <h1>Verdict comparison</h1>
      <p className="ve-intro">
        Real people and roles from your own runs and applications. Left is what the product shows today. Right is the proposed verdict: an action label and one short paragraph. Vote on each row; the votes decide whether the new one ships. Nothing here changes what the product shows or contacts anyone.
      </p>
      <div className="ve-bar">
        <button type="button" className="dash-btn dash-btn-2" onClick={build} disabled={busy !== ""}>
          {busy === "build" ? "Building…" : data?.rows.length ? "Refresh the set" : "Build the set"}
        </button>
        <label className="ve-model">
          Model
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy !== ""}>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="dash-btn" onClick={run} disabled={busy !== "" || !data?.rows.length}>
          {busy === "run" ? "Judging…" : `Run ${model || "the judge"}`}
        </button>
        <span className="ve-progress">{progress}</span>
      </div>
      <div className="ve-bar">
        <span className="ve-tally">
          <b>{rows.length}</b> rows · <b>{withRun.length}</b> judged · votes: new <b>{tally.new}</b> · old <b>{tally.old}</b> · neither <b>{tally.neither}</b>
        </span>
        <span className="ve-filter">
          {(["all", "sourced", "applicant"] as const).map((k) => (
            <button type="button" key={k} className={`ibs-btn${kind === k ? " pri" : ""}`} onClick={() => setKind(k)}>
              {k === "all" ? "All" : k === "sourced" ? "Sourced" : "Applied"}
            </button>
          ))}
        </span>
      </div>
      {error && <p className="cv2d-err">{error}</p>}
      {data && data.rows.length === 0 && <p className="ve-intro">No rows yet. Build the set first.</p>}
      {rows.map((r) => {
        const v = r.votes[model];
        return (
          <section className="ve-card" key={r.id}>
            <div className="ve-person">
              <div className="nm">{r.person.name}</div>
              <div className="sub">{[r.person.title, r.person.company].filter(Boolean).join(" · ")}</div>
              <div className="sub">
                {[r.person.location, r.person.years != null ? `${r.person.years} yrs` : null].filter(Boolean).join(" · ")}
              </div>
              <div className="ve-role">
                <span className="dash-tag t-pending">{r.kind === "sourced" ? "sourced" : "applied"}</span> {r.roleTitle}
              </div>
              {r.person.linkedinUrl && (
                <a className="ve-link" href={r.person.linkedinUrl} target="_blank" rel="noreferrer">
                  LinkedIn ↗
                </a>
              )}
            </div>
            <div className="ve-col">
              <h4>Today</h4>
              <OldVerdict old={r.old} />
            </div>
            <div className="ve-col">
              <h4>Proposed</h4>
              <NewVerdict v={r.runs[model]} />
            </div>
            <div className="ve-vote">
              <span>Which is more useful?</span>
              {(["new", "old", "neither"] as const).map((opt) => (
                <button
                  type="button"
                  key={opt}
                  className={`ibs-btn${v === opt ? " pri" : ""}`}
                  disabled={!r.runs[model]}
                  onClick={() => vote(r.id, opt)}
                >
                  {opt === "new" ? "Proposed" : opt === "old" ? "Today's" : "Neither"}
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
