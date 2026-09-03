// "No reply": we've stopped chasing this person. Not a rejection (that's a
// judgement), not nothing (they'd sit in Contacted forever). One live mark
// per person; on the role they move to Past with the reason "no reply";
// an optional check-back lands in the Inbox as a task on the chosen day.
// A reply from them, or a fresh email to them, clears it all again.
import { sbInsert, sbRest } from "./supabase";
import { cancelReminders } from "./reminders";
import { saveUnifiedStatus } from "./candidates-unified";

export type { NoReplyMark } from "./no-reply-marks";

const KEY_RE = /^(app|src)_[0-9a-f-]{36}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const now = () => new Date().toISOString();

type Row = { job_id: string | null };
const COLS = "job_id";

export async function markNoReply(args: {
  orgId: string;
  memberEmail: string;
  userId: string;
  candidateKey: string;
  candidateName: string;
  threadId: string | null;
  jobId: string | null;
  /** The conversation's subject, for the check-back row. */
  subject: string | null;
  /** YYYY-MM-DD, or null for "never". */
  checkBack: string | null;
}): Promise<{ ok: true; staged: boolean } | { ok: false; error: string }> {
  const { orgId, candidateKey: key } = args;
  if (!KEY_RE.test(key)) return { ok: false, error: "bad_key" };
  if (args.checkBack && !DATE_RE.test(args.checkBack)) return { ok: false, error: "bad_date" };

  // Whatever was chasing them stops: reminders end as "no reply", an older
  // check-back is replaced by this one.
  await cancelReminders({ orgId, candidateKey: key, reason: "no_reply" }).catch(() => 0);
  await sbRest(`tasks?organization_id=eq.${orgId}&candidate_key=eq.${key}&kind=eq.recontact&status=eq.open`, {
    method: "PATCH",
    body: JSON.stringify({ status: "done", completed_at: now(), updated_at: now(), ended_reason: "replaced" }),
    prefer: "return=minimal",
  }).catch(() => null);

  const res = await sbRest(`no_reply_marks?on_conflict=organization_id,candidate_key`, {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({
      organization_id: orgId,
      candidate_key: key,
      marked_at: now(),
      marked_by_email: args.memberEmail,
      thread_id: args.threadId || null,
      job_id: args.jobId || null,
      check_back_at: args.checkBack || null,
      cleared_at: null,
      cleared_reason: null,
    }),
  });
  if (!res.ok) return { ok: false, error: "save_failed" };

  // On the role: out of the active pipeline, into Past under "No reply".
  let staged = false;
  if (args.jobId) {
    const r = await saveUnifiedStatus(orgId, key, args.jobId, "rejected", null, "no_reply", args.memberEmail).catch(() => ({ ok: false as const, error: "save_failed" }));
    staged = r.ok;
  }

  if (args.checkBack) {
    await sbInsert(
      "tasks",
      {
        organization_id: orgId,
        candidate_key: key,
        candidate_name: args.candidateName.trim().slice(0, 160),
        kind: "recontact",
        title: (args.subject || "").trim().slice(0, 300) || "Check back",
        due_date: args.checkBack,
        due_time: null,
        created_by: args.userId,
        created_by_email: args.memberEmail,
        thread_id: args.threadId || null,
        job_id: args.jobId || null,
      },
      true
    ).catch(() => null);
  }
  return { ok: true, staged };
}

/** They replied, or someone emailed them again: the mark clears, the
 *  check-back is cancelled, and on the role they come back out of Past
 *  (to Replied for a reply, to Contacted for an email). Returns whether
 *  there was a live mark. */
export async function clearNoReply(args: {
  orgId: string;
  candidateKey: string;
  reason: "replied" | "contacted";
}): Promise<boolean> {
  const { orgId, candidateKey: key, reason } = args;
  if (!KEY_RE.test(key)) return false;
  const res = await sbRest(`no_reply_marks?organization_id=eq.${orgId}&candidate_key=eq.${key}&cleared_at=is.null&select=${COLS}&limit=1`);
  const [mark] = res.ok ? ((await res.json()) as Row[]) : [];
  if (!mark) return false;
  await sbRest(`no_reply_marks?organization_id=eq.${orgId}&candidate_key=eq.${key}`, {
    method: "PATCH",
    body: JSON.stringify({ cleared_at: now(), cleared_reason: reason }),
    prefer: "return=minimal",
  }).catch(() => null);
  await sbRest(`tasks?organization_id=eq.${orgId}&candidate_key=eq.${key}&kind=eq.recontact&status=eq.open`, {
    method: "PATCH",
    body: JSON.stringify({ status: "done", completed_at: now(), updated_at: now(), ended_reason: reason }),
    prefer: "return=minimal",
  }).catch(() => null);
  if (mark.job_id) {
    const st = await sbRest(
      `candidate_role_statuses?organization_id=eq.${orgId}&candidate_key=eq.${key}&job_id=eq.${encodeURIComponent(mark.job_id)}&select=status,reason&limit=1`
    );
    const [row] = st.ok ? ((await st.json()) as { status: string; reason: string | null }[]) : [];
    if (row && row.status === "rejected" && row.reason === "no_reply") {
      await saveUnifiedStatus(orgId, key, mark.job_id, reason === "replied" ? "replied" : "contacted", null, null).catch(() => null);
    }
  }
  return true;
}

export { noReplyMarkFor, noReplyMarksByKey } from "./no-reply-marks";
