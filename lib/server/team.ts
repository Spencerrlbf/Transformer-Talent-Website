// Team management helpers: admin gate, auth-admin calls (create users,
// mint sign-in links, read last sign-in), and the shared member shape.
import { sbRest } from "./supabase";
import { requireMember, type DashMember } from "./dashboard-auth";

// Where invitation links land after the token verifies. Must be on the
// Supabase auth allow-list.
export const INVITE_REDIRECT = "https://www.transformertalent.com/dashboard";

/** Admins only (member_role 'owner', shown as "Admin" in the UI). */
export async function requireAdmin(req: Request): Promise<DashMember | null> {
  const member = await requireMember(req);
  if (!member || member.memberRole !== "owner") return null;
  return member;
}

function authAdmin(): { base: string; key: string } | null {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return base && key ? { base, key } : null;
}

/** Mint a sign-in link for an email, creating the auth user when needed.
 *  Returns the clickable action link plus the user id, or null. */
export async function mintSignInLink(
  email: string
): Promise<{ userId: string; actionLink: string } | null> {
  const admin = authAdmin();
  if (!admin) return null;
  const headers = {
    apikey: admin.key,
    Authorization: `Bearer ${admin.key}`,
    "Content-Type": "application/json",
  };
  // 'invite' creates brand-new users; existing users need 'magiclink'.
  for (const type of ["invite", "magiclink"]) {
    try {
      const res = await fetch(`${admin.base}/auth/v1/admin/generate_link`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type, email, redirect_to: INVITE_REDIRECT }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      // GoTrue returns the user's fields at the TOP level of this response
      // (id, email, …) alongside action_link — not nested under `user`.
      const json = (await res.json()) as {
        id?: string;
        action_link?: string;
        user?: { id?: string };
      };
      const userId = json.id || json.user?.id;
      if (json.action_link && userId) {
        return { userId, actionLink: json.action_link };
      }
    } catch {
      /* try the next type */
    }
  }
  return null;
}

/** last_sign_in_at per auth user — pending invites have never signed in. */
export async function lastSignIn(userId: string): Promise<string | null> {
  const admin = authAdmin();
  if (!admin) return null;
  try {
    const res = await fetch(`${admin.base}/auth/v1/admin/users/${userId}`, {
      headers: { apikey: admin.key, Authorization: `Bearer ${admin.key}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const u = (await res.json()) as { last_sign_in_at?: string | null };
    return u.last_sign_in_at || null;
  } catch {
    return null;
  }
}

export type OrgMemberRow = {
  id: string;
  user_id: string;
  email: string;
  member_role: string;
  invited_at: string | null;
  created_at: string;
};

export async function loadMembers(orgId: string): Promise<OrgMemberRow[]> {
  const res = await sbRest(
    `org_members?organization_id=eq.${orgId}&select=id,user_id,email,member_role,invited_at,created_at&order=created_at.asc`
  );
  return res.ok ? ((await res.json()) as OrgMemberRow[]) : [];
}
