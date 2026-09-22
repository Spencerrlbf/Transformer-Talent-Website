"use client";
// The role's scorecard on the job page: what every candidate for this role
// is checked against. Drafted from the job description the first time the
// role is opened; editable on every role, synced ones included.
import { useCallback, useEffect, useRef, useState } from "react";
import { useDash } from "../DashShell";
import { TIERS, TIER_LABEL, ladderOf, metAtOf, rowKind, techSpec, type Criterion, type Scorecard } from "@/lib/rolecard";
import ScorecardEditor, { KIND_HINT, TierIcon } from "./ScorecardEditor";

const orList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);

/** How one row is decided, under its label: the kind in a few words and,
 *  where there is one, the ladder with the rung it counts from marked. A
 *  technology row's fixed ladder collapses to one line. */
export function HowDecided({ c }: { c: Criterion }) {
  const kind = rowKind(c);
  if (kind === "years") return <div className="rc-kind">{KIND_HINT.years}</div>;
  const metAt = metAtOf(c);
  if (kind === "tech") {
    const { names, accepted } = techSpec(c);
    const name = names[0]?.[0] || "The technology";
    const alts = accepted.map((g) => g[0]);
    return (
      <div className="rc-kind">
        {KIND_HINT.tech} <span className="rc-ladderline">{name} on a job ✓{alts.length > 0 && <> · {orList(alts)} ≈</>} (met from rung {metAt})</span>
      </div>
    );
  }
  return (
    <div className="rc-kind">
      {KIND_HINT.judgment}
      <ol className="rc-ladder rc-ladder-line">
        {ladderOf(c).map((rung, i) => (
          <li key={i} className={i + 1 >= metAt ? "met" : ""}>
            <span className="rc-rung">{i + 1}</span>
            {rung}
            {i + 1 === metAt && <em>met from here</em>}
          </li>
        ))}
      </ol>
    </div>
  );
}

const ERR: Record<string, string> = {
  no_required_row: "Keep at least one Required row: those rows decide the label.",
  empty_scorecard: "Add at least one row before saving.",
  draft_failed: "The draft did not come back. Try again in a moment, or write the rows by hand.",
  nothing_to_draft_from: "There is not enough written about this role to draft from. Write the rows by hand.",
  save_failed: "Saving failed. Nothing was lost; try again.",
};

type Load = "loading" | "ready" | "failed";

