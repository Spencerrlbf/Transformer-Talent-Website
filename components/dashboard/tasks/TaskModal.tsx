"use client";
// One task modal for the whole product: create (from the drawer) and edit
// (from a Tasks-page row or a timeline event), with delete. Opens above the
// drawer, so its Escape swallows the event before the drawer's handler.
import { useEffect, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import KindIcon from "@/components/dashboard/tasks/KindIcon";

export type TaskModalTarget =
  | { mode: "create"; candidateKey: string; candidateName: string }
  | {
      mode: "edit";
      task: { id: string; kind: string; title: string; dueDate: string; dueTime: string | null; candidateName: string };
    }
  // A candidate's own "hear from me later" ask: only its date is edited here
  // (their preferences live in the drawer's ask panel); "Mark contacted"
  // clears it, same as the row's Done.
  | { mode: "request"; candidateKey: string; candidateName: string; dueDate: string };

const TASK_KINDS = ["task", "call", "email", "message"] as const;
const TASK_LABEL: Record<string, string> = { task: "Task", call: "Call", email: "Email", message: "Message" };

const localDay = (d: Date) => d.toLocaleDateString("en-CA");
const addDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localDay(d);
};
const addMonths = (n: number) => {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return localDay(d);
};

export default function TaskModal({
  target,
  onClose,
  onChanged,
}: {
  target: TaskModalTarget;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { token } = useDash();
  const creating = target.mode === "create";
  const isRequest = target.mode === "request";
  const name = target.mode === "edit" ? target.task.candidateName : target.candidateName;
  const first = name.split(/\s+/)[0] || name || "them";

  const defaultTitle = (k: string) =>
    k === "call"
      ? `Call ${first}`
      : k === "email"
        ? `Email ${first}`
        : k === "message"
          ? `Message ${first} on LinkedIn`
          : `Follow up with ${first}`;

  const [kind, setKind] = useState(target.mode === "edit" ? target.task.kind : "task");
  const [title, setTitle] = useState(target.mode === "edit" ? target.task.title : defaultTitle("task"));
  const [date, setDate] = useState(
    target.mode === "create" ? addDays(7) : target.mode === "edit" ? target.task.dueDate : target.dueDate
  );
  const [time, setTime] = useState(target.mode === "edit" ? target.task.dueTime || "" : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // Above the drawer: swallow Escape before the drawer's document handler.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", h, true);
    return () => document.removeEventListener("keydown", h, true);
  }, [onClose]);

  function pickKind(k: string) {
    const wasDefault = TASK_KINDS.some((x) => title === defaultTitle(x)) || !title.trim();
    setKind(k);
    if (wasDefault) setTitle(defaultTitle(k));
  }

  const quick: [string, string][] = [
    ["1 day", addDays(1)],
    ["1 week", addDays(7)],
    ["1 month", addMonths(1)],
    ["3 months", addMonths(3)],
    ["6 months", addMonths(6)],
  ];

  async function save() {
    if (saving || (!isRequest && !title.trim())) return;
    setSaving(true);
    setErr("");
    if (isRequest) {
      const res = await fetch(`/api/dashboard/candidates/v2/${target.candidateKey}/followup`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ dateOnly: true, at: date }),
      }).catch(() => null);
      const json = res ? await res.json().catch(() => ({})) : {};
      setSaving(false);
      if (res?.ok) {
        onChanged();
        onClose();
      } else {
        setErr(json.error === "bad_date" ? "Pick a date." : "Couldn't save. Try again.");
      }
      return;
    }
    const res = creating
      ? await fetch("/api/dashboard/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            candidateKey: target.candidateKey,
            candidateName: name,
            kind,
            title,
            dueDate: date,
            dueTime: time || null,
          }),
        }).catch(() => null)
      : await fetch(`/api/dashboard/tasks/${target.task.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ kind, title, dueDate: date, dueTime: time || null }),
        }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    setSaving(false);
    if (res?.ok) {
      onChanged();
      onClose();
    } else {
      setErr(json.error || "Couldn't save. Try again.");
    }
  }

  async function remove() {
    if (saving || target.mode !== "edit") return;
    setSaving(true);
    setErr("");
    const res = await fetch(`/api/dashboard/tasks/${target.task.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    setSaving(false);
    if (res?.ok) {
      onChanged();
      onClose();
    } else {
      setErr("Couldn't delete. Try again.");
    }
  }

  // Request rows only: "Mark contacted" clears the ask, same as Done.
  async function markContacted() {
    if (saving || target.mode !== "request") return;
    setSaving(true);
    setErr("");
    const res = await fetch(`/api/dashboard/candidates/v2/${target.candidateKey}/followup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    setSaving(false);
    if (res?.ok) {
      onChanged();
      onClose();
    } else {
      setErr("Couldn't save. Try again.");
    }
  }

  return (
    <div className="tkm-back" onClick={onClose}>
      <div className="tkm" onClick={(e) => e.stopPropagation()}>
        <h3>
          {isRequest ? "Edit follow-up" : creating ? `Add task for ${first}` : "Edit task"}
        </h3>
        <p className="tkm-sub">
          {isRequest
            ? `${name} asked to hear from you later. Move the date here; their full ask (roles, salary, visa) is in their profile.`
            : creating
              ? "Create a task for this candidate; it shows in your Inbox on its due day."
              : `On ${name}'s timeline and in your Inbox on its due day.`}
        </p>

        {!isRequest && (
          <>
            <div className="lbl">Type</div>
            <div className="cv2n-kinds">
              {TASK_KINDS.map((k) => (
                <button key={k} className={kind === k ? "on" : ""} onClick={() => pickKind(k)}>
                  <KindIcon kind={k} className="tk-ico" />
                  {TASK_LABEL[k]}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="cv2n-duo">
          <label>
            <span className="lbl">{isRequest ? "Reach out on" : "Due date"}</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          {!isRequest && (
            <label>
              <span className="lbl">Time · optional</span>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
          )}
        </div>

        <div className="lbl">Quick select</div>
        <div className="tk-chips">
          {quick.map(([label, d]) => (
            <button key={label} className={d === date ? "on" : ""} onClick={() => setDate(d)}>
              {label}
            </button>
          ))}
        </div>

        {!isRequest && (
          <>
            <div className="lbl">Task</div>
            <textarea
              className="tkm-text"
              value={title}
              maxLength={300}
              onChange={(e) => setTitle(e.target.value)}
            />
          </>
        )}

        {err && <p className="cv2d-err">{err}</p>}
        <div className="tkm-foot">
          {target.mode === "edit" && (
            <button className="tkm-del" disabled={saving} onClick={remove}>
              Delete task
            </button>
          )}
          {isRequest && (
            <button className="tkm-markc" disabled={saving} onClick={markContacted}>
              ✓ Mark contacted
            </button>
          )}
          <button className="tkm-cancel" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button
            className="tkm-save"
            disabled={saving || (!isRequest && !title.trim())}
            onClick={save}
          >
            {saving ? "SAVING…" : creating ? "ADD TASK →" : "SAVE"}
          </button>
        </div>
      </div>
    </div>
  );
}
