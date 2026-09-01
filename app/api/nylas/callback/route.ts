import { NextRequest, NextResponse } from "next/server";
import { exchangeCode, requestOrigin, verifyState } from "@/lib/server/nylas";
import { saveAccount } from "@/lib/server/email-compose";

// OAuth return leg. Arrives as a bare browser redirect from Nylas, so the
// seat is identified by the signed state minted in /connect, not by a
// bearer token. On success the grant is stored and the user lands back on
// the dashboard.
export async function GET(req: NextRequest) {
  const origin = requestOrigin(req);
  // Land on the Team page: it hosts the connection card, which reads the
  // email= param and shows what happened.
  const back = (q: string) => NextResponse.redirect(`${origin}/dashboard/team?${q}`);

  const url = new URL(req.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  if (!code || !state) return back("email=error");

  const who = verifyState(state);
  if (!who) return back("email=error");

  const grant = await exchangeCode(code, `${origin}/api/nylas/callback`);
  if (!grant) return back("email=error");

  const ok = await saveAccount({
    orgId: who.orgId,
    memberEmail: who.memberEmail,
    grantId: grant.grantId,
    address: grant.address,
    provider: grant.provider,
  });
  return back(ok ? "email=connected" : "email=error");
}
