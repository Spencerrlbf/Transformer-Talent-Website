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
        <div className="section-label">
          Matches for: {roleTitle}
        </div>
        {matches.length > 0 && (
          <div className="roles-grid" style={{ marginBottom: "2rem" }}>
            {matches.map((m) => (
              <div key={m.ref} className="role-card" style={{ cursor: "default" }}>
                <div className="role-meta" style={{ marginBottom: "0.5rem", justifyContent: "space-between" }}>
                  <span className="role-salary">{m.ref}</span>
                  {m.engaged && <span className="role-salary">● in conversation with us</span>}
                </div>
                <div className="role-title">{m.title}</div>
                <div className="role-meta" style={{ marginBottom: "0.5rem" }}>
                  {m.yearsExperience ? <span>{m.yearsExperience} yrs</span> : null}
                  {m.location && <span>{m.location}</span>}
                </div>
                {m.previousCompanies.length > 0 && (
                  <p style={{ fontSize: "0.75rem", color: "var(--cream-dim)" }}>
                    Previously: {m.previousCompanies.join(", ")}
                  </p>
                )}
                {m.education.length > 0 && (
                  <p style={{ fontSize: "0.75rem", color: "var(--cream-dim)" }}>
                    {m.education.join(" · ")}
                  </p>
                )}
                {m.skills.length > 0 && (
                  <div className="role-tags">
                    {m.skills.map((s) => (
                      <span key={s} className="role-tag">{s}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="page-intro" style={{ marginBottom: "1.5rem" }}>
          {lowConfidence
            ? "These are our closest automated matches — your JD is now with Spencer, who will hand-pick a stronger shortlist from the full network and reply within 24 hours."
            : "Profiles are anonymized. Want introductions, full profiles, and comp expectations? That takes one conversation."}
        </p>
        <div className="cta-group">
          <a
            href="mailto:spencer@transformertalent.com?subject=Intro%20request%20—%20matched%20candidates"
            className="cta cta-primary"
          >
            Get introductions →
          </a>
        </div>
      </div>
    );
  }

  return (
    <form className="form" onSubmit={onSubmit} style={{ width: "100%", maxWidth: 640 }}>
      <label>
        Work email
        <input name="email" type="email" required maxLength={254} autoComplete="email" />
      </label>
      <label>
        Company
        <input name="company" required maxLength={200} autoComplete="organization" />
      </label>
      <label>
        Job description
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
      <button type="submit" className="cta cta-primary" disabled={status.kind === "sending"}>
        {status.kind === "sending" ? "Matching against 400,000+ engineers…" : "Find matching talent →"}
      </button>
      {status.kind === "error" && <p className="form-status error">{status.message}</p>}
    </form>
  );
}
