"use client";
// Multi-select dropdown: a labeled control that opens a checkbox list.
// Closes on outside click; the button summarizes the selection. Used by the
// public future-interest form and the dashboard's editable ask panel.
// SingleSelect below is the one-value variant — same look, no native <select>
// popup (whose macOS anchoring misbehaved inside the board shell).
import { useEffect, useRef, useState } from "react";

export function SingleSelect({
  label,
  options,
  value,
  onChange,
  placeholder = "Any",
}: {
  label: string;
  options: readonly string[];
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
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
  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };
  return (
    <div className="board-msel" ref={wrapRef}>
      <span className="board-msel-lbl">{label}</span>
      <button type="button" aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen(!open)}>
        <span>{value || placeholder}</span>
        <i aria-hidden="true">▾</i>
      </button>
      {open && (
        <div className="board-msel-pop" role="listbox" aria-label={label}>
          {["", ...options].map((o) => (
            <div
              key={o || "any"}
              role="option"
              aria-selected={value === o}
              className={`opt${value === o ? " on" : ""}`}
              onClick={() => pick(o)}
            >
              {o || placeholder}
              {value === o && <span aria-hidden>✓</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
