import { NextRequest, NextResponse } from "next/server";
import { CONNECT_COOKIE, exchangeCode, requestOrigin, verifyState } from "@/lib/server/nylas";
import { saveAccount } from "@/lib/server/email-compose";
import { sbRest } from "@/lib/server/supabase";

// OAuth return leg. Arrives as a bare browser redirect from Nylas, so the
// seat is identified by the signed state minted in /connect, not by a
// bearer token. On success the grant is stored and the user lands back on
// the dashboard.
export async function GET(req: NextRequest) {
  const origin = requestOrigin(req);
  // Land on the Team page: it hosts the connection card, which reads the
  // email= param and shows what happened.
  const back = (q: string) => {
    const res = NextResponse.redirect(`${origin}/dashboard/team?${q}`);
    res.cookies.set(CONNECT_COOKIE, "", { path: "/api/nylas/callback", maxAge: 0 });
    return res;
  };

  const url = new URL(req.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  if (!code || !state) return back("email=error");

  const who = verifyState(state);
  if (!who) return back("email=error");
  // Only the browser that started this connect may finish it.
  if (req.cookies.get(CONNECT_COOKIE)?.value !== who.nonce) return back("email=error");

  // The seat must still belong to that company.
  const mres = await sbRest(`org_members?organization_id=eq.${who.orgId}&select=email`);
  const members = mres.ok ? ((await mres.json()) as { email: string }[]) : [];
  if (!members.some((m) => m.email.toLowerCase() === who.memberEmail.toLowerCase())) return back("email=error");

  const grant = await exchangeCode(code, `${origin}/api/nylas/callback`);
  if (!grant) return back("email=error");

  // One company per mailbox: a mailbox another company already connected is
  // not connected here too (its mail would be filed in both).
  const bound = await sbRest(
    `email_accounts?grant_id=eq.${encodeURIComponent(grant.grantId)}&organization_id=neq.${who.orgId}&select=organization_id&limit=1`
  );
  if (!bound.ok || ((await bound.json()) as unknown[]).length > 0) return back("email=error");

  const ok = await saveAccount({
    orgId: who.orgId,
    memberEmail: who.memberEmail,
    grantId: grant.grantId,
    address: grant.address,
    provider: grant.provider,
  });
  return back(ok ? "email=connected" : "email=error");
}
