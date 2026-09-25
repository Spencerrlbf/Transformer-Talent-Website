"use client";
// Internal-only Network matches table (8a): one row per pool person, their
// matched roles as stage-inset chips, expandable per-role reviews, and the
// send-to-job flow. Person-first by design — filters replace clicking
// through 96 jobs. Rendered only for the Transformer Talent org.
import { useEffect, useMemo, useRef, useState } from "react";
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
  sendsTo: string | null;
};

export type NetRoleFacet = { jobId: string; title: string; company: string | null; contact: number; message: number };

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
const FIT_LABEL: Record<string, string> = {
  strong: "Contact now",
  possible: "Worth a message",
  stretch: "Likely a stretch",
};

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
/** People per page. */
const PAGE = 50;

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
  onKeys,
}: {
  /** Deep-link filter: preselect one role (the job-page shortcut). */
  jobId?: string;
  onOpen?: (key: string) => void;
  /** Filtered row keys in display order — drives drawer prev/next. */
  onKeys?: (keys: string[]) => void;
}) {
  const { token } = useDash();
  // The server pages and filters (fifty people a page); this holds one page
  // and the counts and role facets that came with it.
  const [people, setPeople] = useState<NetPerson[] | null>(null);
  const [meta, setMeta] = useState<{ total: number; totalMatches: number; newSinceYesterday: number; pages: number; roles: NetRoleFacet[] } | null>(null);
  const [error, setError] = useState(false);

  const [q, setQ] = useState("");
  const [role, setRole] = useState(jobId || "");
  const [company, setCompany] = useState("");
  const [fit, setFit] = useState("");
  const [newOnly, setNewOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Fifty people a page: the list is person-first, and one person can match
  // several roles, so the count of matches runs well past the count of rows.
  const [page, setPage] = useState(1);
  const tableTop = useRef<HTMLDivElement>(null);
  const [confirm, setConfirm] = useState<{ person: NetPerson; match: NetMatch } | null>(null);
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState("");

  // One Filters control (§2.3): button opens a grouped menu; a live row opens
  // its option pane; active filters render as chips below the row.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPane, setMenuPane] = useState<"" | "role" | "company" | "fit">("");
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
        setMenuPane("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  // The search box waits for a pause in typing before asking the server.
  const [qLive, setQLive] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQLive(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams();
    if (role) params.set("job", role);
    if (fit === "strong") params.set("label", "contact");
    if (fit === "possible") params.set("label", "message");
    if (company) params.set("company", company);
    if (qLive) params.set("q", qLive);
    if (newOnly) params.set("new", "7");
    params.set("page", String(page));
    fetch(`/api/dashboard/network?${params}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<{ people: NetPerson[]; total: number; totalMatches: number; newSinceYesterday: number; pages: number; roles: NetRoleFacet[] }>;
      })
      .then((d) => {
        if (!live) return;
        setPeople(d.people);
        setMeta({ total: d.total, totalMatches: d.totalMatches, newSinceYesterday: d.newSinceYesterday, pages: d.pages, roles: d.roles });
      })
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [token, role, fit, company, qLive, newOnly, page]);

  const roleOptions = useMemo<[string, string][]>(
    () => (meta?.roles || []).map((r) => [r.jobId, r.title] as [string, string]).sort((a, b) => a[1].localeCompare(b[1])),
    [meta]
  );

  const companyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of meta?.roles || []) if (r.company) set.add(r.company);
    return [...set].sort();
  }, [meta]);

  const dayAgo = Date.now() - DAY;

  useEffect(() => {
    setPage(1);
  }, [qLive, role, company, fit, newOnly]);
  const pages = meta?.pages || 1;
  const current = Math.min(page, pages);
  const visible = people || [];
  const total = meta?.total || 0;
  const totalMatches = meta?.totalMatches || 0;
  const newSinceYesterday = meta?.newSinceYesterday || 0;
  const turnTo = (n: number) => {
    setPage(n);
    tableTop.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  useEffect(() => {
    onKeys?.(visible.map((p) => `net_${p.candidateId}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const roleTitle = roleOptions.find(([id]) => id === role)?.[1] || "";
  const activeCount = [role, company, fit, newOnly].filter(Boolean).length;

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

  const menuRow = (label: string, value: string, onClick: () => void) => (
    <div className="row" role="button" tabIndex={0} onClick={onClick}>
      {label}
      <span className="val">{value}</span>
      <span className="car">›</span>
    </div>
  );

  const paneOption = (label: string, on: boolean, pick: () => void) => (
    <div key={label} className={`row${on ? " onopt" : ""}`} role="button" onClick={pick}>
      {label}
      {on && <span className="val">✓</span>}
    </div>
  );

  if (error)
    return <div className="dash-empty">Couldn&apos;t load network matches — refresh to retry.</div>;
  if (people === null) return <p className="dash-muted">Loading matches…</p>;

  return (
    <div className="cv2">
      <div className="cv2-filters">
        <div className="dash-filters-wrap" ref={menuRef}>
          <button
            type="button"
            className="dash-filters-btn"
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen(!menuOpen);
              setMenuPane("");
            }}
          >
            ☰ Filters
            {activeCount > 0 && <span className="count">{activeCount}</span>}
            <span aria-hidden>▾</span>
          </button>
          {menuOpen && (
            <div className="dash-filters-menu">
              {menuPane === "" && (
                <>
                  <div className="head">Add filter…</div>
                  <div className="group">Filters</div>
                  {menuRow(
                    "Role",
                    roleTitle ? `${roleTitle} (#${role})` : "Any",
                    () => setMenuPane("role")
                  )}
                  {companyOptions.length > 0 &&
                    menuRow("Hiring company", company || "Any", () => setMenuPane("company"))}
                  {menuRow("Fit", fit ? FIT_LABEL[fit] : "Any", () => setMenuPane("fit"))}
                  {menuRow("Recency", newOnly ? "New this week" : "Any time", () =>
                    setNewOnly(!newOnly)
                  )}
                </>
              )}
              {menuPane === "role" && (
                <>
                  <div className="head back" role="button" onClick={() => setMenuPane("")}>
                    ‹ Role
                  </div>
                  {paneOption(`All roles (${roleOptions.length})`, !role, () => {
                    setRole("");
                    setMenuOpen(false);
                  })}
                  {roleOptions.map(([id, title]) =>
                    paneOption(`${title} (#${id})`, role === id, () => {
                      setRole(id);
                      setMenuOpen(false);
                    })
                  )}
                </>
              )}
              {menuPane === "company" && (
                <>
                  <div className="head back" role="button" onClick={() => setMenuPane("")}>
                    ‹ Hiring company
                  </div>
                  {paneOption("All hiring companies", !company, () => {
                    setCompany("");
                    setMenuOpen(false);
                  })}
                  {companyOptions.map((c) =>
                    paneOption(c, company === c, () => {
                      setCompany(c);
                      setMenuOpen(false);
                    })
                  )}
                </>
              )}
              {menuPane === "fit" && (
                <>
                  <div className="head back" role="button" onClick={() => setMenuPane("")}>
                    ‹ Fit
                  </div>
                  {paneOption("All fits", !fit, () => {
                    setFit("");
                    setMenuOpen(false);
                  })}
                  {(["strong", "possible"] as const).map((v) =>
                    paneOption(FIT_LABEL[v], fit === v, () => {
                      setFit(v);
                      setMenuOpen(false);
                    })
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <input
          className="cv2-search"
          placeholder="Search name, title or company…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {newSinceYesterday > 0 && (
          <span className="nw-fresh">
            <i className="nw-newdot" /> {newSinceYesterday} new since yesterday
          </span>
        )}
        <span className="dash-sortnote">Contact first, then newest</span>
      </div>

      <div className="dash-chips nw-countrow">
        {role && (
          <span className="dash-chip">
            Role: <b>{roleTitle || `#${role}`}</b>
            <button type="button" aria-label="Clear role filter" onClick={() => setRole("")}>
              ✕
            </button>
          </span>
        )}
        {company && (
          <span className="dash-chip">
            Company: <b>{company}</b>
            <button type="button" aria-label="Clear company filter" onClick={() => setCompany("")}>
              ✕
            </button>
          </span>
        )}
        {fit && (
          <span className="dash-chip">
            Fit: <b>{FIT_LABEL[fit]}</b>
            <button type="button" aria-label="Clear fit filter" onClick={() => setFit("")}>
              ✕
            </button>
          </span>
        )}
        {newOnly && (
          <span className="dash-chip">
            Recency: <b>New this week</b>
            <button type="button" aria-label="Clear recency filter" onClick={() => setNewOnly(false)}>
              ✕
            </button>
          </span>
        )}
        {activeCount > 0 && (
          <button
            type="button"
            className="clear"
            onClick={() => {
              setRole("");
              setCompany("");
              setFit("");
              setNewOnly(false);
            }}
          >
            Clear all
          </button>
        )}
        <span className="u-spacer" />
        <span className="nw-count" title="The list is one row per person. A person can match several open roles, so the matches outnumber the people.">
          {total.toLocaleString()} {total === 1 ? "person" : "people"} · {totalMatches.toLocaleString()} role{" "}
          {totalMatches === 1 ? "match" : "matches"} between them
        </span>
      </div>

      {people !== null && total === 0 && (
        <div className="dash-empty">
          No matches{q || role || company || fit || newOnly ? " for these filters" : " yet"} — the
          nightly runs add new people as they qualify.
        </div>
      )}

      {total > 0 && (
        <div className="cv2-scroll" ref={tableTop}>
          <table className="cv2-table nw-tight">
            <thead>
              <tr>
                <th>Candidate</th>
                <th>Current role</th>
                <th>Company</th>
                <th>Location</th>
                <th>Matched roles</th>
                <th className="nw-th-latest">Latest</th>
                <th className="cv2-th-icon">LinkedIn</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
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

      {total > PAGE && (
        <div className="dash-src-tfoot">
          <span>
            Showing {((current - 1) * PAGE + 1).toLocaleString()} to {Math.min(current * PAGE, total).toLocaleString()} of {total.toLocaleString()} people · best fit first, newest match next
          </span>
          <span className="dash-src-pager">
            {current > 1 && (
              <button type="button" className="dash-btn dash-btn-2" onClick={() => turnTo(current - 1)}>
                ← Prev
              </button>
            )}
            <span className="dash-muted">Page {current} of {pages}</span>
            {current < pages && (
              <button type="button" className="dash-btn dash-btn-2" onClick={() => turnTo(current + 1)}>
                Next →
              </button>
            )}
          </span>
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
              This creates an application on <b>{confirm.match.title} (#{confirm.match.jobId})</b>
              {confirm.match.sendsTo
                ? <> — delivered straight into <b>{confirm.match.sendsTo}&apos;s</b> pipeline.</>
                : <> — visible in that job&apos;s Pipeline like any applicant.</>}
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
        <td className="cv2-added nw-latest">{fmtDay(person.latestMatchAt)}</td>
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
                    {m.sendsTo && <small className="nw-sendsto">→ delivers to {m.sendsTo}</small>}
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
