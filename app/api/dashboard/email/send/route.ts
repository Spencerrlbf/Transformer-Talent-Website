import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { emailConfigured, sendAsGrant } from "@/lib/server/nylas";
import {
  accountFor,
  candidateContact,
  htmlToSnippet,
  htmlToText,
  loggedMessage,
  logEmail,
  sanitizeEmailHtml,
  threadBelongs,
} from "@/lib/server/email-compose";
import { noteEmailSent, noteStageMoved } from "@/lib/server/inbox";
import { completeEmailTask } from "@/lib/server/tasks";
import { saveUnifiedStatus, STAGE_LABEL } from "@/lib/server/candidates-unified";
import { sbRest } from "@/lib/server/supabase";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A quick action may only move a role the person is actually attached to,
 *  and "Contacted" never overwrites a later stage (Interviewing, Offer…):
 *  the most natural click on an active thread must not drag someone back. */
async function quickMoveAllowed(orgId: string, key: string, jobId: string, stage: "contacted" | "rejected"): Promise<boolean> {
  if (key.startsWith("app_")) {
    const r = await sbRest(`website_applications?id=eq.${key.slice(4)}&organization_id=eq.${orgId}&select=role_ids,matched_role_ids&limit=1`);
    const [a] = r.ok ? ((await r.json()) as { role_ids: string[] | null; matched_role_ids: string[] | null }[]) : [];
    if (!a || ![...(a.role_ids || []), ...(a.matched_role_ids || [])].includes(jobId)) return false;
  }
  if (stage === "contacted") {
    const r = await sbRest(
      `candidate_role_statuses?organization_id=eq.${orgId}&candidate_key=eq.${key}&job_id=eq.${encodeURIComponent(jobId)}&select=status&limit=1`
    );
    const [row] = r.ok ? ((await r.json()) as { status: string }[]) : [];
    if (row && row.status !== "new" && row.status !== "contacted") return false;
  }
  return true;
}

// Quick replies arrive as plain text; give them the same HTML shape the
// composer produces (one div per line).
const textToHtml = (text: string) =>
  text
    .split("\n")
    .map((l) => `<div>${esc(l) || "<br>"}</div>`)
    .join("");

