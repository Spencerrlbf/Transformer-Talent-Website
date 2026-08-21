"use client";
// Interview stage template editor: one modal used for both the per-job
// override (job workspace / board) and the company default (Settings).
// Stable ids ride along invisibly so renames never orphan candidates.
import { useEffect, useState } from "react";

export type StageDef = { id: string; label: string };

const MAX_STAGES = 8;

export default function StageEditor({
  title,
  intro,
  initial,
  showReset,
  saving,
  error,
  onSave,
  onReset,
  onClose,
}: {
  title: string;
  intro: string;
  initial: StageDef[];
  /** Show "Reset to company default" (per-job editor only). */
  showReset?: boolean;
  saving: boolean;
  error: string;
  onSave: (stages: StageDef[]) => void;
  onReset?: () => void;
  onClose: () => void;
}) {
  const [stages, setStages] = useState<StageDef[]>(initial);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function rename(i: number, label: string) {
    setStages((s) => s.map((st, j) => (j === i ? { ...st, label: label.slice(0, 30) } : st)));
  }
  function remove(i: number) {
    setStages((s) => s.filter((_, j) => j !== i));
  }
  function add() {
    setStages((s) =>
      s.length >= MAX_STAGES
        ? s
        : [...s, { id: `s${Math.random().toString(36).slice(2, 8)}`, label: "" }]
    );
  }
  function moveTo(from: number, to: number) {
    setStages((s) => {
      if (to < 0 || to >= s.length || from === to) return s;
      const next = [...s];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }

  const valid = stages.length > 0 && stages.every((s) => s.label.trim());

  return (
    <div className="stged-overlay" onClick={onClose}>
      <div className="stged" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{intro}</p>
        {stages.map((s, i) => (
          <div
            key={s.id}
            className={`stged-row${dragIdx === i ? " dragging" : ""}`}
            draggable
            onDragStart={(e) => {
              setDragIdx(i);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => setDragIdx(null)}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragIdx !== null && dragIdx !== i) {
                moveTo(dragIdx, i);
                setDragIdx(i);
              }
            }}
          >
            <span className="stged-grip" title="Drag to reorder">⠿</span>
            <input
              value={s.label}
              placeholder="Stage name"
              maxLength={30}
              onChange={(e) => rename(i, e.target.value)}
            />
            <button
              type="button"
              className="stged-x"
              title="Remove stage"
              onClick={() => remove(i)}
              disabled={stages.length <= 1}
            >
              ✕
            </button>
          </div>
        ))}
        {stages.length < MAX_STAGES && (
          <button type="button" className="stged-add" onClick={add}>
            + Add a stage
          </button>
        )}
        <div className="stged-foot">
          <button
            className="dash-btn"
            disabled={saving || !valid}
            onClick={() => onSave(stages.map((s) => ({ ...s, label: s.label.trim() })))}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {showReset && onReset && (
            <button className="dash-btn dash-btn-2" disabled={saving} onClick={onReset}>
              Reset to company default
            </button>
          )}
          <button className="dash-btn dash-btn-2" disabled={saving} onClick={onClose}>
            Cancel
          </button>
        </div>
        {error && <p className="dash-error">{error}</p>}
        <p className="stged-note">
          Removing a stage moves its candidates to the previous stage, never
          out of the pipeline.
        </p>
      </div>
    </div>
  );
}
