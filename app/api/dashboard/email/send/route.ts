import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { emailConfigured, sendAsGrant } from "@/lib/server/nylas";
import {
  accountFor,
  candidateContact,
  htmlToSnippet,
  logEmail,
  sanitizeEmailHtml,
} from "@/lib/server/email-compose";

// Send one email to one candidate through the seat's connected account.
// The recipient is always the candidate's email on file — the client never
// chooses an address. Unresolved merge fields are rejected outright: an
// email reading "Hi ," must be impossible to send.
export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  if (!emailConfigured()) return NextResponse.json({ error: "email_off" }, { status: 503 });

  let body: { candidateKey?: unknown; subject?: unknown; html?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }

  const key = String(body.candidateKey || "");
  const subject = String(body.subject || "").trim();
  const html = String(body.html || "");
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

  const clean = sanitizeEmailHtml(html);
  const sent = await sendAsGrant({
    grantId: account.grantId,
    to: { email: contact.email, name: contact.name || undefined },
    subject,
    html: clean,
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
    messageId: sent.messageId,
    threadId: sent.threadId,
  });
  return NextResponse.json({ ok: true });
}
