"use client";
import { useEffect, useMemo, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import {
  CandidateCards,
  SourcedCards,
  type CandidateView,
  type SourcedView,
} from "@/components/dashboard/CandidateList";

export default function CandidatesPage() {
  const { token } = useDash();
  const [data, setData] = useState<{ applicants: CandidateView[]; sourced: SourcedView[] } | null>(null);
  const [error, setError] = useState(false);
  const [tagFilter, setTagFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");

  useEffect(() => {
    fetch("/api/dashboard/candidates", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then(setData)
      .catch(() => setError(true));
  }, [token]);

  const roles = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of data?.applicants || [])
      for (const r of c.roles) if (!seen.has(r.jobId)) seen.set(r.jobId, r.title);
    return [...seen.entries()];
  }, [data]);

  const filtered = useMemo(
    () =>
      (data?.applicants || []).filter(
        (c) =>
          (!tagFilter || c.roles.some((r) => r.tag === tagFilter)) &&
          (!roleFilter || c.roles.some((r) => r.jobId === roleFilter))
      ),
    [data, tagFilter, roleFilter]
  );

  return (
    <>
      <h1 className="dash-h1">Candidates</h1>
      <p className="dash-sub">
        {data
          ? `${data.applicants.length} applicant${data.applicants.length === 1 ? "" : "s"} across all roles${data.sourced.length ? ` · ${data.sourced.length} sourced for you` : ""}`
          : error
            ? "Couldn't load candidates — refresh to retry."
            : "Loading…"}
      </p>

      {data && data.applicants.length > 0 && (
        <div className="dash-candfilters">
          <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
            <option value="">all fits</option>
            <option value="strong">Strong fit</option>
            <option value="possible">Worth a look</option>
            <option value="stretch">Likely a stretch</option>
          </select>
          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
            <option value="">all roles</option>
            {roles.map(([id, title]) => (
              <option key={id} value={id}>
                {title} (#{id})
              </option>
            ))}
          </select>
        </div>
      )}

      {data && <CandidateCards candidates={filtered} showRoleTitles={true} />}
      {data && (
        <div style={{ marginTop: 28 }}>
          <SourcedCards sourced={data.sourced} />
        </div>
      )}
    </>
  );
}
