import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { deleteGrant } from "@/lib/server/nylas";
import { accountFor, accountsByGrant, removeAccount } from "@/lib/server/email-compose";

export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const account = await accountFor(member.org.id, member.email);
  return NextResponse.json({
    connected: Boolean(account),
    address: account?.address || "",
    provider: account?.provider || "",
  });
}

// Disconnect: revoke the grant at Nylas, then forget it. Each seat can only
// disconnect their own account.
export async function DELETE(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const grantId = await removeAccount(member.org.id, member.email);
  // Only revoke at Nylas once no other seat still uses this grant (the same
  // mailbox connected twice shares one grant).
  if (grantId && (await accountsByGrant(grantId)).length === 0) await deleteGrant(grantId);
  return NextResponse.json({ ok: true });
}
