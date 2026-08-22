import { NextRequest, NextResponse } from "next/server";
import { sbRest } from "@/lib/server/supabase";
import { photoPublicUrl } from "@/lib/server/recruiter-profile";
import { lastSignIn, loadMembers, requireAdmin } from "@/lib/server/team";

export const maxDuration = 30;

// The Team page's data: every member with their page, stats, and account
// status, plus the seat picture. Admin-only — recruiters 404.

type ProfileRow = {
  id: string;
  user_id: string;
  slug: string;
  display_name: string;
  photo_path: string | null;
  published: boolean;
};

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [members, pres, ores] = await Promise.all([
    loadMembers(admin.org.id),
    sbRest(
      `recruiter_profiles?organization_id=eq.${admin.org.id}&select=id,user_id,slug,display_name,photo_path,published`
    ),
    sbRest(`organizations?id=eq.${admin.org.id}&select=seat_limit`),
  ]);
  const profiles = pres.ok ? ((await pres.json()) as ProfileRow[]) : [];
  const [orgRow] = ores.ok ? ((await ores.json()) as { seat_limit: number | null }[]) : [];

  const out = await Promise.all(
    members.map(async (m) => {
      const profile = profiles.find((p) => p.user_id === m.user_id) || null;
      const [signIn, stats] = await Promise.all([
        lastSignIn(m.user_id),
        profile
          ? sbRest("rpc/recruiter_page_stats", {
              method: "POST",
              body: JSON.stringify({ profile: profile.id }),
            }).then(async (r) => (r.ok ? await r.json() : null)).catch(() => null)
          : Promise.resolve(null),
      ]);
      return {
        userId: m.user_id,
        email: m.email,
        role: m.member_role === "owner" ? "admin" : "recruiter",
        invitedAt: m.invited_at,
        joinedAt: m.created_at,
        status: signIn ? "active" : "pending",
        isSelf: m.user_id === admin.userId,
        page: profile
          ? {
              slug: profile.slug,
              displayName: profile.display_name,
              published: profile.published,
              photoUrl: photoPublicUrl(profile.photo_path),
            }
          : null,
        stats,
      };
    })
  );

  return NextResponse.json({
    seatLimit: orgRow?.seat_limit ?? null,
    seatsUsed: members.length,
    members: out,
  });
}
