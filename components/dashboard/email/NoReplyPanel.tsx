"use client";
// "Mark no reply": the small panel behind the No reply button. Never sends
// an email. Check back never, in 2 / 4 / 8 weeks, or on a date. Nothing is
// written until Mark no reply is pressed; the fine print says what that does.
import { useEffect, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import { addDays, fmtDue, localDay, rollWeekend } from "@/lib/reminders";

/** Undo a mark made by mistake: DELETE on the same route. Nothing is sent. */
export async function undoNoReplyRequest(token: string, candKey: string): Promise<{ ok: boolean; restoredLabel: string | null; reopened: number }> {
  const r = await fetch(`/api/dashboard/candidates/v2/${candKey}/no-reply`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);
  const j = ((await r?.json().catch(() => ({}))) || {}) as { ok?: boolean; restoredLabel?: string | null; reopened?: number };
  return { ok: Boolean(r?.ok && j.ok), restoredLabel: j.restoredLabel ?? null, reopened: j.reopened ?? 0 };
}

const CHOICES: [string, string][] = [
  ["never", "Never"],
  ["2", "2 weeks"],
  ["4", "4 weeks"],
  ["8", "8 weeks"],
];

export default function NoReplyPanel({
  candKey,
  first,
  threadId,
  jobId,
  jobTitle,
  subject,
  onDone,
  onCancel,
}: {
  candKey: string;
  first: string;
  threadId?: string | null;
  jobId?: string | null;
  jobTitle?: string | null;
  subject?: string | null;
  onDone: (r: { checkBack: string | null; staged: boolean }) => void;
  onCancel: () => void;
}) {
  const { token } = useDash();
  const [choice, setChoice] = useState<string>("never");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // The role this moves them on. Callers that know the title pass it; the
  // rest pass only the id, so look the title up rather than leave it unnamed.
  const [role, setRole] = useState(jobTitle || "");
  useEffect(() => {
    if (jobTitle || !jobId) return;
    let live = true;
    fetch(`/api/dashboard/jobs/${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? ((await r.json()) as { job?: { title?: string } }) : null))
      .then((d) => {
        if (live && d?.job?.title) setRole(d.job.title);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [jobId, jobTitle, token]);

  const today = localDay();
  const due =
    choice === "never"
      ? null
      : choice === "pick"
        ? date && date > today
          ? rollWeekend(date)
          : null
        : rollWeekend(addDays(today, Number(choice) * 7));

  const confirm = async () => {
    if (busy) return;
    if (choice !== "never" && !due) {
      setErr("Pick a day after today.");
      return;
    }
    setBusy(true);
    setErr("");
    const r = await fetch(`/api/dashboard/candidates/v2/${candKey}/no-reply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: threadId || null, jobId: jobId || null, subject: subject || null, checkBack: due }),
    }).catch(() => null);
    const j = ((await r?.json().catch(() => ({}))) || {}) as { ok?: boolean; staged?: boolean };
    setBusy(false);
    if (r?.ok && j.ok) onDone({ checkBack: due, staged: Boolean(j.staged) });
    else setErr("Couldn't save that. Nothing changed; try again.");
  };

  const moves = jobId ? ` and moves to Past${role ? ` on ${role}` : ""}` : "";

  return (
    <div className="nr-panel" role="group" aria-label="Mark no reply">
      <b>Mark no reply</b>
      <span className="rm-chips">
        <span className="rm-lbl">Check back:</span>
        {CHOICES.map(([v, label]) => (
          <button type="button" key={v} className={choice === v ? "on" : ""} disabled={busy} onClick={() => setChoice(v)}>
            {label}
          </button>
        ))}
        <button type="button" className={`rm-date${choice === "pick" ? " on" : ""}`} disabled={busy} onClick={() => setChoice("pick")}>
          Pick a date
        </button>
        {choice === "pick" && (
          <input type="date" min={addDays(today, 1)} value={date} disabled={busy} onChange={(e) => setDate(e.target.value)} />
        )}
        {due && <em className="rm-due">{fmtDue(due)}</em>}
      </span>
      <p className="nr-fine">
        <b>When you press Mark no reply:</b> no email goes out. {first} is marked no reply{moves}.
        {due ? ` "Check back with ${first}" lands in your Inbox on ${fmtDue(due)}.` : " Without a check-back, nothing comes back to you unless they reply."}
      </p>
      <span className="nr-go">
        <button type="button" className="ibs-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="ibs-btn pri" onClick={confirm} disabled={busy}>
          {busy ? "Saving…" : "Mark no reply"}
        </button>
      </span>
      {err && <p className="em-warn">{err}</p>}
    </div>
  );
}
