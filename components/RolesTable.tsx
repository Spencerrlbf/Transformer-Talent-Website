"use client";
// The site's own roles board (/roles and, slimmer, /apply): search + filters +
// sortable table with APPLY +/✓ selection shared via localStorage. Search
// semantics (comma = OR, space = AND, -term excludes, "quoted" literal), the
// sort keys, PAGE_SIZE and the 3-role cap are load-bearing — never change.
// variant="apply" drops the Location column (folded into the meta line) for
// the checkout page's narrower column.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Role } from "@/lib/roles";
import FiltersMenu from "@/components/FiltersMenu";
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
const SORT_NOTE: Record<SortKey, string> = {
  id: "ID",
  title: "role",
  location: "location",
  workplace: "office",
  yoe: "experience",
  salary: "salary",
};

// showSelectionUI=false embeds the table under an external checkout rail
// (the /apply page): same search/filters/sort/pagination and APPLY buttons,
// but no side panel, bottom bar, or speculative button of its own.
export default function RolesTable({
  roles,
  showSelectionUI = true,
  variant = "index",
}: {
  roles: Role[];
  showSelectionUI?: boolean;
  variant?: "index" | "apply";
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

  const activeFilters = [
    ["Location", loc, () => setLoc("")],
    ["Office", office, () => setOffice("")],
    ["Role type", type, () => setType("")],
    ["Visa", visaF, () => setVisaF("")],
  ].filter(([, v]) => v) as [string, string, () => void][];

  const isApply = variant === "apply";
  const pageCount = Math.ceil(shown.length / PAGE_SIZE);

  const th = (key: SortKey, label: string, cls?: string) => (
    <th
      key={key}
      className={cls}
      onClick={() => clickSort(key)}
      style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
      aria-sort={sort === key ? (dir === 1 ? "ascending" : "descending") : "none"}
    >
      {label}
      <span className="board-sort">{sort === key ? (dir === 1 ? "▲" : "▼") : ""}</span>
    </th>
  );

  return (
    <div>
      {showSelectionUI && selected.length === 0 && (
        <div className="spec-banner">
          <p>
            <b>Nothing that fits?</b> Upload your resume — we&apos;ll match you against
            every open role and reach out when the right one arrives.
          </p>
          <Link href="/apply?speculative=1" className="board-btn">
            UPLOAD RESUME →
          </Link>
        </div>
      )}

      <div className="board-filters">
        <FiltersMenu
          groups={[
            { key: "loc", label: "Location", value: loc, options: locations, set: setLoc },
            { key: "office", label: "Office", value: office, options: offices, set: setOffice },
            ...(types.length > 0
              ? [{ key: "type", label: "Role type", value: type, options: types, set: setType }]
              : []),
            {
              key: "visa",
              label: "Visa",
              value: visaF,
              options: ["Visa transfers OK", "No sponsorship"],
              set: setVisaF,
            },
          ]}
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder='search: python, go -java · "machine learning" · comma = OR, minus = exclude'
          aria-label="Search roles"
        />
        <span className="dash-sortnote">Sorted by {SORT_NOTE[sort]}</span>
      </div>

      <div className="board-chipsrow">
        {activeFilters.length > 0 && (
          <>
            {activeFilters.map(([label, v, clear]) => (
              <span key={label} className="dash-chip">
                {label}: <b>{v}</b>
                <button type="button" aria-label={`Clear ${label}`} onClick={clear}>
                  ✕
                </button>
              </span>
            ))}
            <button
              type="button"
              className="clear"
              onClick={() => {
                setLoc("");
                setOffice("");
                setType("");
                setVisaF("");
              }}
            >
              Clear all
            </button>
          </>
        )}
        <p className="board-count">
          {shown.length} of {roles.length} roles
          {shown.length > PAGE_SIZE ? ` · page ${page} of ${pageCount}` : ""}
        </p>
      </div>

      <div className={`roles-layout${showSelectionUI && selected.length > 0 ? " with-panel" : ""}`}>
        <div style={{ minWidth: 0 }}>
          <div className={`board-scroll${isApply ? " apply-scroll" : ""}`}>
            <table className="board-table">
              <thead>
                <tr>
                  {th("id", "ID", "w-id")}
                  {th("title", "Role")}
                  {!isApply && th("location", "Location", "w-loc")}
                  {th("salary", "Base salary", "w-sal")}
                  <th className="w-ap" style={{ whiteSpace: "nowrap" }}>Apply</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((r) => {
                  const isSel = selected.includes(r.jobId);
                  const tease = r.company?.blurb || r.description || "";
                  const metaParts = isApply
                    ? [
                        r.locations.slice(0, 2).join(" · "),
                        r.workplace,
                        r.yoe,
                      ]
                    : [r.workplace, r.yoe, tease.slice(0, 90) + (tease.length > 90 ? "…" : "")];
                  return (
                    <tr key={`${r.jobId}-${r.title}`}>
                      <td className="board-id">#{r.jobId}</td>
                      <td className="board-rolecol">
                        <Link href={`/roles/${slugOf(r)}`} className="board-rolebtn board-rolelink">
                          <span className="t">{r.title}</span>
                          <span className="d">{metaParts.filter(Boolean).join(" · ") || "—"}</span>
                        </Link>
                      </td>
                      {!isApply && (
                        <td className="board-loccol">
                          {r.locations.length > 3
                            ? `${r.locations.slice(0, 3).join(" · ")} +${r.locations.length - 3}`
                            : r.locations.join(" · ") || "USA"}
                        </td>
                      )}
                      <td className="board-salary" style={{ whiteSpace: "nowrap" }}>
                        {r.salary || "On request"}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button
                          type="button"
                          className={`board-apply-btn${isSel ? " sel" : ""}`}
                          onClick={() => setSelected(toggleSelection(r.jobId))}
                          aria-pressed={isSel}
                        >
                          {isSel ? `✓ ${selected.indexOf(r.jobId) + 1}/${MAX_ROLES}` : "APPLY +"}
                        </button>
                      </td>
                    </tr>
                  );
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
                <button type="button" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>‹</button>
                {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={n === page ? "cur" : ""}
                    onClick={() => setPage(n)}
                  >
                    {n}
                  </button>
                ))}
                <button type="button" disabled={page === pageCount} onClick={() => setPage((p) => p + 1)}>
                  ›
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Desktop: sticky selection rail beside the table. */}
        {showSelectionUI && selected.length > 0 && (
          <aside className="board-rail">
            <div className="board-panel">
              <div className="board-panel-label">
                <b>{selected.length}/{MAX_ROLES}</b> ROLES SELECTED
              </div>
              <div className="rail-roles">
                {selected.map((id) => {
                  const r = roles.find((x) => x.jobId === id);
                  if (!r) return null;
                  return (
                    <div key={id} className="board-panel-role">
                      <div>
                        <div className="t">{r.title}</div>
                        <div className="m">{r.salary || "Comp on request"} · #{id}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelected(toggleSelection(id))}
                        aria-label={`Remove ${r.title}`}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
                {selected.length < MAX_ROLES && (
                  <div className="board-panel-slots">
                    + {MAX_ROLES - selected.length} slot{MAX_ROLES - selected.length > 1 ? "s" : ""} left — hit APPLY + in the table
                  </div>
                )}
                <Link href="/apply" className="board-btn rail-continue">
                  CONTINUE TO APPLY →
                </Link>
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* Narrow screens: compact bottom bar instead of a side column. */}
      {showSelectionUI && selected.length > 0 && (
        <div className="board-selbar">
          <b>{selected.length}/{MAX_ROLES} selected</b>
          <Link href="/apply" className="board-btn">
            CONTINUE TO APPLY →
          </Link>
        </div>
      )}
    </div>
  );
}
