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

  // One organization per login. Two memberships would make the org a coin
  // toss (and everything this user types land in either company), so an
  // ambiguous login is refused rather than guessed.
  const mres = await sbRest(
    `org_members?user_id=eq.${user.id}&select=member_role,organizations(id,slug,name)&limit=2`
  );
  if (!mres.ok) return null;
  const rows = (await mres.json()) as {
    member_role: string;
    organizations: { id: string; slug: string; name: string } | null;
  }[];
  if (rows.length !== 1) return null;
  const [row] = rows;
  if (!row?.organizations) return null;

  return {
    userId: user.id,
    email: user.email || "",
    memberRole: row.member_role,
    org: row.organizations,
  };
}

/**
 * The org's job with this number, or null. Job numbers repeat across
 * organizations, so a job-scoped route answers 404 when this is null rather
 * than an empty "OK" for another company's number.
 */
export async function jobInOrg(orgId: string, externalId: string): Promise<{ id: string } | null> {
  if (!externalId) return null;
  const res = await sbRest(
    `org_roles?organization_id=eq.${orgId}&external_id=eq.${encodeURIComponent(externalId)}&select=id&limit=1`
  );
  if (!res.ok) return null;
  const [row] = (await res.json()) as { id: string }[];
  return row ?? null;
}
