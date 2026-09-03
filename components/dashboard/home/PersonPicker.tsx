"use client";
// Home shortcuts: pick a person by name before the composer or the task
// modal opens. Searches the same list the Candidates page shows.
import { useEffect, useRef, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";

type Row = { key: string; name: string; currentTitle: string | null; currentCompany: string | null; location: string | null };

export default function PersonPicker({
  title,
  hint,
  onPick,
  onClose,
}: {
  title: string;
  hint: string;
  onPick: (p: { key: string; name: string }) => void;
  onClose: () => void;
}) {
  const { token } = useDash();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", h, true);
    return () => document.removeEventListener("keydown", h, true);
  }, [onClose]);

  useEffect(() => {
    const id = ++seq.current;
    const t = window.setTimeout(() => {
      fetch(`/api/dashboard/candidates/v2?q=${encodeURIComponent(q.trim())}&sort=added&pageSize=8`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      })
        .then(async (r) => (r.ok ? ((await r.json()) as { items: Row[] }) : null))
        .then((d) => {
          if (id === seq.current) setRows(d?.items || []);
        })
        .catch(() => {
          if (id === seq.current) setRows([]);
        });
    }, q ? 220 : 0);
    return () => window.clearTimeout(t);
  }, [q, token]);

  return (
    <div className="tkm-back" onClick={onClose}>
      <div className="tkm" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <h3>{title}</h3>
        <p className="tkm-sub">{hint}</p>
        <input
          className="hp-search"
          autoFocus
          placeholder="Search by name, title or company"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {rows === null ? (
          <p className="hp-none">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="hp-none">{q ? "No one matches." : "No people yet."}</p>
        ) : (
          <ul className="hp-list">
            {rows.map((r) => (
              <li key={r.key} onClick={() => onPick({ key: r.key, name: r.name })} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onPick({ key: r.key, name: r.name })}>
                <b>{r.name}</b>
                <span>{[r.currentTitle, r.currentCompany].filter(Boolean).join(" @ ") || r.location || ""}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="tkm-foot">
          <button className="tkm-cancel" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
