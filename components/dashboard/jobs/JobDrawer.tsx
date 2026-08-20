"use client";
// Job side panel: the role's details in a slide-over, so clicking a role
// (from a candidate's pipeline or the Network page) doesn't force a new tab.
// Stacks ABOVE the candidate drawer; the opener owns Esc handling.
import { useEffect, useState } from "react";
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
  jd: { about?: string; doing?: string[]; needs?: string[]; bonus?: string[] } | null;
  skills: SkillChip[];
  companyName: string;
};

export default function JobDrawer({ jobId, onClose }: { jobId: string | null; onClose: () => void }) {
  const { token } = useDash();
  const [job, setJob] = useState<Job | null | undefined>(undefined);

  useEffect(() => {
    setJob(undefined);
    if (!jobId) return;
    fetch(`/api/dashboard/jobs/${jobId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => setJob(d ? d.job : null))
      .catch(() => setJob(null));
  }, [jobId, token]);

  if (!jobId) return null;

  return (
    // stopPropagation: this panel can sit inside the candidate drawer's
    // overlay — a backdrop click here must not bubble up and close both.
    <div
      className="jdw-overlay"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <aside className="jdw" onClick={(e) => e.stopPropagation()}>
        <button className="cv2d-close" aria-label="Close job panel" onClick={onClose}>
          ✕
        </button>
        {job === undefined && <p className="dash-muted jdw-pad">Loading job…</p>}
        {job === null && <p className="dash-muted jdw-pad">Job not found.</p>}
        {job && (
          <div className="jdw-pad">
            <h2 className="jdw-title">
              {job.title} <span className={`dash-status ${job.status}`}>{job.status}</span>
            </h2>
            <p className="jdw-sub">
              #{job.id}
              {job.companyName && ` · ${job.companyName}`}
              {job.workplace && ` · ${job.workplace}`}
              {job.locations.length > 0 && ` · ${job.locations.join(", ")}`}
              {job.salary && ` · ${job.salary}`}
              {job.yoe && ` · ${job.yoe}`}
            </p>
            <a className="jdw-open" href={`/dashboard/jobs/${job.id}`} target="_blank" rel="noreferrer">
              Open full page ↗
            </a>

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
            {job.skills.length > 0 && (
              <>
                <div className="dash-sec">Skills</div>
                <div className="dash-skilltags">
                  {job.skills.map((s, i) => (
                    <span key={i} className={`dash-skilltag ${s.must_have ? "must" : ""}`}>
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
          </div>
        )}
      </aside>
    </div>
  );
}
