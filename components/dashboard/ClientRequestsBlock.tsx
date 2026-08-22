"use client";
// TT Jobs page: client jobs whose owners asked for sourcing help. One click
// copies the client's job (their JD, skills and all) into TT's jobs and
// links it, so sends land in their pipeline.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useDash } from "@/components/dashboard/DashShell";

type Request = {
  orgId: string;
  orgName: string;
  jobId: string;
  title: string;
  requestedAt: string | null;
  linkedTo: { id: string; title: string } | null;
};

const ago = (iso: string | null): string => {
  if (!iso) return "";
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3600000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

export default function ClientRequestsBlock({ onCopied }: { onCopied: () => void }) {
  const { org, token } = useDash();
  const [requests, setRequests] = useState<Request[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    fetch("/api/dashboard/client-requests", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => setRequests(d?.requests ?? []))
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    if (org.slug === "transformer-talent") load();
  }, [org.slug, load]);

  if (org.slug !== "transformer-talent" || requests.length === 0) return null;

  async function copy(r: Request) {
    setBusy(`${r.orgId}|${r.jobId}`);
    setError("");
    try {
      const res = await fetch("/api/dashboard/client-requests", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: r.orgId, jobId: r.jobId }),
      });
      if (res.ok) {
        load();
        onCopied();
      } else {
        setError("Couldn't copy that job — please try again.");
      }
    } catch {
      setError("Couldn't copy that job — please try again.");
    }
    setBusy("");
  }

  return (
    <div className="crq">
      <div className="crq-head">
        <b>Client requests</b>
        <span>{requests.length}</span>
      </div>
      {requests.map((r) => (
        <div key={`${r.orgId}|${r.jobId}`} className="crq-row">
          <div className="crq-info">
            <b>{r.orgName}</b> · {r.title} <em>#{r.jobId}</em>
            <small>asked for sourcing help {ago(r.requestedAt)}</small>
          </div>
          {r.linkedTo ? (
            <Link className="crq-linked" href={`/dashboard/jobs/${r.linkedTo.id}`}>
              ⚡ Linked to your #{r.linkedTo.id} →
            </Link>
          ) : (
            <button
              className="dash-btn"
              disabled={busy === `${r.orgId}|${r.jobId}`}
              onClick={() => copy(r)}
            >
              {busy === `${r.orgId}|${r.jobId}` ? "Copying…" : "Copy to my jobs & link"}
            </button>
          )}
        </div>
      ))}
      {error && <p className="dash-error">{error}</p>}
    </div>
  );
}
