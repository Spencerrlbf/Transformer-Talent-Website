"use client";
// Candidates v2 profile drawer: slides in over the table. Profile tab is the
// pure LinkedIn-style profile (header, editable contact, experience grouped
// by employer, education, skills); fit reviews live ONLY in the Pipeline tab,
// one expandable row per role. Resume renders inline when on file. Notes is
// the shared timeline: team notes, tasks, and the candidate's own ask.
import { useCallback, useEffect, useRef, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import { StageSelect } from "@/components/dashboard/candidates/CandidatesTable";
import JobDrawer from "@/components/dashboard/jobs/JobDrawer";
import MultiSelect from "@/components/MultiSelect";
import NotesTab from "@/components/dashboard/tasks/NotesTab";
import EmailModal from "@/components/dashboard/email/EmailModal";
import {
  ROLE_FOCUS_OPTIONS,
  WORKPLACE_OPTIONS,
  SALARY_BAND_OPTIONS,
  VISA_OPTIONS,
} from "@/lib/future-options";

type PipelineEntry = {
  jobId: string;
  title: string;
  company: string | null;
  salary: string | null;
  location: string | null;
  via: "applied" | "sourced" | "matched" | "added";
  tag: string | null;
  tagLabel: string | null;
  reason: string | null;
  addedAt: string;
  stage: string;
};

type Detail = {
  key: string;
  name: string;
  headline: string | null;
  location: string | null;
  linkedinUrl: string | null;
  photoUrl: string | null;
  about: string | null;
  source: "applied" | "sourced";
  shortlisted: boolean;
  viaTT: boolean;
  alsoSourced: boolean;
  provenance: string;
  contact: { email?: string | null; phone?: string | null; github?: string | null; otherEmails?: string[] | null };
  bestTag: string | null;
  bestTagLabel: string | null;
  screeningPending?: boolean;
  followUp: {
    at: string;
    due: boolean;
    askedAt: string;
    roles: string[];
    workplace: string[];
    locations: string[];
    locationOptions: string[];
    salary: string | null;
    visa: string | null;
  } | null;
  pipeline: PipelineEntry[];
  experience: {
    company: string;
    logoUrl: string | null;
    companyLinkedinUrl: string | null;
    span: string | null;
    roles: {
      title: string;
      dates: string | null;
      duration: string | null;
      location: string | null;
      employmentType: string | null;
      description: string | null;
    }[];
  }[];
  education: {
    school: string;
    logoUrl: string | null;
    linkedinUrl: string | null;
    degree: string | null;
    field: string | null;
    period: string | null;
  }[];
  skills: string[];
  resumeUrl: string | null;
  resumeName: string | null;
  hasResume: boolean;
  addedAt: string;
};

const TAG_CLASS: Record<string, string> = {
  strong_yes: "t-strong",
  strong: "t-strong",
  yes: "t-yes",
  possible: "t-possible",
  worth_message: "t-msg",
  stretch: "t-stretch",
  not_now: "t-notnow",
};

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

function HeadAvatar({ photoUrl, name }: { photoUrl: string | null; name: string }) {
  const [broken, setBroken] = useState(false);
  if (!photoUrl || broken)
    return <div className="cv2d-avatar cv2d-avatar-fallback">{initials(name)}</div>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="cv2d-avatar" src={photoUrl} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
  );
}

// Company/school tile: real logo when the (expiring) LinkedIn CDN URL still
// works, letter tile otherwise. Clickable through to the LinkedIn page.
function OrgLogo({
  logoUrl,
  linkedinUrl,
  label,
}: {
  logoUrl: string | null;
  linkedinUrl: string | null;
  label: string;
}) {
  const [broken, setBroken] = useState(false);
  const tile =
    logoUrl && !broken ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className="cv2d-xp-logo"
        src={logoUrl}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    ) : (
      <div className="cv2d-xp-logo cv2d-xp-logo-fb">{label[0]}</div>
    );
  return linkedinUrl ? (
    <a
      href={linkedinUrl}
      target="_blank"
      rel="noreferrer"
      title={`Open ${label} on LinkedIn`}
      className="cv2d-xp-logolink"
    >
      {tile}
    </a>
  ) : (
    tile
  );
}

const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

