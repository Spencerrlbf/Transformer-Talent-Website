"use client";
// Employer-facing candidate cards: tag-first, plain-English reason, links.
// Shared by the per-job view and the cross-job Candidates page. Shows only
// what clients should see — no evidence, no Q&A, no internal shorthand.
import type { ClientTag } from "@/lib/server/client-reason";

export type CandidateView = {
  applicationId: string;
  name: string;
  location: string | null;
  linkedinUrl: string | null;
  resumeUrl: string | null;
  preferredLocations: string[];
  appliedAt: string;
  roles: {
    jobId: string;
    title: string;
    tag: ClientTag | null;
    tagLabel: string | null;
    reason: string | null;
  }[];
};

export type SourcedView = {
  name: string;
  title: string | null;
  company: string | null;
  location: string | null;
  linkedinUrl: string | null;
  jobId: string;
  jobTitle: string;
  note: string;
};

const TAG_CLASS: Record<ClientTag, string> = {
  strong: "t-strong",
  possible: "t-possible",
  stretch: "t-stretch",
};

export function CandidateCards({
  candidates,
  showRoleTitles,
}: {
  candidates: CandidateView[];
  showRoleTitles: boolean;
}) {
  if (candidates.length === 0)
    return <div className="dash-empty">No applicants yet — they&apos;ll appear here the moment someone applies on your board.</div>;
  return (
    <div className="dash-candlist">
      {candidates.map((c) => (
        <div key={c.applicationId} className="dash-cand">
          <div className="dash-cand-head">
            <div>
              <span className="dash-cand-name">{c.name}</span>
              <small>
                {[c.location, c.preferredLocations.length ? `open to ${c.preferredLocations.join(", ")}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            </div>
            <div className="dash-cand-links">
              {c.linkedinUrl && (
                <a href={c.linkedinUrl} target="_blank" rel="noreferrer">
                  LinkedIn
                </a>
              )}
              {c.resumeUrl && (
                <a href={c.resumeUrl} target="_blank" rel="noreferrer">
                  Resume
                </a>
              )}
              <span className="dash-cand-date">
                {new Date(c.appliedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            </div>
          </div>
          {c.roles.length === 0 && (
            <div className="dash-cand-role">
              <span className="dash-tag t-pending">General application</span>
              <p className="dash-cand-reason">
                Applied without picking a role — we&apos;re matching them against your openings.
              </p>
            </div>
          )}
          {c.roles.map((r) => (
            <div key={r.jobId} className="dash-cand-role">
              {r.tag ? (
                <span className={`dash-tag ${TAG_CLASS[r.tag]}`}>{r.tagLabel}</span>
              ) : (
                <span className="dash-tag t-pending">Screening…</span>
              )}
              <div>
                {showRoleTitles && (
                  <span className="dash-cand-roletitle">
                    {r.title} <em>#{r.jobId}</em>
                  </span>
                )}
                {r.reason && <p className="dash-cand-reason">{r.reason}</p>}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function SourcedCards({ sourced }: { sourced: SourcedView[] }) {
  if (sourced.length === 0) return null;
  return (
    <div className="dash-sourced">
      <div className="dash-sec" style={{ marginTop: 0 }}>
        Sourced by Transformer Talent
      </div>
      <div className="dash-candlist">
        {sourced.map((s, i) => (
          <div key={i} className="dash-cand dash-cand-sourced">
            <div className="dash-cand-head">
              <div>
                <span className="dash-cand-name">
                  {s.name}
                  <span className="dash-sourcedbadge">SOURCED</span>
                </span>
                <small>
                  {[s.title, s.company, s.location].filter(Boolean).join(" · ")}
                </small>
              </div>
              <div className="dash-cand-links">
                {s.linkedinUrl && (
                  <a href={s.linkedinUrl} target="_blank" rel="noreferrer">
                    LinkedIn
                  </a>
                )}
              </div>
            </div>
            <div className="dash-cand-role">
              <span className="dash-tag t-strong">Recommended</span>
              <div>
                <span className="dash-cand-roletitle">
                  {s.jobTitle} <em>#{s.jobId}</em>
                </span>
                <p className="dash-cand-reason">{s.note}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
