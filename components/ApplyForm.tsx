"use client";

import { useState } from "react";

type Status = { kind: "idle" | "sending" | "ok" | "error"; message?: string };

export default function ApplyForm({ defaultRole }: { defaultRole?: string }) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    setStatus({ kind: "sending" });
    try {
      const res = await fetch("/api/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        form.reset();
        setStatus({
          kind: "ok",
          message:
            "Got it — we'll be in touch if there's a fit with anything we're working on.",
        });
      } else {
        setStatus({
          kind: "error",
          message: json.error || "Something went wrong — please try again.",
        });
      }
    } catch {
      setStatus({
        kind: "error",
        message: "Network error — please try again.",
      });
    }
  }

  return (
    <form className="form" onSubmit={onSubmit}>
      <label>
        Name
        <input name="name" required maxLength={120} autoComplete="name" />
      </label>
      <label>
        Email
        <input
          name="email"
          type="email"
          required
          maxLength={254}
          autoComplete="email"
        />
      </label>
      <label>
        LinkedIn URL
        <input
          name="linkedin"
          type="url"
          placeholder="https://linkedin.com/in/…"
          maxLength={300}
        />
      </label>
      <label>
        Role you&apos;re interested in
        <input
          name="role"
          defaultValue={defaultRole}
          placeholder="e.g. Backend/Infra Engineer — or leave blank"
          maxLength={120}
        />
      </label>
      <label>
        Anything else
        <textarea
          name="note"
          rows={4}
          maxLength={2000}
          placeholder="Current situation, what you're looking for, comp expectations…"
        />
      </label>
      {/* Honeypot — hidden from real users */}
      <input
        name="website"
        tabIndex={-1}
        autoComplete="off"
        style={{ position: "absolute", left: "-9999px" }}
        aria-hidden="true"
      />
      <button
        type="submit"
        className="btn hot"
        disabled={status.kind === "sending"}
      >
        {status.kind === "sending" ? "SENDING…" : "SUBMIT →"}
      </button>
      {(status.kind === "ok" || status.kind === "error") && (
        <p className={`form-status ${status.kind}`}>{status.message}</p>
      )}
    </form>
  );
}
