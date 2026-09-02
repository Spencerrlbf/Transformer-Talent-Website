// Reply reminders live in the tasks table (kind = 'reminder') so the Inbox,
// the drawer timeline and the Team view get them for free. One open
// reminder per conversation per seat: a newer email in the same thread
// moves it, a nudge from the Inbox closes it as "nudged" and sets the next.
// Nothing here ever sends anything.
import { sbInsert, sbRest } from "./supabase";

export type EndReason = "replied" | "closed" | "nudged" | "cancelled" | "done";

const KEY_RE = /^(app|src)_[0-9a-f-]{36}$/i;
const ID_RE = /^[0-9a-f-]{36}$/i;
const now = () => new Date().toISOString();

type Open = { id: string; thread_id: string | null; due_date: string; created_by_email: string; candidate_key: string | null };
const OPEN_COLS = "id,thread_id,due_date,created_by_email,candidate_key";

/** Set (or move) the sender's reminder on this conversation. */
export async function setReplyReminder(args: {
  orgId: string;
  memberEmail: string;
  userId: string;
  candidateKey: string;
  candidateName: string;
  threadId: string;
  messageId: string;
  subject: string;
  jobId: string | null;
  /** YYYY-MM-DD, already weekend-rolled. */
  due: string;
}): Promise<boolean> {
  if (!KEY_RE.test(args.candidateKey) || !args.threadId) return false;
  const res = await sbRest(
    `tasks?organization_id=eq.${args.orgId}&kind=eq.reminder&status=eq.open` +
      `&thread_id=eq.${encodeURIComponent(args.threadId)}&created_by_email=eq.${encodeURIComponent(args.memberEmail)}` +
      `&select=id&limit=1`
  );
  const [existing] = res.ok ? ((await res.json()) as { id: string }[]) : [];
  const title = args.subject.trim().slice(0, 300) || "your email";
  if (existing) {
    const p = await sbRest(`tasks?id=eq.${existing.id}&organization_id=eq.${args.orgId}`, {
      method: "PATCH",
      body: JSON.stringify({
        due_date: args.due,
        remind_message_id: args.messageId || null,
        title,
        job_id: args.jobId || null,
        updated_at: now(),
      }),
      prefer: "return=minimal",
    });
    return p.ok;
  }
  const row = await sbInsert<{ id: string }>(
    "tasks",
    {
      organization_id: args.orgId,
      candidate_key: args.candidateKey,
      candidate_name: args.candidateName.trim().slice(0, 160),
      kind: "reminder",
      title,
      due_date: args.due,
      due_time: null,
      created_by: args.userId,
      created_by_email: args.memberEmail,
      thread_id: args.threadId,
      remind_message_id: args.messageId || null,
      job_id: args.jobId || null,
    },
    true
  ).catch(() => null);
  return Boolean(row);
}

/** End every open reminder on a person (or on one of their conversations),
 *  recording why. Returns how many closed. */
export async function cancelReminders(args: {
  orgId: string;
  candidateKey: string;
  threadId?: string | null;
  reason: EndReason;
}): Promise<number> {
  if (!KEY_RE.test(args.candidateKey)) return 0;
  const thread = args.threadId ? `&thread_id=eq.${encodeURIComponent(args.threadId)}` : "";
  const res = await sbRest(
    `tasks?organization_id=eq.${args.orgId}&candidate_key=eq.${args.candidateKey}&kind=eq.reminder&status=eq.open${thread}&select=id`,
    {
      method: "PATCH",
      body: JSON.stringify({ status: "done", completed_at: now(), updated_at: now(), ended_reason: args.reason }),
      prefer: "return=representation",
    }
  );
  return res.ok ? ((await res.json()) as unknown[]).length : 0;
}

/** End one specific open reminder (the one an Inbox nudge is answering). */
export async function endReminder(orgId: string, id: string, candidateKey: string, reason: EndReason): Promise<boolean> {
  if (!ID_RE.test(id) || !KEY_RE.test(candidateKey)) return false;
  const res = await sbRest(
    `tasks?id=eq.${id}&organization_id=eq.${orgId}&candidate_key=eq.${candidateKey}&kind=eq.reminder&status=eq.open&select=id`,
    {
      method: "PATCH",
      body: JSON.stringify({ status: "done", completed_at: now(), updated_at: now(), ended_reason: reason }),
      prefer: "return=representation",
    }
  );
  return res.ok && ((await res.json()) as unknown[]).length > 0;
}

/** This seat's live reminders on a person, for the Email tab's thread strip. */
export async function openReminders(
  orgId: string,
  candidateKey: string,
  memberEmail: string
): Promise<{ id: string; threadId: string; dueDate: string }[]> {
  if (!KEY_RE.test(candidateKey)) return [];
  const res = await sbRest(
    `tasks?organization_id=eq.${orgId}&candidate_key=eq.${candidateKey}&kind=eq.reminder&status=eq.open` +
      `&created_by_email=eq.${encodeURIComponent(memberEmail)}&select=${OPEN_COLS}&order=due_date.asc&limit=50`
  );
  const rows = res.ok ? ((await res.json()) as Open[]) : [];
  return rows.filter((r) => r.thread_id).map((r) => ({ id: r.id, threadId: r.thread_id!, dueDate: r.due_date }));
}

/** Earliest live reminder per person across the org, for the Candidates
 *  table's Reach out column (anyone's: the column is about the person). */
export async function openReminderDues(orgId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const res = await sbRest(
    `tasks?organization_id=eq.${orgId}&kind=eq.reminder&status=eq.open&select=candidate_key,due_date&order=due_date.asc&limit=2000`
  );
  const rows = res.ok ? ((await res.json()) as { candidate_key: string | null; due_date: string }[]) : [];
  for (const r of rows) if (r.candidate_key && !out.has(r.candidate_key)) out.set(r.candidate_key, r.due_date);
  return out;
}
