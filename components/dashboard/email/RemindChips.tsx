"use client";
// "Remind me if no reply": Off · +2 · +3 · +5 · +7 · a date. The same control
// in the composer footer, the quick-reply box and Settings; the day it lands
// is shown beside it so nobody has to count.
import { useState } from "react";
import { REMIND_DAYS, addDays, fmtDue, reminderDue, type RemindChoice } from "@/lib/reminders";

export default function RemindChips({
  value,
  onChange,
  today,
  disabled,
  compact,
  label,
}: {
  value: RemindChoice;
  onChange: (v: RemindChoice) => void;
  today: string;
  disabled?: boolean;
  /** Quick-reply box: no label, "Date" instead of "Pick a date". */
  compact?: boolean;
  label?: string;
}) {
  const [pick, setPick] = useState(Boolean(value && "date" in value));
  const due = reminderDue(today, value);
  const days = value && "days" in value ? value.days : null;
  return (
    <span className={`rm-chips${compact ? " compact" : ""}`} role="group" aria-label="Remind me if no reply">
      <span className="rm-lbl">{label ?? (compact ? "Remind" : "Remind me if no reply")}</span>
      <button
        type="button"
        className={!value ? "on" : ""}
        disabled={disabled}
        onClick={() => {
          setPick(false);
          onChange(null);
        }}
      >
        Off
      </button>
      {REMIND_DAYS.map((d) => (
        <button
          type="button"
          key={d}
          className={days === d ? "on" : ""}
          disabled={disabled}
          onClick={() => {
            setPick(false);
            onChange({ days: d });
          }}
        >
          +{d}
        </button>
      ))}
      <button type="button" className={`rm-date${pick ? " on" : ""}`} disabled={disabled} onClick={() => setPick(true)}>
        {compact ? "Date" : "Pick a date"}
      </button>
      {pick && (
        <input
          type="date"
          min={addDays(today, 1)}
          value={value && "date" in value ? value.date : ""}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value) onChange({ date: e.target.value });
          }}
        />
      )}
      {due && <em className="rm-due">{fmtDue(due)}</em>}
    </span>
  );
}
