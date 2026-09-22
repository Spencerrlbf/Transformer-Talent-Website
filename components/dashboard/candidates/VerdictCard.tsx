"use client";
// The verdict as a recruiter reads it. With a scorecard it is the report
// card: the facts about the person (written by code), the companies they
// worked at, the technologies strip, then the judged checklist beside the
// review (label, the rows in one line, the paragraph, what to ask on a first
// call) and the decision. `compact` is the table-row form: label, the rows
// in one line, five chips. A verdict without a card (older reviews) renders
// the old way: label, paragraph, strip.
import { useState } from "react";
import { VERDICT_CLASS, VERDICT_LABEL, firstSentences, rowChips, shortRequirement, type TechChip, type VerdictView } from "@/lib/verdict-view";
import { rowSummary, tally, type ProfileFacts } from "@/lib/rolecard";
import Checklist, { type VerdictFeedbackTarget } from "@/components/dashboard/rolecard/Checklist";

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

const yearsWord = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} ${n === 1 ? "year" : "years"}`;
const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;
const monthsWord = (m: number) => (m >= 24 ? `${(m / 12).toFixed(m % 12 === 0 ? 0 : 1)} years` : m >= 12 ? (m === 12 ? "1 year" : `1 year ${plural(m - 12, "month")}`) : plural(m, "month"));
const people = (n: number) => (n >= 1000 ? `~${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}k people` : `~${n} people`);

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

/** The facts strip: four things about the person, worked out in code from
 *  the dated positions and the employer's own page, never by a model. */
function FactsStrip({ p }: { p: ProfileFacts }) {
  const cur = p.current;
  // The years the role's bar is about lead: engineering years on an
  // engineering role, the career on any other (a data science or product
  // role), so the strip says what the years row says.
  const career = p.basis === "career" || (p.engineeringYears == null && p.careerYears != null);
  const lead = career ? p.careerYears : p.engineeringYears;
  return (
    <dl className="vc-facts-grid" title="Facts, not the AI's reading: worked out in code from the dated positions on the profile, plus the employer's own company page">
      <div>
        <dt>Experience</dt>
        <dd>
          {lead != null ? <b>{yearsWord(lead)}</b> : <b>Not dated</b>}
          <small>
            {career ? "of career" : "in engineering roles"}
            {p.careerSince && ` · since ${p.careerSince}`}
            {!career && p.careerYears != null && p.engineeringYears != null && p.careerYears - p.engineeringYears >= 0.5 && ` · ${yearsWord(p.careerYears)} of career in all`}
            {career && p.engineeringYears != null && p.engineeringYears >= 0.5 && ` · ${yearsWord(p.engineeringYears)} in engineering roles`}
          </small>
        </dd>
      </div>
      <div>
        <dt>Average tenure</dt>
        <dd>
          {p.avgTenureYears != null ? <b>{yearsWord(p.avgTenureYears)}</b> : <b>Not dated</b>}
          <small>{p.careerJobs === 0 ? "no dated career positions" : `across ${p.careerJobs} career ${p.careerJobs === 1 ? "job" : "jobs"}`}</small>
        </dd>
      </div>
      <div>
        <dt>Current company</dt>
        <dd>
          {cur?.company ? (
            <>
              <b>
                {cur.company}
                {cur.tag && (
                  <span className={`vc-tag ${cur.tag}`} title={cur.tag === "startup" ? "Under 200 employees on the company's own page" : "Over 2,000 employees on the company's own page"}>
                    {cur.tag}
                    {cur.employees != null && ` · ${people(cur.employees)}`}
                  </span>
                )}
              </b>
              <small>
                {[cur.title, cur.months != null ? monthsWord(cur.months) : null, !cur.tag && cur.employees != null ? people(cur.employees) : null, cur.founded ? `founded ${cur.founded}` : null].filter(Boolean).join(" · ")}
              </small>
            </>
          ) : (
            <>
              <b>None listed</b>
              <small>no current position on the profile</small>
            </>
          )}
        </dd>
      </div>
      <div>
        <dt>School</dt>
        <dd>
          {p.school ? (
            <>
              <b>{p.school.name}</b>
              <small>{[p.school.degree, p.school.field, p.school.year].filter(Boolean).join(" · ") || "no degree listed"}</small>
            </>
          ) : (
            <>
              <b>None listed</b>
              <small>no education on the profile</small>
            </>
          )}
        </dd>
      </div>
    </dl>
  );
}

function Companies({ list }: { list: ProfileFacts["companies"] }) {
  if (!list.length) return null;
  return (
    <ol className="vc-companies" title="The dated positions on the profile, current first. Internships and other non-career positions are greyed.">
      {list.map((c, i) => (
        <li key={i} className={c.career ? "" : "aside"}>
          <b>{c.name}</b>
          <span>{c.title}</span>
          <small>
            {[c.from && c.to ? `${c.from} · ${c.to}` : c.from ? `${c.from} · now` : null, c.years != null ? yearsWord(c.years) : null].filter(Boolean).join(" · ")}
            {!c.career && " · not a career job"}
          </small>
        </li>
      ))}
    </ol>
  );
}

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
  const card = view.card;
  const hasCard = !!card?.rows.length;
  const summary = hasCard ? rowSummary(card!.rows) : "";
  if (compact) {
    const chips = rowChips(view, 5);
    return (
      <div className="vc vc-compact">
        <span className={`dash-tag ${VERDICT_CLASS[view.label]}`}>{VERDICT_LABEL[view.label]}</span>
        {!!card?.confirm?.length && <span className="vc-confirm" title="Profiles rarely say this, so this role confirms it on a call. Everything else Required is met.">confirm {card.confirm.join(", ")}</span>}
        {summary ? <p className="vc-summary" title="Every Required row, then the Exceptional and Bonus rows that are met">{summary}</p> : <p className="vc-first">{firstSentences(view.paragraph, 2)}</p>}
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

  const moved = hasCard && card!.aiLabel !== view.label;
  const head = (
    <div className="vc-head">
      <span className={`dash-tag ${VERDICT_CLASS[view.label]}`}>{VERDICT_LABEL[view.label]}</span>
      {!!card?.confirm?.length && <span className="vc-confirm" title="Profiles rarely say this, so this role confirms it on a call. Everything else Required is met.">confirm {card.confirm.join(", ")}</span>}
      {moved && <span className="vc-was">with confirmed rows · the AI alone read {VERDICT_LABEL[card!.aiLabel]}</span>}
    </div>
  );
  const when = reviewedOn(view.at) && (
    <p className="vc-when" title="Years and tenure in this note are as of that day. Review again to refresh it.">
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
        {decision && <DecideButtons d={decision} />}
        {reviewLink}
      </div>
    );
  }

  const req = tally(card!.rows, "required");
  const short = card!.rows.filter((r) => r.tier === "required" && r.status === "short").length;
  const shortWord = short === 0 ? "" : short === 1 ? " · one short" : ` · ${short} short`;
  return (
    <div className="vc vc-report">
      {card!.profile ? (
        <>
          <FactsStrip p={card!.profile} />
          <Companies list={card!.profile.companies} />
        </>
      ) : (
        !!card!.facts?.length && (
          <ul className="vc-facts" title="Facts, not the AI's reading: worked out in code from the dated positions on the profile, plus the employer's own company page">
            {card!.facts.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        )
      )}
      <TechStrip view={view} />
      <div className="vc-cols">
        <div className="vc-col vc-col-rows">
          <Checklist view={view} feedback={feedback} />
        </div>
        <div className="vc-col vc-col-review">
          <div className="vc-lbl">Review</div>
          {head}
          <p className="vc-reqline">
            Required {req.met} of {req.of} met{shortWord}
          </p>
          {summary && (
            <p className="vc-summary" title="Every Required row, then the Exceptional and Bonus rows that are met">
              {summary}
            </p>
          )}
          <p className="cv2d-why">{view.paragraph}</p>
          {view.betterSuited && <div className="cv2d-route">↪ {view.betterSuited}</div>}
          {view.ask.length > 0 && (
            <div className="cv2d-probe vc-ask">
              <b>Ask on a first call</b>
              <ul>
                {view.ask.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="vc-note">Written from the rows and the facts above. It changes only when a row or a fact above changes.</p>
          {when}
          {decision && <DecideButtons d={decision} />}
          {reviewLink}
        </div>
      </div>
    </div>
  );
}