export default function ScorecardCard({ jobId }: { jobId: string }) {
  const { token } = useDash();
  const [load, setLoad] = useState<Load>("loading");
  const [card, setCard] = useState<Scorecard | null>(null);
  const [canDraft, setCanDraft] = useState(true);
  const [rows, setRows] = useState<Criterion[] | null>(null); // non-null = editing
  const [dirty, setDirty] = useState(false);
  const [armed, setArmed] = useState(false); // "Draft again" over edited rows: a two-step button
  const [busy, setBusy] = useState<"" | "save" | "draft">("");
  const [error, setError] = useState("");
  // What the last save changed for the people already judged, from the PUT response.
  const [saved, setSaved] = useState<{ relabelled: number; reask: number } | null>(null);
  const seq = useRef(0);

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
      .then(async (r) => {
        if (!live) return;
        if (!r.ok) return setLoad("failed");
        const d = await r.json();
        // A reload (token refresh) never replaces rows being edited.
        setCard((c) => c ?? d.scorecard ?? null);
        setCanDraft(d.canDraft !== false);
        setLoad("ready");
      })
      .catch(() => live && setLoad("failed"));
    return () => {
      live = false;
    };
  }, [call]);

  const edit = (next: Criterion[]) => {
    setRows(next);
    setDirty(true);
    setArmed(false);
  };

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
    setDirty(false);
    setSaved({ relabelled: Number(d.relabelled) || 0, reask: Number(d.reask) || 0 });
  }

  async function draftAgain() {
    // Rows someone edited are only replaced on a second, deliberate press.
    if (dirty && !armed) return setArmed(true);
    setArmed(false);
    setError("");
    setBusy("draft");
    const mine = ++seq.current;
    const r = await call("POST").catch(() => null);
    const d = r ? await r.json().catch(() => null) : null;
    if (mine !== seq.current) return;
    setBusy("");
    if (!r?.ok || !d?.scorecard) return setError(ERR[d?.error] || ERR.draft_failed);
    setRows(d.scorecard.criteria);
    setDirty(true); // unsaved until they press Save
  }

  return (
    <section className="rc-card">
      <div className="rc-head">
        <div>
          <div className="dash-sec">Scorecard</div>
          <p className="rc-sub">Every candidate for this role is checked against these rows. The Required rows decide the label.</p>
        </div>
        {card && !rows && (
          <button type="button" className="dash-btn dash-btn-2" onClick={() => { setRows(card.criteria); setDirty(false); setSaved(null); }}>
            Edit
          </button>
        )}
      </div>

      {load === "loading" && (
        <p className="dash-muted">Loading the scorecard. The first time a role is opened it is drafted from the job description, which takes a few seconds.</p>
      )}
      {load === "failed" && <p className="dash-error">The scorecard could not be loaded. Reload the page to try again.</p>}

      {load === "ready" && !card && !rows && (
        <p className="dash-muted">
          {canDraft ? "No scorecard yet. " : "There is not enough written about this role to draft a scorecard from. "}
          {canDraft && (
            <>
              <button type="button" className="link" onClick={draftAgain} disabled={busy === "draft"}>
                {busy === "draft" ? "Drafting…" : "Draft one from the job description"}
              </button>
              {" or "}
            </>
          )}
          <button type="button" className="link" onClick={() => { setRows([]); setDirty(false); }}>
            write the rows by hand
          </button>
          .
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
                      <span>
                        {c.label}
                        {c.confirmOnCall && <em className="ck-call">confirm on a call</em>}
                      </span>
                      <HowDecided c={c} />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <p className="rc-foot">
            {card.editedAt ? "Edited by your team" : card.draftedBy === "ai" ? "Drafted by AI from what is written about the role" : "Written by your team"}
            {saved && " · "}
            {saved && (
              <b className="rc-saved">
                {saved.reask > 0
                  ? `Saved. ${saved.reask} ${saved.reask === 1 ? "row" : "rows"} changed: Review again re-asks only ${saved.reask === 1 ? "that row" : "those rows"} for each person.`
                  : saved.relabelled > 0
                    ? `Saved. ${saved.relabelled} ${saved.relabelled === 1 ? "person was" : "people were"} re-labelled from their stored rows; nobody was reviewed again.`
                    : "Saved. It applies the next time people are reviewed."}
              </b>
            )}
          </p>
        </div>
      )}

      {rows && (
        <>
          <ScorecardEditor value={rows} onChange={edit} disabled={busy !== ""} />
          {error && <p className="dash-error">{error}</p>}
          <div className="rc-actions">
            <button type="button" className="dash-btn" onClick={save} disabled={busy !== ""}>
              {busy === "save" ? "Saving…" : "Save scorecard"}
            </button>
            <button type="button" className="dash-btn dash-btn-2" onClick={() => { setRows(null); setError(""); setArmed(false); setDirty(false); }} disabled={busy !== ""}>
              Cancel
            </button>
            {canDraft && (
              <span className="rc-redraft">
                {armed && <span className="rc-armed">This replaces the rows above. </span>}
                <button type="button" className="link" onClick={draftAgain} disabled={busy !== ""}>
                  {busy === "draft" ? "Drafting…" : armed ? "Yes, draft again" : "Draft again from the job description"}
                </button>
                {armed && (
                  <>
                    {" · "}
                    <button type="button" className="link" onClick={() => setArmed(false)}>
                      Keep mine
                    </button>
                  </>
                )}
              </span>
            )}
          </div>
        </>
      )}
      {!rows && error && <p className="dash-error">{error}</p>}
    </section>
  );
}
