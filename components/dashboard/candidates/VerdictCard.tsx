"use client";
// The verdict as a recruiter reads it: an action label, one paragraph, and a
// technologies strip (now / before / required but not shown), each chip
// marked against the role. `compact` is the table-row form: label, the first
// two sentences, five chips.
import { useState } from "react";
import { VERDICT_CLASS, VERDICT_LABEL, firstSentences, rowChips, type TechChip, type VerdictView } from "@/lib/verdict-view";

function Chip({ c }: { c: TechChip }) {
  const title =
    c.status === "met"
      ? `Meets: ${c.evidence || "a role requirement"}`
      : c.status === "equivalent"
        ? `Equivalent the role would accept${c.evidence ? `: ${c.evidence}` : ""}`
        : c.evidence || undefined;
  return (
    <span className={`vc-chip ${c.status}`} title={title}>
      {c.name}
      {c.years != null && c.years > 0 && <span className="y">{c.years >= 10 ? Math.round(c.years) : c.years}y</span>}
    </span>
  );
}

export default function VerdictCard({ view, compact = false }: { view: VerdictView; compact?: boolean }) {
  const [askOpen, setAskOpen] = useState(false);
  if (compact) {
    const chips = rowChips(view, 5);
    return (
      <div className="vc vc-compact">
        <span className={`dash-tag ${VERDICT_CLASS[view.label]}`}>{VERDICT_LABEL[view.label]}</span>
        <p className="vc-first">{firstSentences(view.paragraph, 2)}</p>
        {chips.length > 0 && (
          <div className="vc-chips">
            {chips.map((c, i) => (
              <Chip key={`${c.name}-${i}`} c={c} />
            ))}
          </div>
        )}
      </div>
    );
  }
  const { now, before, gaps } = view.tech;
  return (
    <div className="vc">
      <div className="vc-head">
        <span className={`dash-tag ${VERDICT_CLASS[view.label]}`}>{VERDICT_LABEL[view.label]}</span>
      </div>
      <p className="cv2d-why">{view.paragraph}</p>
      {view.missing.length > 0 && (
        <ul className="vc-missing">
          {view.missing.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
      {view.betterSuited && <div className="cv2d-route">↪ {view.betterSuited}</div>}
      {(now.length > 0 || before.length > 0 || gaps.length > 0) && (
        <div className="vc-tech">
          {now.length > 0 && (
            <>
              <div className="vc-lbl">
                Now
                {view.tech.nowPosition && <small>{view.tech.nowPosition}</small>}
              </div>
              <div className="vc-chips">
                {now.map((c, i) => (
                  <Chip key={`n-${i}`} c={c} />
                ))}
              </div>
            </>
          )}
          {before.length > 0 && (
            <>
              <div className="vc-lbl">
                Before
                <small>earlier roles, or listed with no date</small>
              </div>
              <div className="vc-chips">
                {before.map((c, i) => (
                  <Chip key={`b-${i}`} c={c} />
                ))}
              </div>
            </>
          )}
          {gaps.length > 0 && (
            <>
              <div className="vc-lbl">Required, not shown</div>
              <div className="vc-chips">
                {gaps.map((g, i) => (
                  <span className="vc-chip gap" key={`g-${i}`} title="Required by the role; no evidence on the profile or resume">
                    {g}
                  </span>
                ))}
              </div>
            </>
          )}
          <div className="vc-legend">
            <span className="l-met">meets a requirement</span>
            <span className="l-eq">equivalent the role would accept</span>
            <span className="l-gap">required, no evidence</span>
          </div>
        </div>
      )}
      {view.ask.length > 0 && (
        <button type="button" className="vc-link" onClick={() => setAskOpen((o) => !o)}>
          {askOpen ? "Hide" : "Show"} questions for a first call ({view.ask.length})
        </button>
      )}
      {askOpen && (
        <div className="cv2d-probe">
          <b>Ask about</b>
          <ul>
            {view.ask.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
