"use client";
// Settings: the org's default weekly targets (owner-editable). A seat's own
// targets are edited on Home; this is what they start from.
import { useEffect, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import { GOAL_KEYS, GOAL_LABEL, type Targets } from "@/lib/goals";

export default function WeeklyTargets() {
  const { token } = useDash();
  const [data, setData] = useState<{ mine: Targets | null; defaults: Targets; canEditDefaults: boolean } | null>(null);
  const [draft, setDraft] = useState<Targets | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/dashboard/home/goals", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setData(d);
          setDraft(d.defaults);
        }
      })
      .catch(() => {});
  }, [token]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaved(false);
    setErr("");
    const r = await fetch("/api/dashboard/home/goals", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ defaults: draft }),
    }).catch(() => null);
    setSaving(false);
    if (r?.ok) setSaved(true);
    else setErr("Couldn't save. Try again.");
  };

  if (!data || !draft) return <small>Loading…</small>;
  return (
    <>
      <div className="set-grid">
        {GOAL_KEYS.map((k) => (
          <span key={k} style={{ display: "contents" }}>
            <span>{GOAL_LABEL[k]}</span>
            {data.canEditDefaults ? (
              <input
                type="number"
                min={0}
                max={999}
                value={draft[k]}
                onChange={(e) => {
                  setDraft({ ...draft, [k]: Math.max(0, Math.min(999, Math.round(Number(e.target.value) || 0))) });
                  setSaved(false);
                }}
              />
            ) : (
              <b style={{ textAlign: "right" }}>{data.defaults[k]}</b>
            )}
          </span>
        ))}
      </div>
      {data.canEditDefaults && (
        <div className="set-foot">
          <button className="dash-btn dash-btn-2" disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </button>
          {saved && !err && <span className="dash-saved">Saved ✓</span>}
          {err && <span className="cv2d-err">{err}</span>}
        </div>
      )}
      <small>
        Per seat, per week, Monday to Friday. Emails sent from a connected mailbox, call tasks marked done, people moved to Interviewing, people moved to Hired.
        {data.canEditDefaults ? " These are the team defaults; anyone can set their own on Home with Edit targets." : " Set by your company's owner account; set your own on Home with Edit targets."}
        {data.mine ? " You have your own targets set on Home." : ""}
      </small>
    </>
  );
}
