"use client";

import { useState } from "react";

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

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
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
      if (res.ok && json.ok) {
        setStatus({ kind: "done", result: json as Result });
      } else {
        setStatus({
          kind: "error",
          message: json.error || "Something went wrong — please try again.",
        });
      }
    } catch {
      setStatus({ kind: "error", message: "Network error — please try again." });
    }
  }

  if (status.kind === "done") {
    const { roleTitle, matches, lowConfidence } = status.result;
    return (
      <div style={{ width: "100%" }}>
        <div className="sec-label" style={{ paddingTop: 0 }}>
          <b>OUT</b> — matches for: {roleTitle}
        </div>
        {matches.length > 0 && (
          <div className="match-grid" style={{ marginBottom: "1.8rem" }}>
            {matches.map((m) => (
              <div key={m.ref} className="match-card">
                <div className="ref-row">
                  <span className="ref">{m.ref}</span>
                </div>
                <h4>{m.title}</h4>
                <div className="meta">
                  {[
                    m.yearsExperience ? `${m.yearsExperience}y` : null,
                    m.location,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                {m.applied ? (
                  <span className="badge">● applied to us directly</span>
                ) : m.engaged ? (
                  <span className="badge">● in conversation with us</span>
                ) : null}
                {m.previousCompanies.length > 0 && (
                  <p className="prev">
                    prev: <b>{m.previousCompanies.join(", ")}</b>
                  </p>
                )}
                {m.education.length > 0 && (
                  <p className="prev">{m.education.join(" · ")}</p>
                )}
                {m.fit && (
                  <p className="prev" style={{ marginTop: "0.4rem" }}>
                    <span style={{ color: "var(--ok)" }}>✓ {m.fit.strengths}</span>
                    {m.fit.verify && (
                      <span style={{ color: "var(--fog-30)" }}> · verify: {m.fit.verify}</span>
                    )}
                  </p>
                )}
                {m.skills.length > 0 && (
                  <div className="tags">
                    {m.skills.map((s) => (
                      <span key={s} className="tag">
                        {s}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="page-intro" style={{ marginBottom: "1.6rem" }}>
          {lowConfidence
            ? "These are our closest instant matches — your JD is with the team, and we'll hand-pick a stronger shortlist from the full network and reply within 24 hours."
            : "Profiles are anonymized. Introductions, full profiles, and comp expectations take one conversation."}
        </p>
        <a
          href="mailto:spencer@transformertalent.com?subject=Intro%20request%20%E2%80%94%20matched%20candidates"
          className="btn hot"
        >
          GET INTRODUCTIONS →
        </a>
      </div>
    );
  }

  return (
    <form className="form" onSubmit={onSubmit} style={{ maxWidth: 680 }}>
      <label>
        work_email
        <input name="email" type="email" required maxLength={254} autoComplete="email" />
      </label>
      <label>
        company
        <input name="company" required maxLength={200} autoComplete="organization" />
      </label>
      <label>
        your_linkedin
        <input
          name="linkedin"
          type="url"
          required
          maxLength={300}
          placeholder="https://www.linkedin.com/in/…"
          autoComplete="url"
        />
      </label>
      <label>
        job_description
        <textarea
          name="jdText"
          rows={12}
          maxLength={40000}
          placeholder="Paste the full job description here… or upload it as a PDF below."
        />
      </label>
      <label>
        jd_pdf (optional)
        <input name="jdFile" type="file" accept="application/pdf,.pdf" />
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
          ? "FINDING POTENTIAL MATCHES…"
          : "SEE POTENTIAL MATCHES →"}
      </button>
      {status.kind === "error" && (
        <p className="form-status error">{status.message}</p>
      )}
    </form>
  );
}
