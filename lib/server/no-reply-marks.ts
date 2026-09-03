// Read side of "No reply" marks (see no-reply.ts for the writes). Kept
// import-light so the candidates list and detail can use it without a cycle.
import { sbRest } from "./supabase";

export type NoReplyMark = {
  markedAt: string;
  checkBackAt: string | null;
  threadId: string | null;
  jobId: string | null;
};

const KEY_RE = /^(app|src)_[0-9a-f-]{36}$/i;
type Row = { candidate_key: string; marked_at: string; check_back_at: string | null; thread_id: string | null; job_id: string | null };
export const MARK_COLS = "candidate_key,marked_at,check_back_at,thread_id,job_id";
export const shapeMark = (r: Row): NoReplyMark => ({ markedAt: r.marked_at, checkBackAt: r.check_back_at, threadId: r.thread_id, jobId: r.job_id });

export async function noReplyMarkFor(orgId: string, key: string): Promise<NoReplyMark | null> {
  if (!KEY_RE.test(key)) return null;
  const res = await sbRest(`no_reply_marks?organization_id=eq.${orgId}&candidate_key=eq.${key}&cleared_at=is.null&select=${MARK_COLS}&limit=1`);
  const [row] = res.ok ? ((await res.json()) as Row[]) : [];
  return row ? shapeMark(row) : null;
}

/** Live marks across the org, for the Candidates table. */
export async function noReplyMarksByKey(orgId: string): Promise<Map<string, NoReplyMark>> {
  const out = new Map<string, NoReplyMark>();
  const res = await sbRest(`no_reply_marks?organization_id=eq.${orgId}&cleared_at=is.null&select=${MARK_COLS}&limit=5000`);
  for (const r of res.ok ? ((await res.json()) as Row[]) : []) out.set(r.candidate_key, shapeMark(r));
  return out;
}