// Stored sourced reasons are "<why> Worth asking: <a · b> → <route>"; render
// them structured, falling back to the raw text for any other shape.
function splitReason(reason: string): { why: string; probes: string[]; route: string | null } {
  let rest = reason;
  let route: string | null = null;
  const routeIdx = rest.lastIndexOf(" → ");
  if (routeIdx !== -1) {
    route = rest.slice(routeIdx + 3).trim() || null;
    rest = rest.slice(0, routeIdx);
  }
  let probes: string[] = [];
  const probeIdx = rest.indexOf("Worth asking:");
  if (probeIdx !== -1) {
    probes = rest.slice(probeIdx + "Worth asking:".length).split(" · ").map((s) => s.trim()).filter(Boolean);
    rest = rest.slice(0, probeIdx);
  }
  return { why: rest.trim(), probes, route };
}

function FitReview({ entry }: { entry: PipelineEntry }) {
  if (!entry.reason) return <p className="cv2d-why cv2d-dim">Not reviewed yet.</p>;
  const { why, probes, route } = splitReason(entry.reason);
  return (
    <>
      <p className="cv2d-why">{why}</p>
      {probes.length > 0 && (
        <div className="cv2d-probe">
          <b>Worth asking about</b>
          <ul>
            {probes.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {route && <div className="cv2d-route">↪ {route}</div>}
    </>
  );
}

function PipelineRows({
  entry,
  expanded,
  onToggle,
  onStage,
  stageBusy,
  stageEditable = true,
  screeningPending = true,
  onOpenJob,
}: {
  entry: PipelineEntry;
  expanded: boolean;
  onToggle: () => void;
  onStage: (jobId: string, stage: string) => void;
  stageBusy: boolean;
  stageEditable?: boolean;
  screeningPending?: boolean;
  onOpenJob: (jobId: string) => void;
}) {
  return (
    <>
      <tr className="cv2d-prow" onClick={onToggle}>
        <td className="cv2d-prole">
          <button
            type="button"
            className="cv2d-rolebtn"
            title="View this job"
            onClick={(e) => {
              e.stopPropagation();
              onOpenJob(entry.jobId);
            }}
          >
            {entry.title} <em>#{entry.jobId}</em>
          </button>
          <small>
            {[
              entry.via === "applied"
                ? "applied"
                : entry.via === "matched"
                  ? "matched"
                  : entry.via === "added"
                    ? "added by your team"
                    : "via sourcing run",
              entry.company,
              entry.salary,
              entry.location,
            ]
              .filter(Boolean)
              .join(" · ")}
          </small>
        </td>
        <td className="cv2d-pnum">{fmtDay(entry.addedAt)}</td>
        <td>
          {entry.tag ? (
            <span className={`dash-tag ${TAG_CLASS[entry.tag] || "t-pending"}`}>{entry.tagLabel}</span>
          ) : (
            <span
              className="dash-tag t-pending"
              title={
                screeningPending
                  ? undefined
                  : "Screening finished — this role did not match strongly enough to run a full screen."
              }
            >
              {screeningPending ? "Screening…" : "No role match"}
            </span>
          )}
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          {stageEditable ? (
            <StageSelect
              value={entry.stage || "new"}
              busy={stageBusy}
              onChange={(s) => onStage(entry.jobId, s)}
            />
          ) : (
            <span className="cv2d-stage">Match</span>
          )}
        </td>
        <td className="cv2d-pcar">{expanded ? "▾" : "▸"}</td>
      </tr>
      {expanded && (
        <tr className="cv2d-preview-row">
          <td colSpan={5}>
            <div className="cv2d-pipe-detail">
              <FitReview entry={entry} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

type Tab = "profile" | "pipeline" | "resume" | "notes";

export default function CandidateDrawer({
  candKey,
  roleContext,
  onClose,
  navKeys,
  onNavigate,
}: {
  candKey: string | null;
  roleContext?: string;
  onClose: () => void;
  /** The list's current row order — enables ‹ › stepping without closing. */
  navKeys?: string[];
  onNavigate?: (key: string) => void;
}) {
  const { token } = useDash();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<Tab>("profile");
  const [expanded, setExpanded] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const [stageSaving, setStageSaving] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const [markedDone, setMarkedDone] = useState(false);
  // Editable ask panel state; fields seeded from detail.followUp on Edit.
  const [askEditing, setAskEditing] = useState(false);
  const [askSaving, setAskSaving] = useState(false);
  const [askErr, setAskErr] = useState("");
  const [eAt, setEAt] = useState("");
  const [eRoles, setERoles] = useState<string[]>([]);
  const [eWp, setEWp] = useState<string[]>([]);
  const [eLocs, setELocs] = useState<string[]>([]);
  const [eSal, setESal] = useState("");
  const [eVisa, setEVisa] = useState("");
  const [editingContact, setEditingContact] = useState(false);
  const [openJob, setOpenJob] = useState<string | null>(null);
  // Pool person opened from the internal Network page: read-only extras
  // (no stage edits, no contact edit, no resume upload).
  const isNet = !!candKey?.startsWith("net_");
  const [cEmail, setCEmail] = useState("");
  const [cPhone, setCPhone] = useState("");
  const [cGithub, setCGithub] = useState("");
  const [cOther, setCOther] = useState("");
  const [contactErr, setContactErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  // Bumped on send so an already-open Notes tab remounts and refetches.
  const [notesBump, setNotesBump] = useState(0);

  useEffect(() => {
    setDetail(null);
    setError(false);
    setTab("profile");
    setEditingContact(false);
    setContactErr("");
    setOpenJob(null);
    setEmailOpen(false);
    setMarking(false);
    setMarkedDone(false);
    setAskEditing(false);
    setAskErr("");
    if (!candKey) return;
    fetch(`/api/dashboard/candidates/v2/${candKey}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<Detail>;
      })
      .then((d) => {
        setDetail(d);
        setCEmail(d.contact.email || "");
        setCPhone(d.contact.phone || "");
        setCGithub(d.contact.github || "");
        setCOther((d.contact.otherEmails || []).join(", "));
        // Opened from a job page: that role's review is what they came for.
        const ctx = roleContext && d.pipeline.find((p) => p.jobId === roleContext);
        setExpanded(ctx ? ctx.jobId : d.pipeline[0]?.jobId ?? null);
        if (ctx) setTab("pipeline");
      })
      .catch(() => setError(true));
  }, [candKey, token, roleContext]);

  // Toggle Shortlist membership from the header star (optimistic).
  const [starBusy, setStarBusy] = useState(false);
  async function toggleStar() {
    if (!candKey || !detail || starBusy) return;
    const was = detail.shortlisted;
    setStarBusy(true);
    setDetail({ ...detail, shortlisted: !was });
    const res = await fetch(`/api/dashboard/lists/shortlist/members`, {
      method: was ? "DELETE" : "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ keys: [candKey] }),
    }).catch(() => null);
    setStarBusy(false);
    if (!res?.ok) setDetail((d) => (d ? { ...d, shortlisted: was } : d));
  }

  // Save one role's stage from the pipeline table; optimistic with rollback.
  async function changeStage(jobId: string, stage: string) {
    if (!candKey || !detail) return;
    const prev = detail.pipeline.find((p) => p.jobId === jobId)?.stage ?? "new";
    setStageSaving(jobId);
    setDetail({
      ...detail,
      pipeline: detail.pipeline.map((p) => (p.jobId === jobId ? { ...p, stage } : p)),
    });
    const res = await fetch(`/api/dashboard/candidates/v2/${candKey}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jobId, status: stage }),
    }).catch(() => null);
    setStageSaving(null);
    if (!res?.ok)
      setDetail((d) =>
        d
          ? { ...d, pipeline: d.pipeline.map((p) => (p.jobId === jobId ? { ...p, stage: prev } : p)) }
          : d
      );
  }

  // Prev/next within the list that opened the drawer (current page's order).
  const navIndex = candKey && navKeys ? navKeys.indexOf(candKey) : -1;
  const navPrev = navIndex > 0 ? navKeys![navIndex - 1] : null;
  const navNext = navIndex >= 0 && navIndex < (navKeys?.length ?? 0) - 1 ? navKeys![navIndex + 1] : null;

  const escClose = useCallback(
    (e: KeyboardEvent) => {
      // Esc peels the top layer: job panel first, then the drawer itself.
      if (e.key === "Escape") {
        if (openJob) setOpenJob(null);
        else onClose();
      }
      // Arrow keys step through the list — but never while typing.
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && onNavigate) {
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName || "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
        const to = e.key === "ArrowLeft" ? navPrev : navNext;
        if (to) onNavigate(to);
      }
    },
    [onClose, openJob, onNavigate, navPrev, navNext]
  );
  useEffect(() => {
    if (!candKey) return;
    document.addEventListener("keydown", escClose);
    return () => document.removeEventListener("keydown", escClose);
  }, [candKey, escClose]);

  if (!candKey) return null;

  const uploadResume = async (file: File) => {
    setUploadErr("");
    if (file.type && file.type !== "application/pdf") {
      setUploadErr("PDF files only.");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setUploadErr("That file is over 8MB.");
      return;
    }
    setUploading(true);
    const body = new FormData();
    body.append("file", file);
    const res = await fetch(`/api/dashboard/candidates/v2/${candKey}/resume`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body,
    }).catch(() => null);
    setUploading(false);
    if (!res || !res.ok) {
      setUploadErr("Upload failed — try again.");
      return;
    }
    const r = (await res.json()) as { resumeUrl: string | null; resumeName: string | null };
    if (detail) setDetail({ ...detail, resumeUrl: r.resumeUrl, resumeName: r.resumeName, hasResume: true });
  };

  const putContact = async (payload: {
    email: string; phone: string; github: string; otherEmails: string[];
  }): Promise<boolean> => {
    setSaving(true);
    setContactErr("");
    const res = await fetch(`/api/dashboard/candidates/v2/${candKey}/contact`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
    setSaving(false);
    if (!res || !res.ok) {
      const err = res ? ((await res.json()) as { error?: string }).error : null;
      setContactErr(
        err === "invalid_email" ? "One of those emails doesn't look right."
        : err === "invalid_phone" ? "That phone number doesn't look right."
        : "Couldn't save — try again."
      );
      return false;
    }
    const { contact } = (await res.json()) as { contact: Detail["contact"] };
    setDetail((d) => (d ? { ...d, contact } : d));
    setCEmail(contact.email || "");
    setCPhone(contact.phone || "");
    setCGithub(contact.github || "");
    setCOther((contact.otherEmails || []).join(", "));
    return true;
  };

  const saveContact = async () => {
    const ok = await putContact({
      email: cEmail,
      phone: cPhone,
      github: cGithub,
      otherEmails: cOther.split(/[,\n;]+/).map((e) => e.trim()).filter(Boolean),
    });
    if (ok) setEditingContact(false);
  };

  // One-click actions on the other-emails list (display mode).
  const makePrimary = (email: string) => {
    const d = detail!;
    const others = (d.contact.otherEmails || []).filter((e) => e !== email);
    if (d.contact.email) others.unshift(d.contact.email);
    putContact({
      email,
      phone: d.contact.phone || "",
      github: d.contact.github || "",
      otherEmails: others,
    });
  };
  const removeOther = (email: string) => {
    const d = detail!;
    putContact({
      email: d.contact.email || "",
      phone: d.contact.phone || "",
      github: d.contact.github || "",
      otherEmails: (d.contact.otherEmails || []).filter((e) => e !== email),
    });
  };

  const currentRole = detail?.experience[0]?.roles[0];
  const currentCompany = detail?.experience[0]?.company;

  return (
    <div className="cv2d-overlay" onClick={onClose}>
      <JobDrawer jobId={openJob} onClose={() => setOpenJob(null)} />
      {emailOpen && detail && candKey && (
        <EmailModal
          candKey={candKey}
          candidateName={detail.name}
          onClose={() => setEmailOpen(false)}
          onSent={() => {
            setTab("notes");
            setNotesBump((b) => b + 1);
          }}
        />
      )}
      <aside
        className={`cv2d${onNavigate && navIndex >= 0 && (navKeys?.length ?? 0) > 1 ? " has-nav" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        {onNavigate && navIndex >= 0 && (navKeys?.length ?? 0) > 1 && (
          <span className="cv2d-nav">
            <button
              type="button"
              disabled={!navPrev}
              aria-label="Previous candidate"
              onClick={() => navPrev && onNavigate(navPrev)}
            >
              ‹
            </button>
            <span className="cv2d-navpos">
              {navIndex + 1} of {navKeys!.length}
            </span>
            <button
              type="button"
              disabled={!navNext}
              aria-label="Next candidate"
              onClick={() => navNext && onNavigate(navNext)}
            >
              ›
            </button>
          </span>
        )}
        <button className="cv2d-close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        {error && <div className="dash-empty" style={{ margin: 24 }}>Couldn&apos;t load this profile — close and retry.</div>}
        {!error && !detail && <div className="cv2d-loading">Loading profile…</div>}

        {detail && (
          <>
            <div className="cv2d-head">
              <HeadAvatar photoUrl={detail.photoUrl} name={detail.name} />
              <div className="cv2d-id">
                <div className="cv2d-name">
                  <h3>{detail.name}</h3>
                  {!isNet && (
                    <button
                      type="button"
                      className={`cv2d-star${detail.shortlisted ? " on" : ""}`}
                      disabled={starBusy}
                      title={detail.shortlisted ? "On your Shortlist — click to remove" : "Add to Shortlist"}
                      aria-label="Shortlist"
                      onClick={toggleStar}
                    >
                      {detail.shortlisted ? "★" : "☆"}
                    </button>
                  )}
                  {!isNet && (
                    <button
                      type="button"
                      className="cv2d-mail"
                      title={`Email ${detail.name.split(/\s+/)[0] || "them"}`}
                      aria-label="Send email"
                      onClick={() => setEmailOpen(true)}
                    >
                      ✉
                    </button>
                  )}
                  {detail.bestTag && (
                    <span className={`dash-tag ${TAG_CLASS[detail.bestTag] || "t-pending"}`}>
                      {detail.bestTagLabel}
                    </span>
                  )}
                  {detail.viaTT && <span className="cv2-via">Via TT</span>}
                </div>
                {detail.headline && <div className="cv2d-headline">{detail.headline}</div>}
                <div className="cv2d-meta">
                  {[
                    currentRole && currentCompany ? `${currentRole.title} at ${currentCompany}` : null,
                    detail.location,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                <div className="cv2d-links">
                  {detail.linkedinUrl && (
                    <a href={detail.linkedinUrl} target="_blank" rel="noreferrer">
                      LinkedIn ↗
                    </a>
                  )}
                  <span className={`cv2-src cv2-src-${detail.source}`}>
                    <i />
                    {detail.source === "applied" ? "Applied" : "Sourced"}
                  </span>
                  {detail.alsoSourced && detail.source === "applied" && (
                    <span className="cv2d-dim">also in your sourcing runs</span>
                  )}
                </div>

                {/* Contact: email / phone / github, editable in place. */}
                {!editingContact ? (
                  <div className="cv2d-contact">
                    {(
                      [
                        ["email", detail.contact.email, "Add email"],
                        ["phone", detail.contact.phone, "Add phone"],
                        ["github", detail.contact.github, "Add GitHub"],
                      ] as const
                    ).map(([field, value, addLabel]) =>
                      value ? (
                        field === "github" ? (
                          <a
                            key={field}
                            href={value.startsWith("http") ? value : `https://github.com/${value.replace(/^@/, "")}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {value.replace(/^https?:\/\/(www\.)?github\.com\//, "github.com/")}
                          </a>
                        ) : (
                          <span key={field}>{value}</span>
                        )
                      ) : (
                        <button key={field} className="cv2d-add" onClick={() => setEditingContact(true)}>
                          + {addLabel}
                        </button>
                      )
                    )}
                    <button className="cv2d-edit" onClick={() => setEditingContact(true)}>
                      Edit
                    </button>
                  </div>
                ) : (
                  <div className="cv2d-contact-edit">
                    <input placeholder="Email" value={cEmail} onChange={(e) => setCEmail(e.target.value)} />
                    <input placeholder="Phone" value={cPhone} onChange={(e) => setCPhone(e.target.value)} />
                    <input placeholder="GitHub URL or handle" value={cGithub} onChange={(e) => setCGithub(e.target.value)} />
                    <input
                      className="cv2d-ce-other"
                      placeholder="Other emails (comma-separated)"
                      value={cOther}
                      onChange={(e) => setCOther(e.target.value)}
                    />
                    <button className="cv2d-save" onClick={saveContact} disabled={saving}>
                      {saving ? "Saving…" : "Save"}
                    </button>
                    <button
                      className="cv2d-cancel"
                      onClick={() => {
                        setEditingContact(false);
                        setContactErr("");
                        setCEmail(detail.contact.email || "");
                        setCPhone(detail.contact.phone || "");
                        setCGithub(detail.contact.github || "");
                        setCOther((detail.contact.otherEmails || []).join(", "));
                      }}
                    >
                      Cancel
                    </button>
                    {contactErr && <span className="cv2d-err">{contactErr}</span>}
                  </div>
                )}
                {!editingContact && (detail.contact.otherEmails?.length ?? 0) > 0 && (
                  <div className="cv2d-otheremails">
                    {detail.contact.otherEmails!.map((e) => (
                      <span key={e} className="cv2d-oe">
                        {e}
                        <button type="button" disabled={saving} title="Use this as the primary email" onClick={() => makePrimary(e)}>
                          Make primary
                        </button>
                        <button type="button" disabled={saving} title="Remove this address" onClick={() => removeOther(e)}>
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Their ask: compact editable panel beside the identity block.
                  Absorbs the provenance line; Mark contacted clears the date
                  and keeps the person in the pool. */}
              {detail.followUp && (
                <div className={`cv2d-ask${markedDone ? " done" : ""}`}>
                  <div className="ca-top">
                    <span className="ca-k">Their ask</span>
                    {!markedDone && !askEditing && (
                      <button
                        type="button"
                        className="ca-editlink"
                        onClick={() => {
                          const f = detail.followUp!;
                          setEAt(f.at);
                          setERoles([...f.roles]);
                          setEWp([...f.workplace]);
                          setELocs([...f.locations]);
                          setESal(f.salary || "");
                          setEVisa(f.visa || "");
                          setAskErr("");
                          setAskEditing(true);
                        }}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  {markedDone ? (
                    <p className="ca-donenote">
                      Contacted ✓ — follow-up cleared. They stay in your candidates.
                    </p>
                  ) : !askEditing ? (
                    <>
                      <div className="ca-rows">
                        <div className="ca-r">
                          <span className="ca-rk">Asked</span>
                          <span className="ca-mut">
                            {new Date(detail.followUp.askedAt).toLocaleDateString("en-GB", {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                            })}{" "}
                            · via your page
                          </span>
                        </div>
                        <div className="ca-r">
                          <span className="ca-rk">Reach out</span>
                          <b>
                            {new Date(`${detail.followUp.at}T00:00:00Z`).toLocaleDateString("en-GB", {
                              month: "long",
                              year: "numeric",
                              timeZone: "UTC",
                            })}
                            {detail.followUp.due ? " (due)" : ""}
                          </b>
                        </div>
                        <div className="ca-r">
                          <span className="ca-rk">Roles</span>
                          <span>{detail.followUp.roles.join(", ") || "Any"}</span>
                        </div>
                        <div className="ca-r">
                          <span className="ca-rk">Workplace</span>
                          <span>{detail.followUp.workplace.join(", ") || "Any"}</span>
                        </div>
                        <div className="ca-r">
                          <span className="ca-rk">Locations</span>
                          <span>{detail.followUp.locations.join(", ") || "Any"}</span>
                        </div>
                        <div className="ca-r">
                          <span className="ca-rk">Salary</span>
                          <span>{detail.followUp.salary || "Any"}</span>
                        </div>
                        <div className="ca-r">
                          <span className="ca-rk">Visa</span>
                          <span>{detail.followUp.visa || "Not set"}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="dw-mark"
                        disabled={marking}
                        onClick={async () => {
                          setMarking(true);
                          const res = await fetch(
                            `/api/dashboard/candidates/v2/${candKey}/followup`,
                            { method: "POST", headers: { Authorization: `Bearer ${token}` } }
                          ).catch(() => null);
                          setMarking(false);
                          if (res?.ok) setMarkedDone(true);
                        }}
                      >
                        {marking ? "Saving…" : "Mark contacted"}
                      </button>
                    </>
                  ) : (
                    <div className="ca-form">
                      <label className="ca-fld">
                        Reach out
                        <input type="date" value={eAt} onChange={(e) => setEAt(e.target.value)} />
                      </label>
                      <MultiSelect
                        label="Role focus"
                        options={ROLE_FOCUS_OPTIONS}
                        value={eRoles}
                        onChange={setERoles}
                      />
                      <MultiSelect
                        label="Workplace"
                        options={WORKPLACE_OPTIONS}
                        value={eWp}
                        onChange={setEWp}
                      />
                      {detail.followUp.locationOptions.length > 0 && (
                        <MultiSelect
                          label="Locations"
                          options={detail.followUp.locationOptions}
                          value={eLocs}
                          onChange={setELocs}
                        />
                      )}
                      <label className="ca-fld">
                        Min salary
                        <select value={eSal} onChange={(e) => setESal(e.target.value)}>
                          <option value="">Any</option>
                          {SALARY_BAND_OPTIONS.map((v) => (
                            <option key={v} value={v}>
                              {v}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="ca-fld">
                        Visa status
                        <select value={eVisa} onChange={(e) => setEVisa(e.target.value)}>
                          <option value="">Not set</option>
                          {VISA_OPTIONS.map((v) => (
                            <option key={v} value={v}>
                              {v}
                            </option>
                          ))}
                        </select>
                      </label>
                      {askErr && <span className="cv2d-err">{askErr}</span>}
                      <div className="ca-btns">
                        <button
                          type="button"
                          className="cv2d-save"
                          disabled={askSaving}
                          onClick={async () => {
                            setAskSaving(true);
                            setAskErr("");
                            const res = await fetch(
                              `/api/dashboard/candidates/v2/${candKey}/followup`,
                              {
                                method: "PATCH",
                                headers: {
                                  "Content-Type": "application/json",
                                  Authorization: `Bearer ${token}`,
                                },
                                body: JSON.stringify({
                                  at: eAt,
                                  roles: eRoles,
                                  workplace: eWp,
                                  locations: eLocs,
                                  salary: eSal || null,
                                  visa: eVisa || null,
                                }),
                              }
                            ).catch(() => null);
                            setAskSaving(false);
                            if (!res?.ok) {
                              setAskErr("Couldn't save — check the date and retry.");
                              return;
                            }
                            setDetail((d) =>
                              d && d.followUp
                                ? {
                                    ...d,
                                    followUp: {
                                      ...d.followUp,
                                      at: eAt,
                                      due: eAt <= new Date().toISOString().slice(0, 10),
                                      roles: eRoles,
                                      workplace: eWp,
                                      locations: eLocs,
                                      salary: eSal || null,
                                      visa: eVisa || null,
                                    },
                                  }
                                : d
                            );
                            setAskEditing(false);
                          }}
                        >
                          {askSaving ? "Saving…" : "Save"}
                        </button>
                        <button type="button" className="cv2d-cancel" onClick={() => setAskEditing(false)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {!detail.followUp && (
              <div className={`cv2d-provenance${detail.source === "applied" ? " applied" : ""}`}>
                {detail.provenance}
              </div>
            )}

            <div className="dash-tabs cv2d-tabs">
              {(
                [
                  ["profile", "Profile", null],
                  ["pipeline", "Pipeline", detail.pipeline.length],
                  ["resume", "Resume", null],
                  ["notes", "Notes", null],
                ] as [Tab, string, number | null][]
              ).map(([id, label, n]) => (
                <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
                  {label}
                  {n != null && n > 0 && <span className="n">{n}</span>}
                </button>
              ))}
            </div>

            <div className="cv2d-body">
              {tab === "profile" && (
                <>
                  {detail.about && (
                    <>
                      <h4 className="cv2d-sec">About</h4>
                      <p className="cv2d-about">{detail.about}</p>
                    </>
                  )}
                  <h4 className="cv2d-sec">Experience</h4>
                  {detail.experience.length === 0 && (
                    <p className="cv2d-dim">
                      No LinkedIn work history on file{detail.hasResume ? " — see the Resume tab." : "."}
                    </p>
                  )}
                  {detail.experience.map((g, gi) => (
                    <div className="cv2d-xp" key={gi}>
                      <OrgLogo logoUrl={g.logoUrl} linkedinUrl={g.companyLinkedinUrl} label={g.company} />
                      <div className="cv2d-xp-main">
                        {g.companyLinkedinUrl ? (
                          <a className="cv2d-xp-co cv2d-xp-colink" href={g.companyLinkedinUrl} target="_blank" rel="noreferrer">
                            {g.company}
                          </a>
                        ) : (
                          <span className="cv2d-xp-co">{g.company}</span>
                        )}
                        {g.span && <span className="cv2d-xp-span"> · {g.span}</span>}
                        <div className="cv2d-xp-roles">
                          {g.roles.map((r, ri) => (
                            <div className="cv2d-xp-role" key={ri}>
                              <div className="cv2d-xp-title">{r.title}</div>
                              <div className="cv2d-xp-dates">
                                {[r.dates, r.duration, r.location].filter(Boolean).join(" · ")}
                              </div>
                              {r.description && <div className="cv2d-xp-desc">{r.description}</div>}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}

                  {detail.education.length > 0 && (
                    <>
                      <h4 className="cv2d-sec" style={{ marginTop: 26 }}>
                        Education
                      </h4>
                      {detail.education.map((e, i) => (
                        <div className="cv2d-edu" key={i}>
                          <span className="cv2d-edu-main">
                            <OrgLogo logoUrl={e.logoUrl} linkedinUrl={e.linkedinUrl} label={e.school} />
                            <span>
                              {e.linkedinUrl ? (
                                <a className="cv2d-edu-school cv2d-xp-colink" href={e.linkedinUrl} target="_blank" rel="noreferrer">
                                  {e.school}
                                </a>
                              ) : (
                                <span className="cv2d-edu-school">{e.school}</span>
                              )}
                              <br />
                              <span className="cv2d-edu-deg">{[e.degree, e.field].filter(Boolean).join(", ")}</span>
                            </span>
                          </span>
                          {e.period && <span className="cv2d-edu-yr">{e.period}</span>}
                        </div>
                      ))}
                    </>
                  )}

                  {detail.skills.length > 0 && (
                    <>
                      <h4 className="cv2d-sec" style={{ marginTop: 26 }}>
                        Skills
                      </h4>
                      <div className="cv2d-skills">
                        {detail.skills.slice(0, 30).map((s) => (
                          <span key={s}>{s}</span>
                        ))}
                        {detail.skills.length > 30 && <span>+{detail.skills.length - 30} more</span>}
                      </div>
                    </>
                  )}
                </>
              )}

              {tab === "pipeline" && (
                <>
                  {detail.pipeline.length === 0 && (
                    <p className="cv2d-dim">Not attached to any role yet.</p>
                  )}
                  {detail.pipeline.length > 0 && (
                    <div className="cv2d-ptable-wrap">
                      <table className="cv2d-ptable">
                        <thead>
                          <tr>
                            <th>Role</th>
                            <th>Added</th>
                            <th>Fit</th>
                            <th>Stage</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {detail.pipeline.map((p) => (
                            <PipelineRows
                              key={p.jobId}
                              entry={p}
                              expanded={expanded === p.jobId}
                              onToggle={() => setExpanded(expanded === p.jobId ? null : p.jobId)}
                              onStage={changeStage}
                              stageBusy={stageSaving === p.jobId}
                              stageEditable={!isNet}
                              screeningPending={detail.screeningPending !== false}
                              onOpenJob={setOpenJob}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}

              {tab === "resume" && isNet && (
                <p className="cv2d-dim" style={{ marginTop: 6 }}>
                  No resume on file — pool profiles come from LinkedIn. One can be attached after
                  they&apos;re sent to a job.
                </p>
              )}
              {tab === "resume" && !isNet && (
                <>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="application/pdf"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadResume(f);
                      e.target.value = "";
                    }}
                  />
                  {detail.resumeUrl ? (
                    <>
                      <div className="cv2d-rz-bar">
                        <span className="cv2d-rz-file">
                          <span className="cv2d-rz-pdf">PDF</span>
                          {detail.resumeName || "Resume.pdf"}
                        </span>
                        <button
                          className="cv2d-rz-btn"
                          disabled={uploading}
                          onClick={() => fileInput.current?.click()}
                        >
                          {uploading ? "Uploading…" : "Re-upload"}
                        </button>
                      </div>
                      {uploadErr && <p className="cv2d-err" style={{ marginBottom: 10 }}>{uploadErr}</p>}
                      <iframe className="cv2d-resume" src={`${detail.resumeUrl}#toolbar=0&navpanes=0&view=FitH`} title="Resume" />
                    </>
                  ) : (
                    <div
                      className={`cv2d-dropzone${dragOver ? " over" : ""}`}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOver(true);
                      }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOver(false);
                        const f = e.dataTransfer.files?.[0];
                        if (f) uploadResume(f);
                      }}
                      onClick={() => fileInput.current?.click()}
                    >
                      <div className="cv2d-rz-ic">⇪</div>
                      {uploading ? (
                        "Uploading…"
                      ) : (
                        <>
                          Drag a resume here, or <b>browse files</b>
                          <small>PDF · up to 8 MB</small>
                        </>
                      )}
                      {uploadErr && <p className="cv2d-err">{uploadErr}</p>}
                    </div>
                  )}
                </>
              )}

              {tab === "notes" && !isNet && candKey && (
                <NotesTab key={notesBump} candKey={candKey} name={detail.name} />
              )}
              {tab === "notes" && isNet && (
                <div className="cv2d-notes">
                  <p>Notes live on your own candidates — this is a network profile.</p>
                </div>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
