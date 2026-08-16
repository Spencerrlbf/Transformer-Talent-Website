"use client";
// Tenant job board: a light-skinned mirror of the site's roles board — same
// speculative banner, search semantics, filters, sortable table with
// APPLY +/✓ selection, sticky side panel, 25-per-page pagination, and
// checkout-style apply — scoped to one organization. Tenant roles have no
// detail pages, so clicking a role title expands the full JD inline.
// Posts to /api/apply with the board slug; suggestions come back scoped to
// this company only. When embedded via widget.js it reports its height to
// the parent for iframe auto-resizing.
import { useEffect, useMemo, useRef, useState } from "react";

const MAX_ROLES = 3;
const PAGE_SIZE = 25;

export type BoardRoleView = {
  jobId: string;
  title: string;
  salary: string;
  locations: string[];
  workplace: string;
  yoe: string;
  roleType: string;
  techStack: string;
  visa: string;
  about: string;
  doing: string[];
  needs: string[];
  bonus: string[];
};

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "ok"; matches: { jobId: string; title: string; salary: string }[]; wasSpeculative: boolean }
  | { kind: "error"; message: string };

// comma = OR groups; space-separated terms = AND; -term excludes; "quoted phrase"
function matchesQuery(hay: string, q: string): boolean {
  const groups = q.toLowerCase().split(",").map((g) => g.trim()).filter(Boolean);
  if (!groups.length) return true;
  return groups.some((g) => {
    const terms = g.match(/-?"[^"]+"|\S+/g) || [];
    return terms.every((t) => {
      const neg = t.startsWith("-");
      const term = t.replace(/^-/, "").replace(/"/g, "").trim();
      if (!term) return true;
      const has = hay.includes(term);
      return neg ? !has : has;
    });
  });
}

const visaBucket = (r: BoardRoleView) =>
  /transfer|sponsor/i.test(r.visa || "") ? "Visa transfers OK" : "No sponsorship";
const salaryMin = (r: BoardRoleView) => {
  const m = r.salary.toLowerCase().replace(/,/g, "").match(/(\d+(?:\.\d+)?)k|\$(\d{5,6})/);
  return m ? parseFloat(m[1] || String(Number(m[2]) / 1000)) : 0;
};
const yoeMin = (r: BoardRoleView) => {
  const m = r.yoe.match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
};

type SortKey = "id" | "title" | "location" | "workplace" | "yoe" | "salary";
const HEADERS: { key: SortKey; label: string }[] = [
  { key: "id", label: "ID" },
  { key: "title", label: "Role" },
  { key: "location", label: "Location" },
  { key: "workplace", label: "Office" },
  { key: "yoe", label: "Experience" },
  { key: "salary", label: "Base salary" },
];

export default function BoardClient({
  org,
  roles,
}: {
  org: { slug: string; name: string };
  roles: BoardRoleView[];
}) {
  const [q, setQ] = useState("");
  const [loc, setLoc] = useState("");
  const [office, setOffice] = useState("");
  const [type, setType] = useState("");
  const [visaF, setVisaF] = useState("");
  const [sort, setSort] = useState<SortKey>("id");
  const [dir, setDir] = useState<1 | -1>(1);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [speculative, setSpeculative] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [formError, setFormError] = useState("");
  const applyRef = useRef<HTMLDivElement>(null);

  // Embed mode: report height to the parent page for iframe auto-resize.
  useEffect(() => {
    if (window.self === window.top) return;
    const post = () =>
      window.parent.postMessage(
        { ttBoard: org.slug, height: document.documentElement.scrollHeight },
        "*"
      );
    post();
    const ro = new ResizeObserver(post);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, [org.slug]);

  useEffect(() => {
    setPage(1);
  }, [q, loc, office, type, visaF]);

  const locations = useMemo(() => [...new Set(roles.flatMap((r) => r.locations))].sort(), [roles]);
  const offices = useMemo(() => [...new Set(roles.map((r) => r.workplace).filter(Boolean))].sort(), [roles]);
  const types = useMemo(
    () => [...new Set(roles.flatMap((r) => r.roleType.split(",").map((t) => t.trim())).filter(Boolean))].sort(),
    [roles]
  );

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = roles.filter((r) => {
      if (loc && !r.locations.includes(loc)) return false;
      if (office && r.workplace !== office) return false;
      if (type && !r.roleType.toLowerCase().includes(type.toLowerCase())) return false;
      if (visaF && visaBucket(r) !== visaF) return false;
      if (needle) {
        const hay = [
          r.jobId, r.title, r.about, r.techStack, r.roleType,
          r.locations.join(" "), r.needs.join(" "), r.doing.join(" "),
        ].join(" ").toLowerCase();
        if (!matchesQuery(hay, needle)) return false;
      }
      return true;
    });
    const cmp: Record<SortKey, (a: BoardRoleView, b: BoardRoleView) => number> = {
      id: (a, b) => parseInt(a.jobId, 10) - parseInt(b.jobId, 10),
      title: (a, b) => a.title.localeCompare(b.title),
      location: (a, b) => (a.locations[0] || "zz").localeCompare(b.locations[0] || "zz"),
      workplace: (a, b) => (a.workplace || "zz").localeCompare(b.workplace || "zz"),
      yoe: (a, b) => yoeMin(a) - yoeMin(b),
      salary: (a, b) => salaryMin(a) - salaryMin(b),
    };
    return out.sort((a, b) => cmp[sort](a, b) * dir);
  }, [roles, q, loc, office, type, visaF, sort, dir]);

  function clickSort(k: SortKey) {
    if (k === sort) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSort(k);
      setDir(1);
    }
  }

  function toggle(jobId: string) {
    setSpeculative(false);
    setSelected((cur) =>
      cur.includes(jobId)
        ? cur.filter((x) => x !== jobId)
        : cur.length >= MAX_ROLES
          ? cur
          : [...cur, jobId]
    );
  }

  const goToApply = () => applyRef.current?.scrollIntoView({ behavior: "smooth" });
  const isSpeculative = speculative && selected.length === 0;
  const selectedRoles = selected
    .map((id) => roles.find((r) => r.jobId === id))
    .filter((r): r is BoardRoleView => Boolean(r));

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError("");
    const form = e.currentTarget;
    const data = new FormData(form);
    const resume = data.get("resume");
    const hasResume = resume instanceof File && resume.size > 0;
    if (isSpeculative && !hasResume) {
      setFormError("A resume is required for a general application — it's what we match you with.");
      return;
    }
    if (!isSpeculative && selected.length === 0) {
      setFormError("Select at least one role above (APPLY +), or upload your resume for general matching.");
      return;
    }
    data.set("board", org.slug);
    data.set("roleIds", selected.join(","));
    if (isSpeculative) data.set("speculative", "1");
    setStatus({ kind: "sending" });
    try {
      const res = await fetch("/api/apply", { method: "POST", body: data });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        form.reset();
        setSelected([]);
        setStatus({ kind: "ok", matches: json.matches || [], wasSpeculative: isSpeculative });
      } else {
        setStatus({ kind: "error", message: json.error || "Something went wrong — please try again." });
      }
    } catch {
      setStatus({ kind: "error", message: "Network error — please try again." });
    }
  }

  const pageCount = Math.ceil(shown.length / PAGE_SIZE);

  return (
    <div className="board-app">
      <header className="board-head">
        <h1>{org.name}</h1>
        <p>Open roles</p>
      </header>

      {selected.length === 0 && status.kind !== "ok" && (
        <div className="board-spec">
          <p>
            <b>Nothing that fits?</b> Upload your resume — we&apos;ll match you against{" "}
            {org.name}&apos;s open roles and reach out when the right one arrives.
          </p>
          <button
            className="board-btn"
            onClick={() => {
              setSpeculative(true);
              goToApply();
            }}
          >
            UPLOAD RESUME →
          </button>
        </div>
      )}

      <div className="board-filters">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder='search: python, go -java · "machine learning" · comma = OR, minus = exclude'
          aria-label="Search roles"
        />
        <select value={loc} onChange={(e) => setLoc(e.target.value)} aria-label="Filter by location">
          <option value="">all locations</option>
          {locations.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
        <select value={office} onChange={(e) => setOffice(e.target.value)} aria-label="Filter by office type">
          <option value="">all office types</option>
          {offices.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
        {types.length > 0 && (
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by role type">
            <option value="">all role types</option>
            {types.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        )}
        <select value={visaF} onChange={(e) => setVisaF(e.target.value)} aria-label="Filter by visa">
          <option value="">any visa status</option>
          <option value="Visa transfers OK">Visa transfers OK</option>
          <option value="No sponsorship">No sponsorship</option>
        </select>
      </div>

      <p className="board-count">
        {shown.length} of {roles.length} roles
        {shown.length > PAGE_SIZE ? ` · page ${page} of ${pageCount}` : ""}
      </p>

      <div className={`board-layout${selected.length > 0 ? " with-panel" : ""}`}>
        <div style={{ minWidth: 0 }}>
          <div style={{ overflowX: "auto" }}>
            <table className="board-table">
              <thead>
                <tr>
                  {HEADERS.map((h) => (
                    <th
                      key={h.key}
                      onClick={() => clickSort(h.key)}
                      style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
                      aria-sort={sort === h.key ? (dir === 1 ? "ascending" : "descending") : "none"}
                    >
                      {h.label}
                      <span className="board-sort">{sort === h.key ? (dir === 1 ? "▲" : "▼") : ""}</span>
                    </th>
                  ))}
                  <th style={{ whiteSpace: "nowrap" }}>Apply</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((r) => {
                  const isSel = selected.includes(r.jobId);
                  const isOpen = expanded === r.jobId;
                  return [
                    <tr key={r.jobId} className={isOpen ? "row-open" : ""}>
                      <td className="board-id">#{r.jobId}</td>
                      <td style={{ minWidth: 240 }}>
                        <button
                          className="board-rolebtn"
                          onClick={() => setExpanded(isOpen ? null : r.jobId)}
                          aria-expanded={isOpen}
                        >
                          <span className="t">{r.title}</span>
                          <span className="d">
                            {(r.about || "").slice(0, 110)}
                            {(r.about || "").length > 110 ? "…" : ""}
                          </span>
                        </button>
                      </td>
                      <td style={{ fontSize: "12.5px", minWidth: 120 }}>
                        {r.locations.length > 3
                          ? `${r.locations.slice(0, 3).join(" · ")} +${r.locations.length - 3}`
                          : r.locations.join(" · ") || "—"}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{r.workplace || "—"}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{r.yoe || "—"}</td>
                      <td className="board-salary" style={{ whiteSpace: "nowrap" }}>
                        {r.salary || "On request"}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button
                          type="button"
                          className={`board-apply-btn${isSel ? " sel" : ""}`}
                          onClick={() => toggle(r.jobId)}
                          aria-pressed={isSel}
                        >
                          {isSel ? `✓ ${selected.indexOf(r.jobId) + 1}/${MAX_ROLES}` : "APPLY +"}
                        </button>
                      </td>
                    </tr>,
                    isOpen ? (
                      <tr key={`${r.jobId}-detail`} className="board-detail-row">
                        <td colSpan={7}>
                          <div className="board-detail">
                            {r.about && <p>{r.about}</p>}
                            {r.doing.length > 0 && (
                              <>
                                <h4>What you&apos;ll do</h4>
                                <ul>{r.doing.map((d, i) => <li key={i}>{d}</li>)}</ul>
                              </>
                            )}
                            {r.needs.length > 0 && (
                              <>
                                <h4>What they&apos;re looking for</h4>
                                <ul>{r.needs.map((d, i) => <li key={i}>{d}</li>)}</ul>
                              </>
                            )}
                            {r.bonus.length > 0 && (
                              <>
                                <h4>Nice to have</h4>
                                <ul>{r.bonus.map((d, i) => <li key={i}>{d}</li>)}</ul>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          </div>

          {shown.length > PAGE_SIZE && (
            <div className="board-pager">
              <span>
                showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, shown.length)} of {shown.length} roles
              </span>
              <div>
                <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>‹</button>
                {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
                  <button key={n} className={n === page ? "cur" : ""} onClick={() => setPage(n)}>
                    {n}
                  </button>
                ))}
                <button disabled={page === pageCount} onClick={() => setPage((p) => p + 1)}>›</button>
              </div>
            </div>
          )}
        </div>

        {/* Desktop: sticky side panel beside the table. */}
        {selected.length > 0 && (
          <aside className="board-panel">
            <div className="board-panel-label">
              <b>{selected.length}/{MAX_ROLES}</b> ROLES SELECTED
            </div>
            {selectedRoles.map((r) => (
              <div key={r.jobId} className="board-panel-role">
                <div>
                  <div className="t">{r.title}</div>
                  <div className="m">{r.salary || "Comp on request"} · #{r.jobId}</div>
                </div>
                <button onClick={() => toggle(r.jobId)} aria-label={`Remove ${r.title}`}>✕</button>
              </div>
            ))}
            {selected.length < MAX_ROLES && (
              <div className="board-panel-slots">
                + {MAX_ROLES - selected.length} slot{MAX_ROLES - selected.length > 1 ? "s" : ""} left
              </div>
            )}
            <button className="board-btn" style={{ width: "100%" }} onClick={goToApply}>
              CONTINUE TO APPLY →
            </button>
          </aside>
        )}
      </div>

      {/* Narrow screens: compact bottom bar instead of a side column. */}
      {selected.length > 0 && (
        <div className="board-selbar">
          <b>{selected.length}/{MAX_ROLES} selected</b>
          <button className="board-btn" onClick={goToApply}>
            CONTINUE TO APPLY →
          </button>
        </div>
      )}

      <div className="board-apply" ref={applyRef}>
        {status.kind === "ok" ? (
          <div className="board-thanks">
            <h2>{status.wasSpeculative ? "Resume received." : "Application received."}</h2>
            <p>
              {status.wasSpeculative
                ? `We'll match you against ${org.name}'s open roles — and new ones as they arrive — and be in touch when there's a genuine fit.`
                : "Every application is screened and reviewed — you'll hear back when there's a fit."}
            </p>
            {status.matches.length > 0 && (
              <>
                <h3>You also look like a fit for</h3>
                <ul className="board-matchlist">
                  {status.matches.map((m) => (
                    <li key={m.jobId}>
                      <b>{m.title}</b>
                      {m.salary ? ` — ${m.salary}` : ""}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : (
          <div className="board-checkout">
            <div className="board-cartcol">
              <h2>Your application</h2>
              {isSpeculative ? (
                <p className="board-instr">
                  <b>No role selected — we&apos;ll do the matching.</b> Drop your resume and
                  we&apos;ll screen you against {org.name}&apos;s roles, now and as new ones open.{" "}
                  <button className="board-linkbtn" onClick={() => setSpeculative(false)}>
                    back to selecting roles
                  </button>
                </p>
              ) : selected.length === 0 ? (
                <p className="board-instr">
                  Nothing selected yet — hit <b>APPLY +</b> on up to {MAX_ROLES} roles in the
                  table, or{" "}
                  <button className="board-linkbtn" onClick={() => setSpeculative(true)}>
                    upload your resume
                  </button>{" "}
                  for general matching.
                </p>
              ) : (
                <p className="board-instr">
                  Complete the form to finish your application for the{" "}
                  <b>{selected.length} selected role{selected.length > 1 ? "s" : ""}</b> — one
                  form covers them all.
                  {selected.length < MAX_ROLES && <> You can add {MAX_ROLES - selected.length} more.</>}
                </p>
              )}
              <ul className="board-cart">
                {selectedRoles.map((r) => (
                  <li key={r.jobId}>
                    <span>
                      <b>{r.title}</b>
                      <em>{r.salary || "Comp on request"} · #{r.jobId}</em>
                    </span>
                    <button className="board-linkbtn" onClick={() => toggle(r.jobId)}>
                      remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <form onSubmit={onSubmit} className="board-form">
              <h3>Your details</h3>
              <label>
                Name
                <input name="name" required maxLength={120} autoComplete="name" />
              </label>
              <label>
                Email
                <input name="email" type="email" required maxLength={254} autoComplete="email" />
              </label>
              <label>
                LinkedIn URL (required)
                <input name="linkedin" type="url" required placeholder="https://linkedin.com/in/…" maxLength={300} />
              </label>
              <label>
                Resume (PDF{isSpeculative ? ", required" : ", optional but recommended"})
                <input name="resume" type="file" accept="application/pdf" required={isSpeculative} />
              </label>
              <label>
                Locations you&apos;re open to (optional — ⌘/Ctrl-click for several; empty = your profile location)
                <select name="preferredLocations" multiple size={5}>
                  <option value="SF">SF / Bay Area</option>
                  <option value="NYC">NYC</option>
                  <option value="Miami">Miami</option>
                  <option value="Seattle">Seattle</option>
                  <option value="Chicago">Chicago</option>
                  <option value="Washington DC">Washington DC</option>
                  <option value="Austin">Austin</option>
                  <option value="Boston">Boston</option>
                  <option value="Los Angeles">Los Angeles</option>
                  <option value="Canada">Canada</option>
                </select>
              </label>
              <label>
                Visa status
                <select name="visa" defaultValue="">
                  <option value="" disabled>
                    select…
                  </option>
                  <option value="None needed (US citizen / green card)">
                    None needed (US citizen / green card)
                  </option>
                  <option value="H-1B">H-1B</option>
                  <option value="STEM OPT">STEM OPT</option>
                  <option value="TN">TN</option>
                  <option value="O-1">O-1</option>
                  <option value="Other">Other</option>
                </select>
              </label>
              <label>
                Anything else
                <textarea name="note" rows={2} maxLength={2000} />
              </label>
              <input
                name="website"
                tabIndex={-1}
                autoComplete="off"
                style={{ position: "absolute", left: "-9999px" }}
                aria-hidden="true"
              />
              {(formError || status.kind === "error") && (
                <p className="board-error">
                  {formError || (status.kind === "error" ? status.message : "")}
                </p>
              )}
              <button type="submit" className="board-btn" disabled={status.kind === "sending"}>
                {status.kind === "sending"
                  ? "SUBMITTING & MATCHING…"
                  : isSpeculative
                    ? "SUBMIT FOR MATCHING →"
                    : selected.length > 0
                      ? `SUBMIT — ${selected.length} ROLE${selected.length > 1 ? "S" : ""} →`
                      : "SUBMIT APPLICATION →"}
              </button>
            </form>
          </div>
        )}
      </div>

      <footer className="board-foot">
        <a href="https://www.transformertalent.com" target="_blank" rel="noreferrer">
          Powered by Transformer Talent
        </a>
      </footer>
    </div>
  );
}
