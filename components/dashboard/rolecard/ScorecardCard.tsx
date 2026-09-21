"use client";
// The role's scorecard on the job page: what every candidate for this role
// is checked against. Drafted from the job description the first time the
// role is opened; editable on every role, synced ones included.
import { useCallback, useEffect, useState } from "react";
import { useDash } from "../DashShell";
import { TIERS, TIER_LABEL, type Criterion, type Scorecard } from "@/lib/rolecard";
import ScorecardEditor, { TierIcon } from "./ScorecardEditor";

const ERR: Record<string, string> = {
  no_required_row: "Keep at least one Required row: those rows decide the label.",
  empty_scorecard: "Add at least one row before saving.",
  draft_failed: "The draft did not come back. Try again in a moment.",
  save_failed: "Saving failed. Nothing was lost; try again.",
};

export default function ScorecardCard({ jobId }: { jobId: string }) {
  const { token } = useDash();
  const [card, setCard] = useState<Scorecard | null | undefined>(undefined);
  const [rows, setRows] = useState<Criterion[] | null>(null); // non-null = editing
  const [busy, setBusy] = useState<"" | "save" | "draft">("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const call = useCallback(
    (method: "GET" | "PUT" | "POST", body?: unknown) =>
      fetch(`/api/dashboard/rolecard/${encodeURIComponent(jobId)}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    [jobId, token]
  );

  useEffect(() => {
    let live = true;
    call("GET")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setCard(d?.scorecard ?? null))
      .catch(() => live && setCard(null));
    return () => {
      live = false;
    };
  }, [call]);

  async function save() {
    if (!rows) return;
    setError("");
    setBusy("save");
    const r = await call("PUT", { scorecard: { criteria: rows } }).catch(() => null);
    const d = r ? await r.json().catch(() => null) : null;
    setBusy("");
    if (!r?.ok) return setError(ERR[d?.error] || ERR.save_failed);
    setCard(d.scorecard);
    setRows(null);
    setSaved(true);
  }

  async function draftAgain() {
    setError("");
    setBusy("draft");
    const r = await call("POST").catch(() => null);
    const d = r ? await r.json().catch(() => null) : null;
    setBusy("");
    if (!r?.ok || !d?.scorecard) return setError(ERR.draft_failed);
    setRows(d.scorecard.criteria);
  }

  return (
    <section className="rc-card">
      <div className="rc-head">
        <div>
          <div className="dash-sec">Scorecard</div>
          <p className="rc-sub">Every candidate for this role is checked against these rows. The Required rows decide the label.</p>
        </div>
        {card && !rows && (
          <button type="button" className="dash-btn dash-btn-2" onClick={() => { setRows(card.criteria); setSaved(false); }}>
            Edit
          </button>
        )}
      </div>

      {card === undefined && <p className="dash-muted">Drafting the scorecard from the job description. This takes a few seconds the first time.</p>}
      {card === null && !rows && (
        <p className="dash-muted">
          No scorecard yet.{" "}
          <button type="button" className="link" onClick={draftAgain} disabled={busy === "draft"}>
            {busy === "draft" ? "Drafting…" : "Draft one from the job description"}
          </button>
        </p>
      )}

      {card && !rows && (
        <div className="rc-read">
          {TIERS.map((tier) => {
            const list = card.criteria.filter((c) => c.tier === tier);
            if (!list.length) return null;
            return (
              <div className={`rc-tier rc-${tier}`} key={tier}>
                <div className="rc-tname">
                  <TierIcon tier={tier} />
                  {TIER_LABEL[tier]}
                </div>
                <ul>
                  {list.map((c) => (
                    <li key={c.id}>
                      <span>{c.label}</span>
                      {c.good && <small>{c.good}</small>}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <p className="rc-foot">
            {card.editedAt ? "Edited" : "Drafted from the job description"}
            {saved && " · Saved. It applies the next time people are reviewed: press Review again on a sourcing run to re-check it."}
          </p>
        </div>
      )}

      {rows && (
        <>
          <ScorecardEditor value={rows} onChange={setRows} disabled={busy !== ""} />
          {error && <p className="dash-error">{error}</p>}
          <div className="rc-actions">
            <button type="button" className="dash-btn" onClick={save} disabled={busy !== ""}>
              {busy === "save" ? "Saving…" : "Save scorecard"}
            </button>
            <button type="button" className="dash-btn dash-btn-2" onClick={() => { setRows(null); setError(""); }} disabled={busy !== ""}>
              Cancel
            </button>
            <button type="button" className="link rc-redraft" onClick={draftAgain} disabled={busy !== ""}>
              {busy === "draft" ? "Drafting…" : "Draft again from the job description"}
            </button>
          </div>
        </>
      )}
      {!rows && error && <p className="dash-error">{error}</p>}
    </section>
  );
}
