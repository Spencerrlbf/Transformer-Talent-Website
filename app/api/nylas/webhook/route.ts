import { NextRequest, NextResponse } from "next/server";
import { cancelReminders } from "@/lib/server/reminders";
import { clearNoReply } from "@/lib/server/no-reply";
import { fetchMessage, verifyWebhookSignature } from "@/lib/server/nylas";
import {
  accountsByGrant,
  cleanInbound,
  isOrgMemberAddress,
  logEmail,
  matchCandidateByAddress,
  matchCandidateByThread,
} from "@/lib/server/email-compose";

// Nylas message.created webhook: this is how candidate replies reach the
// timeline. The privacy rule lives here — a message whose sender doesn't
// match one of the org's candidates is dropped on the floor, never stored.

// Nylas verifies the endpoint with a GET ?challenge= that must be echoed.
export async function GET(req: NextRequest) {
  const challenge = new URL(req.url).searchParams.get("challenge") || "";
  return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
}

type WebhookMessage = {
  grant_id?: string;
  id?: string;
  thread_id?: string;
  subject?: string;
  snippet?: string;
  body?: string;
  from?: { name?: string; email?: string }[];
};

export async function POST(req: NextRequest) {
  const raw = await req.text();
  // No secret configured = webhook not provisioned for this environment;
  // fail closed (this endpoint writes to timelines).
  if (!process.env.NYLAS_WEBHOOK_SECRET) return NextResponse.json({ error: "off" }, { status: 503 });
  const sig = req.headers.get("x-nylas-signature");
  if (!verifyWebhookSignature(raw, sig)) {
    return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  }

  let event: { type?: string; data?: { object?: WebhookMessage } };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true });
  }
  if (event.type !== "message.created") return NextResponse.json({ ok: true });

  const msg = event.data?.object;
  const grantId = msg?.grant_id || "";
  if (!msg || !grantId) return NextResponse.json({ ok: true });

  // A shared inbox connected by several seats/orgs maps to ONE Nylas grant;
  // serve every binding — each org matches the sender against its own
  // candidates, and the (org, message_id) index dedups within an org.
  const accounts = await accountsByGrant(grantId);
  if (!accounts.length) return NextResponse.json({ ok: true });

  const fromAddr = (msg.from?.[0]?.email || "").trim();
  if (!fromAddr) return NextResponse.json({ ok: true });
  // The account's own outbound messages also sync as message.created; app
  // sends were already logged at send time (and the message_id unique index
  // catches the echo), and out-of-app sends are out of scope for v1.
  if (fromAddr.toLowerCase() === accounts[0].address.trim().toLowerCase()) {
    return NextResponse.json({ ok: true });
  }

  // The payload may omit the body; fetch the full message once so the reply
  // can be split into its own words + the quoted chain.
  let bodyHtml = msg.body || "";
  let subject = msg.subject || "";
  let snippet = msg.snippet || "";
  let threadId = msg.thread_id || "";
  if (!bodyHtml && msg.id) {
    const full = await fetchMessage(grantId, msg.id);
    if (full) {
      bodyHtml = full.body;
      subject = subject || full.subject;
      snippet = snippet || full.snippet;
      threadId = threadId || full.threadId;
    }
  }
  const { own, quoted } = cleanInbound(bodyHtml, snippet);

  for (const account of accounts) {
    // The conversation decides who this is: a reply in a thread we started
    // with a candidate is theirs even from another address. A teammate's
    // message in that thread is not. Unknown thread: match the sender.
    let candidateKey: string | null = null;
    if (threadId && !(await isOrgMemberAddress(account.orgId, fromAddr).catch(() => false))) {
      candidateKey = await matchCandidateByThread(account.orgId, threadId).catch(() => null);
    }
    if (!candidateKey) candidateKey = await matchCandidateByAddress(account.orgId, fromAddr);
    if (!candidateKey) continue;
    await logEmail({
      orgId: account.orgId,
      candidateKey,
      direction: "in",
      memberEmail: account.memberEmail,
      address: fromAddr,
      subject,
      snippet: (own || snippet).slice(0, 180),
      bodyText: own,
      quotedText: quoted,
      messageId: msg.id || "",
      threadId,
    });
    // Their reply ends the sender's reminder on this conversation.
    await cancelReminders({ orgId: account.orgId, candidateKey, threadId: threadId || null, reason: "replied" }).catch(() => {});
    // A "no reply" mark ends the moment they do reply; on the role they come back to Replied.
    await clearNoReply({ orgId: account.orgId, candidateKey, reason: "replied" }).catch(() => {});
  }
  return NextResponse.json({ ok: true });
}
