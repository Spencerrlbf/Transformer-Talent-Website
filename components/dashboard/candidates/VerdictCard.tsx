"use client";
// The verdict as a recruiter reads it. With a scorecard it is the report
// card: on top, the label, the one-line bottom line and the decision beside
// the facts block; below, the career and the skills on the left, and on the
// right the review as bullets with evidence tags, then the judged checklist.
// `compact` is the table-row form: label, the rows in one line, the bottom
// line. A verdict without a card (older reviews) renders the old way: label,
// paragraph, strip. Older cards without a profile, skills or a bulleted
// review fall back piece by piece to what they do carry.
import { useId, useState } from "react";
import { VERDICT_CLASS, VERDICT_LABEL, firstSentences, rowChips, shortRequirement, type TechChip, type VerdictView } from "@/lib/verdict-view";
import { rowSummary } from "@/lib/rolecard";
import Checklist, { anchorScopeOf, type VerdictFeedbackTarget } from "@/components/dashboard/rolecard/Checklist";
import FactsBlock from "./FactsBlock";
import CareerList from "./CareerList";
import SkillsTable from "./SkillsTable";
import ReviewBullets, { BottomLine } from "./ReviewBullets";

/** Yes or No on this person for this role, where the row on screen can hold
 *  it (a sourcing run's membership). Yes shortlists them; No hides them. */
export interface Decision {
  shortlisted: boolean;
  hidden: boolean;
  onYes: () => void;
  onNo: () => void;
}

/** "Review again" for someone who applied, held by the drawer. */
export interface ReviewControl {
  busy: boolean;
  error: string;
  run: () => void;
}

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

/** The technologies strip: what the person uses now and used before, and
 *  what the role requires that was not found. Shown on verdicts written
 *  before the profile carried a skills table. */
function TechStrip({ view }: { view: VerdictView }) {
  const { now, before, gaps } = view.tech;
  const hasCard = !!view.card?.rows.length;
  if (!(now.length > 0 || before.length > 0 || gaps.length > 0)) return null;
  return (
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
  );
}

function DecideButtons({ d }: { d: Decision }) {
  return (
    <div className="vc-decide" role="group" aria-label="Your decision">
      <button type="button" className={`dash-btn vc-yes${d.shortlisted ? " on" : ""}`} aria-pressed={d.shortlisted} onClick={d.onYes} title={d.shortlisted ? "Shortlisted. Press to take it back." : "Shortlist this person and reach out"}>
        {d.shortlisted ? "✓ Yes · shortlisted" : "Yes · shortlist and reach out"}
      </button>
      <button type="button" className={`dash-btn dash-btn-2 vc-no${d.hidden ? " on" : ""}`} aria-pressed={d.hidden} onClick={d.onNo} title={d.hidden ? "Hidden from this run. Press to bring them back." : "Not this person: hide them from this run"}>
        {d.hidden ? "✓ No" : "No"}
      </button>
    </div>
  );
}

/** The questions for a first call, on a verdict written before the review
 *  folded them into its bullets. */
function AskList({ ask }: { ask: string[] }) {
  if (!ask.length) return null;
  return (
    <div className="cv2d-probe vc-ask">
      <b>Ask on a first call</b>
      <ul>
        {ask.map((q, i) => (
          <li key={i}>{q}</li>
        ))}
      </ul>
    </div>
  );
}

