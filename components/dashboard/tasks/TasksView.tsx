"use client";
// The Tasks page: open tasks grouped by due day (overdue first), a Done view,
// and candidate-requested follow-ups folded in as "Candidate request" rows.
// Clicking a task row (or its Edit button) opens the shared TaskModal —
// retitle, retype, reschedule, delete. A request's date belongs to the
// candidate's ask, so its row opens the drawer instead.
import { useCallback, useEffect, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import KindIcon from "@/components/dashboard/tasks/KindIcon";
import TaskModal, { type TaskModalTarget } from "@/components/dashboard/tasks/TaskModal";

type TaskRow = {
  id: string;
  candidateKey: string | null;
  candidateName: string;
  kind: string;
  title: string;
  dueDate: string;
  dueTime: string | null;
  status: "open" | "done";
  createdByEmail: string;
  createdAt: string;
  completedAt: string | null;
};
type RequestRow = { candidateKey: string; candidateName: string; dueDate: string };
type Data = { tasks: TaskRow[]; done: TaskRow[]; requests: RequestRow[] };

type Entry = {
  id: string;
  isRequest: boolean;
  candidateKey: string | null;
  candidateName: string;
  kind: string;
  title: string;
  dueDate: string;
  dueTime: string | null;
};

type Seg = "today" | "week" | "open" | "done";

const localDay = (d: Date) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD
const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return localDay(d);
};
const fmtDay = (iso: string) => {
  const d = new Date(iso + "T12:00:00");
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
};
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("") || "?";

