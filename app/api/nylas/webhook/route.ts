import { NextRequest, NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/server/nylas";
import {
  accountByGrant,
  htmlToSnippet,
  logEmail,
  matchCandidateByAddress,
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

  const account = await accountByGrant(grantId);
  if (!account) return NextResponse.json({ ok: true });

  const fromAddr = (msg.from?.[0]?.email || "").trim();
  if (!fromAddr) return NextResponse.json({ ok: true });
  // The account's own outbound messages also sync as message.created; app
  // sends were already logged at send time (and the message_id unique index
  // catches the echo), and out-of-app sends are out of scope for v1.
  if (fromAddr.toLowerCase() === account.address.trim().toLowerCase()) {
    return NextResponse.json({ ok: true });
  }

  const candidateKey = await matchCandidateByAddress(account.orgId, fromAddr);
  if (!candidateKey) return NextResponse.json({ ok: true });

  await logEmail({
    orgId: account.orgId,
    candidateKey,
    direction: "in",
    memberEmail: account.memberEmail,
    address: fromAddr,
    subject: msg.subject || "",
    snippet: msg.snippet ? msg.snippet.slice(0, 180) : htmlToSnippet(msg.body || ""),
    messageId: msg.id || "",
    threadId: msg.thread_id || "",
  });
  return NextResponse.json({ ok: true });
}
