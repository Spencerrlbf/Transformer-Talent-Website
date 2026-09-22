"use client";
// The role scorecard as the hiring manager or recruiter edits it: three
// tiers, each row one thing to check. Rows can be reworded, moved between
// tiers, deleted or added. Every row says how it is decided: a years row by
// arithmetic on dated positions, a technology row from job tags on a fixed
// ladder, anything else on a ladder of the role's own words. Controlled: the
// parent owns the rows and saves.
import {
  FLOOR,
  MAX_CRITERIA,
  MAX_LABEL,
  MAX_RUNG,
  MAX_RUNGS,
  TIERS,
  TIER_LABEL,
  ladderOf,
  metAtOf,
  rowKind,
  type Criterion,
  type RowKind,
  type Tier,
} from "@/lib/rolecard";

export const TIER_HINT: Record<Tier, string> = {
  exceptional: "What the ideal hire has beyond the bar. Never counts against anyone.",
  required: "Without it you would say no. These rows decide the label.",
  bonus: "Nice to have. Never counts against anyone.",
};

/** How each kind of row is decided, in one line. */
export const KIND_HINT: Record<RowKind, string> = {
  years: "Decided from dated positions in engineering roles. Within a year of the bar reads short; more than a year short reads no.",
  tech: "Decided from job tags and descriptions.",
  judgment: "Judged on this ladder.",
};

