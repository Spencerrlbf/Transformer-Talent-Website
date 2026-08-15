"use client";

// The checkout rail: Your Application (cart) on top, Your Details below.
// Lives beside the full roles table on /apply — the table feeds the cart via
// the shared selection module. Deliberately self-contained (roles in, one
// endpoint out, CSS-variable theming): this is the future embeddable unit.

import { useEffect, useState } from "react";
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

  const isSpeculative = speculative && selected.length === 0;
  const selectedRoles = selected
    .map((id) => roles.find((r) => r.jobId === id))
    .filter((r): r is ApplyRole => Boolean(r));

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

  // ---------- thank-you (replaces the rail) ----------
  if (status.kind === "ok") {
    return (
      <div className="cart-panel">
        <p className="form-status ok" style={{ marginBottom: "1.2rem" }}>
          {status.wasSpeculative
            ? "Resume received. We're matching you against every open role — and new ones as they arrive — and will contact you when there's a genuine fit."
            : "Application received. We review every submission personally and will be in touch when there's a fit."}
        </p>
        {status.matches.length > 0 && (
          <>
            <div className="sec-label" style={{ paddingTop: 0 }}>
              <b>MATCH</b> — you also look like a fit for
            </div>
            <div className="logs" style={{ marginBottom: "1.2rem" }}>
              {status.matches.map((m) => {
                const isAdded = added.includes(m.jobId);
                return (
                  <div
                    key={m.jobId}
                    className="log"
                    style={{ gridTemplateColumns: "1fr auto", alignItems: "center", gap: "0.6rem" }}
                  >
                    <span>
                      <Link href={`/roles/${m.slug}`} target="_blank" rel="noreferrer" className="co" style={{ fontSize: "0.74rem" }}>
                        {m.title} ↗
                      </Link>
                      <span style={{ display: "block", color: "var(--signal)", fontSize: "0.66rem" }}>{m.salary}</span>
                    </span>
                    {!status.wasSpeculative && status.applicationId && (
                      <button
                        type="button"
                        onClick={() => !isAdded && addRole(status.applicationId!, m.jobId)}
                        disabled={isAdded || adding === m.jobId}
                        className="btn"
                        style={{
                          fontSize: "0.6rem",
                          padding: "0.3rem 0.5rem",
                          cursor: isAdded ? "default" : "pointer",
                          color: isAdded ? "var(--ok)" : undefined,
                        }}
                      >
                        {isAdded ? "☑ ADDED" : adding === m.jobId ? "ADDING…" : "☐ ADD"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="page-intro" style={{ fontSize: "0.72rem" }}>
              {status.wasSpeculative
                ? "These are your closest instant matches — we'll be in touch about them, no further action needed."
                : (
                  <>
                    Open a role in a new tab to review it, then tick <b>add</b> to be considered
                    for it too — no need to fill anything in again.
                  </>
                )}
            </p>
          </>
        )}
      </div>
    );
  }

  // ---------- the rail: cart on top, details below ----------
  return (
    <div>
      <div className="cart-panel" style={{ marginBottom: "1.2rem" }}>
        <div className="sec-label" style={{ paddingTop: 0, display: "flex", justifyContent: "space-between" }}>
          <span><b>YOUR APPLICATION</b></span>
          <span style={{ color: "var(--fog-60)", fontSize: "0.7rem", letterSpacing: 0 }}>
            {isSpeculative ? <b style={{ color: "var(--signal)" }}>speculative</b> : (
              <><b style={{ color: "var(--fog)" }}>{selected.length}/{MAX_ROLES}</b> roles</>
            )}
          </span>
        </div>
        {selectedRoles.map((r) => (
          <div key={r.jobId} className="cart-role">
            <div>
              <div style={{ fontSize: "0.78rem" }}>
                <Link href={`/roles/${r.slug}`} target="_blank" rel="noreferrer" style={{ color: "var(--fog)", borderBottom: "1px dotted var(--fog-30)", textDecoration: "none" }}>
                  {r.title}
                </Link>{" "}
                <span style={{ color: "var(--fog-30)", fontSize: "0.64rem" }}>↗</span>
              </div>
              <div className="meta">
                <em>{r.salary || "Comp on request"}</em>
                {r.locations.length ? ` · ${r.locations.slice(0, 2).join(", ")}` : ""}
                {r.workplace ? ` · ${r.workplace}` : ""}
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
            nothing selected yet — hit <b>APPLY +</b> on up to {MAX_ROLES} roles in the table, or{" "}
            <Link href="/apply?speculative=1" style={{ color: "var(--fog-60)" }}>
              just drop your resume
            </Link>
          </div>
        ) : selected.length < MAX_ROLES ? (
          <div className="cart-empty">
            + {MAX_ROLES - selected.length} slot{MAX_ROLES - selected.length > 1 ? "s" : ""} left —
            one application covers them all
          </div>
        ) : null}
      </div>

      <form className="form cart-panel" onSubmit={onSubmit} encType="multipart/form-data" style={{ margin: 0, maxWidth: "none" }}>
        <div className="sec-label" style={{ paddingTop: 0 }}>
          <b>YOUR DETAILS</b>
        </div>
        <p style={{ color: "var(--fog-60)", fontSize: "0.72rem", margin: "0 0 0.6rem", lineHeight: 1.5 }}>
          {isSpeculative
            ? "Complete this form and attach your resume — we'll match you and be in touch."
            : selected.length > 0
              ? `Complete this form to finish your application for the ${selected.length} selected role${selected.length > 1 ? "s" : ""} — one form covers them all.`
              : "Pick roles from the table, then complete this form to apply."}
        </p>
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
        <button type="submit" className="btn hot" disabled={status.kind === "sending"} style={{ width: "100%" }}>
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
  );
}
