"use client";
// Internal-only Network matches table: one row per pool person, their
// matched roles as fit-colored chips, expandable per-role reviews, and the
// send-to-job flow. Person-first by design — filters replace clicking
// through 96 jobs. Rendered only for the Transformer Talent org.
import { useEffect, useMemo, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import JobDrawer from "@/components/dashboard/jobs/JobDrawer";

export type NetMatch = {
  jobId: string;
  title: string;
  company: string | null;
  salary: string | null;
  location: string | null;
  tag: "strong" | "possible" | "stretch";
  tagLabel: string;
  reason: string;
  addedAt: string;
  sentAt: string | null;
};

export type NetPerson = {
  candidateId: string;
  name: string;
  photoUrl: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  location: string | null;
  linkedinUrl: string | null;
  email: string | null;
  phone: string | null;
  years: number | null;
  latestMatchAt: string;
  matches: NetMatch[];
};

const TAG_CLASS: Record<string, string> = {
  strong: "t-strong",
  possible: "t-possible",
  stretch: "t-stretch",
};
const DOT_CLASS: Record<string, string> = { strong: "g", possible: "b", stretch: "a" };

const AV_COLORS = ["#5B7FDB", "#4CA88C", "#C4736B", "#8A6FC2", "#C99242", "#5E9DB8", "#7A8699"];
const avColor = (name: string) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AV_COLORS[Math.abs(h) % AV_COLORS.length];
};
const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const DAY = 86400_000;

function Avatar({ photoUrl, name }: { photoUrl: string | null; name: string }) {
  const [broken, setBroken] = useState(false);
  if (!photoUrl || broken)
    return (
      <span className="cv2-avatar" style={{ background: avColor(name) }}>
        {initials(name)}
      </span>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="cv2-avatar cv2-avatar-img" src={photoUrl} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
  );
}

const InIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
    <rect width="24" height="24" rx="4" fill="#0A66C2" />
    <path
      fill="#fff"
      d="M7.1 9.4H4.9V19h2.2V9.4Zm-1.1-1c.7 0 1.3-.6 1.3-1.3 0-.7-.6-1.3-1.3-1.3-.7 0-1.3.6-1.3 1.3 0 .7.6 1.3 1.3 1.3Zm4.3 1h-2.1V19h2.2v-4.7c0-2 2.6-2.2 2.6 0V19h2.2v-5.5c0-3.4-3.7-3.3-4.9-1.6v-1.5Z"
    />
  </svg>
);