export function TierIcon({ tier }: { tier: Tier }) {
  if (tier === "exceptional")
    return (
      <svg className="rc-ico" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1.6l1.9 4.1 4.5.5-3.3 3 .9 4.4L8 11.4l-4 2.2.9-4.4-3.3-3 4.5-.5z" fill="currentColor" />
      </svg>
    );
  if (tier === "required")
    return (
      <svg className="rc-ico" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M5.2 8.2l1.9 1.9 3.7-3.9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  return (
    <svg className="rc-ico" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.4 7.4h2.3v6.1H2.4zM5.9 13.2V7.5l2.6-4.9c.9 0 1.6.7 1.6 1.6v2.2h2.7c.8 0 1.4.8 1.2 1.6l-.9 3.9c-.2.7-.8 1.3-1.5 1.3z" fill="currentColor" />
    </svg>
  );
}

let minted = 0;
const newId = () => `row-${Date.now().toString(36)}-${(minted++).toString(36)}`;

/** The rungs a judgment row shows for editing: what is stored, else the one
 *  rung its note (or label) seeds. Rung 1 is FLOOR and is never stored. */
const editableRungs = (c: Criterion): string[] => (c.ladder?.length ? c.ladder : ladderOf(c).slice(1));

export default function ScorecardEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: Criterion[];
  onChange: (rows: Criterion[]) => void;
  disabled?: boolean;
}) {
  const patch = (id: string, p: Partial<Criterion>) => onChange(value.map((c) => (c.id === id ? { ...c, ...p } : c)));
  // A property set to undefined is dropped, so a row reads exactly as it will be stored.
  const unset = (id: string, keys: (keyof Criterion)[]) =>
    onChange(
      value.map((c) => {
        if (c.id !== id) return c;
        const next = { ...c };
        for (const k of keys) delete next[k];
        return next;
      })
    );
  const left = Math.max(0, MAX_CRITERIA - value.length);
  const full = left === 0;

  const metSelect = (c: Criterion, values: number[]) => (
    <label className="rc-metfrom">
      <span>Met from rung</span>
      <select value={metAtOf(c)} aria-label="The rung from which this row counts as met" onChange={(e) => patch(c.id, { metAt: Number(e.target.value) })}>
        {values.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );

  const callBox = (c: Criterion) =>
    c.tier === "required" ? (
      <label className="rc-ecall" title="Tick this when LinkedIn profiles rarely say it (a specific language, depth of ownership). While a profile does not show it, it will not hold the label back: the label reads, for example, Contact now · confirm TypeScript.">
        <input type="checkbox" checked={!!c.confirmOnCall} onChange={(e) => patch(c.id, { confirmOnCall: e.target.checked })} />
        Confirm on a call: profiles rarely say this
      </label>
    ) : null;

  function kindBlock(c: Criterion) {
    const kind = rowKind(c);
    if (kind === "years") return <p className="rc-kind">{KIND_HINT.years}</p>;
    if (kind === "tech") {
      const ladder = ladderOf(c);
      const metAt = metAtOf(c);
      const values = ladder.map((_, i) => i + 1).filter((n) => n >= 3);
      return (
        <div className="rc-how">
          <p className="rc-kind">
            {KIND_HINT.tech}{" "}
            <button type="button" className="rc-kindlink" onClick={() => patch(c.id, { kind: "judgment" })}>
              judge it on a ladder instead
            </button>
          </p>
          <ol className="rc-ladder">
            {ladder.map((rung, i) => (
              <li key={i} className={i + 1 >= metAt ? "met" : ""}>
                <span className="rc-rung">{i + 1}</span>
                {rung}
                {i + 1 === metAt && <em>met from here</em>}
              </li>
            ))}
          </ol>
          <div className="rc-howfoot">
            {metSelect(c, values)}
            {callBox(c)}
          </div>
        </div>
      );
    }
    const rungs = editableRungs(c);
    const values = rungs.map((_, i) => i + 2);
    const metAt = metAtOf({ ...c, ladder: rungs });
    const setRungs = (next: string[]) => patch(c.id, { ladder: next });
    // A technology row read on a ladder can go back to being decided from tags.
    const overridden = c.kind === "judgment" && rowKind({ label: c.label }) === "tech";
    return (
      <div className="rc-how">
        <p className="rc-kind">
          {KIND_HINT.judgment}{" "}
          {overridden && (
            <button type="button" className="rc-kindlink" onClick={() => unset(c.id, ["kind", "ladder", "metAt"])}>
              decide it from job tags instead
            </button>
          )}
        </p>
        <ol className="rc-ladder rc-ladder-edit">
          <li>
            <span className="rc-rung">1</span>
            <input className="rc-erung" value={FLOOR} disabled aria-label="Rung 1, fixed" />
          </li>
          {rungs.map((rung, i) => (
            <li key={i} className={i + 2 >= metAt ? "met" : ""}>
              <span className="rc-rung">{i + 2}</span>
              <input
                className="rc-erung"
                value={rung}
                maxLength={MAX_RUNG}
                aria-label={`Rung ${i + 2}`}
                placeholder={i === 0 ? "The weakest sign of it, e.g. named on a job or a resume line" : "A stronger sign of it"}
                onChange={(e) => setRungs(rungs.map((r, k) => (k === i ? e.target.value : r)))}
              />
              <button
                type="button"
                className="dash-skill-x"
                title={rungs.length <= 1 ? "A ladder keeps at least one rung above the floor" : "Remove this rung"}
                disabled={rungs.length <= 1}
                onClick={() => setRungs(rungs.filter((_, k) => k !== i))}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
        <div className="rc-howfoot">
          <button
            type="button"
            className="dash-addrow rc-addrung"
            disabled={rungs.length >= MAX_RUNGS - 1}
            title={rungs.length >= MAX_RUNGS - 1 ? `A ladder holds up to ${MAX_RUNGS} rungs` : undefined}
            onClick={() => setRungs([...rungs, ""])}
          >
            + add a rung (up to {MAX_RUNGS})
          </button>
          {metSelect(c, values)}
          {callBox(c)}
        </div>
      </div>
    );
  }

  return (
    <div className="rc-edit">
      {TIERS.map((tier) => {
        const rows = value.filter((c) => c.tier === tier);
        return (
          <fieldset className={`rc-tier rc-${tier}`} key={tier} disabled={disabled}>
            <legend>
              <TierIcon tier={tier} />
              {TIER_LABEL[tier]}
              <small>{TIER_HINT[tier]}</small>
            </legend>
            {rows.length === 0 && <p className="rc-none">No rows.</p>}
            {rows.map((c) => (
              <div className="rc-erow" key={c.id}>
                <div className="rc-efields">
                  <label className="rc-ename">
                    <span>Row</span>
                    <input
                      className="rc-elabel"
                      value={c.label}
                      maxLength={MAX_LABEL}
                      placeholder="One thing to check, e.g. Has taken a system from zero to one"
                      onChange={(e) => patch(c.id, { label: e.target.value })}
                    />
                  </label>
                  {kindBlock(c)}
                  {rowKind(c) === "years" && callBox(c)}
                </div>
                <select
                  className="rc-etier"
                  value={c.tier}
                  aria-label="Tier"
                  onChange={(e) => patch(c.id, { tier: e.target.value as Tier })}
                >
                  {TIERS.map((t) => (
                    <option key={t} value={t}>
                      {TIER_LABEL[t]}
                    </option>
                  ))}
                </select>
                <button type="button" className="dash-skill-x" title="Remove this row" onClick={() => onChange(value.filter((x) => x.id !== c.id))}>
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="dash-addrow"
              disabled={full}
              title={full ? `A scorecard holds up to ${MAX_CRITERIA} rows` : undefined}
              onClick={() => onChange([...value, { id: newId(), label: "", tier }])}
            >
              + Add {TIER_LABEL[tier].toLowerCase()} row <small>({left} left of {MAX_CRITERIA})</small>
            </button>
          </fieldset>
        );
      })}
    </div>
  );
}
