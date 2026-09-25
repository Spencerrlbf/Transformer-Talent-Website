"use client";
// Job workspace: one page with horizontal tabs — Overview (job details),
// Pipeline (unified candidates table + drawer), Sourcing (runs/builder),
// Past (placeholder until rejection statuses land). Deep-linkable via ?tab=.
// A person opened from a sourcing run's table gets the same drawer, with
// that run's page to step through and Yes or No on its report card.
import { Suspense, use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useDash } from "@/components/dashboard/DashShell";
import type { SkillChip } from "@/components/dashboard/JobForm";
import CandidatesTable from "@/components/dashboard/candidates/CandidatesTable";
import PipelineBoard from "@/components/dashboard/candidates/PipelineBoard";
import CandidateDrawer from "@/components/dashboard/candidates/CandidateDrawer";
import type { Decision } from "@/components/dashboard/candidates/VerdictCard";
import SourcingPanel from "@/components/dashboard/sourcing/SourcingPanel";
import type { RunOpenContext } from "@/components/dashboard/sourcing/RunView";
import type { CandidateRow } from "@/components/dashboard/sourcing/types";
import { CompanyNameField, IdealCompanies, type TargetCompany } from "@/components/dashboard/jobs/IdealCompanies";
import InterviewStagesCard from "@/components/dashboard/jobs/InterviewStagesCard";
import ClientLinkCard from "@/components/dashboard/jobs/ClientLinkCard";
import LeadEmailsCard, { type Teammate } from "@/components/dashboard/jobs/LeadEmailsCard";
import SourcingHelpCard from "@/components/dashboard/jobs/SourcingHelpCard";
import ShortlistPanel from "@/components/dashboard/jobs/ShortlistPanel";
import ScorecardCard from "@/components/dashboard/rolecard/ScorecardCard";

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
  linkedOrgRole: { orgId: string; jobId: string } | null;
  sourcingRequested: boolean;
  leadEmails?: { userIds: string[]; team: Teammate[] };
};

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "pipeline", label: "Pipeline" },
  { id: "sourcing", label: "Sourcing" },
  { id: "shortlist", label: "Shortlist" },
  { id: "past", label: "Past" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function isTab(v: string | null): v is TabId {
  return TABS.some((t) => t.id === v);
}

function JobWorkspace({ id }: { id: string }) {
  const { token, org } = useDash();
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
  const [rowKeys, setRowKeys] = useState<string[]>([]);
  const [shortlistCount, setShortlistCount] = useState<number | null>(null);
  // Opened from a sourcing run's table: that run, and each person on the
  // page's membership, so the drawer can hold Yes or No on them; and the
  // page's people in order, to step through.
  const [runPick, setRunPick] = useState<{ runId: string; members: RunOpenContext["members"] } | null>(null);
  const [runKeys, setRunKeys] = useState<string[]>([]);
  // Bumped when the drawer decides Yes or No, so the run table's row follows.
  const [sourcingRefresh, setSourcingRefresh] = useState(0);
  // Bumped when a Past-tab restore happens so the (mounted) Pipeline table refetches.
  const [pipelineRefresh, setPipelineRefresh] = useState(0);
  // Pipeline view: the table and the board are the same data in two shapes.
  const [view, setView] = useState<"table" | "board">(() =>
    search.get("view") === "board" ? "board" : "table"
  );
  // TT-only shortcut: how many nightly pool matches exist for this role.
  const [netCount, setNetCount] = useState<number>(0);

  useEffect(() => {
    if (org.slug !== "transformer-talent") return;
    fetch(`/api/dashboard/network?job=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => setNetCount(d?.total ?? 0))
      .catch(() => {});
  }, [id, token, org.slug]);

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

  const onOpenCandidate = (row: CandidateRow, ctx: RunOpenContext) => {
    setRunPick({ runId: ctx.runId, members: ctx.members });
    setRunKeys(ctx.keys);
    setOpenKey(row.candidateKey);
  };
  // Yes or No from the drawer, on the run's membership: the same rule as the
  // run table's own buttons, optimistic here, then the table reloads.
  async function decide(key: string, patch: { shortlisted?: boolean; hidden?: boolean }) {
    const pick = runPick;
    const m = pick?.members[key];
    if (!pick || !m) return;
    setRunPick((p) => (p && p.members[key] ? { ...p, members: { ...p.members, [key]: { ...p.members[key], ...patch } } } : p));
    await fetch(`/api/dashboard/sourcing/runs/${pick.runId}/candidates`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ membershipId: m.membershipId, ...patch }),
    }).catch(() => {});
    setSourcingRefresh((n) => n + 1);
  }
  // Yes shortlists (and un-hides); No hides (and un-shortlists). Pressing
  // the one already filled takes it back.
  const member = runPick && openKey ? runPick.members[openKey] : undefined;
  const decision: Decision | undefined =
    member && openKey
      ? {
          shortlisted: member.shortlisted,
          hidden: member.hidden,
          onYes: () => decide(openKey, member.shortlisted ? { shortlisted: false } : { shortlisted: true, hidden: false }),
          onNo: () => decide(openKey, member.hidden ? { hidden: false } : { hidden: true, shortlisted: false }),
        }
      : undefined;

  if (job === undefined) return <p className="dash-muted">Loading…</p>;
  if (!job)
    return (
      <>
        <p className="dash-muted">Job not found.</p>
        <Link href="/dashboard/jobs">← Back to jobs</Link>
      </>
    );

  const editable = job.source === "dashboard";
  return (
    <>
      <div className="dash-crumb">
        <Link href="/dashboard/jobs">Jobs</Link> / {job.title}
      </div>
      <div className="dash-jobhead">
        <div>
          <h1 className="dash-h1">
            {job.title}{" "}
            <span className={`dash-status ${job.status}`}>{job.status}</span>
            {job.linkedOrgRole && <span className="dash-linkchip">linked</span>}
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

      <nav className="dash-tabs jobws-tabs" aria-label="Job sections">
        {/* The Shortlist is TT's pool: TT's own jobs only (the API 404s others). */}
        {TABS.filter((t) => t.id !== "shortlist" || org.slug === "transformer-talent").map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "on" : ""}
            onClick={() => switchTab(t.id)}
          >
            {t.label}
            {t.id === "pipeline" && counts !== null && <span className="n">{counts.all}</span>}
            {t.id === "shortlist" && shortlistCount !== null && shortlistCount > 0 && <span className="n">{shortlistCount}</span>}
            {t.id === "past" && counts !== null && counts.rejected > 0 && (
              <span className="n">{counts.rejected}</span>
            )}
          </button>
        ))}
      </nav>

      {tab === "overview" && (
        <div className="dash-jobgrid">
          <section>
            <ScorecardCard jobId={job.id} />
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
          <aside className="jw-rail">
            <div className="jw-card">
            <CompanyNameField
              jobId={job.id}
              initial={job.companyName}
              onSaved={(companyName) => setJob({ ...job, companyName })}
            />
            </div>
            <div className="jw-card">
            <IdealCompanies
              jobId={job.id}
              initial={job.targetCompanies}
              onSaved={(targetCompanies) => setJob({ ...job, targetCompanies })}
            />
            </div>
            <div className="jw-card">
              <InterviewStagesCard jobId={job.id} />
            </div>
            {job.leadEmails && (
              <div className="jw-card">
                <LeadEmailsCard jobId={job.id} initial={job.leadEmails} />
              </div>
            )}
            <div className="jw-card">
            {org.slug === "transformer-talent" ? (
              <ClientLinkCard
                jobId={job.id}
                initial={job.linkedOrgRole}
                onSaved={(linkedOrgRole) => setJob({ ...job, linkedOrgRole })}
              />
            ) : (
              <SourcingHelpCard jobId={job.id} initial={job.sourcingRequested} />
            )}
            </div>
            {job.skills.length > 0 && (
              <div className="jw-card">
                <div className="dash-sec">Skills</div>
                <div className="dash-skilltags">
                  {job.skills.map((s, i) => (
                    <span key={i} className={`dash-skilltag ${s.must_have ? "must" : ""}`} title={s.alternates.length ? `or: ${s.alternates.join(", ")}` : undefined}>
                      {s.skill}
                      {s.alternates.length > 0 && <small> +{s.alternates.length} alt</small>}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {job.visa && (
              <div className="jw-card">
                <div className="dash-sec">Visa</div>
                <p className="dash-body">{job.visa}</p>
              </div>
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
            {netCount > 0 && (
              <Link className="link nw-strip-link" href={`/dashboard/network?job=${job.id}`}>
                {netCount} network match{netCount === 1 ? "" : "es"} →
              </Link>
            )}
            <button className="link jobws-linkbtn" onClick={() => switchTab("sourcing")}>
              View sourcing runs →
            </button>
          </div>
        )}
        <div className="pb-viewbar">
          <div className="dash-seg" role="tablist" aria-label="Pipeline view">
            {(["table", "board"] as const).map((v) => (
              <button
                key={v}
                className={view === v ? "on" : ""}
                onClick={() => {
                  setView(v);
                  const url = new URL(window.location.href);
                  if (v === "board") url.searchParams.set("view", "board");
                  else url.searchParams.delete("view");
                  window.history.replaceState(null, "", url.toString());
                }}
              >
                {v === "table" ? "Table" : "Board"}
              </button>
            ))}
          </div>
        </div>
        {/* Both views stay mounted so filters / scroll positions survive the
            toggle; each hides via CSS. */}
        <div style={{ display: view === "table" ? undefined : "none" }}>
          <CandidatesTable
            jobId={job.id}
            defaultHideNotNow
            refreshKey={pipelineRefresh}
            onCounts={setCounts}
            onOpen={setOpenKey}
            onKeys={setRowKeys}
          />
        </div>
        {view === "board" && (
          <PipelineBoard
            jobId={job.id}
            refreshKey={pipelineRefresh}
            onOpen={setOpenKey}
            onChanged={() => setPipelineRefresh((n) => n + 1)}
          />
        )}
      </div>

      {tab === "sourcing" && <SourcingPanel jobId={job.id} jobTitle={job.title} onOpenCandidate={onOpenCandidate} refreshKey={sourcingRefresh} />}

      {tab === "shortlist" && org.slug === "transformer-talent" && <ShortlistPanel jobId={job.id} onOpen={setOpenKey} onKeys={setRowKeys} onCount={setShortlistCount} />}

      {tab === "past" && (
        <>
          <p className="dash-sub jobws-past-lead">
            People you rejected on this role, and people you stopped chasing (No reply). Profiles and
            reviews are kept; restore anyone to put them back in the active pipeline.
          </p>
          <CandidatesTable
            jobId={job.id}
            past
            onOpen={setOpenKey}
            onKeys={setRowKeys}
            onRestored={() => setPipelineRefresh((n) => n + 1)}
          />
        </>
      )}

      <CandidateDrawer
        candKey={openKey}
        roleContext={job.id}
        onClose={() => {
          setOpenKey(null);
          setRunPick(null);
        }}
        navKeys={runPick ? runKeys : rowKeys}
        onNavigate={setOpenKey}
        decision={decision}
        onVerdictChanged={() => setSourcingRefresh((n) => n + 1)}
      />
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
