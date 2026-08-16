// Dashboard access control. The client sends the Supabase Auth access token
// as a bearer header; we verify it with the Auth API, then resolve the
// user's organization through org_members with the service role. No RLS —
// every dashboard route goes through requireMember, and the browser never
// talks to the database directly.
import { sbRest } from "./supabase";

export type DashMember = {
  userId: string;
  email: string;
  memberRole: string;
  org: { id: string; slug: string; name: string };
};

export async function requireMember(req: Request): Promise<DashMember | null> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;

  const base = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !serviceKey) return null;

  const ures = await fetch(`${base}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${token}` },
  });
  if (!ures.ok) return null;
  const user = (await ures.json()) as { id?: string; email?: string };
  if (!user.id) return null;

  const mres = await sbRest(
    `org_members?user_id=eq.${user.id}&select=member_role,organizations(id,slug,name)&limit=1`
  );
  if (!mres.ok) return null;
  const [row] = (await mres.json()) as {
    member_role: string;
    organizations: { id: string; slug: string; name: string } | null;
  }[];
  if (!row?.organizations) return null;

  return {
    userId: user.id,
    email: user.email || "",
    memberRole: row.member_role,
    org: row.organizations,
  };
}
