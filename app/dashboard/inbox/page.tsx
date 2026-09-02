"use client";
// Inbox: the list (InboxView) plus the working session — open a row, the
// drawer lands on the right tab with a strip naming the item; act, and the
// strip flips to Handled with Next. The session keeps its own snapshot of
// the order so items clearing underneath don't move the ground.
import { useCallback, useEffect, useRef, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import CandidateDrawer from "@/components/dashboard/candidates/CandidateDrawer";
import TaskModal, { type TaskModalTarget } from "@/components/dashboard/tasks/TaskModal";
import InboxView, { type Seg } from "@/components/dashboard/inbox/InboxView";
import InboxStrip from "@/components/dashboard/inbox/InboxStrip";
import {
  isTask,
  landingTab,
  type InboxData,
  type InboxDone,
  type InboxItem,
  type InboxScope,
} from "@/components/dashboard/inbox/types";

type Session = {
  items: InboxItem[];
  index: number;
  /** item id → reason, for items dealt with (or gone) in this session. */
  handled: Record<string, string>;
};

const localDay = () => new Date().toLocaleDateString("en-CA");
const TASK_KIND: Record<string, string> = { temail: "email", tcall: "call", tmsg: "message", ttask: "task" };
const announce = () => window.dispatchEvent(new CustomEvent("tt-inbox-changed"));

export default function InboxPage() {
  const { token, email } = useDash();
  const [scope, setScope] = useState<InboxScope>("me");
  const [seg, setSeg] = useState<Seg>("today");
  const [data, setData] = useState<InboxData | null>(null);
  const [error, setError] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [session, setSession] = useState<Session | null>(null);
  const [taskModal, setTaskModal] = useState<TaskModalTarget | null>(null);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;
  // Items this seat has already opened this session (marks are fire-and-forget).
  const seenRef = useRef<Set<string>>(new Set());
  // Only the newest request may land: scope toggles and polls overlap.
  const seqRef = useRef(0);

  useEffect(() => {
    try {
      const s = localStorage.getItem("tt-inbox-scope");
      if (s === "team") setScope("team");
    } catch {
      /* no storage */
    }
  }, []);
  const pickScope = (s: InboxScope) => {
    setScope(s);
    try {
      localStorage.setItem("tt-inbox-scope", s);
    } catch {
      /* no storage */
    }
  };

  const load = useCallback(() => {
    const seq = ++seqRef.current;
    fetch(`/api/dashboard/inbox?scope=${scope}&today=${localDay()}&_=${Date.now()}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<InboxData>;
      })
      .then((d) => {
        if (seq !== seqRef.current) return;
        setData(d);
        setError(false);
        // Keep the open session's items current. Anything that left the
        // list for a reason this session didn't cause is "gone", not done.
        setSession((s) => {
          if (!s) return s;
          const handled = { ...s.handled };
          const items = s.items.map((old) => {
            const fresh = d.items.find((n) => n.id === old.id);
            if (!fresh && !handled[old.id]) handled[old.id] = "gone";
            return fresh ? { ...fresh, seen: fresh.seen || seenRef.current.has(fresh.id) } : old;
          });
          return { ...s, items, handled };
        });
        announce();
      })
      .catch(() => {
        if (seq === seqRef.current) setError(true);
      });
  }, [scope, token]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  // Replies and applications arrive while the page is open: poll gently,
  // refetch on focus.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") load();
    };
    const id = window.setInterval(tick, 30_000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  const auth = { Authorization: `Bearer ${token}` };
  const setBusy = (id: string, on: boolean) =>
    setBusyIds((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const busyId = (id: string | null) => (id && busyIds.has(id) ? id : null);

  const markSeen = (item: InboxItem) => {
    if (isTask(item.kind) || item.seen || seenRef.current.has(item.id)) return;
    seenRef.current.add(item.id);
    setData((d) => (d ? { ...d, items: d.items.map((i) => (i.id === item.id ? { ...i, seen: true } : i)) } : d));
    fetch("/api/dashboard/inbox/mark", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, seen: true, kind: item.kind, candidateKey: item.candidateKey }),
    }).catch(() => {});
  };

  /** Clear an item without acting: the right call for its kind. */
  const tick = async (item: InboxItem): Promise<boolean> => {
    setBusy(item.id, true);
    let res: Response | null = null;
    if (isTask(item.kind) && item.taskId) {
      res = await fetch(`/api/dashboard/tasks/${item.taskId}`, {
        method: "PATCH",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      }).catch(() => null);
    } else if (item.kind === "fdue" && item.candidateKey) {
      res = await fetch(`/api/dashboard/candidates/v2/${item.candidateKey}/followup`, { method: "POST", headers: auth }).catch(() => null);
    } else {
      res = await fetch("/api/dashboard/inbox/mark", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, handled: "done", kind: item.kind, label: item.title, candidateKey: item.candidateKey }),
      }).catch(() => null);
    }
    setBusy(item.id, false);
    const ok = Boolean(res?.ok);
    if (ok) {
      setData((d) =>
        d
          ? {
              ...d,
              items: d.items.filter((i) => i.id !== item.id),
              counts: { ...d.counts, today: Math.max(0, d.counts.today - 1), overdue: Math.max(0, d.counts.overdue - (item.overdue ? 1 : 0)) },
            }
          : d
      );
    }
    load();
    return ok;
  };

  const reopen = async (d: InboxDone) => {
    setBusy(d.id, true);
    if (d.kind === "task") {
      await fetch(`/api/dashboard/tasks/${d.id.replace(/^task:/, "")}`, {
        method: "PATCH",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "open" }),
      }).catch(() => null);
    } else {
      await fetch("/api/dashboard/inbox/mark", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ id: d.id, handled: null }),
      }).catch(() => null);
    }
    setBusy(d.id, false);
    load();
  };

  const edit = (item: InboxItem) => {
    if (item.kind === "fdue" && item.candidateKey && item.dueDate) {
      setTaskModal({ mode: "request", candidateKey: item.candidateKey, candidateName: item.candidateName, dueDate: item.dueDate });
    } else if (item.taskId) {
      setTaskModal({
        mode: "edit",
        task: {
          id: item.taskId,
          kind: TASK_KIND[item.kind] || "task",
          title: item.title,
          dueDate: item.dueDate || localDay(),
          dueTime: item.dueTime,
          candidateName: item.candidateName,
        },
      });
    }
  };

  // ---- the working session --------------------------------------------
  const open = (item: InboxItem) => {
    if (!item.candidateKey || !data) return;
    // Step through the list the row came from: Today, or an Upcoming day.
    const inToday = data.items.some((i) => i.id === item.id);
    const pool = inToday ? data.items : data.upcoming.flatMap((d) => d.items);
    let items = pool.filter((i) => i.candidateKey);
    let index = items.findIndex((i) => i.id === item.id);
    if (index < 0) {
      items = [item];
      index = 0;
    }
    setSession({ items, index, handled: {} });
    markSeen(item);
  };
  const goto = (index: number) => {
    const s = sessionRef.current;
    if (!s || index < 0 || index >= s.items.length) return;
    markSeen(s.items[index]);
    setSession({ ...s, index });
  };
  const nextUnhandled = (s: Session): number => {
    for (let i = s.index + 1; i < s.items.length; i++) if (!s.handled[s.items[i].id]) return i;
    for (let i = 0; i < s.index; i++) if (!s.handled[s.items[i].id]) return i;
    return -1;
  };
  const closeSession = () => {
    setSession(null);
    load();
  };
  const noteHandled = (id: string, reason: string) =>
    setSession((s) => (s ? { ...s, handled: { ...s.handled, [id]: reason } } : s));

  const current = session ? session.items[session.index] : null;
  const onActivity = (ev: { type: "stage" | "sent" | "contacted"; label?: string }) => {
    const s = sessionRef.current;
    const cur = s ? s.items[s.index] : null;
    if (!cur) {
      load();
      return;
    }
    let reason: string | null = null;
    if (ev.type === "stage" && (cur.kind === "app" || cur.kind === "drop")) reason = `stage:${ev.label || "moved"}`;
    if (ev.type === "sent") {
      if (cur.kind === "mail") reason = "reply";
      else if (cur.kind === "ask" || cur.kind === "ref" || cur.kind === "drop" || cur.kind === "fdue" || cur.kind === "temail") reason = "email";
    }
    if (ev.type === "contacted" && cur.kind === "fdue") reason = "contacted";
    if (reason) noteHandled(cur.id, reason);
    load();
  };

  return (
    <>
      {error && <p className="cv2d-err">Couldn&apos;t load the Inbox. Refresh to try again.</p>}
      <InboxView
        data={data}
        scope={scope}
        seg={seg}
        viewer={email}
        currentId={current?.id || null}
        busyIds={busyIds}
        onScope={pickScope}
        onSeg={setSeg}
        onOpen={open}
        onTick={tick}
        onReopen={reopen}
        onEdit={edit}
      />
      {session && current && (
        <CandidateDrawer
          candKey={current.candidateKey}
          roleContext={current.jobId || undefined}
          initialTab={landingTab(current.kind)}
          initialThreadId={current.threadId}
          navItems={session.items.map((i) => ({ id: i.id, key: i.candidateKey! }))}
          navIndex={session.index}
          onNavigateItem={goto}
          onActivity={onActivity}
          completeTaskId={current.kind === "temail" ? current.taskId : null}
          inboxThreadId={current.kind === "mail" ? current.threadId : null}
          contextStrip={
            <InboxStrip
              item={current}
              today={data?.today || localDay()}
              handledReason={session.handled[current.id] || null}
              remaining={data?.counts.today ?? 0}
              hasNext={nextUnhandled(session) >= 0}
              busy={busyId(current.id) !== null}
              onDone={async () => {
                const ok = await tick(current);
                if (ok) noteHandled(current.id, current.kind === "fdue" ? "contacted" : "done");
              }}
              onSkip={() => goto(nextUnhandled(session))}
              onNext={() => goto(nextUnhandled(session))}
              onClose={closeSession}
            />
          }
          onClose={closeSession}
        />
      )}
      {taskModal && (
        <TaskModal
          target={taskModal}
          onClose={() => setTaskModal(null)}
          onChanged={load}
        />
      )}
    </>
  );
}
