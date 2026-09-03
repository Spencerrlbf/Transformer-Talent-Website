"use client";
// Home shortcut "Start a sourcing run": a run belongs to one role, so pick
// the role first; the job's Sourcing tab takes it from there (no credits
// are spent until Import).
import { useEffect, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";

type Job = { id: string; title: string; status: string; company: string; applicants: number };

export default function RolePicker({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  const { token } = useDash();
  const [q, setQ] = useState("");
  const [jobs, setJobs] = useState<Job[] | null>(null);

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
    fetch("/api/dashboard/jobs", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as { jobs: Job[] }) : null))
      .then((d) => setJobs((d?.jobs || []).filter((j) => j.status === "open")))
      .catch(() => setJobs([]));
  }, [token]);

  const needle = q.trim().toLowerCase();
  const shown = (jobs || [])
    .filter((j) => !needle || j.title.toLowerCase().includes(needle) || `#${j.id}`.includes(needle) || (j.company || "").toLowerCase().includes(needle))
    .slice(0, 12);

  return (
    <div className="tkm-back" onClick={onClose}>
      <div className="tkm" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Start a sourcing run">
        <h3>Start a sourcing run</h3>
        <p className="tkm-sub">A run searches for one role. Pick it, and the role&apos;s Sourcing tab opens ready to preview the search.</p>
        <input className="hp-search" autoFocus placeholder="Search open roles by title, #id or company" value={q} onChange={(e) => setQ(e.target.value)} />
        {jobs === null ? (
          <p className="hp-none">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="hp-none">{needle ? "No open role matches." : "No open roles."}</p>
        ) : (
          <ul className="hp-list">
            {shown.map((j) => (
              <li key={j.id} onClick={() => onPick(j.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onPick(j.id)}>
                <b>{j.title}</b>
                <span>{[j.company, `#${j.id}`, `${j.applicants} applicant${j.applicants === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</span>
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
