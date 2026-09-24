import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { authUrl, CONNECT_COOKIE, emailConfigured, requestOrigin, signState } from "@/lib/server/nylas";

// Start the hosted-OAuth connect flow. The client fetches this (it needs
// the bearer header) and then navigates to the returned URL.
export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  if (!emailConfigured()) return NextResponse.json({ error: "email_off" }, { status: 503 });

  const redirectUri = `${requestOrigin(req)}/api/nylas/callback`;
  // The nonce binds the flow to this browser (see signState).
  const nonce = randomBytes(16).toString("hex");
  const state = signState(member.org.id, member.email, nonce);
  const res = NextResponse.json({ url: authUrl(redirectUri, state) });
  res.cookies.set(CONNECT_COOKIE, nonce, {
    httpOnly: true,
    secure: redirectUri.startsWith("https:"),
    sameSite: "lax",
    path: "/api/nylas/callback",
    maxAge: 15 * 60,
  });
  return res;
}