export default function NetworkTable({
  jobId,
  onOpen,
}: {
  /** Deep-link filter: preselect one role (the job-page shortcut). */
  jobId?: string;
  onOpen?: (key: string) => void;
}) {
  const { token } = useDash();
  const [people, setPeople] = useState<NetPerson[] | null>(null);
  const [error, setError] = useState(false);

  const [q, setQ] = useState("");
  const [role, setRole] = useState(jobId || "");
  const [company, setCompany] = useState("");
  const [fit, setFit] = useState("");
  const [newOnly, setNewOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ person: NetPerson; match: NetMatch } | null>(null);
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState("");

  useEffect(() => {
    fetch("/api/dashboard/network", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<{ people: NetPerson[] }>;
      })
      .then((d) => setPeople(d.people))
      .catch(() => setError(true));
  }, [token]);

  const roleOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of people || [])
      for (const m of p.matches) if (!map.has(m.jobId)) map.set(m.jobId, m.title);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [people]);

  const companyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of people || []) for (const m of p.matches) if (m.company) set.add(m.company);
    return [...set].sort();
  }, [people]);

  const weekAgo = Date.now() - 7 * DAY;
  const dayAgo = Date.now() - DAY;

  const matchPasses = (m: NetMatch) =>
    (!role || m.jobId === role) &&
    (!company || m.company === company) &&
    (!fit || m.tag === fit);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (people || []).filter((p) => {
      if (
        needle &&
        ![p.name, p.currentTitle, p.currentCompany]
          .some((v) => (v || "").toLowerCase().includes(needle))
      )
        return false;
      if (newOnly && new Date(p.latestMatchAt).getTime() < weekAgo) return false;
      return p.matches.some(matchPasses);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, q, role, company, fit, newOnly]);

  const newSinceYesterday = (people || []).filter(
    (p) => new Date(p.latestMatchAt).getTime() >= dayAgo
  ).length;

  async function send() {
    if (!confirm) return;
    setSending(true);
    setSendErr("");
    const res = await fetch("/api/dashboard/network/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ candidateId: confirm.person.candidateId, jobId: confirm.match.jobId }),
    }).catch(() => null);
    setSending(false);
    if (!res?.ok && res?.status !== 409) {
      setSendErr("Couldn't send — try again in a moment.");
      return;
    }
    // 409 = already sent (e.g. from another tab) — reflect it the same way.
    const now = new Date().toISOString();
    setPeople((ps) =>
      (ps || []).map((p) =>
        p.candidateId === confirm.person.candidateId
          ? {
              ...p,
              matches: p.matches.map((m) =>
                m.jobId === confirm.match.jobId ? { ...m, sentAt: now } : m
              ),
            }
          : p
      )
    );
    setConfirm(null);
  }

  if (error)
    return <div className="dash-empty">Couldn&apos;t load network matches — refresh to retry.</div>;
  if (people === null) return <p className="dash-muted">Loading matches…</p>;

  return (
    <div className="cv2">
      <div className="cv2-filters">
        <input
          className="cv2-search"
          placeholder="Search name, title or company…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">All roles ({roleOptions.length})</option>
          {roleOptions.map(([id, title]) => (
            <option key={id} value={id}>
              {title} (#{id})
            </option>
          ))}
        </select>
        {companyOptions.length > 0 && (
          <select value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">All hiring companies</option>
            {companyOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        <select value={fit} onChange={(e) => setFit(e.target.value)}>
          <option value="">All fits</option>
          <option value="strong">Strong fit</option>
          <option value="possible">Worth a look</option>
          <option value="stretch">Likely a stretch</option>
        </select>
        <label className="cv2-toggle">
          <input type="checkbox" checked={newOnly} onChange={(e) => setNewOnly(e.target.checked)} />
          New this week
        </label>
        {newSinceYesterday > 0 && (
          <span className="nw-fresh">● {newSinceYesterday} new since yesterday</span>
        )}
      </div>

      {filtered.length === 0 && (
        <div className="dash-empty">
          No matches{q || role || company || fit || newOnly ? " for these filters" : " yet"} — the
          nightly runs add new people as they qualify.
        </div>
      )}

      {filtered.length > 0 && (
        <div className="cv2-scroll">
          <table className="cv2-table nw-tight">
            <thead>
              <tr>
                <th>Candidate</th>
                <th>Current role</th>
                <th>Company</th>
                <th>Location</th>
                <th>Matched roles</th>
                <th>Latest</th>
                <th className="cv2-th-icon">LinkedIn</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <PersonRows
                  key={p.candidateId}
                  person={p}
                  expanded={expanded === p.candidateId}
                  isNew={new Date(p.latestMatchAt).getTime() >= dayAgo}
                  onToggle={() =>
                    setExpanded(expanded === p.candidateId ? null : p.candidateId)
                  }
                  onOpen={onOpen}
                  onSend={(match) => {
                    setSendErr("");
                    setConfirm({ person: p, match });
                  }}
                  onOpenJob={setOpenJobId}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <JobDrawer jobId={openJobId} onClose={() => setOpenJobId(null)} />

      {confirm && (
        <div className="nw-modal-back" onClick={() => !sending && setConfirm(null)}>
          <div className="nw-modal" onClick={(e) => e.stopPropagation()}>
            <h3>
              Send {confirm.person.name.split(" ")[0]} to {confirm.match.title}?
            </h3>
            <p>
              This creates an application on <b>{confirm.match.title} (#{confirm.match.jobId})</b> —
              visible in that job&apos;s Pipeline like any applicant.
            </p>
            <div className="nw-modal-who">
              <Avatar photoUrl={confirm.person.photoUrl} name={confirm.person.name} />
              <span className="nw-modal-nm">
                {confirm.person.name}
                <small>
                  {[confirm.person.currentTitle, confirm.person.currentCompany]
                    .filter(Boolean)
                    .join(" @ ") || "Pool candidate"}
                </small>
              </span>
              <span className="spacer" />
              <span className={`dash-tag ${TAG_CLASS[confirm.match.tag]}`}>{confirm.match.tagLabel}</span>
            </div>
            <ul>
              <li>Marked <b>⚡ Via Transformer Talent</b> — the referral credit is yours.</li>
              <li>Built from their pool profile (LinkedIn data on file).</li>
              <li>Starts at stage <b>New</b> in that job&apos;s Pipeline.</li>
            </ul>
            {sendErr && <p className="cv2d-err">{sendErr}</p>}
            <div className="nw-modal-acts">
              <button className="dash-btn dash-btn-2" disabled={sending} onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button className="dash-btn" disabled={sending} onClick={send}>
                {sending ? "Sending…" : "Send to job"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PersonRows({
  person,
  expanded,
  isNew,
  onToggle,
  onOpen,
  onSend,
  onOpenJob,
}: {
  person: NetPerson;
  expanded: boolean;
  isNew: boolean;
  onToggle: () => void;
  onOpen?: (key: string) => void;
  onSend: (match: NetMatch) => void;
  onOpenJob: (jobId: string) => void;
}) {
  return (
    <>
      <tr className="cv2-click" onClick={() => onOpen?.(`net_${person.candidateId}`)}>
        <td>
          <span className="cv2-cand">
            <Avatar photoUrl={person.photoUrl} name={person.name} />
            <span className="cv2-name">
              {person.name}
              {isNew && <i className="nw-newdot" title="New match since yesterday" />}
            </span>
          </span>
        </td>
        <td className="cv2-title">{person.currentTitle || <span className="cv2-dim">—</span>}</td>
        <td className="cv2-company">{person.currentCompany || <span className="cv2-dim">—</span>}</td>
        <td className="cv2-loc">{person.location || <span className="cv2-dim">—</span>}</td>
        <td onClick={(e) => { e.stopPropagation(); onToggle(); }}>
          <span className="nw-chips">
            {(expanded ? person.matches : person.matches.slice(0, 3)).map((m) =>
              m.sentAt ? (
                <span key={m.jobId} className="nw-rc nw-rc-sent" title={`Sent ${fmtDay(m.sentAt)} — in that job's pipeline`}>
                  ✓ {m.title} <small>#{m.jobId}</small>
                </span>
              ) : (
                <span key={m.jobId} className="nw-rc" title={m.tagLabel}>
                  <i className={`nw-dot ${DOT_CLASS[m.tag]}`} />
                  {m.title} <small>#{m.jobId}</small>
                </span>
              )
            )}
            {!expanded && person.matches.length > 3 && (
              <span className="nw-rc nw-rc-more">+{person.matches.length - 3} more</span>
            )}
          </span>
        </td>
        <td className="cv2-added">{fmtDay(person.latestMatchAt)}</td>
        <td className="cv2-icons">
          {person.linkedinUrl ? (
            <a href={person.linkedinUrl} target="_blank" rel="noreferrer" title="Open LinkedIn profile" onClick={(e) => e.stopPropagation()}>
              <InIcon />
            </a>
          ) : (
            <span className="cv2-ic-off"><InIcon /></span>
          )}
        </td>
        <td className="cv2d-pcar" onClick={(e) => { e.stopPropagation(); onToggle(); }}>
          {expanded ? "▾" : "▸"}
        </td>
      </tr>
      {expanded && (
        <tr className="nw-review-row">
          <td colSpan={8}>
            <div className="nw-reviews">
              {person.matches.map((m) => (
                <div key={m.jobId} className={`nw-rv${m.tag === "strong" ? " best" : ""}`}>
                  <span className="nw-rv-role">
                    <b>{m.title}</b>
                    <small>
                      #{m.jobId}
                      {m.company && ` · ${m.company}`}
                      {m.salary && ` · ${m.salary}`}
                    </small>
                    <span className={`dash-tag ${TAG_CLASS[m.tag]}`}>{m.tagLabel}</span>
                  </span>
                  <span className="nw-rv-body">{m.reason}</span>
                  <span className="nw-rv-acts">
                    {m.sentAt ? (
                      <span className="nw-senttag">
                        Sent ✓<small>{fmtDay(m.sentAt)} · in Pipeline</small>
                      </span>
                    ) : (
                      <button className="dash-btn nw-sendbtn" onClick={() => onSend(m)}>
                        Send to job
                      </button>
                    )}
                    <button type="button" className="nw-openjob" onClick={() => onOpenJob(m.jobId)}>
                      View job
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
