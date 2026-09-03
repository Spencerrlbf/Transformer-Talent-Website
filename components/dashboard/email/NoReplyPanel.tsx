"use client";
// "Mark no reply": the small panel behind the No reply button. Never sends
// an email. Check back never, in 2 / 4 / 8 weeks, or on a date.
import { useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import { addDays, fmtDue, localDay, rollWeekend } from "@/lib/reminders";

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
      <span className="nr-go">
        <button type="button" className="ibs-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="ibs-btn pri" onClick={confirm} disabled={busy}>
          {busy ? "Saving…" : "Confirm"}
        </button>
      </span>
      <p className="nr-fine">
        No email goes out. {first} is marked no reply{jobTitle ? ` and moves to Past on ${jobTitle}` : ""}.
        {due ? ` "Check back with ${first}" lands in your Inbox on ${fmtDue(due)}.` : " Without a check-back they stay there unless they reply."}
      </p>
      {err && <p className="em-warn">{err}</p>}
    </div>
  );
}
