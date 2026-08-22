"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDash } from "@/components/dashboard/DashShell";
import ClientRequestsBlock from "@/components/dashboard/ClientRequestsBlock";

type Job = {
  id: string;
  title: string;
  status: string;
  salary: string;
  locations: string[];
  workplace: string;
  yoe: string;
  applicants: number;
  linked?: boolean;
};

export default function JobsPage() {
  const { token } = useDash();
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    fetch("/api/dashboard/jobs", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((data) => setJobs(data.jobs))
      .catch(() => setError(true));
  }, [token, refresh]);

  const open = jobs?.filter((j) => j.status === "open") ?? [];
  const closed = jobs?.filter((j) => j.status !== "open") ?? [];

  return (
    <>
      <ClientRequestsBlock onCopied={() => setRefresh((n) => n + 1)} />
      <div className="dash-jobhead">
        <div>
          <h1 className="dash-h1">Jobs</h1>
          <p className="dash-sub">
            {jobs
              ? `${open.length} open · ${closed.length} closed`
              : error
                ? "Couldn't load jobs — refresh to retry."
                : "Loading…"}
          </p>
        </div>
        <Link className="dash-btn" href="/dashboard/jobs/new">
          + New job
        </Link>
      </div>
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
              <tr
                key={j.id}
                className="dash-row-link"
                onClick={() => router.push(`/dashboard/jobs/${j.id}`)}
              >
                <td>
                  <span className="dash-name">
                    {j.title}
                    {j.linked && (
                      <span className="dash-linkchip" title="Linked to a client company — network sends land in their pipeline">
                        ⚡ linked
                      </span>
                    )}
                  </span>
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
        <>
          <div className="dash-sec" style={{ marginTop: 28 }}>
            Closed
          </div>
          <table className="dash-table">
            <tbody>
              {closed.map((j) => (
                <tr
                  key={j.id}
                  className="dash-row-link dash-row-closed"
                  onClick={() => router.push(`/dashboard/jobs/${j.id}`)}
                >
                  <td>
                    <span className="dash-name">{j.title}</span>
                    <small>#{j.id}</small>
                  </td>
                  <td className="dash-num">{j.applicants}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
