"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Role } from "@/lib/roles";

function slugOf(role: Role): string {
  const base = role.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base}-${role.jobId}`;
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

export default function RolesTable({ roles }: { roles: Role[] }) {
  const [q, setQ] = useState("");
  const [loc, setLoc] = useState("");
  const [office, setOffice] = useState("");
  const [type, setType] = useState("");
  const [sort, setSort] = useState<SortKey>("id");
  const [dir, setDir] = useState<1 | -1>(1);

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
      if (needle) {
        const hay = [
          r.jobId, r.title, r.description, r.techStack, r.industry,
          r.roleType, r.locations.join(" "), r.company?.blurb || "",
        ].join(" ").toLowerCase();
        if (!hay.includes(needle)) return false;
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
  }, [roles, q, loc, office, type, sort, dir]);

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
          placeholder="search roles, stacks, industries…"
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
      </div>

      <p style={{ fontSize: "0.66rem", color: "var(--fog-30)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "0.6rem" }}>
        {shown.length} of {roles.length} roles
      </p>

      <div style={{ overflowX: "auto" }}>
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
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
