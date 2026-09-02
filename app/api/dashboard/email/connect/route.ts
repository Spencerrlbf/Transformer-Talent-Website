import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { authUrl, emailConfigured, requestOrigin, signState } from "@/lib/server/nylas";

// Start the hosted-OAuth connect flow. The client fetches this (it needs
// the bearer header) and then navigates to the returned URL.
export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  if (!emailConfigured()) return NextResponse.json({ error: "email_off" }, { status: 503 });

  const redirectUri = `${requestOrigin(req)}/api/nylas/callback`;
  const state = signState(member.org.id, member.email);
  return NextResponse.json({ url: authUrl(redirectUri, state) });
}
