"use client";
// The drawer's Notes tab: one timeline merging notes, task created/completed
// events, and the candidate's own "hear from me later" ask. Notes and tasks
// are created and edited in modals (NoteModal / TaskModal); Edit shows on
// your own notes (author-only, server-enforced) and on every task event.
import { useCallback, useEffect, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import KindIcon from "@/components/dashboard/tasks/KindIcon";
import NoteModal, { type NoteModalTarget } from "@/components/dashboard/tasks/NoteModal";
import TaskModal, { type TaskModalTarget } from "@/components/dashboard/tasks/TaskModal";
import EmailModal from "@/components/dashboard/email/EmailModal";

type NoteRow = {
  id: string;
  kind: string;
  body: string;
  authorEmail: string;
  createdAt: string;
  updatedAt: string | null;
};
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
type EmailRow = {
  id: string;
  direction: "out" | "in";
  memberEmail: string;
  address: string;
  subject: string;
  snippet: string;
  bodyHtml: string | null;
  createdAt: string;
};
type Data = {
  notes: NoteRow[];
  tasks: TaskRow[];
  ask: { at: string; askedAt: string | null } | null;
  emails?: EmailRow[];
};

type Ev =
  | { at: string; type: "note"; note: NoteRow }
  | { at: string; type: "task_created"; task: TaskRow }
  | { at: string; type: "task_done"; task: TaskRow }
  | { at: string; type: "ask"; date: string }
  | { at: string; type: "email"; email: EmailRow };

const NOTE_LABEL: Record<string, string> = { note: "Note", call: "Call", email: "Email", message: "Message" };

const localDay = (d: Date) => d.toLocaleDateString("en-CA");
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

export default function NotesTab({ candKey, name }: { candKey: string; name: string }) {
  const { token, email } = useDash();
  const first = name.split(/\s+/)[0] || name;

  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState(false);
  const [noteModal, setNoteModal] = useState<NoteModalTarget | null>(null);
  const [taskModal, setTaskModal] = useState<TaskModalTarget | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailView, setEmailView] = useState<string | null>(null);

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
    setNoteModal(null);
    setTaskModal(null);
    setEmailOpen(false);
    setEmailView(null);
    load();
  }, [load]);

  const events: Ev[] = data
    ? [
        ...data.notes.map((n): Ev => ({ at: n.createdAt, type: "note", note: n })),
        ...(data.emails || []).map((e): Ev => ({ at: e.createdAt, type: "email", email: e })),
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
      <div className="cv2n-actions">
        <button
          className="cv2n-newbtn primary"
          onClick={() => setNoteModal({ mode: "create", candidateKey: candKey, candidateName: name })}
        >
          + Add note
        </button>
        <button
          className="cv2n-newbtn"
          onClick={() => setTaskModal({ mode: "create", candidateKey: candKey, candidateName: name })}
        >
          + Add task
        </button>
        <button className="cv2n-newbtn" onClick={() => setEmailOpen(true)}>
          ✉ Send email
        </button>
        <span className="cv2n-hint">Notes are shared with your team; tasks land in your Tasks tab.</span>
      </div>

      {error && <p className="cv2d-err">Couldn&apos;t load the timeline. Reopen to try again.</p>}
      {!data && !error && <p className="dash-muted" style={{ padding: "14px 2px" }}>Loading…</p>}
      {data && events.length === 0 && (
        <p className="cv2n-empty">No notes yet. Add the first note about {first}.</p>
      )}

      <div className="cv2n-tl">
        {events.map((ev, i) => {
          if (ev.type === "note") {
            const n = ev.note;
            const mine = n.authorEmail === email;
            return (
              <div className="cv2n-ev" key={`n${n.id}`}>
                <span className="av">{authorName(n.authorEmail)[0]}</span>
                <div className="b">
                  <div className="m">
                    <b>
                      {n.kind !== "note" && <KindIcon kind={n.kind} className="tk-ico tk-kind" />}
                      {n.kind === "note"
                        ? authorName(n.authorEmail)
                        : `${NOTE_LABEL[n.kind]} · ${authorName(n.authorEmail)}`}
                    </b>
                    <span>{fmtWhen(n.createdAt)}</span>
                    {n.updatedAt && <span className="cv2n-edited">edited</span>}
                    {mine && (
                      <button
                        className="cv2n-edit"
                        onClick={() =>
                          setNoteModal({
                            mode: "edit",
                            candidateName: name,
                            note: { id: n.id, kind: n.kind, body: n.body },
                          })
                        }
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  <p>{n.body}</p>
                </div>
              </div>
            );
          }
          if (ev.type === "email") {
            const e = ev.email;
            const out = e.direction === "out";
            const open = emailView === e.id;
            const expandable = out ? Boolean(e.bodyHtml) : e.snippet.length > 0;
            return (
              <div className="cv2n-ev" key={`e${e.id}`}>
                <span className={`av ${out ? "mail" : "rin"}`}>{out ? "✉" : "↩"}</span>
                <div className="b">
                  <div className="m">
                    <b>{out ? `Email · ${authorName(e.memberEmail)}` : `${first} replied`}</b>
                    <span>{out ? "sent" : `to ${authorName(e.memberEmail)}`} · {fmtWhen(e.createdAt)}</span>
                    {expandable && (
                      <button className="cv2n-edit" onClick={() => setEmailView(open ? null : e.id)}>
                        {open ? "Hide" : "View"}
                      </button>
                    )}
                  </div>
                  {e.subject && <p className="cv2n-mailsubj">{e.subject}</p>}
                  {!open && e.snippet && <p className="cv2n-mailsnip">{e.snippet}</p>}
                  {open &&
                    (out && e.bodyHtml ? (
                      // Sanitized server-side at write time (rebuild-only
                      // allowlist); replies are never stored as HTML.
                      <div className="cv2n-mailbody" dangerouslySetInnerHTML={{ __html: e.bodyHtml }} />
                    ) : (
                      <div className="cv2n-mailbody">{e.snippet}</div>
                    ))}
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
                  <KindIcon kind={done ? "task" : t.kind} className="tk-ico" />
                </span>
                <div className="b">
                  <div className="m">
                    <b>{done ? "Task completed" : "Task created"}</b>
                    <span>
                      by {authorName(t.createdByEmail)} · {fmtWhen(ev.at)}
                    </span>
                    <button
                      className="cv2n-edit"
                      onClick={() =>
                        setTaskModal({
                          mode: "edit",
                          task: {
                            id: t.id,
                            kind: t.kind,
                            title: t.title,
                            dueDate: t.dueDate,
                            dueTime: t.dueTime,
                            candidateName: name,
                          },
                        })
                      }
                    >
                      Edit
                    </button>
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

      {noteModal && (
        <NoteModal target={noteModal} onClose={() => setNoteModal(null)} onChanged={load} />
      )}
      {taskModal && (
        <TaskModal target={taskModal} onClose={() => setTaskModal(null)} onChanged={load} />
      )}
      {emailOpen && (
        <EmailModal
          candKey={candKey}
          candidateName={name}
          onClose={() => setEmailOpen(false)}
          onSent={load}
        />
      )}
    </div>
  );
}
