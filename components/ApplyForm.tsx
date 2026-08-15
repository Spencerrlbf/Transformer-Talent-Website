"use client";

// Checkout-style apply widget: cart (Your Application) + form (Your Details)
// side by side, browse list below feeding the cart. Deliberately
// self-contained — roles in, submit endpoint out, all theming via CSS
// variables — so this is the future embeddable unit for other companies.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  MAX_ROLES,
  getSelection,
  setSelection,
  toggleSelection,
  clearSelection,
  onSelectionChange,
} from "./applySelection";

export interface ApplyRole {
  jobId: string;
  title: string;
  salary: string;
  locations: string[];
  workplace: string;
  yoe: string;
  slug: string;
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
  | { kind: "ok"; matches: MatchedRole[]; applicationId: string | null; wasSpeculative: boolean }
  | { kind: "error"; message: string };

const PAGE_SIZE = 25;

export default function ApplyForm({
  roles,
  preselected,
  speculative = false,
}: {
  roles: ApplyRole[];
  preselected?: string;
  speculative?: boolean;
}) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [selected, setSelected] = useState<string[]>([]);
  const [roleQuery, setRoleQuery] = useState("");
  const [page, setPage] = useState(1);
  const [added, setAdded] = useState<string[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [formError, setFormError] = useState("");

  // Selection is shared with the roles table via localStorage; ?role= merges in.
  useEffect(() => {
    let cur = getSelection();
    if (preselected && roles.some((r) => r.jobId === preselected) && !cur.includes(preselected)) {
      cur = setSelection([...cur, preselected]);
    }
    setSelected(cur);
    return onSelectionChange(() => setSelected(getSelection()));
  }, [preselected, roles]);

  useEffect(() => setPage(1), [roleQuery]);

  const isSpeculative = speculative && selected.length === 0;
  const selectedRoles = selected
    .map((id) => roles.find((r) => r.jobId === id))
    .filter((r): r is ApplyRole => Boolean(r));

  const visibleRoles = useMemo(() => {
    const q = roleQuery.trim().toLowerCase();
    return q
      ? roles.filter((r) => `${r.title} ${r.locations.join(" ")}`.toLowerCase().includes(q))
      : roles;
  }, [roles, roleQuery]);
  const pageCount = Math.max(1, Math.ceil(visibleRoles.length / PAGE_SIZE));

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

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError("");
    const form = e.currentTarget;
    const data = new FormData(form);
    const resume = data.get("resume");
    const hasResume = resume instanceof File && resume.size > 0;
    if (isSpeculative && !hasResume) {
      setFormError("A resume is required for a speculative application — it's what we match you with.");
      return;
    }
    data.set("roleIds", selected.join(","));
    if (isSpeculative) data.set("speculative", "1");
    setStatus({ kind: "sending" });
    try {
      const res = await fetch("/api/apply", { method: "POST", body: data });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        form.reset();
        clearSelection();
        setStatus({
          kind: "ok",
          matches: json.matches || [],
          applicationId: json.applicationId || null,
          wasSpeculative: isSpeculative,
        });
      } else {
        setStatus({ kind: "error", message: json.error || "Something went wrong — please try again." });
      }
    } catch {
      setStatus({ kind: "error", message: "Network error — please try again." });
    }
  }

  // ---------- thank-you ----------
  if (status.kind === "ok") {
    return (
      <div style={{ maxWidth: 680 }}>
        <p className="form-status ok" style={{ marginBottom: "1.6rem" }}>
          {status.wasSpeculative
            ? "Resume received. We're matching you against every open role — and new ones as they arrive — and will contact you when there's a genuine fit."
            : "Application received. We review every submission personally and will be in touch when there's a fit."}
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
                    {!status.wasSpeculative && status.applicationId && (
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
              {status.wasSpeculative
                ? "These are your closest instant matches — we'll be in touch about them, no further action needed."
                : (
                  <>
                    Open a role in a new tab to review it, then tick <b>add to my application</b> to
                    be considered for it too — no need to fill anything in again.
                  </>
                )}
            </p>
          </>
        )}
      </div>
    );
  }

  // ---------- checkout ----------
  return (
    <div>
      <div className="apply-grid">
        {/* cart */}
        <div className="cart-panel">
          <div className="sec-label" style={{ paddingTop: 0, display: "flex", justifyContent: "space-between" }}>
            <span><b>YOUR APPLICATION</b></span>
            <span style={{ color: "var(--fog-60)", fontSize: "0.7rem", letterSpacing: 0 }}>
              {isSpeculative ? <b style={{ color: "var(--signal)" }}>speculative</b> : (
                <>applying to <b style={{ color: "var(--fog)" }}>{selected.length}/{MAX_ROLES}</b> roles</>
              )}
            </span>
          </div>
          {selectedRoles.map((r) => (
            <div key={r.jobId} className="cart-role">
              <div>
                <div style={{ fontSize: "0.82rem" }}>
                  <Link href={`/roles/${r.slug}`} target="_blank" rel="noreferrer" style={{ color: "var(--fog)", borderBottom: "1px dotted var(--fog-30)", textDecoration: "none" }}>
                    {r.title}
                  </Link>{" "}
                  <span style={{ color: "var(--fog-30)", fontSize: "0.66rem" }}>↗ view</span>
                </div>
                <div className="meta">
                  <em>{r.salary || "Comp on request"}</em>
                  {r.locations.length ? ` · ${r.locations.slice(0, 2).join(", ")}` : ""}
                  {r.workplace ? ` · ${r.workplace}` : ""}
                  {r.yoe ? ` · ${r.yoe}` : ""}
                </div>
              </div>
              <button
                type="button"
                className="cart-remove"
                onClick={() => setSelected(toggleSelection(r.jobId))}
                aria-label={`Remove ${r.title}`}
              >
                ✕
              </button>
            </div>
          ))}
          {isSpeculative ? (
            <div className="cart-empty" style={{ borderColor: "var(--fog-30)", color: "var(--fog-60)", padding: "0.9rem" }}>
              <b style={{ color: "var(--fog)" }}>No role selected — we&apos;ll do the matching.</b>
              <br />
              Your resume and profile run against all {roles.length} open roles (and new ones as
              they arrive). We contact you when there&apos;s a genuine fit.
            </div>
          ) : selected.length === 0 ? (
            <div className="cart-empty">
              nothing selected yet — add up to {MAX_ROLES} roles from the list below, or{" "}
              <Link href="/apply?speculative=1" style={{ color: "var(--fog-60)" }}>
                just drop your resume
              </Link>{" "}
              and we&apos;ll match you
            </div>
          ) : selected.length < MAX_ROLES ? (
            <div className="cart-empty">
              + {MAX_ROLES - selected.length} slot{MAX_ROLES - selected.length > 1 ? "s" : ""} left —
              add from the list below, one application covers them all
            </div>
          ) : null}
        </div>

        {/* form */}
        <form className="form" onSubmit={onSubmit} encType="multipart/form-data" style={{ margin: 0 }}>
          <div className="sec-label" style={{ paddingTop: 0 }}>
            <b>YOUR DETAILS</b>
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
            <input name="linkedin" type="url" required placeholder="https://linkedin.com/in/…" maxLength={300} />
          </label>
          <label>
            resume (PDF{isSpeculative ? ", required" : ", optional but recommended"})
            <input name="resume" type="file" accept="application/pdf" required={isSpeculative} />
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
            <textarea name="note" rows={2} maxLength={2000} />
          </label>
          <input
            name="website"
            tabIndex={-1}
            autoComplete="off"
            style={{ position: "absolute", left: "-9999px" }}
            aria-hidden="true"
          />
          <button type="submit" className="btn hot" disabled={status.kind === "sending"}>
            {status.kind === "sending"
              ? "SUBMITTING & MATCHING…"
              : isSpeculative
                ? "SUBMIT FOR MATCHING →"
                : selected.length > 0
                  ? `SUBMIT — ${selected.length} ROLE${selected.length > 1 ? "S" : ""} →`
                  : "SUBMIT APPLICATION →"}
          </button>
          {(formError || status.kind === "error") && (
            <p className="form-status error">{formError || (status.kind === "error" ? status.message : "")}</p>
          )}
        </form>
      </div>

      {/* browse list */}
      {!isSpeculative && (
        <div className="cart-panel" style={{ marginTop: "1.4rem" }}>
          <div className="sec-label" style={{ paddingTop: 0 }}>
            <b>ADD MORE ROLES</b>{" "}
            <span style={{ color: "var(--fog-30)", letterSpacing: 0 }}>
              — {visibleRoles.length} open
            </span>
          </div>
          <input
            value={roleQuery}
            onChange={(e) => setRoleQuery(e.target.value)}
            placeholder="search roles… (title, location)"
            style={{ marginBottom: "0.6rem", width: "100%" }}
          />
          <div className="logs">
            {visibleRoles.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((r) => (
              <div
                key={r.jobId}
                className="log"
                style={{ gridTemplateColumns: "auto 1fr auto auto", alignItems: "center", gap: "0.8rem" }}
              >
                <button
                  type="button"
                  className={`apply-add-btn${selected.includes(r.jobId) ? " sel" : ""}`}
                  onClick={() => setSelected(toggleSelection(r.jobId))}
                  aria-pressed={selected.includes(r.jobId)}
                >
                  {selected.includes(r.jobId) ? `✓ ${selected.indexOf(r.jobId) + 1}/${MAX_ROLES}` : "APPLY +"}
                </button>
                <span>
                  <Link
                    href={`/roles/${r.slug}`}
                    target="_blank"
                    rel="noreferrer"
                    className="co"
                    style={{ fontSize: "0.74rem" }}
                  >
                    {r.title} <span style={{ color: "var(--fog-30)", fontSize: "0.64rem" }}>↗</span>
                  </Link>
                  <span style={{ display: "block", color: "var(--fog-60)", fontSize: "0.66rem" }}>
                    {r.locations.slice(0, 2).join(", ") || "USA"}
                    {r.workplace ? ` · ${r.workplace}` : ""}
                  </span>
                </span>
                <span className="t" style={{ color: "var(--signal)", fontSize: "0.68rem", whiteSpace: "nowrap" }}>
                  {r.salary}
                </span>
              </div>
            ))}
          </div>
          {pageCount > 1 && (
            <div className="pager">
              <span className="info">
                showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, visibleRoles.length)} of {visibleRoles.length}
              </span>
              <div className="pages">
                <button type="button" className="pg-btn" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>‹</button>
                {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
                  <button key={n} type="button" className={`pg-btn${n === page ? " cur" : ""}`} onClick={() => setPage(n)}>
                    {n}
                  </button>
                ))}
                <button type="button" className="pg-btn" disabled={page === pageCount} onClick={() => setPage((p) => p + 1)}>›</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
