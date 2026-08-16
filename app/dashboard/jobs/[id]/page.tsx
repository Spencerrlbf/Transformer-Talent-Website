"use client";
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useDash } from "@/components/dashboard/DashShell";
import type { SkillChip } from "@/components/dashboard/JobForm";

type Job = {
  id: string;
  title: string;
  status: string;
  salary: string;
  locations: string[];
  workplace: string;
  visa: string;
  yoe: string;
  roleType: string;
  jd: { about?: string; doing?: string[]; needs?: string[]; bonus?: string[] } | null;
  skills: SkillChip[];
  source: string;
  applicants: number;
};

export default function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { token } = useDash();
  const [job, setJob] = useState<Job | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/dashboard/jobs/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => setJob(d ? d.job : null))
      .catch(() => setJob(null));
  }, [id, token]);
  useEffect(load, [load]);

  async function setStatus(status: "open" | "closed") {
    setBusy(true);
    await fetch(`/api/dashboard/jobs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status }),
    });
    setBusy(false);
    load();
  }

  if (job === undefined) return <p className="dash-muted">Loading…</p>;
  if (!job)
    return (
      <>
        <p className="dash-muted">Job not found.</p>
        <Link href="/dashboard">← Back to jobs</Link>
      </>
    );

  const editable = job.source === "dashboard";
  return (
    <>
      <div className="dash-crumb">
        <Link href="/dashboard">Jobs</Link> / {job.title}
      </div>
      <div className="dash-jobhead">
        <div>
          <h1 className="dash-h1">
            {job.title}{" "}
            <span className={`dash-status ${job.status}`}>{job.status}</span>
          </h1>
          <p className="dash-sub">
            #{job.id}
            {job.workplace && ` · ${job.workplace}`}
            {job.locations.length > 0 && ` · ${job.locations.join(", ")}`}
            {job.salary && ` · ${job.salary}`}
            {job.yoe && ` · ${job.yoe}`}
          </p>
        </div>
        <div className="dash-jobactions">
          {editable && (
            <Link className="dash-btn dash-btn-2" href={`/dashboard/jobs/${job.id}/edit`}>
              Edit
            </Link>
          )}
          {editable &&
            (job.status === "open" ? (
              <button className="dash-btn dash-btn-2" disabled={busy} onClick={() => setStatus("closed")}>
                Close job
              </button>
            ) : (
              <button className="dash-btn" disabled={busy} onClick={() => setStatus("open")}>
                Reopen
              </button>
            ))}
          {!editable && (
            <span className="dash-muted">Managed by Transformer Talent</span>
          )}
        </div>
      </div>

      <div className="dash-jobgrid">
        <section>
          {job.jd?.about && (
            <>
              <div className="dash-sec">About</div>
              <p className="dash-body">{job.jd.about}</p>
            </>
          )}
          {(job.jd?.doing?.length ?? 0) > 0 && (
            <>
              <div className="dash-sec">Responsibilities</div>
              <ul className="dash-list">{job.jd!.doing!.map((d, i) => <li key={i}>{d}</li>)}</ul>
            </>
          )}
          {(job.jd?.needs?.length ?? 0) > 0 && (
            <>
              <div className="dash-sec">Requirements</div>
              <ul className="dash-list">{job.jd!.needs!.map((d, i) => <li key={i}>{d}</li>)}</ul>
            </>
          )}
          {(job.jd?.bonus?.length ?? 0) > 0 && (
            <>
              <div className="dash-sec">Nice to have</div>
              <ul className="dash-list">{job.jd!.bonus!.map((d, i) => <li key={i}>{d}</li>)}</ul>
            </>
          )}
        </section>
        <aside>
          <div className="dash-sec">Applicants</div>
          <p className="dash-body">
            {job.applicants === 0 ? "None yet." : job.applicants} {job.applicants > 0 && "applicant" + (job.applicants === 1 ? "" : "s")}
          </p>
          <p className="dash-muted" style={{ fontSize: 12.5 }}>
            The candidate view with fit tags lands here in the next release.
          </p>
          {job.skills.length > 0 && (
            <>
              <div className="dash-sec">Skills</div>
              <div className="dash-skilltags">
                {job.skills.map((s, i) => (
                  <span key={i} className={`dash-skilltag ${s.must_have ? "must" : ""}`} title={s.alternates.length ? `or: ${s.alternates.join(", ")}` : undefined}>
                    {s.skill}
                    {s.alternates.length > 0 && <small> +{s.alternates.length} alt</small>}
                  </span>
                ))}
              </div>
            </>
          )}
          {job.visa && (
            <>
              <div className="dash-sec">Visa</div>
              <p className="dash-body">{job.visa}</p>
            </>
          )}
        </aside>
      </div>
    </>
  );
}
