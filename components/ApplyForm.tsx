"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

export interface ApplyRole {
  jobId: string;
  title: string;
  salary: string;
  locations: string[];
}

interface MatchedRole {
  jobId: string;
  title: string;
  salary: string;
  slug: string;
}

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "ok"; matches: MatchedRole[]; applicationId: string | null }
  | { kind: "error"; message: string };

export default function ApplyForm({
  roles,
  preselected,
}: {
  roles: ApplyRole[];
  preselected?: string;
}) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [selected, setSelected] = useState<string[]>(
    preselected && roles.some((r) => r.jobId === preselected) ? [preselected] : []
  );
  const [roleQuery, setRoleQuery] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  const [adding, setAdding] = useState<string | null>(null);

  async function addRole(applicationId: string, jobId: string) {
    setAdding(jobId);
    try {
      const res = await fetch("/api/apply/add-role", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationId, jobId }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) setAdded((a) => [...a, jobId]);
    } finally {
      setAdding(null);
    }
  }

  const visibleRoles = useMemo(() => {
    const q = roleQuery.trim().toLowerCase();
    const list = q
      ? roles.filter((r) => `${r.title} ${r.locations.join(" ")}`.toLowerCase().includes(q))
      : roles;
    // Selected roles always visible at the top.
    const sel = roles.filter((r) => selected.includes(r.jobId));
    const rest = list.filter((r) => !selected.includes(r.jobId));
    return [...sel, ...rest];
  }, [roles, roleQuery, selected]);

  function toggle(jobId: string) {
    setSelected((s) =>
      s.includes(jobId) ? s.filter((x) => x !== jobId) : s.length < 3 ? [...s, jobId] : s
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    data.set("roleIds", selected.join(","));
    setStatus({ kind: "sending" });
    try {
      const res = await fetch("/api/apply", { method: "POST", body: data });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        form.reset();
        setStatus({ kind: "ok", matches: json.matches || [], applicationId: json.applicationId || null });
      } else {
        setStatus({ kind: "error", message: json.error || "Something went wrong — please try again." });
      }
    } catch {
      setStatus({ kind: "error", message: "Network error — please try again." });
    }
  }

  if (status.kind === "ok") {
    return (
      <div style={{ maxWidth: 680 }}>
        <p className="form-status ok" style={{ marginBottom: "1.6rem" }}>
          Application received. We review every submission personally and will
          be in touch when there&apos;s a fit.
        </p>
        {status.matches.length > 0 && (
          <>
            <div className="sec-label" style={{ paddingTop: 0 }}>
              <b>MATCH</b> — you also look like a fit for
            </div>
            <div className="logs" style={{ marginBottom: "1.4rem" }}>
              {status.matches.map((m) => {
                const isAdded = added.includes(m.jobId);
                return (
                  <div
                    key={m.jobId}
                    className="log"
                    style={{ gridTemplateColumns: "1fr auto auto", alignItems: "center", gap: "0.8rem" }}
                  >
                    <Link href={`/roles/${m.slug}`} target="_blank" rel="noreferrer" className="co">
                      {m.title} ↗
                    </Link>
                    <span className="t" style={{ color: "var(--signal)" }}>
                      {m.salary}
                    </span>
                    {status.applicationId && (
                      <button
                        type="button"
                        onClick={() => !isAdded && addRole(status.applicationId!, m.jobId)}
                        disabled={isAdded || adding === m.jobId}
                        className="btn"
                        style={{
                          fontSize: "0.62rem",
                          padding: "0.3rem 0.6rem",
                          cursor: isAdded ? "default" : "pointer",
                          color: isAdded ? "var(--ok)" : undefined,
                        }}
                      >
                        {isAdded ? "☑ ADDED" : adding === m.jobId ? "ADDING…" : "☐ ADD TO MY APPLICATION"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="page-intro" style={{ fontSize: "0.75rem" }}>
              Open a role in a new tab to review it, then tick{" "}
              <b>add to my application</b> to be considered for it too — no need
              to fill anything in again.
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <form className="form" onSubmit={onSubmit} style={{ maxWidth: 680 }} encType="multipart/form-data">
      <label>
        roles you&apos;re applying for ({selected.length}/3 selected{selected.length === 0 ? " — pick up to 3, or leave empty for general consideration" : ""})
        <input
          value={roleQuery}
          onChange={(e) => setRoleQuery(e.target.value)}
          placeholder="search roles…"
        />
      </label>
      <div className="logs" style={{ maxHeight: 260, overflowY: "auto" }}>
        {visibleRoles.map((r) => (
          <button
            key={r.jobId}
            type="button"
            onClick={() => toggle(r.jobId)}
            className="log"
            style={{
              gridTemplateColumns: "24px 1fr auto",
              width: "100%",
              textAlign: "left",
              background: selected.includes(r.jobId) ? "var(--panel)" : "transparent",
              border: 0,
              borderBottom: "1px solid var(--line)",
              cursor: "pointer",
              fontFamily: "inherit",
              color: "inherit",
            }}
          >
            <span style={{ color: selected.includes(r.jobId) ? "var(--ok)" : "var(--fog-30)" }}>
              {selected.includes(r.jobId) ? "☑" : "☐"}
            </span>
            <span className="co" style={{ fontSize: "0.72rem" }}>
              {r.title}
            </span>
            <span className="t" style={{ color: "var(--signal)", fontSize: "0.68rem" }}>
              {r.salary}
            </span>
          </button>
        ))}
      </div>

      <label>
        name
        <input name="name" required maxLength={120} autoComplete="name" />
      </label>
      <label>
        email
        <input name="email" type="email" required maxLength={254} autoComplete="email" />
      </label>
      <label>
        linkedin_url (required)
        <input
          name="linkedin"
          type="url"
          required
          placeholder="https://linkedin.com/in/…"
          maxLength={300}
        />
      </label>
      <label>
        resume (PDF, optional but recommended)
        <input name="resume" type="file" accept="application/pdf" />
      </label>
      <label>
        visa_status
        <select name="visa" defaultValue="">
          <option value="" disabled>
            select…
          </option>
          <option value="None needed (US citizen / green card)">None needed (US citizen / green card)</option>
          <option value="H-1B">H-1B</option>
          <option value="STEM OPT">STEM OPT</option>
          <option value="TN">TN</option>
          <option value="O-1">O-1</option>
          <option value="Other">Other</option>
        </select>
      </label>
      <label>
        anything_else
        <textarea name="note" rows={3} maxLength={2000} />
      </label>
      <input
        name="website"
        tabIndex={-1}
        autoComplete="off"
        style={{ position: "absolute", left: "-9999px" }}
        aria-hidden="true"
      />
      <button type="submit" className="btn hot" disabled={status.kind === "sending"}>
        {status.kind === "sending" ? "SUBMITTING & MATCHING…" : "SUBMIT APPLICATION →"}
      </button>
      {status.kind === "error" && <p className="form-status error">{status.message}</p>}
    </form>
  );
}
