"use client";
import { useEffect, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";

type Job = {
  id: string;
  title: string;
  status: string;
  salary: string;
  locations: string[];
  workplace: string;
  yoe: string;
  applicants: number;
};

export default function JobsPage() {
  const { token } = useDash();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/api/dashboard/jobs", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((data) => setJobs(data.jobs))
      .catch(() => setError(true));
  }, [token]);

  const open = jobs?.filter((j) => j.status === "open") ?? [];
  const closed = jobs?.filter((j) => j.status !== "open") ?? [];

  return (
    <>
      <h1 className="dash-h1">Jobs</h1>
      <p className="dash-sub">
        {jobs
          ? `${open.length} open · ${closed.length} closed`
          : error
            ? "Couldn't load jobs — refresh to retry."
            : "Loading…"}
      </p>
      {jobs && jobs.length === 0 && (
        <div className="dash-empty">
          No jobs yet. Job creation from this dashboard is coming next — for
          now, we set roles up for you during onboarding.
        </div>
      )}
      {open.length > 0 && (
        <table className="dash-table">
          <thead>
            <tr>
              <th>Role</th>
              <th>Locations</th>
              <th>Salary</th>
              <th>Years</th>
              <th className="dash-num">Applicants</th>
            </tr>
          </thead>
          <tbody>
            {open.map((j) => (
              <tr key={j.id}>
                <td>
                  <span className="dash-name">{j.title}</span>
                  <small>
                    #{j.id}
                    {j.workplace ? ` · ${j.workplace}` : ""}
                  </small>
                </td>
                <td>{j.locations.join(", ") || "—"}</td>
                <td>{j.salary || "—"}</td>
                <td>{j.yoe || "—"}</td>
                <td className="dash-num">{j.applicants}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {closed.length > 0 && (
        <p className="dash-muted" style={{ marginTop: 16 }}>
          {closed.length} closed role{closed.length === 1 ? "" : "s"} hidden.
        </p>
      )}
    </>
  );
}
