"use client";
// The drawer's Notes tab: typed composer (note / call / email / message —
// picking a channel seeds "Email {name}: …"), an add-task panel, and one
// timeline merging notes, task created/completed events, and the candidate's
// own "hear from me later" ask. Notes are shared across the org's seats.
import { useCallback, useEffect, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import KindIcon from "@/components/dashboard/tasks/KindIcon";

type NoteRow = { id: string; kind: string; body: string; authorEmail: string; createdAt: string };
type TaskRow = {
  id: string;
  kind: string;
  title: string;
  dueDate: string;
  dueTime: string | null;
  status: "open" | "done";
  createdByEmail: string;
  createdAt: string;
  completedAt: string | null;
};
type Data = {
  notes: NoteRow[];
  tasks: TaskRow[];
  ask: { at: string; askedAt: string | null } | null;
};

type Ev =
  | { at: string; type: "note"; note: NoteRow }
  | { at: string; type: "task_created"; task: TaskRow }
  | { at: string; type: "task_done"; task: TaskRow }
  | { at: string; type: "ask"; date: string };

const NOTE_KINDS = ["note", "call", "email", "message"] as const;
const TASK_KINDS = ["task", "call", "email"] as const;
const NOTE_LABEL: Record<string, string> = { note: "Note", call: "Call", email: "Email", message: "Message" };
const TASK_LABEL: Record<string, string> = { task: "Task", call: "Call", email: "Email" };

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
const fmtDay = (iso: string) =>
  new Date(iso.slice(0, 10) + "T12:00:00").toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  if (localDay(d) === localDay(new Date())) {
    return `Today, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
  }
  return fmtDay(iso);
};
const authorName = (email: string) => {
  const local = email.split("@")[0] || "Teammate";
  return local.charAt(0).toUpperCase() + local.slice(1);
};
// A body that is still just a channel seed gets replaced when the type changes.
const SEED_RE = /^(Call|Email|Message) [^:]{0,60}: ?$/;

export default function NotesTab({ candKey, name }: { candKey: string; name: string }) {
  const { token } = useDash();
  const first = name.split(/\s+/)[0] || name;

  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState(false);
  const [kind, setKind] = useState<string>("note");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/dashboard/candidates/v2/${candKey}/timeline`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<Data>;
      })
      .then((d) => {
        setData(d);
        setError(false);
      })
      .catch(() => setError(true));
  }, [candKey, token]);

  useEffect(() => {
    setData(null);
    setKind("note");
    setBody("");
    setPanelOpen(false);
    setSaveErr("");
    load();
  }, [load]);

  function pickKind(k: string) {
    setKind(k);
    if (body.trim() === "" || SEED_RE.test(body)) {
      setBody(k === "note" ? "" : `${NOTE_LABEL[k]} ${first}: `);
    }
  }

  async function saveNote() {
    if (!body.trim() || saving) return;
    setSaving(true);
    setSaveErr("");
    const res = await fetch(`/api/dashboard/candidates/v2/${candKey}/timeline`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind, body }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    setSaving(false);
    if (res?.ok && json.note && data) {
      setData({ ...data, notes: [json.note as NoteRow, ...data.notes] });
      setBody("");
      setKind("note");
    } else {
      setSaveErr(json.error || "Couldn't save the note. Try again.");
    }
  }

  const events: Ev[] = data
    ? [
        ...data.notes.map((n): Ev => ({ at: n.createdAt, type: "note", note: n })),
        ...data.tasks.map((t): Ev => ({ at: t.createdAt, type: "task_created", task: t })),
        ...data.tasks
          .filter((t) => t.completedAt)
          .map((t): Ev => ({ at: t.completedAt!, type: "task_done", task: t })),
        ...(data.ask && data.ask.askedAt
          ? [{ at: data.ask.askedAt, type: "ask", date: data.ask.at } as Ev]
          : []),
      ].sort((a, b) => b.at.localeCompare(a.at))
    : [];

  return (
    <div className="cv2n">
      <div className="cv2n-composer">
        <div className="cv2n-kinds">
          {NOTE_KINDS.map((k) => (
            <button key={k} className={kind === k ? "on" : ""} onClick={() => pickKind(k)}>
              <KindIcon kind={k} className="tk-ico" />
              {NOTE_LABEL[k]}
            </button>
          ))}
          <button className="cv2n-addtask" onClick={() => setPanelOpen(!panelOpen)}>
            {panelOpen ? "Close" : "+ Add task"}
          </button>
        </div>
        <textarea
          placeholder={`Add a note about ${first}…`}
          value={body}
          maxLength={4000}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") saveNote();
          }}
        />
        <div className="cv2n-bar">
          <span>Shared with your team · ⌘↵ to save</span>
          <button className="cv2n-save" disabled={saving || !body.trim()} onClick={saveNote}>
            {saving ? "Saving…" : "SAVE NOTE"}
          </button>
        </div>
        {saveErr && <p className="cv2d-err">{saveErr}</p>}
      </div>

      {panelOpen && (
        <AddTaskPanel
          candKey={candKey}
          name={name}
          first={first}
          token={token}
          onCreated={() => {
            setPanelOpen(false);
            load();
          }}
        />
      )}

      {error && <p className="cv2d-err">Couldn&apos;t load the timeline. Reopen to try again.</p>}
      {!data && !error && <p className="dash-muted" style={{ padding: "14px 2px" }}>Loading…</p>}
      {data && events.length === 0 && (
        <p className="cv2n-empty">No notes yet. What you write here is only visible to your team.</p>
      )}

      <div className="cv2n-tl">
        {events.map((ev, i) => {
          if (ev.type === "note") {
            const n = ev.note;
            return (
              <div className="cv2n-ev" key={`n${n.id}`}>
                <span className="av">{authorName(n.authorEmail)[0]}</span>
                <div className="b">
                  <div className="m">
                    <b>
                      {n.kind !== "note" && <KindIcon kind={n.kind} className="tk-ico tk-kind" />}
                      {n.kind === "note" ? authorName(n.authorEmail) : `${NOTE_LABEL[n.kind]} · ${authorName(n.authorEmail)}`}
                    </b>
                    <span>{fmtWhen(n.createdAt)}</span>
                  </div>
                  <p>{n.body}</p>
                </div>
              </div>
            );
          }
          if (ev.type === "task_created" || ev.type === "task_done") {
            const t = ev.task;
            const done = ev.type === "task_done";
            return (
              <div className="cv2n-ev" key={`t${t.id}${done ? "d" : "c"}`}>
                <span className={`av sys${done ? " pos" : ""}`}>
                  <KindIcon kind={done ? "task" : t.kind === "task" ? "task" : t.kind} className="tk-ico" />
                </span>
                <div className="b">
                  <div className="m">
                    <b>{done ? "Task completed" : "Task created"}</b>
                    <span>
                      by {authorName(t.createdByEmail)} · {fmtWhen(ev.at)}
                    </span>
                  </div>
                  <p className="sys">
                    {t.title}
                    {!done && (
                      <span className="cv2n-due">
                        due {fmtDay(t.dueDate)}
                        {t.dueTime ? ` · ${t.dueTime}` : ""}
                      </span>
                    )}
                  </p>
                </div>
              </div>
            );
          }
          return (
            <div className="cv2n-ev" key={`ask${i}`}>
              <span className="av sys">
                <KindIcon kind="request" className="tk-ico" />
              </span>
              <div className="b">
                <div className="m">
                  <b>Candidate request</b>
                  <span>{fmtWhen(ev.at)}</span>
                </div>
                <p className="sys">
                  Asked to hear from you later
                  <span className="cv2n-due">follow up {fmtDay(ev.date)}</span>
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AddTaskPanel({
  candKey,
  name,
  first,
  token,
  onCreated,
}: {
  candKey: string;
  name: string;
  first: string;
  token: string;
  onCreated: () => void;
}) {
  const [kind, setKind] = useState("task");
  const [date, setDate] = useState(addDays(7));
  const [time, setTime] = useState("");
  const [title, setTitle] = useState(`Follow up with ${first}`);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const defaultTitle = (k: string) =>
    k === "call" ? `Call ${first}` : k === "email" ? `Email ${first}` : `Follow up with ${first}`;

  function pickKind(k: string) {
    const wasDefault = TASK_KINDS.some((x) => title === defaultTitle(x));
    setKind(k);
    if (!title.trim() || wasDefault) setTitle(defaultTitle(k));
  }

  const quick: [string, string][] = [
    ["1 day", addDays(1)],
    ["1 week", addDays(7)],
    ["1 month", addMonths(1)],
    ["3 months", addMonths(3)],
    ["6 months", addMonths(6)],
  ];

  async function create() {
    if (saving) return;
    setSaving(true);
    setErr("");
    const res = await fetch("/api/dashboard/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        candidateKey: candKey,
        candidateName: name,
        kind,
        title,
        dueDate: date,
        dueTime: time || null,
      }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    setSaving(false);
    if (res?.ok) onCreated();
    else setErr(json.error || "Couldn't save the task. Try again.");
  }

  return (
    <div className="cv2n-task">
      <h4>Add task for {first}</h4>
      <p className="sub">Create a task for this candidate and get it into your Tasks tab.</p>

      <div className="lbl">Type</div>
      <div className="cv2n-kinds">
        {TASK_KINDS.map((k) => (
          <button key={k} className={kind === k ? "on" : ""} onClick={() => pickKind(k)}>
            <KindIcon kind={k} className="tk-ico" />
            {TASK_LABEL[k]}
          </button>
        ))}
      </div>

      <div className="cv2n-duo">
        <label>
          <span className="lbl">Due date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          <span className="lbl">Time · optional</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>

      <div className="lbl">Quick select</div>
      <div className="tk-chips">
        {quick.map(([label, d]) => (
          <button key={label} className={d === date ? "on" : ""} onClick={() => setDate(d)}>
            {label}
          </button>
        ))}
      </div>

      <div className="lbl">Task</div>
      <textarea value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />

      {err && <p className="cv2d-err">{err}</p>}
      <button className="cv2n-create" disabled={saving || !title.trim()} onClick={create}>
        {saving ? "SAVING…" : "ADD TASK →"}
      </button>
      <p className="note">The task lands in your Tasks tab and on {first}&apos;s timeline.</p>
    </div>
  );
}
