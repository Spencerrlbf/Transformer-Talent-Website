import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { emailConfigured } from "@/lib/server/nylas";
import {
  accountFor,
  candidateContact,
  composeJobs,
  listTemplates,
  trackedLinkUrl,
} from "@/lib/server/email-compose";
import { loadProfile } from "@/lib/server/recruiter-profile";

// Everything the compose modal needs, in one round trip: the seat's
// connection state, the candidate's contact, the org's open roles (for the
// role merge + Insert job), templates, and the candidate's tracked link
// (minted here if it doesn't exist yet — same lazy scheme as the table).
export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  if (!emailConfigured()) return NextResponse.json({ error: "email_off" }, { status: 503 });

  let body: { candidateKey?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const key = String(body.candidateKey || "");
  const contact = await candidateContact(member.org.id, key);
  if (!contact) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [account, jobs, templates, trackedLink, profile] = await Promise.all([
    accountFor(member.org.id, member.email),
    composeJobs(member.org.id, member.org.slug),
    listTemplates(member.org.id),
    trackedLinkUrl(member.org.id, key, member.userId),
    loadProfile(member.org.id, member.userId),
  ]);

  // {{sender_name}}: the seat's recruiter-page display name when they have
  // one; the email local part is a last resort, not a good look.
  const local = member.email.split("@")[0] || "";
  const senderName =
    profile?.display_name || (local ? local.charAt(0).toUpperCase() + local.slice(1) : "");

  return NextResponse.json({
    connected: Boolean(account),
    address: account?.address || "",
    candidate: { name: contact.name, email: contact.email },
    senderName,
    jobs,
    templates,
    trackedLink,
  });
}