// Send one email to one candidate through the seat's connected account.
// The recipient is always the candidate's email on file — the client never
// chooses an address. Unresolved merge fields are rejected outright: an
// email reading "Hi ," must be impossible to send.
export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  if (!emailConfigured()) return NextResponse.json({ error: "email_off" }, { status: 503 });

  let body: {
    candidateKey?: unknown;
    subject?: unknown;
    html?: unknown;
    text?: unknown;
    replyToMessageId?: unknown;
    /** Inbox email task this send fulfils — marked done on success. */
    completeTaskId?: unknown;
    /** The viewer's local date (YYYY-MM-DD), so "follow-up due" agrees with the Inbox. */
    today?: unknown;
    /** Inbox: the thread this (fresh, unthreaded) email answers. */
    inboxThreadId?: unknown;
    /** Quick action: the pipeline move to make once the email is out. */
    after?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }

  const key = String(body.candidateKey || "");
  const completeTaskId =
    typeof body.completeTaskId === "string" && /^[0-9a-f-]{36}$/i.test(body.completeTaskId) ? body.completeTaskId : null;
  const subject = String(body.subject || "").trim();
  const text = String(body.text || "").slice(0, 50_000);
  const html = String(body.html || "") || (text.trim() ? textToHtml(text) : "");
  const replyToMessageId = String(body.replyToMessageId || "");
  if (!subject || subject.length > 300) return NextResponse.json({ error: "bad_subject" }, { status: 400 });
  if (!html.trim() || html.length > 100_000) return NextResponse.json({ error: "bad_html" }, { status: 400 });
  if (html.includes("{{") || subject.includes("{{") || html.includes("em-miss")) {
    return NextResponse.json({ error: "unresolved_fields" }, { status: 400 });
  }

  const account = await accountFor(member.org.id, member.email);
  if (!account) return NextResponse.json({ error: "not_connected" }, { status: 409 });

  const contact = await candidateContact(member.org.id, key);
  if (!contact) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!contact.email) return NextResponse.json({ error: "no_candidate_email" }, { status: 400 });

  // A reply may only target a message we logged for this candidate; local-
  // prefixed ids are ours (no provider id), so they can't thread upstream.
  const target = replyToMessageId ? await loggedMessage(member.org.id, key, replyToMessageId) : null;
  if (replyToMessageId && !target) {
    return NextResponse.json({ error: "bad_reply_target" }, { status: 400 });
  }
  // A fresh email sent while working an Inbox thread answers that thread:
  // it is logged under it (so the conversation reads in order and the
  // item clears) — but only a thread that really is this candidate's.
  const inboxThreadId =
    !target && typeof body.inboxThreadId === "string" && (await threadBelongs(member.org.id, key, body.inboxThreadId))
      ? body.inboxThreadId
      : null;

  const clean = sanitizeEmailHtml(html);
  const sent = await sendAsGrant({
    grantId: account.grantId,
    to: { email: contact.email, name: contact.name || undefined },
    subject,
    html: clean,
    // Provider message ids are per-grant: only the seat whose inbox holds
    // the target can thread under it. Another seat sends plain, and the
    // conversation still groups on our side via the thread id below.
    replyToMessageId:
      target && target.memberEmail === member.email && !replyToMessageId.startsWith("local-")
        ? replyToMessageId
        : undefined,
  });
  if ("error" in sent) {
    // grant_invalid = revoked/expired at the provider; the modal offers a
    // reconnect rather than a retry.
    const status = sent.error === "grant_invalid" ? 409 : 502;
    return NextResponse.json({ error: sent.error }, { status });
  }

  await logEmail({
    orgId: member.org.id,
    candidateKey: key,
    direction: "out",
    memberEmail: member.email,
    address: contact.email,
    subject,
    snippet: htmlToSnippet(clean),
    bodyHtml: clean,
    bodyText: htmlToText(clean),
    messageId: sent.messageId,
    // Group on our side by the conversation answered: a colleague's reply
    // (which the provider can't thread across mailboxes) and a fresh email
    // from an Inbox item both belong to the thread the candidate is in.
    threadId: target?.threadId || inboxThreadId || sent.threadId || "",
  });

  // Inbox bookkeeping: the thread is answered, an ask/referral/drop is
  // reached out to, a due follow-up counts as contacted, and the email task
  // this fulfilled is done.
  await noteEmailSent({
    orgId: member.org.id,
    viewer: member.email,
    key,
    threadId: target?.threadId || inboxThreadId || null,
    subject,
    today: typeof body.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.today) ? body.today : null,
  }).catch(() => {});
  let taskDone = false;
  if (completeTaskId) {
    taskDone = await completeEmailTask(member.org.id, completeTaskId, key).catch(() => false);
  }

  // Quick action outcome: the email is out, now the pipeline move. Only the
  // two moves a rule can name, on a role this org has.
  let staged: string | null = null;
  const after = body.after as { stage?: unknown; jobId?: unknown } | undefined;
  if (after && (after.stage === "contacted" || after.stage === "rejected") && typeof after.jobId === "string" && after.jobId) {
    if (await quickMoveAllowed(member.org.id, key, after.jobId, after.stage)) {
      const res = await saveUnifiedStatus(member.org.id, key, after.jobId, after.stage).catch(() => ({ ok: false as const, error: "save_failed" }));
      if (res.ok) {
        staged = after.stage;
        await noteStageMoved(member.org.id, member.email, key, STAGE_LABEL[after.stage], after.jobId).catch(() => {});
      }
    }
  }
  return NextResponse.json({ ok: true, taskDone, staged });
}
