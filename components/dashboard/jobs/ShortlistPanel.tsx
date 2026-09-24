"use client";
// Phase 2: the role's shortlist, built nightly by code. Rank, who they are,
// what the card's rules said about them, and a click opens the same drawer
// the rest of the dashboard uses.
import { useEffect, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import type { ShortlistRow } from "@/app/api/dashboard/jobs/[id]/shortlist/route";

interface Props {
  jobId: string;
  onOpen: (key: string) => void;
  onKeys?: (keys: string[]) => void;
  onCount?: (count: number) => void;
}

const check = (v: boolean | null) => (v === true ? "yes" : v === false ? "no" : "unknown");

export default function ShortlistPanel({ jobId, onOpen, onKeys, onCount }: Props) {
  const { token } = useDash();
  const [state, setState] = useState<{ count: number; builtAt: string | null; rows: ShortlistRow[] } | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    fetch(`/api/dashboard/jobs/${jobId}/shortlist`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!live) return;
        setState(data);
        if (data) {
          onKeys?.(data.rows.map((r: ShortlistRow) => r.candidateKey));
          onCount?.(data.count);
        }
      })
      .catch(() => live && setState(null));
    return () => {
      live = false;
    };
  }, [jobId, token, onKeys, onCount]);

  if (state === undefined) return <p className="dash-muted">Loading…</p>;
  if (!state) return <p className="dash-muted">The shortlist could not be loaded.</p>;
  if (!state.rows.length)
    return (
      <p className="dash-sub">
        No shortlist yet. It is built overnight from the scorecard, and the first one appears the morning after the card is saved.
      </p>
    );
  const built = state.builtAt ? new Date(state.builtAt).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : null;
  return (
    <>
      <p className="dash-sub">
        {state.count} people worth judging for this role, picked by code from the scorecard{built ? `, built ${built}` : ""}. Higher is closer.
      </p>
      <div className="cv2-scroll">
        <table className="cv2-table nw-tight">
          <thead>
            <tr>
              <th>#</th>
              <th>Candidate</th>
              <th>Current role</th>
              <th>Company</th>
              <th>Location</th>
              <th>Score</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {state.rows.map((r) => (
              <tr key={r.candidateId} className="cv2-click" onClick={() => onOpen(r.candidateKey)}>
                <td className="dash-muted">{r.rank}</td>
                <td>
                  {r.name}
                  {r.engaged && <span className="tal-badge engaged"> engaged</span>}
                </td>
                <td>{r.title || ""}</td>
                <td>{r.company || ""}</td>
                <td>{r.location || ""}</td>
                <td title={`similarity ${r.similarity ?? "?"}; years ${check(r.checks.years)}, title ${check(r.checks.family)}, top ${check(r.checks.top)}`}>{r.score.toFixed(2)}</td>
                <td className="dash-muted">{r.reasons.join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
