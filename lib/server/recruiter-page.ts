// Public recruiter page data: published profile by slug, its org, and the
// role set the page shows (all the org's open roles, or only the ones the
// recruiter created). Roles come from loadOrgRoles so the page renders and
// applies exactly like a tenant board.
import { sbRest } from "./supabase";
import { loadOrgRoles, type BoardRole } from "./org-board";
import { photoPublicUrl, type RecruiterProfileRow } from "./recruiter-profile";

export type RecruiterPage = {
  profile: {
    id: string;
    name: string;
    photoUrl: string | null;
    linkedinUrl: string;
    bio: string;
  };
  org: { id: string; slug: string; name: string; website: string };
  roles: BoardRole[];
  /** Bounty in dollars, or null when the recruiter hides the referral block. */
  referralAmount: number | null;
};

export async function loadRecruiterPage(slug: string): Promise<RecruiterPage | null> {
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) return null;

  const pres = await sbRest(`recruiter_profiles?slug=eq.${slug}&published=is.true&limit=1`);
  if (!pres.ok) return null;
  const [profile] = (await pres.json()) as RecruiterProfileRow[];
  if (!profile) return null;

  const ores = await sbRest(
    `organizations?id=eq.${profile.organization_id}&select=id,slug,name,website,referral_amount`
  );
  if (!ores.ok) return null;
  const [org] = (await ores.json()) as
    { id: string; slug: string; name: string; website: string | null; referral_amount: number | null }[];
  if (!org) return null;

  let roles = await loadOrgRoles(org.id);
  if (!profile.show_all_roles) {
    const mres = await sbRest(
      `org_roles?organization_id=eq.${org.id}&created_by=eq.${profile.user_id}&select=external_id`
    );
    const mine = new Set(
      mres.ok ? ((await mres.json()) as { external_id: string }[]).map((r) => r.external_id) : []
    );
    roles = roles.filter((r) => mine.has(r.jobId));
  }

  return {
    profile: {
      id: profile.id,
      name: profile.display_name,
      photoUrl: photoPublicUrl(profile.photo_path),
      linkedinUrl: profile.linkedin_url || "",
      bio: profile.bio,
    },
    org: { id: org.id, slug: org.slug, name: org.name, website: org.website || "" },
    roles,
    referralAmount: profile.show_referral !== false ? org.referral_amount ?? 5000 : null,
  };
}
