"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Role } from "@/lib/roles";
import { MAX_ROLES, getSelection, toggleSelection, onSelectionChange } from "./applySelection";

const PAGE_SIZE = 25;

function slugOf(role: Role): string {
  const base = role.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base}-${role.jobId}`;
}

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

function visaBucket(r: Role): string {
  return /transfer|sponsor/i.test(r.visa || "") ? "Visa transfers OK" : "No sponsorship";
}

function salaryMin(r: Role): number {
  const m = r.salary.toLowerCase().match(/(\d+(?:\.\d+)?)k/);
  return m ? parseFloat(m[1]) : 0;
}

function yoeMin(r: Role): number {
  const m = r.yoe.match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

type SortKey = "id" | "title" | "location" | "workplace" | "yoe" | "salary";

const HEADERS: { key: SortKey; label: string }[] = [
  { key: "id", label: "ID" },
  { key: "title", label: "Role" },
  { key: "location", label: "Location" },
  { key: "workplace", label: "Office" },
  { key: "yoe", label: "Experience" },
  { key: "salary", label: "Base salary" },
];

// showSelectionUI=false embeds the table under an external checkout rail
// (the /apply page): same search/filters/sort/pagination and APPLY buttons,
// but no side panel, bottom bar, or speculative button of its own.
export default function RolesTable({
  roles,
  showSelectionUI = true,
}: {
  roles: Role[];
  showSelectionUI?: boolean;
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

  // Selection lives in localStorage (shared with /apply); sync on mount + changes.
  useEffect(() => {
    setSelected(getSelection());
    return onSelectionChange(() => setSelected(getSelection()));
  }, []);
  // Any query change goes back to page 1.
  useEffect(() => {
    setPage(1);
  }, [q, loc, office, type, visaF]);

  const locations = useMemo(
    () => [...new Set(roles.flatMap((r) => r.locations))].sort(),
    [roles]
  );
  const offices = useMemo(
    () => [...new Set(roles.map((r) => r.workplace).filter(Boolean))].sort(),
    [roles]
  );
  const types = useMemo(
    () =>
      [...new Set(roles.flatMap((r) => r.roleType.split(",").map((t) => t.trim())).filter(Boolean))].sort(),
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
          r.jobId, r.title, r.description, r.techStack, r.industry,
          r.roleType, r.locations.join(" "), r.company?.blurb || "",
          r.jd?.about || "", (r.jd?.needs || []).join(" "),
        ].join(" ").toLowerCase();
        if (!matchesQuery(hay, needle)) return false;
      }
      return true;
    });
    const cmp: Record<SortKey, (a: Role, b: Role) => number> = {
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

  const selStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono), monospace",
    fontSize: "0.72rem",
    color: "var(--fog)",
    background: "var(--panel)",
    border: "1px solid var(--line)",
    padding: "0.6rem 0.7rem",
    outline: "none",
  };

  return (
    <div>
      {showSelectionUI && selected.length === 0 && (
        <div className="spec-banner">
          <p>
            <b>Nothing that fits?</b> Upload your resume — we&apos;ll match you against
            every open role and reach out when the right one arrives.
          </p>
          <Link href="/apply?speculative=1" className="btn hot" style={{ whiteSpace: "nowrap", padding: "0.7rem 1.3rem", fontSize: "0.72rem" }}>
            UPLOAD RESUME →
          </Link>
        </div>
      )}
      <div
        style={{
          display: "flex",
          gap: "0.8rem",
          flexWrap: "wrap",
          marginBottom: "1rem",
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder='search: python, go -java · "machine learning" · comma = OR, minus = exclude' 
          style={{ ...selStyle, flex: "1 1 220px" }}
          aria-label="Search roles"
        />
        <select value={loc} onChange={(e) => setLoc(e.target.value)} style={selStyle} aria-label="Filter by location">
          <option value="">all locations</option>
          {locations.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
        <select value={office} onChange={(e) => setOffice(e.target.value)} style={selStyle} aria-label="Filter by office type">
          <option value="">all office types</option>
          {offices.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)} style={selStyle} aria-label="Filter by role type">
          <option value="">all role types</option>
          {types.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select value={visaF} onChange={(e) => setVisaF(e.target.value)} style={selStyle} aria-label="Filter by visa">
          <option value="">any visa status</option>
          <option value="Visa transfers OK">Visa transfers OK</option>
          <option value="No sponsorship">No sponsorship</option>
        </select>
      </div>

      <p style={{ fontSize: "0.66rem", color: "var(--fog-30)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "0.6rem" }}>
        {shown.length} of {roles.length} roles
        {shown.length > PAGE_SIZE ? ` · page ${page} of ${Math.ceil(shown.length / PAGE_SIZE)}` : ""}
      </p>

      <div className={`roles-layout${showSelectionUI && selected.length > 0 ? " with-panel" : ""}`}>
      <div style={{ minWidth: 0 }}>
      <div className="roles-scroll">
        <table className="data-table">
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
                  <span style={{ color: "var(--signal)", marginLeft: 4 }}>
                    {sort === h.key ? (dir === 1 ? "▲" : "▼") : ""}
                  </span>
                </th>
              ))}
              <th style={{ whiteSpace: "nowrap" }}>Apply</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((r) => (
              <tr key={`${r.jobId}-${r.title}`}>
                <td className="hi" style={{ whiteSpace: "nowrap" }}>#{r.jobId}</td>
                <td style={{ minWidth: 260 }}>
                  <Link
                    href={`/roles/${slugOf(r)}`}
                    style={{ textDecoration: "none", display: "block" }}
                  >
                    <span
                      style={{
                        display: "block",
                        fontFamily: "var(--font-grot), sans-serif",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                        color: "var(--fog)",
                        fontSize: "0.8rem",
                      }}
                    >
                      {r.title}
                    </span>
                    <span style={{ fontSize: "0.7rem", color: "var(--fog-60)" }}>
                      {r.company?.blurb || r.description}
                    </span>
                  </Link>
                </td>
                <td style={{ fontSize: "0.72rem", minWidth: 140 }}>
                  {r.locations.length > 3
                    ? `${r.locations.slice(0, 3).join(" · ")} +${r.locations.length - 3}`
                    : r.locations.join(" · ") || "USA"}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>{r.workplace || "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>{r.yoe || "—"}</td>
                <td className="hi" style={{ whiteSpace: "nowrap" }}>
                  <span className="sig">{r.salary || "On request"}</span>
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button
                    type="button"
                    className={`apply-add-btn${selected.includes(r.jobId) ? " sel" : ""}`}
                    onClick={() => setSelected(toggleSelection(r.jobId))}
                    aria-pressed={selected.includes(r.jobId)}
                  >
                    {selected.includes(r.jobId)
                      ? `✓ ${selected.indexOf(r.jobId) + 1}/${MAX_ROLES}`
                      : "APPLY +"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {shown.length > PAGE_SIZE && (
        <div className="pager">
          <span className="info">
            showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, shown.length)} of {shown.length} roles
          </span>
          <div className="pages">
            <button type="button" className="pg-btn" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>‹</button>
            {Array.from({ length: Math.ceil(shown.length / PAGE_SIZE) }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                className={`pg-btn${n === page ? " cur" : ""}`}
                onClick={() => setPage(n)}
              >
                {n}
              </button>
            ))}
            <button
              type="button"
              className="pg-btn"
              disabled={page === Math.ceil(shown.length / PAGE_SIZE)}
              onClick={() => setPage((p) => p + 1)}
            >
              ›
            </button>
          </div>
        </div>
      )}

      </div>

      {/* Desktop: sticky side panel beside the table. */}
      {showSelectionUI && selected.length > 0 && (
        <aside className="side-panel">
          <div className="sec-label" style={{ paddingTop: 0 }}>
            <b>{selected.length}/{MAX_ROLES}</b> ROLES SELECTED
          </div>
          {selected.map((id) => {
            const r = roles.find((x) => x.jobId === id);
            if (!r) return null;
            return (
              <div key={id} className="sp-role">
                <div>
                  <div className="t">{r.title}</div>
                  <div className="m">
                    <em>{r.salary || "Comp on request"}</em> · #{id}
                  </div>
                </div>
                <button
                  type="button"
                  className="cart-remove"
                  onClick={() => setSelected(toggleSelection(id))}
                  aria-label={`Remove ${r.title}`}
                >
                  ✕
                </button>
              </div>
            );
          })}
          {selected.length < MAX_ROLES && (
            <div className="cart-empty" style={{ marginBottom: "0.8rem" }}>
              + {MAX_ROLES - selected.length} slot{MAX_ROLES - selected.length > 1 ? "s" : ""} left
            </div>
          )}
          <Link href="/apply" className="btn hot" style={{ display: "block", textAlign: "center" }}>
            CONTINUE TO APPLY →
          </Link>
        </aside>
      )}
      </div>

      {/* Narrow screens: compact bottom bar instead of a side column. */}
      {showSelectionUI && selected.length > 0 && (
        <div className="sel-bar mobile-only">
          <b style={{ color: "var(--signal)", fontSize: "0.78rem" }}>
            {selected.length}/{MAX_ROLES} selected
          </b>
          <Link href="/apply" className="btn hot" style={{ whiteSpace: "nowrap" }}>
            CONTINUE TO APPLY →
          </Link>
        </div>
      )}
    </div>
  );
}
