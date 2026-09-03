"use client";
// Home: this week against the seat's targets, with a pace tick where the
// week has got to. Me = your four goals; Team = every seat summed against
// the sum of their targets (owners see the per-person split).
import { useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import { GOAL_KEYS, GOAL_LABEL, GOAL_SUB, goalHint, goalState, weekLabel, type GoalKey, type Targets } from "@/lib/goals";
import type { GoalsData } from "@/lib/server/home-goals";

export default function GoalsCard({ goals, scope, today, onSaved }: { goals: GoalsData; scope: "me" | "team"; today: string; onSaved: () => void }) {
  const { token } = useDash();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Targets>(goals.targets.mine || goals.targets.defaults);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const pacePct = Math.round(goals.pace * 100);

  const startEdit = () => {
    setDraft(goals.targets.mine || goals.targets.defaults);
    setErr("");
    setEditing(true);
  };
  const patch = async (body: Record<string, unknown>) => {
    setSaving(true);
    setErr("");
    const r = await fetch("/api/dashboard/home/goals", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setSaving(false);
    if (r?.ok) {
      setEditing(false);
      onSaved();
    } else {
      setErr("Couldn't save. Try again.");
    }
  };

  return (
    <div className="hm-card">
      <div className="hm-ch">
        <div>
          <h4>Goals</h4>
          <p className="cs">
            {weekLabel(goals.weekStart)} · resets Monday ·{" "}
            {scope === "me" ? (goals.targets.mine ? "your targets" : "team default targets") : `${goals.seats} seat${goals.seats === 1 ? "" : "s"}, targets summed`}
          </p>
        </div>
        {scope === "me" && !editing && (
          <button type="button" className="hm-lnk" onClick={startEdit}>
            Edit targets
          </button>
        )}
      </div>

      {!editing &&
        goals.rows.map((r) => {
          const f = r.target > 0 ? Math.min(1, r.n / r.target) : 1;
          const state = goalState(r.n, r.target, goals.pace);
          return (
            <div className="hm-goal" key={r.key}>
              <div className="gl">
                {GOAL_LABEL[r.key]}
                {scope === "me" && <small>{GOAL_SUB[r.key]}</small>}
              </div>
              <div className="gn">
                {r.n} <span>/ {r.target}</span>
              </div>
              <div className="gb" aria-hidden="true">
                <i className={state === "done" ? "done" : state === "behind" ? "behind" : ""} style={{ width: `${Math.round(f * 100)}%` }} />
                <em style={{ left: `${pacePct}%` }} />
              </div>
              <div className="gs">
                <span>{r.split ? r.split.map((s) => `${s.name} ${s.n}`).join(" · ") || "nobody yet" : goalHint(r.n, r.target, today)}</span>
                {state === "done" ? <span className="hm-chip pos">Done</span> : state === "on" ? <span className="hm-chip pos">On pace</span> : <span className="hm-chip warn">Behind</span>}
              </div>
            </div>
          );
        })}

      {editing && (
        <div className="hm-gedit" role="group" aria-label="Edit targets">
          <div className="h">Goal</div>
          <div className="h" style={{ textAlign: "right" }}>Yours</div>
          <div className="h" style={{ textAlign: "right" }}>Team default</div>
          {GOAL_KEYS.map((k: GoalKey) => (
            <span key={k} style={{ display: "contents" }}>
              <div>{GOAL_LABEL[k]}</div>
              <input
                type="number"
                min={0}
                max={999}
                value={draft[k]}
                onChange={(e) => setDraft({ ...draft, [k]: Math.max(0, Math.min(999, Math.round(Number(e.target.value) || 0))) })}
              />
              <div className="def">
                {goals.targets.defaults[k]}
                <button type="button" className="hm-lnk" onClick={() => setDraft({ ...draft, [k]: goals.targets.defaults[k] })}>
                  use
                </button>
              </div>
            </span>
          ))}
          <div className="hm-gfoot">
            {err && <span className="cv2d-err">{err}</span>}
            {goals.targets.mine && (
              <button type="button" className="hm-lnk" disabled={saving} onClick={() => patch({ useDefaults: true })} style={{ marginRight: "auto" }}>
                Use the team defaults
              </button>
            )}
            <button type="button" className="tkm-cancel" disabled={saving} onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" className="tkm-save" disabled={saving} onClick={() => patch({ targets: draft })}>
              {saving ? "Saving…" : "Save targets"}
            </button>
          </div>
        </div>
      )}

      <p className="hm-fine">
        Counted from what the app records: emails sent from your connected mailbox, call tasks marked done, people you moved to Interviewing, people moved to Hired.
        {" "}The owner sets the team defaults in Settings; each seat can set their own.
      </p>
    </div>
  );
}
