"use client";
// Job workspace: one page with horizontal tabs — Overview (job details),
// Pipeline (unified candidates table + drawer), Sourcing (runs/builder),
// Past (placeholder until rejection statuses land). Deep-linkable via ?tab=.
import { Suspense, use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useDash } from "@/components/dashboard/DashShell";
import type { SkillChip } from "@/components/dashboard/JobForm";
import CandidatesTable from "@/components/dashboard/candidates/CandidatesTable";
import CandidateDrawer from "@/components/dashboard/candidates/CandidateDrawer";
import SourcingPanel from "@/components/dashboard/sourcing/SourcingPanel";
import { CompanyNameField, IdealCompanies, type TargetCompany } from "@/components/dashboard/jobs/IdealCompanies";

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
  targetCompanies: TargetCompany[];
  companyName: string;
};

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "pipeline", label: "Pipeline" },
  { id: "sourcing", label: "Sourcing" },
  { id: "past", label: "Past" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function isTab(v: string | null): v is TabId {
  return TABS.some((t) => t.id === v);
}

function JobWorkspace({ id }: { id: string }) {
  const { token } = useDash();
  const search = useSearchParams();
  const [job, setJob] = useState<Job | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabId>(() => {
    const t = search.get("tab");
    return isTab(t) ? t : "overview";
  });
  const [counts, setCounts] = useState<{
    all: number;
    applied: number;
    sourced: number;
    notNow: number;
    rejected: number;
  } | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/dashboard/jobs/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => setJob(d ? d.job : null))
      .catch(() => setJob(null));
  }, [id, token]);
  useEffect(load, [load]);

  function switchTab(next: TabId) {
    setTab(next);
    const url = next === "overview" ? `/dashboard/jobs/${id}` : `/dashboard/jobs/${id}?tab=${next}`;
    window.history.replaceState(null, "", url);
  }

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

      <nav className="jobws-tabs" aria-label="Job sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`jobws-tab ${tab === t.id ? "on" : ""}`}
            onClick={() => switchTab(t.id)}
          >
            {t.label}
            {t.id === "pipeline" && counts !== null && <span className="n">{counts.all}</span>}
          </button>
        ))}
      </nav>

      {tab === "overview" && (
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
            {!job.jd?.about && (job.jd?.doing?.length ?? 0) === 0 && (job.jd?.needs?.length ?? 0) === 0 && (
              <p className="dash-muted">No job description on file yet.</p>
            )}
          </section>
          <aside>
            <CompanyNameField
              jobId={job.id}
              initial={job.companyName}
              onSaved={(companyName) => setJob({ ...job, companyName })}
            />
            <IdealCompanies
              jobId={job.id}
              initial={job.targetCompanies}
              onSaved={(targetCompanies) => setJob({ ...job, targetCompanies })}
            />
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
      )}

      {/* Pipeline stays mounted across tab switches so filters, the open
          drawer, and the tab-badge count survive; hidden via CSS. */}
      <div style={{ display: tab === "pipeline" ? undefined : "none" }}>
        {counts && (
          <div className="cv2-countstrip">
            <span className="c">
              <b>{counts.all}</b>candidates
            </span>
            <span className="c">
              <b>{counts.applied}</b>applied
            </span>
            <span className="c">
              <b>{counts.sourced}</b>sourced
            </span>
            {counts.notNow > 0 && (
              <span className="c dim">
                <b>{counts.notNow}</b>&ldquo;Not now&rdquo; hidden
              </span>
            )}
            {counts.rejected > 0 && (
              <span className="c dim">
                <b>{counts.rejected}</b>rejected → Past
              </span>
            )}
            <span className="spacer" />
            <button className="link jobws-linkbtn" onClick={() => switchTab("sourcing")}>
              View sourcing runs →
            </button>
          </div>
        )}
        <CandidatesTable jobId={job.id} defaultHideNotNow onCounts={setCounts} onOpen={setOpenKey} />
      </div>

      {tab === "sourcing" && <SourcingPanel jobId={job.id} jobTitle={job.title} />}

      {tab === "past" && (
        <div className="jobws-past-empty">
          {counts && counts.rejected > 0 ? (
            <>
              <b>
                {counts.rejected} rejected candidate{counts.rejected === 1 ? "" : "s"}.
              </b>
              <p>
                The full Past list — profiles, rejection context, and a restore button — arrives with
                the next update. Rejected candidates are already out of your active Pipeline.
              </p>
            </>
          ) : (
            <>
              <b>No past candidates yet.</b>
              <p>
                Set a candidate&apos;s stage to &ldquo;Rejected&rdquo; in the Pipeline tab and
                they&apos;ll move here so your active list stays clean — with their profile and the
                reason kept for reference.
              </p>
            </>
          )}
        </div>
      )}

      <CandidateDrawer candKey={openKey} roleContext={job.id} onClose={() => setOpenKey(null)} />
    </>
  );
}

export default function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={<p className="dash-muted">Loading…</p>}>
      <JobWorkspace id={id} />
    </Suspense>
  );
}
