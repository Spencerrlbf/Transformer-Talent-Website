// Tasks + candidate notes. Tasks power the Tasks page; notes and task events
// merge into the per-candidate timeline in the drawer. Candidate-requested
// follow-ups ("hear from me later") fold into the Tasks page as read-only
// request rows — completing one goes through the existing followup clear
// endpoint so both systems stay in step.
import { sbInsert, sbRest } from "./supabase";

export const TASK_KINDS = ["task", "call", "email", "message"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const NOTE_KINDS = ["note", "call", "email", "message"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

const KEY_RE = /^(app|src)_[0-9a-f-]{36}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export type TaskRow = {
  id: string;
  candidateKey: string | null;
  candidateName: string;
  kind: TaskKind;
  title: string;
  dueDate: string; // YYYY-MM-DD
  dueTime: string | null; // HH:MM
  status: "open" | "done";
  createdByEmail: string;
  createdAt: string;
  completedAt: string | null;
};

export type RequestRow = {
  candidateKey: string;
  candidateName: string;
  dueDate: string;
};

export type NoteRow = {
  id: string;
  kind: NoteKind;
  body: string;
  authorEmail: string;
  createdAt: string;
  /** Set when the note was edited after creation. */
  updatedAt: string | null;
};

type DbTask = {
  id: string;
  candidate_key: string | null;
  candidate_name: string;
  kind: TaskKind;
  title: string;
  due_date: string;
  due_time: string | null;
  status: "open" | "done";
  created_by_email: string;
  created_at: string;
  completed_at: string | null;
};

const shapeTask = (t: DbTask): TaskRow => ({
  id: t.id,
  candidateKey: t.candidate_key,
  candidateName: t.candidate_name,
  kind: t.kind,
  title: t.title,
  dueDate: t.due_date,
  dueTime: t.due_time ? t.due_time.slice(0, 5) : null,
  status: t.status,
  createdByEmail: t.created_by_email,
  createdAt: t.created_at,
  completedAt: t.completed_at,
});

const TASK_COLS =
  "id,candidate_key,candidate_name,kind,title,due_date,due_time,status,created_by_email,created_at,completed_at";

/** The candidate must exist AND belong to the org — anything else is a 404. */
export async function candidateInOrg(orgId: string, key: string): Promise<boolean> {
  if (!KEY_RE.test(key)) return false;
  const id = key.slice(4);
  const table = key.startsWith("app_") ? "website_applications" : "sourced_candidates";
  const res = await sbRest(`${table}?id=eq.${id}&organization_id=eq.${orgId}&select=id&limit=1`);
  if (!res.ok) return false;
  return ((await res.json()) as unknown[]).length > 0;
}

export async function listTasks(
  orgId: string
): Promise<{ tasks: TaskRow[]; done: TaskRow[]; requests: RequestRow[] }> {
  const [openRes, doneRes, reqRes] = await Promise.all([
    sbRest(
      `tasks?organization_id=eq.${orgId}&status=eq.open&select=${TASK_COLS}` +
        `&order=due_date.asc,due_time.asc.nullslast,created_at.asc&limit=500`
    ),
    sbRest(
      `tasks?organization_id=eq.${orgId}&status=eq.done&select=${TASK_COLS}` +
        `&order=completed_at.desc&limit=100`
    ),
    sbRest(
      `website_applications?organization_id=eq.${orgId}&follow_up_at=not.is.null` +
        `&select=id,name,follow_up_at&order=follow_up_at.asc&limit=500`
    ),
  ]);
  const tasks = openRes.ok ? ((await openRes.json()) as DbTask[]).map(shapeTask) : [];
  const done = doneRes.ok ? ((await doneRes.json()) as DbTask[]).map(shapeTask) : [];
  const reqRows = reqRes.ok
    ? ((await reqRes.json()) as { id: string; name: string | null; follow_up_at: string }[])
    : [];
  const requests = reqRows.map((r) => ({
    candidateKey: `app_${r.id}`,
    candidateName: (r.name || "").trim() || "Candidate",
    dueDate: r.follow_up_at,
  }));
  return { tasks, done, requests };
}

export async function createTask(args: {
  orgId: string;
  candidateKey: string;
  candidateName: string;
  kind: string;
  title: string;
  dueDate: string;
  dueTime: string | null;
  userId: string;
  userEmail: string;
}): Promise<TaskRow | { error: string }> {
  const kind = (TASK_KINDS as readonly string[]).includes(args.kind) ? args.kind : "task";
  const title = args.title.trim().slice(0, 300);
  if (!title) return { error: "Give the task a description." };
  if (!DATE_RE.test(args.dueDate)) return { error: "Pick a due date." };
  if (args.dueTime && !TIME_RE.test(args.dueTime)) return { error: "Time must be HH:MM." };
  if (!(await candidateInOrg(args.orgId, args.candidateKey))) return { error: "not_found" };
  const row = await sbInsert<DbTask>(
    "tasks",
    {
      organization_id: args.orgId,
      candidate_key: args.candidateKey,
      candidate_name: args.candidateName.trim().slice(0, 160),
      kind,
      title,
      due_date: args.dueDate,
      due_time: args.dueTime || null,
      created_by: args.userId,
      created_by_email: args.userEmail,
    },
    true
  ).catch(() => null);
  return row ? shapeTask(row) : { error: "Could not save the task. Please try again." };
}

export async function updateTask(
  orgId: string,
  id: string,
  patch: { title?: string; kind?: string; dueDate?: string; dueTime?: string | null; status?: string }
): Promise<TaskRow | { error: string }> {
  const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) {
    const t = patch.title.trim().slice(0, 300);
    if (!t) return { error: "Give the task a description." };
    body.title = t;
  }
  if (patch.kind !== undefined) {
    if (!(TASK_KINDS as readonly string[]).includes(patch.kind)) return { error: "bad_kind" };
    body.kind = patch.kind;
  }
  if (patch.dueDate !== undefined) {
    if (!DATE_RE.test(patch.dueDate)) return { error: "Pick a due date." };
    body.due_date = patch.dueDate;
  }
  if (patch.dueTime !== undefined) {
    if (patch.dueTime && !TIME_RE.test(patch.dueTime)) return { error: "Time must be HH:MM." };
    body.due_time = patch.dueTime || null;
  }
  if (patch.status !== undefined) {
    if (patch.status !== "open" && patch.status !== "done") return { error: "bad_status" };
    body.status = patch.status;
    body.completed_at = patch.status === "done" ? new Date().toISOString() : null;
  }
  const res = await sbRest(`tasks?id=eq.${id}&organization_id=eq.${orgId}&select=${TASK_COLS}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    prefer: "return=representation",
  });
  if (!res.ok) return { error: "Could not save. Please try again." };
  const [row] = (await res.json()) as DbTask[];
  return row ? shapeTask(row) : { error: "not_found" };
}

export async function deleteTask(orgId: string, id: string): Promise<boolean> {
  const res = await sbRest(`tasks?id=eq.${id}&organization_id=eq.${orgId}`, { method: "DELETE" });
  return res.ok;
}

export async function addNote(args: {
  orgId: string;
  candidateKey: string;
  kind: string;
  body: string;
  userId: string;
  userEmail: string;
}): Promise<NoteRow | { error: string }> {
  const kind = (NOTE_KINDS as readonly string[]).includes(args.kind) ? args.kind : "note";
  const body = args.body.trim().slice(0, 4000);
  if (!body) return { error: "Write the note first." };
  if (!(await candidateInOrg(args.orgId, args.candidateKey))) return { error: "not_found" };
  const row = await sbInsert<DbNote>(
    "candidate_notes",
    {
      organization_id: args.orgId,
      candidate_key: args.candidateKey,
      kind,
      body,
      author_id: args.userId,
      author_email: args.userEmail,
    },
    true
  ).catch(() => null);
  return row ? shapeNote(row) : { error: "Could not save the note. Please try again." };
}

type DbNote = {
  id: string;
  kind: NoteKind;
  body: string;
  author_email: string;
  created_at: string;
  updated_at: string | null;
};

const NOTE_COLS = "id,kind,body,author_email,created_at,updated_at";

const shapeNote = (n: DbNote): NoteRow => ({
  id: n.id,
  kind: n.kind,
  body: n.body,
  authorEmail: n.author_email,
  createdAt: n.created_at,
  updatedAt: n.updated_at,
});

/** Edit a note — only its author's (the where clause enforces it). */
export async function updateNote(
  orgId: string,
  id: string,
  authorEmail: string,
  patch: { kind?: string; body?: string }
): Promise<NoteRow | { error: string }> {
  const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.kind !== undefined) {
    if (!(NOTE_KINDS as readonly string[]).includes(patch.kind)) return { error: "bad_kind" };
    body.kind = patch.kind;
  }
  if (patch.body !== undefined) {
    const b = patch.body.trim().slice(0, 4000);
    if (!b) return { error: "Write the note first." };
    body.body = b;
  }
  const res = await sbRest(
    `candidate_notes?id=eq.${id}&organization_id=eq.${orgId}` +
      `&author_email=eq.${encodeURIComponent(authorEmail)}&select=${NOTE_COLS}`,
    { method: "PATCH", body: JSON.stringify(body), prefer: "return=representation" }
  );
  if (!res.ok) return { error: "Could not save. Please try again." };
  const [row] = (await res.json()) as DbNote[];
  return row ? shapeNote(row) : { error: "not_found" };
}

/** Delete a note — only its author's. */
export async function deleteNote(orgId: string, id: string, authorEmail: string): Promise<boolean> {
  const res = await sbRest(
    `candidate_notes?id=eq.${id}&organization_id=eq.${orgId}` +
      `&author_email=eq.${encodeURIComponent(authorEmail)}`,
    { method: "DELETE", prefer: "return=representation" }
  );
  if (!res.ok) return false;
  return ((await res.json()) as unknown[]).length > 0;
}

/** Everything the drawer's timeline needs for one candidate, newest first
 *  client-side: notes, this candidate's tasks (created/completed events),
 *  and their own follow-up ask if any. */
export async function candidateTimeline(
  orgId: string,
  key: string
): Promise<{ notes: NoteRow[]; tasks: TaskRow[]; ask: { at: string; askedAt: string | null } | null } | null> {
  if (!KEY_RE.test(key)) return null;
  const [notesRes, tasksRes] = await Promise.all([
    sbRest(
      `candidate_notes?organization_id=eq.${orgId}&candidate_key=eq.${key}` +
        `&select=${NOTE_COLS}&order=created_at.desc&limit=200`
    ),
    sbRest(
      `tasks?organization_id=eq.${orgId}&candidate_key=eq.${key}` +
        `&select=${TASK_COLS}&order=created_at.desc&limit=100`
    ),
  ]);
  const notes = notesRes.ok ? ((await notesRes.json()) as DbNote[]).map(shapeNote) : [];
  const tasks = tasksRes.ok ? ((await tasksRes.json()) as DbTask[]).map(shapeTask) : [];
  let ask: { at: string; askedAt: string | null } | null = null;
  if (key.startsWith("app_")) {
    const res = await sbRest(
      `website_applications?id=eq.${key.slice(4)}&organization_id=eq.${orgId}` +
        `&follow_up_at=not.is.null&select=follow_up_at,created_at&limit=1`
    );
    const [row] = res.ok
      ? ((await res.json()) as { follow_up_at: string; created_at: string }[])
      : [];
    if (row) ask = { at: row.follow_up_at, askedAt: row.created_at };
  }
  return { notes, tasks, ask };
}
