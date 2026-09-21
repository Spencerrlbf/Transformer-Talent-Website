"use client";
// The verdict as a recruiter reads it: an action label, one paragraph, and a
// technologies strip (now / before / required but not shown), each chip
// marked against the role. `compact` is the table-row form: label, the first
// two sentences, five chips.
import { useState } from "react";
import { VERDICT_CLASS, VERDICT_LABEL, firstSentences, rowChips, shortRequirement, type TechChip, type VerdictView } from "@/lib/verdict-view";
import Checklist, { type VerdictFeedbackTarget } from "@/components/dashboard/rolecard/Checklist";

const reviewedOn = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

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

export default function VerdictCard({
  view,
  compact = false,
  feedback,
}: {
  view: VerdictView;
  compact?: boolean;
  /** Who and which role this verdict is for: makes the scorecard rows a
   *  one-click check-off. Without it the rows are read-only. */
  feedback?: VerdictFeedbackTarget;
}) {
  const [askOpen, setAskOpen] = useState(false);
  if (compact) {
    const chips = rowChips(view, 5);
    return (
      <div className="vc vc-compact">
        <span className={`dash-tag ${VERDICT_CLASS[view.label]}`}>{VERDICT_LABEL[view.label]}</span>
        {!!view.card?.confirm?.length && <span className="vc-confirm" title="Profiles rarely say this, so this role confirms it on a call. Everything else Required is met.">confirm {view.card.confirm.join(", ")}</span>}
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
  const hasCard = !!view.card?.rows.length;
  const moved = hasCard && view.card!.aiLabel !== view.label;
  return (
    <div className="vc">
      <div className="vc-head">
        <span className={`dash-tag ${VERDICT_CLASS[view.label]}`}>{VERDICT_LABEL[view.label]}</span>
        {!!view.card?.confirm?.length && <span className="vc-confirm" title="Profiles rarely say this, so this role confirms it on a call. Everything else Required is met.">confirm {view.card.confirm.join(", ")}</span>}
        {moved && <span className="vc-was">with confirmed rows · the AI alone read {VERDICT_LABEL[view.card!.aiLabel]}</span>}
      </div>
      {!!view.card?.facts?.length && (
        <ul className="vc-facts" title="Facts, not the AI's reading: worked out in code from the dated positions on the profile, plus the employer's own company page">
          {view.card.facts.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
      <p className="cv2d-why">{view.paragraph}</p>
      {/* With a scorecard the rows say what is missing, with evidence, and
          they stay true after a recruiter overrules one; the judge's own
          list would not. */}
      {!hasCard && view.missing.length > 0 && (
        <ul className="vc-missing">
          {view.missing.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
      {view.betterSuited && <div className="cv2d-route">↪ {view.betterSuited}</div>}
      {hasCard && <Checklist view={view} feedback={feedback} />}
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
              <div className="vc-lbl">{hasCard ? "Required, not met" : "Required, not shown"}</div>
              <div className="vc-chips">
                {gaps.map((g, i) => {
                  const label = shortRequirement(g);
                  const original = view.requirements.find((r) => r.status === "missing" && (r.requirement === g || shortRequirement(r.requirement) === label));
                  return (
                    <span className="vc-chip gap" key={`g-${i}`} title={`${hasCard ? "Required by the role: not met, or not shown on the profile or resume" : "Required by the role; no evidence on the profile or resume"}${original && original.requirement !== label ? `: ${original.requirement}` : ""}`}>
                      {label}
                    </span>
                  );
                })}
              </div>
            </>
          )}
          <div className="vc-legend">
            <span className="l-met">meets a requirement</span>
            <span className="l-eq">equivalent the role would accept</span>
            <span className="l-gap">{hasCard ? "required, not met" : "required, no evidence"}</span>
          </div>
        </div>
      )}
      {reviewedOn(view.at) && (
        <p className="vc-when" title="Years and tenure in this note are as of that day. Review again to refresh it.">
          Reviewed {reviewedOn(view.at)}
        </p>
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
