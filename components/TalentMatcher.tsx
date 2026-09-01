"use client";
// The JD-to-matches lead magnet (/talent). Behavior is load-bearing: field
// names, the 200-char validation, /api/talent wiring, and the states (idle /
// sending / done / error, with lowConfidence swapping only the closing line)
// carry over from the pre-redesign component untouched. The numeric score the
// API returns is never rendered — plain-English fit reads only.

import { useState } from "react";
import Turnstile, { resetTurnstile } from "@/components/Turnstile";

interface Match {
  ref: string;
  title: string;
  yearsExperience: number | null;
  location: string | null;
  previousCompanies: string[];
  education: string[];
  skills: string[];
  engaged: boolean;
  applied?: boolean;
  score: number;
  fit?: { strengths: string; verify: string } | null;
}

interface Result {
  roleTitle: string;
  matches: Match[];
  lowConfidence: boolean;
}

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "done"; result: Result }
  | { kind: "error"; message: string };

export default function TalentMatcher() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [jdFileName, setJdFileName] = useState("");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const jdFile = form.get("jdFile");
    const jdTextLen = String(form.get("jdText") || "").trim().length;
    if (jdTextLen < 200 && !(jdFile instanceof File && jdFile.size > 0)) {
      setStatus({
        kind: "error",
        message: "Paste the full job description (200+ characters) or upload it as a PDF.",
      });
      return;
    }
    setStatus({ kind: "sending" });
    try {
      const res = await fetch("/api/talent", { method: "POST", body: form });
      const json = await res.json().catch(() => ({}));
      resetTurnstile(formEl);
      if (res.ok && json.ok) {
        setStatus({ kind: "done", result: json as Result });
      } else {
        setStatus({
          kind: "error",
          message: json.error || "Something went wrong — please try again.",
        });
      }
    } catch {
      resetTurnstile(formEl);
      setStatus({ kind: "error", message: "Network error — please try again." });
    }
  }

  if (status.kind === "done") {
    const { roleTitle, matches, lowConfidence } = status.result;
    return (
      <div className="tal-results">
        <p className="tal-out">
          <b>OUT</b> - matches for: {roleTitle}
        </p>
        {matches.length > 0 && (
          <div className="tal-matches">
            {matches.map((m) => (
              <div key={m.ref} className="tal-match">
                <div className="tal-main">
                  <div className="tal-toprow">
                    <span className="tal-ref">{m.ref}</span>
                    <span className="tal-title">{m.title}</span>
                  </div>
                  <div className="tal-meta">
                    {[m.yearsExperience ? `${m.yearsExperience}y` : null, m.location]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  {m.previousCompanies.length > 0 && (
                    <p className="tal-prev">
                      prev: <b>{m.previousCompanies.join(", ")}</b>
                    </p>
                  )}
                  {m.education.length > 0 && <p className="tal-prev">{m.education.join(" · ")}</p>}
                  {m.fit && (
                    <p className="tal-fit">
                      <span className="ok">✓ {m.fit.strengths}</span>
                      {m.fit.verify && <span className="verify"> · verify: {m.fit.verify}</span>}
                    </p>
                  )}
                  {m.skills.length > 0 && (
                    <div className="tal-tags">
                      {m.skills.map((s) => (
                        <span key={s} className="tal-tag">
                          {s}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {m.applied ? (
                  <span className="tal-badge applied">
                    <i />applied to us directly
                  </span>
                ) : m.engaged ? (
                  <span className="tal-badge engaged">
                    <i />in conversation with us
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}
        <p className="tal-after">
          {lowConfidence
            ? "These are our closest instant matches — your JD is with the team, and we'll hand-pick a stronger shortlist from the full network and reply within 24 hours."
            : "Profiles are anonymized. Introductions, full profiles, and comp expectations take one conversation."}
        </p>
        <a
          href="mailto:spencer@transformertalent.com?subject=Intro%20request%20-%20matched%20candidates"
          className="board-btn tal-cta"
        >
          GET INTRODUCTIONS →
        </a>
      </div>
    );
  }

  return (
    <form className="tal-card" onSubmit={onSubmit}>
      <div className="tal-row2">
        <label className="tal-field">
          <span className="tal-lbl">Work email</span>
          <input name="email" type="email" required maxLength={254} autoComplete="email" />
        </label>
        <label className="tal-field">
          <span className="tal-lbl">Company</span>
          <input name="company" required maxLength={200} autoComplete="organization" />
        </label>
      </div>
      <label className="tal-field">
        <span className="tal-lbl">Your LinkedIn</span>
        <input
          name="linkedin"
          type="url"
          required
          maxLength={300}
          placeholder="https://www.linkedin.com/in/…"
          autoComplete="url"
        />
        <span className="tal-hint">
          Required. So we know who&apos;s asking before we share anonymized profiles.
        </span>
      </label>
      <label className="tal-field">
        <span className="tal-lbl">Job description</span>
        <textarea
          name="jdText"
          rows={12}
          maxLength={40000}
          placeholder="Paste the full job description here… or upload it as a PDF below."
        />
      </label>
      <label className="tal-field">
        <span className="tal-lbl">JD PDF (optional)</span>
        <span className={`tal-dz${jdFileName ? " has" : ""}`}>
          <input
            name="jdFile"
            type="file"
            accept="application/pdf,.pdf"
            onChange={(e) => setJdFileName(e.target.files?.[0]?.name || "")}
          />
          {jdFileName ? (
            <span>
              <b>{jdFileName}</b>
            </span>
          ) : (
            <span>
              <b>Choose a PDF</b> or drop it here
            </span>
          )}
        </span>
        <span className="tal-hint">PDF only.</span>
      </label>
      <input
        name="website"
        tabIndex={-1}
        autoComplete="off"
        style={{ position: "absolute", left: "-9999px" }}
        aria-hidden="true"
      />
      <Turnstile />
      <button type="submit" className="tal-submit" disabled={status.kind === "sending"}>
        {status.kind === "sending" ? "FINDING POTENTIAL MATCHES…" : "SEE POTENTIAL MATCHES →"}
      </button>
      {status.kind === "error" && (
        <p className="tal-error">
          <span aria-hidden>⚠</span>
          <span>{status.message}</span>
        </p>
      )}
    </form>
  );
}
