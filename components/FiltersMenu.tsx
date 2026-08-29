"use client";
// The one filter pattern (README §2.3), extracted: a Filters button with an
// active-count badge opening a grouped two-pane menu. Each group is a filter
// with options; picking one sets it and closes. Used by the public roles
// table; the board carries its own inline copy until the cleanup pass.
import { useEffect, useRef, useState } from "react";

export type FilterGroup = {
  key: string;
  label: string;
  value: string;
  options: string[];
  set: (v: string) => void;
};

export default function FiltersMenu({ groups }: { groups: FilterGroup[] }) {
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setPane("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const active = groups.filter((g) => g.value).length;
  const cur = groups.find((g) => g.key === pane);

  return (
    <div className="dash-filters-wrap" ref={wrapRef}>
      <button
        type="button"
        className="dash-filters-btn"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setPane("");
        }}
      >
        ☰ Filters
        {active > 0 && <span className="count">{active}</span>}
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="dash-filters-menu">
          {!cur && (
            <>
              <div className="head">Add filter…</div>
              {groups.map((g) => (
                <div
                  key={g.key}
                  className="row"
                  role="button"
                  tabIndex={0}
                  onClick={() => setPane(g.key)}
                >
                  {g.label}
                  <span className="val">{g.value || "Any"}</span>
                  <span className="car">›</span>
                </div>
              ))}
            </>
          )}
          {cur && (
            <>
              <div className="head back" role="button" onClick={() => setPane("")}>
                ‹ {cur.label}
              </div>
              {["", ...cur.options].map((o) => (
                <div
                  key={o || "any"}
                  className={`row${cur.value === o ? " onopt" : ""}`}
                  role="button"
                  onClick={() => {
                    cur.set(o);
                    setOpen(false);
                    setPane("");
                  }}
                >
                  {o || "Any"}
                  {cur.value === o && <span className="val">✓</span>}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