export default function TasksView({
  reloadNonce,
  onOpenCandidate,
}: {
  reloadNonce: number;
  onOpenCandidate: (key: string) => void;
}) {
  const { token } = useDash();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState(false);
  const [seg, setSeg] = useState<Seg>("today");
  const [busy, setBusy] = useState<string | null>(null);
  const [taskModal, setTaskModal] = useState<TaskModalTarget | null>(null);

  const load = useCallback(() => {
    fetch("/api/dashboard/tasks", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<Data>;
      })
      .then((d) => {
        setData(d);
        setError(false);
      })
      .catch(() => setError(true));
  }, [token]);

  useEffect(load, [load, reloadNonce]);

  const today = localDay(new Date());
  // "This week" = the next 7 days inclusive, so a "1 week" quick-select task
  // still shows up in the view that created it.
  const weekEnd = addDays(today, 7);

  const entries: Entry[] = data
    ? [
        ...data.tasks.map((t) => ({
          id: t.id,
          isRequest: false,
          candidateKey: t.candidateKey,
          candidateName: t.candidateName,
          kind: t.kind,
          title: t.title,
          dueDate: t.dueDate,
          dueTime: t.dueTime,
        })),
        ...data.requests.map((r) => ({
          id: `req_${r.candidateKey}`,
          isRequest: true,
          candidateKey: r.candidateKey,
          candidateName: r.candidateName,
          kind: "request",
          title: "Asked to hear from you later",
          dueDate: r.dueDate,
          dueTime: null,
        })),
      ]
    : [];

  const overdue = entries.filter((e) => e.dueDate < today);
  const openCount = entries.length;
  const todayCount = entries.filter((e) => e.dueDate <= today).length;
  const weekCount = entries.filter((e) => e.dueDate <= weekEnd).length;

  const visible =
    seg === "today"
      ? entries.filter((e) => e.dueDate <= today)
      : seg === "week"
        ? entries.filter((e) => e.dueDate <= weekEnd)
        : entries;

  // Group by day, overdue first as one group.
  const groups: { label: string; overdue: boolean; items: Entry[] }[] = [];
  if (seg !== "done") {
    const od = visible.filter((e) => e.dueDate < today);
    if (od.length) groups.push({ label: "Overdue", overdue: true, items: od });
    const byDay = new Map<string, Entry[]>();
    for (const e of visible.filter((x) => x.dueDate >= today)) {
      byDay.set(e.dueDate, [...(byDay.get(e.dueDate) || []), e]);
    }
    for (const [day, items] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const label =
        day === today
          ? `Today · ${fmtDay(day)}`
          : day === addDays(today, 1)
            ? `Tomorrow · ${fmtDay(day)}`
            : fmtDay(day);
      groups.push({ label, overdue: false, items });
    }
  }

  function openEntry(e: Entry) {
    if (e.isRequest) {
      // Same modal as tasks; it edits the ask's date (prefs stay in the drawer).
      setTaskModal({
        mode: "request",
        candidateKey: e.candidateKey!,
        candidateName: e.candidateName,
        dueDate: e.dueDate,
      });
      return;
    }
    const t = data?.tasks.find((x) => x.id === e.id);
    if (t) {
      setTaskModal({
        mode: "edit",
        task: {
          id: t.id,
          kind: t.kind,
          title: t.title,
          dueDate: t.dueDate,
          dueTime: t.dueTime,
          candidateName: t.candidateName,
        },
      });
    }
  }

  async function completeTask(t: Entry) {
    setBusy(t.id);
    const res = t.isRequest
      ? await fetch(`/api/dashboard/candidates/v2/${t.candidateKey}/followup`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => null)
      : await fetch(`/api/dashboard/tasks/${t.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ status: "done" }),
        }).catch(() => null);
    setBusy(null);
    if (res?.ok && data) {
      setData({
        ...data,
        tasks: data.tasks.filter((x) => x.id !== t.id),
        requests: data.requests.filter((r) => `req_${r.candidateKey}` !== t.id),
      });
    }
    load();
  }

  async function reopenTask(id: string) {
    setBusy(id);
    await fetch(`/api/dashboard/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: "open" }),
    }).catch(() => null);
    setBusy(null);
    load();
  }

  return (
    <>
      <div className="tk-head">
        <div>
          <h1 className="dash-h1">Tasks</h1>
          <p className="dash-sub">
            {data
              ? `${openCount} open${overdue.length ? ` · ${overdue.length} overdue` : ""}`
              : "Everything due — your tasks and candidate-requested follow-ups."}
          </p>
        </div>
        <span className="dash-tabs tk-seg">
          {(
            [
              ["today", `Today`, todayCount],
              ["week", `This week`, weekCount],
              ["open", `All open`, openCount],
              ["done", `Done`, null],
            ] as [Seg, string, number | null][]
          ).map(([v, label, n]) => (
            <button key={v} className={seg === v ? "on" : ""} onClick={() => setSeg(v)}>
              {label}
              {data && n !== null && <span className="n">{n}</span>}
            </button>
          ))}
        </span>
      </div>

      {error && <p className="cv2d-err">Couldn&apos;t load tasks. Refresh to try again.</p>}
      {!data && !error && <p className="dash-muted">Loading…</p>}

      {data && seg !== "done" && overdue.length > 0 && (
        <div className="tk-strip">
          <b>{overdue.length} overdue</b>
          <span>oldest from {fmtDay(overdue.map((e) => e.dueDate).sort()[0])}</span>
        </div>
      )}

      {data && seg !== "done" && groups.length === 0 && (
        <p className="tk-empty">
          {seg === "today"
            ? "Nothing due today."
            : seg === "week"
              ? "Nothing due this week."
              : "No open tasks. Create one from any candidate's drawer."}
        </p>
      )}

      {data &&
        seg !== "done" &&
        groups.map((g) => (
          <div className="tk-day" key={g.label}>
            <div className={`tk-day-h${g.overdue ? " bad" : ""}`}>
              {g.label} <span className="cnt">· {g.items.length}</span>
            </div>
            <div className="tk-rows">
              {g.items.map((e) => (
                <div
                  className="tk-row tk-click"
                  key={e.id}
                  role="button"
                  onClick={() => openEntry(e)}
                >
                  <button
                    className="tk-tick"
                    title={e.isRequest ? "Mark contacted" : "Mark done"}
                    disabled={busy === e.id}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      completeTask(e);
                    }}
                    aria-label="Mark done"
                  />
                  <span className="tk-title">
                    {(e.kind === "call" || e.kind === "email") && (
                      <KindIcon kind={e.kind} className="tk-ico tk-kind" />
                    )}
                    {e.title}
                  </span>
                  {e.candidateKey && (
                    <button
                      className="tk-cand"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onOpenCandidate(e.candidateKey!);
                      }}
                    >
                      <span className="av">{initials(e.candidateName)}</span>
                      {e.candidateName}
                    </button>
                  )}
                  {e.isRequest && <span className="tk-src">Candidate request</span>}
                  <span className={`tk-due${g.overdue ? " bad" : ""}`}>
                    {e.dueDate === today ? "Today" : fmtDay(e.dueDate)}
                    {e.dueTime ? ` · ${e.dueTime}` : ""}
                  </span>
                  <button
                    className="tk-doneb tk-editb"
                    title={e.isRequest ? "Move their follow-up date" : "Edit, reschedule, or delete"}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      openEntry(e);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    className="tk-doneb"
                    disabled={busy === e.id}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      completeTask(e);
                    }}
                  >
                    {busy === e.id ? "…" : "Done"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}

      {data && seg === "done" && (
        <div className="tk-day">
          {data.done.length === 0 ? (
            <p className="tk-empty">Nothing completed yet.</p>
          ) : (
            <div className="tk-rows">
              {data.done.map((t) => (
                <div className="tk-row done" key={t.id}>
                  <span className="tk-tick done" aria-hidden="true" />
                  <span className="tk-title">
                    {(t.kind === "call" || t.kind === "email") && (
                      <KindIcon kind={t.kind} className="tk-ico tk-kind" />
                    )}
                    {t.title}
                  </span>
                  {t.candidateKey && (
                    <button className="tk-cand" onClick={() => onOpenCandidate(t.candidateKey!)}>
                      <span className="av">{initials(t.candidateName)}</span>
                      {t.candidateName}
                    </button>
                  )}
                  <span className="tk-due">
                    done {t.completedAt ? fmtDay(t.completedAt.slice(0, 10)) : ""}
                  </span>
                  <button className="tk-doneb" disabled={busy === t.id} onClick={() => reopenTask(t.id)}>
                    Reopen
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {taskModal && (
        <TaskModal target={taskModal} onClose={() => setTaskModal(null)} onChanged={load} />
      )}
    </>
  );
}
