"use client";
// The role scorecard as the hiring manager or recruiter edits it: three
// tiers, each row one thing to check. Rows can be reworded, moved between
// tiers, deleted or added. Controlled: the parent owns the rows and saves.
import { TIERS, TIER_LABEL, MAX_CRITERIA, MAX_GOOD, MAX_LABEL, type Criterion, type Tier } from "@/lib/rolecard";

export const TIER_HINT: Record<Tier, string> = {
  exceptional: "What the ideal hire has beyond the bar. Never counts against anyone.",
  required: "Without it you would say no. These rows decide the label.",
  bonus: "Nice to have. Never counts against anyone.",
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
  const full = value.length >= MAX_CRITERIA;
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
                  <input
                    className="rc-elabel"
                    value={c.label}
                    maxLength={MAX_LABEL}
                    placeholder="One thing to check, e.g. Has taken a system from zero to one"
                    aria-label="What to check"
                    onChange={(e) => patch(c.id, { label: e.target.value })}
                  />
                  {c.tier === "required" && (
                    <label className="rc-ecall" title="Tick this when LinkedIn profiles rarely say it (a specific language, depth of ownership). While a profile does not show it, it will not hold the label back: the label reads, for example, Contact now · confirm TypeScript.">
                      <input type="checkbox" checked={!!c.confirmOnCall} onChange={(e) => patch(c.id, { confirmOnCall: e.target.checked })} />
                      Confirm on a call: profiles rarely say this
                    </label>
                  )}
                  <input
                    className="rc-egood"
                    value={c.good || ""}
                    maxLength={MAX_GOOD}
                    placeholder="What counts as evidence (optional)"
                    aria-label="What counts as evidence"
                    onChange={(e) => patch(c.id, { good: e.target.value })}
                  />
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
              + Add {TIER_LABEL[tier].toLowerCase()} row
            </button>
          </fieldset>
        );
      })}
    </div>
  );
}
