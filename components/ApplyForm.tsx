"use client";

// The checkout rail: Your Application (cart) on top, Your Details below.
// Lives beside the roles table on /apply — the table feeds the cart via the
// shared selection module. Deliberately self-contained (roles in, one
// endpoint out): this is the future embeddable unit. All six states and the
// submit wiring are load-bearing; the redesign touched markup and labels only.

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

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "ok"; roleTitles: string[]; wasSpeculative: boolean; alreadyApplied?: boolean }
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
  const [formError, setFormError] = useState("");
  const [resumeName, setResumeName] = useState("");

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
        const roleTitles = roles
          .filter((r) => selected.includes(r.jobId))
          .map((r) => r.title);
        form.reset();
        setResumeName("");
        clearSelection();
        setStatus({
          kind: "ok",
          roleTitles,
          wasSpeculative: isSpeculative,
          alreadyApplied: json.alreadyApplied === true,
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
      <div className="cart-panel apply-thanks">
        <h2>
          {status.alreadyApplied
            ? "You've already applied."
            : status.wasSpeculative
              ? "Thank you for your application."
              : status.roleTitles.length > 0
                ? `Thank you for applying to ${status.roleTitles.join(", ")}.`
                : "Thank you for your application."}
        </h2>
        <p>
          {status.alreadyApplied
            ? "We are reviewing your application and will reach out within 48 hours."
            : "We will be in touch within 48 hours."}
        </p>
      </div>
    );
  }

  // ---------- the rail: cart on top, details below ----------
  return (
    <div className="apply-railstack">
      <div className="cart-panel">
        <div className="board-panel-label">
          <b>YOUR APPLICATION</b>
          <span className="cart-count">
            {isSpeculative ? (
              <b>speculative</b>
            ) : (
              <>
                <b>{selected.length}/{MAX_ROLES}</b> roles
              </>
            )}
          </span>
        </div>
        <div className="cart-body">
          {selectedRoles.map((r) => (
            <div key={r.jobId} className="board-panel-role">
              <div>
                <div className="t">
                  <Link href={`/roles/${r.slug}`} target="_blank" rel="noreferrer">
                    {r.title} <span className="cart-ext">↗</span>
                  </Link>
                </div>
                <div className="m">
                  {r.salary || "Comp on request"}
                  {r.locations.length ? ` · ${r.locations.slice(0, 2).join(", ")}` : ""}
                  {r.workplace ? ` · ${r.workplace}` : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelected(toggleSelection(r.jobId))}
                aria-label={`Remove ${r.title}`}
              >
                ✕
              </button>
            </div>
          ))}
          {isSpeculative ? (
            <div className="board-panel-slots">
              <b>No role selected? No problem.</b> Send your resume and we will consider you for
              all {roles.length} open roles, and for new ones as they arrive.
            </div>
          ) : selected.length === 0 ? (
            <div className="board-panel-slots">
              Nothing selected yet — hit <b>APPLY +</b> on up to {MAX_ROLES} roles in the table,
              or{" "}
              <Link href="/apply?speculative=1">just drop your resume</Link>
            </div>
          ) : selected.length < MAX_ROLES ? (
            <div className="board-panel-slots">
              + {MAX_ROLES - selected.length} slot{MAX_ROLES - selected.length > 1 ? "s" : ""} left —
              one application covers them all
            </div>
          ) : null}
        </div>
      </div>

      <div className="cart-panel">
        <div className="board-panel-label">
          <b>YOUR DETAILS</b>
        </div>
        <form className="board-form" onSubmit={onSubmit} encType="multipart/form-data">
          <p className="apply-intro">
            {isSpeculative
              ? "Complete this form and attach your resume. We will be in touch within 48 hours."
              : selected.length > 0
                ? `Complete this form to finish your application for the ${selected.length} selected role${selected.length > 1 ? "s" : ""} — one form covers them all.`
                : "Pick roles from the table, then complete this form to apply."}
          </p>
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
            <span className={`apply-dz${resumeName ? " has" : ""}`}>
              <input
                name="resume"
                type="file"
                accept="application/pdf"
                required={isSpeculative}
                onChange={(e) => setResumeName(e.target.files?.[0]?.name || "")}
              />
              {resumeName ? (
                <span className="dz-name">
                  <span className="dz-pdf">PDF</span> {resumeName}
                </span>
              ) : (
                <span className="dz-hint">⇪ Choose a PDF or drop it here</span>
              )}
            </span>
          </label>
          <label>
            Locations you&apos;re open to (optional — ⌘/Ctrl-click several; empty = your profile
            location; remote roles always considered)
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
                Select…
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
          <button type="submit" className="board-btn apply-submit" disabled={status.kind === "sending"}>
            {status.kind === "sending"
              ? "SUBMITTING…"
              : selected.length > 0
                ? `SUBMIT (${selected.length} ROLE${selected.length > 1 ? "S" : ""}) →`
                : "SUBMIT APPLICATION →"}
          </button>
          {(formError || status.kind === "error") && (
            <p className="board-error">{formError || (status.kind === "error" ? status.message : "")}</p>
          )}
        </form>
      </div>
    </div>
  );
}
