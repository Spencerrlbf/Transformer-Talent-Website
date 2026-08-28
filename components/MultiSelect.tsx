"use client";
// Multi-select dropdown: a labeled control that opens a checkbox list.
// Closes on outside click; the button summarizes the selection. Used by the
// public future-interest form and the dashboard's editable ask panel.
import { useEffect, useRef, useState } from "react";

export default function MultiSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const summary =
    value.length === 0 ? "Any" : value.length <= 2 ? value.join(", ") : `${value.length} selected`;
  return (
    <div className="board-msel" ref={wrapRef}>
      <span className="board-msel-lbl">{label}</span>
      <button type="button" aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen(!open)}>
        <span>{summary}</span>
        <i aria-hidden="true">▾</i>
      </button>
      {open && (
        <div className="board-msel-pop" role="listbox" aria-label={label}>
          {options.map((o) => (
            <label key={o}>
              <input
                type="checkbox"
                checked={value.includes(o)}
                onChange={() =>
                  onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o])
                }
              />
              {o}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
