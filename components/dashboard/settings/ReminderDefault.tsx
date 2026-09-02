"use client";
// Settings: the seat's default for "remind me if no reply". Saved on click;
// the shell refetches /me so the next composer opens with it.
import { useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import { REMIND_DAYS } from "@/lib/reminders";

export default function ReminderDefault() {
  const { token, reminderDays } = useDash();
  const [days, setDays] = useState(reminderDays);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const pick = async (d: number) => {
    if (saving || d === days) return;
    setSaving(true);
    setErr("");
    const r = await fetch("/api/dashboard/me", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reminderDays: d }),
    }).catch(() => null);
    setSaving(false);
    if (r?.ok) {
      setDays(d);
      window.dispatchEvent(new Event("tt-me-changed"));
    } else {
      setErr("Couldn't save. Try again.");
    }
  };

  return (
    <div className="rm-chips set-chips" role="group" aria-label="Default reply reminder">
      <span className="rm-lbl">Remind me if no reply</span>
      <button type="button" className={days === 0 ? "on" : ""} disabled={saving} onClick={() => pick(0)}>
        Off
      </button>
      {REMIND_DAYS.map((d) => (
        <button type="button" key={d} className={days === d ? "on" : ""} disabled={saving} onClick={() => pick(d)}>
          +{d}
        </button>
      ))}
      <em className="rm-due">{days ? `${days} days after you send` : "only when you pick one on an email"}</em>
      {err && <span className="rm-err">{err}</span>}
    </div>
  );
}
