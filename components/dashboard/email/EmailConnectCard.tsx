"use client";
// The seat's own email connection, shown on the Team page for every member
// (the rest of that page is owner-only; this card is each seat's own).
// Connecting here is the same hosted-OAuth flow the compose modal starts.
import { useCallback, useEffect, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";

type Status = { connected: boolean; address: string; provider: string };

export default function EmailConnectCard() {
  const { token } = useDash();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(() => {
    fetch("/api/dashboard/email/account", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? (r.json() as Promise<Status>) : null))
      .then((s) => {
        if (s) setStatus(s);
      })
      .catch(() => {});
  }, [token]);
  useEffect(load, [load]);

  const connect = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/dashboard/email/connect", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = (await r.json()) as { url?: string };
      if (j.url) {
        window.location.href = j.url;
        return;
      }
    } catch {
      /* fall through */
    }
    setBusy(false);
  };

  const disconnect = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    await fetch("/api/dashboard/email/account", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
    setBusy(false);
    setConfirming(false);
    load();
  };

  if (!status) return null;

  return (
    <div className="em-card">
      <span className="lbl" style={{ margin: 0 }}>
        Email sending
      </span>
      {status.connected ? (
        <div className="em-cardrow">
          <span className="em-cardstat">
            <i className="em-dot" /> Connected — <b>{status.address}</b>
            {status.provider ? ` (${status.provider})` : ""} · emails you send from candidate
            profiles go out from this address, and candidate replies land in their timelines.
          </span>
          <button className="tk-doneb" onClick={disconnect} disabled={busy}>
            {confirming ? "Really disconnect?" : "Disconnect"}
          </button>
        </div>
      ) : (
        <div className="em-cardrow">
          <span className="em-cardstat">
            Connect your own Gmail or Outlook to email candidates from inside the dashboard —
            sends come from your real address and replies are logged to the timeline.
          </span>
          <button className="dash-btn" onClick={connect} disabled={busy}>
            {busy ? "Opening…" : "Connect email"}
          </button>
        </div>
      )}
    </div>
  );
}