export default function VerdictCard({
  view,
  compact = false,
  feedback,
  decision,
  review,
}: {
  view: VerdictView;
  compact?: boolean;
  /** Who and which role this verdict is for: makes the scorecard rows a
   *  one-click check-off. Without it the rows are read-only. */
  feedback?: VerdictFeedbackTarget;
  /** Yes or No on the person, when the row on screen can hold it. */
  decision?: Decision;
  /** "Review again", when the person can be reviewed from here. */
  review?: ReviewControl;
}) {
  const [askOpen, setAskOpen] = useState(false);
  // This card's scope for its checklist anchors: two cards on one page (a
  // run table can show two with the same rows) never share a row id.
  const anchorScope = anchorScopeOf(useId());
  const card = view.card;
  const hasCard = !!card?.rows.length;
  const summary = hasCard ? rowSummary(card!.rows) : "";
  // The bulleted review, when the verdict carries one with anything in it;
  // the paragraph stands in for older verdicts.
  const bullets = card?.review && (card.review.fits.length > 0 || card.review.gaps.length > 0) ? card.review : null;
  const bottomLine = card?.review?.bottomLine?.trim() || "";
  // The paragraph opens with the bottom line (for older readers). With the
  // bottom line already on top, only the rest of it stands in for a review.
  const paragraph = bottomLine && view.paragraph.trim().startsWith(bottomLine) ? view.paragraph.trim().slice(bottomLine.length).trim() : view.paragraph.trim();

  if (compact) {
    if (!hasCard) {
      // An older review, written before the role had a scorecard.
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
    return (
      <div className="vc vc-compact">
        <span className={`dash-tag ${VERDICT_CLASS[view.label]}`}>{VERDICT_LABEL[view.label]}</span>
        {!!card?.confirm?.length && <span className="vc-confirm" title="Profiles rarely say this, so this role confirms it on a call. Everything else Required is met.">confirm {card.confirm.join(", ")}</span>}
        {summary && (
          <p className="vc-summary" title="Every Required row, then the Exceptional and Bonus rows that are met">
            {summary}
          </p>
        )}
        {/* Without a bulleted review the paragraph's first sentence stands in. */}
        {(bottomLine || firstSentences(view.paragraph, 1).trim()) && <BottomLine text={bottomLine || firstSentences(view.paragraph, 1).trim()} />}
      </div>
    );
  }

  const moved = hasCard && card!.aiLabel !== view.label;
  const head = (
    <div className="vc-head">
      <span className={`dash-tag ${VERDICT_CLASS[view.label]}`}>{VERDICT_LABEL[view.label]}</span>
      {!!card?.confirm?.length && <span className="vc-confirm" title="Profiles rarely say this, so this role confirms it on a call. Everything else Required is met.">confirm {card.confirm.join(", ")}</span>}
      {moved && <span className="vc-was">with confirmed rows · the AI alone read {VERDICT_LABEL[card!.aiLabel]}</span>}
    </div>
  );
  const when = reviewedOn(view.at) && (
    <p className="vc-when" title="Years and tenure on this card are as of that day. Review again to refresh it.">
      Reviewed {reviewedOn(view.at)}
    </p>
  );
  const reviewLink = review && (
    <p className="vc-review-again">
      <button type="button" className="ck-link" onClick={review.run} disabled={review.busy}>
        {review.busy ? "Reviewing their LinkedIn profile and resume, about 20 seconds…" : "Review again · re-asks only changed rows"}
      </button>
      {review.error && <span className="dash-error"> {review.error}</span>}
    </p>
  );

  if (!hasCard) {
    // An older review, written before the role had a scorecard.
    return (
      <div className="vc">
        {head}
        <p className="cv2d-why">{view.paragraph}</p>
        {view.missing.length > 0 && (
          <ul className="vc-missing">
            {view.missing.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        )}
        {view.betterSuited && <div className="cv2d-route">↪ {view.betterSuited}</div>}
        <TechStrip view={view} />
        {when}
        {view.ask.length > 0 && (
          <button type="button" className="vc-link" onClick={() => setAskOpen((o) => !o)}>
            {askOpen ? "Hide" : "Show"} questions for a first call ({view.ask.length})
          </button>
        )}
        {askOpen && <AskList ask={view.ask} />}
        {decision && <DecideButtons d={decision} />}
        {reviewLink}
      </div>
    );
  }

  const profile = card!.profile;
  return (
    <div className="vc vc-report">
      <div className="vc-top">
        <div className="vc-top-main">
          {head}
          {bottomLine && <BottomLine text={bottomLine} />}
          {decision && <DecideButtons d={decision} />}
        </div>
        {profile && <FactsBlock p={profile} />}
      </div>
      <div className="vc-body">
        <div className="vc-who">
          {profile ? (
            <>
              <section className="vc-rsec">
                <h4 className="vc-sec">Career</h4>
                <CareerList p={profile} />
              </section>
              {profile.skills ? (
                <section className="vc-rsec">
                  <h4 className="vc-sec">Skills, from the jobs they were used on</h4>
                  <SkillsTable skills={profile.skills} companies={profile.companies} />
                </section>
              ) : (
                <TechStrip view={view} />
              )}
            </>
          ) : (
            <>
              {!!card!.facts?.length && (
                <ul className="vc-facts" title="Facts, not the AI's reading: worked out in code from the dated positions on the profile, plus the employer's own company page">
                  {card!.facts.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              )}
              <TechStrip view={view} />
            </>
          )}
        </div>
        <div className="vc-review">
          {bullets ? (
            <ReviewBullets review={bullets} rows={card!.rows} anchorScope={anchorScope} />
          ) : (
            (paragraph || view.ask.length > 0) && (
              <section className="vc-rsec">
                <h4 className="vc-sec">Review</h4>
                {paragraph && <p className="cv2d-why">{paragraph}</p>}
                <AskList ask={view.ask} />
              </section>
            )
          )}
          {view.betterSuited && <div className="cv2d-route">↪ {view.betterSuited}</div>}
          <hr className="vc-divider" />
          <section className="vc-rsec">
            <h4 className="vc-sec" title="The judged rows the review rests on. Check a row off and the label and the review follow.">
              Against the card
            </h4>
            <Checklist view={view} feedback={feedback} anchorScope={anchorScope} />
          </section>
          {when}
          {reviewLink}
        </div>
      </div>
    </div>
  );
}
