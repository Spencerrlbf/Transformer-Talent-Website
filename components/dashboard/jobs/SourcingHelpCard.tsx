"use client";
// Client-side: raise a hand on this job. Turning it on tells Transformer
// Talent this role wants external help and consents to receiving screened
// profiles; turning it off withdraws the request.
import { useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";

export default function SourcingHelpCard({
  jobId,
  initial,
}: {
  jobId: string;
  initial: boolean;
}) {
  const { token } = useDash();
  const [on, setOn] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function toggle() {
    const next = !on;
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/dashboard/jobs/${jobId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sourcingRequested: next }),
      });
      if (res.ok) setOn(next);
      else setError("Couldn't save — please try again.");
    } catch {
      setError("Couldn't save — please try again.");
    }
    setSaving(false);
  }

  return (
    <>
      <div className="dash-sec">Sourcing help</div>
      <div className="shc">
        {on ? (
          <p className="shc-state on">● Transformer Talent is helping fill this role.</p>
        ) : (
          <p className="shc-state">Want help filling this role?</p>
        )}
        <small className="shc-note">
          {on
            ? "You will receive screened candidate profiles in this job's pipeline. Switch off any time to stop."
            : "Ask Transformer Talent to source for this role. You will receive screened candidate profiles in this job's pipeline."}
        </small>
        <button className="stg-editbtn" disabled={saving} onClick={toggle}>
          {saving ? "Saving…" : on ? "Stop sourcing help" : "Ask Transformer Talent to help"}
        </button>
        {error && <p className="dash-error">{error}</p>}
      </div>
    </>
  );
}
