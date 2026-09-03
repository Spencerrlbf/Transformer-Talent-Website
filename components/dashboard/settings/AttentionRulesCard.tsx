"use client";
// Settings: the day-counts behind Home's Needs attention card, on/off per
// rule. Owner-editable; everyone else sees what is set.
import { useEffect, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import { RULE_HINT, RULE_KEYS, RULE_LABEL, type AttentionRules } from "@/lib/goals";

export default function AttentionRulesCard() {
  const { token } = useDash();
  const [rules, setRules] = useState<AttentionRules | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/dashboard/org", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.attentionRules) {
          setRules(d.attentionRules);
          setCanEdit(!!d.canEdit);
        }
      })
      .catch(() => {});
  }, [token]);

  const save = async () => {
    if (!rules) return;
    setSaving(true);
    setSaved(false);
    setErr("");
    const r = await fetch("/api/dashboard/org", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ attentionRules: rules }),
    }).catch(() => null);
    setSaving(false);
    if (r?.ok) setSaved(true);
    else setErr("Couldn't save. Try again.");
  };

  if (!rules) return <small>Loading…</small>;
  const unit = (k: string) => (k === "fdue" ? "days ahead" : "days");
  return (
    <>
      <div className="set-rules">
        {RULE_KEYS.map((k) => (
          <div className={`set-rule${rules[k].on ? "" : " off"}`} key={k}>
            <input
              type="checkbox"
              id={`rule-${k}`}
              checked={rules[k].on}
              disabled={!canEdit}
              onChange={(e) => {
                setRules({ ...rules, [k]: { ...rules[k], on: e.target.checked } });
                setSaved(false);
              }}
            />
            <label htmlFor={`rule-${k}`} style={{ margin: 0, textTransform: "none", letterSpacing: 0, fontSize: "13.5px", color: "var(--ink)", fontWeight: 600 }}>
              {RULE_LABEL[k]}
            </label>
            {canEdit ? (
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={rules[k].days}
                  disabled={!rules[k].on}
                  onChange={(e) => {
                    setRules({ ...rules, [k]: { ...rules[k], days: Math.max(1, Math.min(90, Math.round(Number(e.target.value) || 1))) } });
                    setSaved(false);
                  }}
                />
              </span>
            ) : (
              <b style={{ textAlign: "right" }}>
                {rules[k].days} {unit(k)}
              </b>
            )}
            <small>{RULE_HINT[k]}{canEdit ? ` · ${unit(k)}` : ""}</small>
          </div>
        ))}
      </div>
      {canEdit && (
        <div className="set-foot">
          <button className="dash-btn dash-btn-2" disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </button>
          {saved && !err && <span className="dash-saved">Saved ✓</span>}
          {err && <span className="cv2d-err">{err}</span>}
        </div>
      )}
      <small>
        What lands in Home&apos;s Needs attention card. Nothing here creates a task or sends anything; a row is a prompt with the action next to it. Anyone with an open task, reminder, check-back or no-reply mark is left to the Inbox.
        {canEdit ? "" : " Set by your company's owner account."}
      </small>
    </>
  );
}
