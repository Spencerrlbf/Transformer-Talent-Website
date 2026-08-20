"use client";
// Candidates v2 profile drawer: slides in over the table. Profile tab is the
// pure LinkedIn-style profile (header, editable contact, experience grouped
// by employer, education, skills); fit reviews live ONLY in the Pipeline tab,
// one expandable row per role. Resume renders inline when on file (upload
// arrives with the resume task); Notes is a placeholder.
import { useCallback, useEffect, useRef, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";

type PipelineEntry = {
  jobId: string;
  title: string;
  company: string | null;
  salary: string | null;
  location: string | null;
  via: "applied" | "sourced";
  tag: string | null;
  tagLabel: string | null;
  reason: string | null;
  addedAt: string;
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
  viaTT: boolean;
  alsoSourced: boolean;
  provenance: string;
  contact: { email?: string | null; phone?: string | null; github?: string | null };
  bestTag: string | null;
  bestTagLabel: string | null;
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
}: {
  entry: PipelineEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="cv2d-prow" onClick={onToggle}>
        <td className="cv2d-prole">
          <a
            href={`/dashboard/jobs/${entry.jobId}`}
            target="_blank"
            rel="noreferrer"
            title="Open this job in a new tab"
            onClick={(e) => e.stopPropagation()}
          >
            {entry.title} <em>#{entry.jobId}</em> ↗
          </a>
          <small>{entry.via === "applied" ? "applied" : "via sourcing run"}</small>
        </td>
        <td className="cv2d-ploc">{entry.company || "—"}</td>
        <td className="cv2d-pnum">{entry.salary || "—"}</td>
        <td className="cv2d-ploc">{entry.location || "—"}</td>
        <td className="cv2d-pnum">{fmtDay(entry.addedAt)}</td>
        <td>
          {entry.tag ? (
            <span className={`dash-tag ${TAG_CLASS[entry.tag] || "t-pending"}`}>{entry.tagLabel}</span>
          ) : (
            <span className="dash-tag t-pending">Screening…</span>
          )}
        </td>
        <td>
          <span className="cv2d-stage">New</span>
        </td>
        <td className="cv2d-pcar">{expanded ? "▾" : "▸"}</td>
      </tr>
      {expanded && (
        <tr className="cv2d-preview-row">
          <td colSpan={8}>
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
}: {
  candKey: string | null;
  roleContext?: string;
  onClose: () => void;
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

  const [editingContact, setEditingContact] = useState(false);
  const [cEmail, setCEmail] = useState("");
  const [cPhone, setCPhone] = useState("");
  const [cGithub, setCGithub] = useState("");
  const [contactErr, setContactErr] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDetail(null);
    setError(false);
    setTab("profile");
    setEditingContact(false);
    setContactErr("");
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
        // Opened from a job page: that role's review is what they came for.
        const ctx = roleContext && d.pipeline.find((p) => p.jobId === roleContext);
        setExpanded(ctx ? ctx.jobId : d.pipeline[0]?.jobId ?? null);
        if (ctx) setTab("pipeline");
      })
      .catch(() => setError(true));
  }, [candKey, token, roleContext]);

  const escClose = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
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

  const saveContact = async () => {
    setSaving(true);
    setContactErr("");
    const res = await fetch(`/api/dashboard/candidates/v2/${candKey}/contact`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: cEmail, phone: cPhone, github: cGithub }),
    }).catch(() => null);
    setSaving(false);
    if (!res || !res.ok) {
      const err = res ? ((await res.json()) as { error?: string }).error : null;
      setContactErr(
        err === "invalid_email" ? "That email doesn't look right."
        : err === "invalid_phone" ? "That phone number doesn't look right."
        : "Couldn't save — try again."
      );
      return;
    }
    const { contact } = (await res.json()) as { contact: Detail["contact"] };
    if (detail) setDetail({ ...detail, contact });
    setEditingContact(false);
  };

  const currentRole = detail?.experience[0]?.roles[0];
  const currentCompany = detail?.experience[0]?.company;

  return (
    <div className="cv2d-overlay" onClick={onClose}>
      <aside className="cv2d" onClick={(e) => e.stopPropagation()}>
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
                  {detail.bestTag && (
                    <span className={`dash-tag ${TAG_CLASS[detail.bestTag] || "t-pending"}`}>
                      {detail.bestTagLabel}
                    </span>
                  )}
                  {detail.viaTT && <span className="cv2-tt">⚡ Via Transformer Talent</span>}
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
                      }}
                    >
                      Cancel
                    </button>
                    {contactErr && <span className="cv2d-err">{contactErr}</span>}
                  </div>
                )}
              </div>
            </div>

            <div className={`cv2d-provenance${detail.source === "applied" ? " applied" : ""}`}>
              {detail.provenance}
            </div>

            <div className="cv2d-tabs">
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
                  {n != null && n > 0 && <span className="cv2d-n">{n}</span>}
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
                            <th>Company</th>
                            <th>Salary</th>
                            <th>Location</th>
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
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}

              {tab === "resume" && (
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

              {tab === "notes" && (
                <div className="cv2d-notes">
                  <textarea disabled placeholder="Add a note about this candidate…" />
                  <p>Notes are coming soon — they&apos;ll be shared with your teammates and kept alongside the candidate.</p>
                </div>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
