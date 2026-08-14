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
  score: number;
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
    const data = Object.fromEntries(new FormData(e.currentTarget).entries());
    setStatus({ kind: "sending" });
    try {
      const res = await fetch("/api/talent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
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
                  <span className="score">{m.score.toFixed(2)}</span>
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
                {m.engaged && <span className="badge">● in conversation with us</span>}
                {m.previousCompanies.length > 0 && (
                  <p className="prev">
                    prev: <b>{m.previousCompanies.join(", ")}</b>
                  </p>
                )}
                {m.education.length > 0 && (
                  <p className="prev">{m.education.join(" · ")}</p>
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
            ? "These are the closest automated matches — your JD is with Spencer, who will hand-pick a stronger shortlist from the full network and reply within 24 hours."
            : "Profiles are anonymized. Introductions, full profiles, and comp expectations take one conversation."}
        </p>
        <a
          href="mailto:spencer@transformertalent.com?subject=Intro%20request%20—%20matched%20candidates"
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
        job_description
        <textarea
          name="jdText"
          rows={12}
          required
          minLength={200}
          maxLength={40000}
          placeholder="Paste the full job description here…"
        />
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
          ? "SCANNING 419,595 PROFILES…"
          : "RUN MATCH →"}
      </button>
      {status.kind === "error" && (
        <p className="form-status error">{status.message}</p>
      )}
    </form>
  );
}
