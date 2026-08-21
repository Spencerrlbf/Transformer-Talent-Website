// Recruiter profile helpers, shared by the My page API (G1) and the public
// /r/[slug] page (G2). One profile per user per org; unpublished profiles
// have no public page.
import { sbRest } from "./supabase";

export type RecruiterProfileRow = {
  id: string;
  organization_id: string;
  user_id: string;
  slug: string;
  display_name: string;
  photo_path: string | null;
  linkedin_url: string | null;
  bio: string;
  show_all_roles: boolean;
  show_referral: boolean;
  published: boolean;
  updated_at: string;
};

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
export const LINKEDIN_RE = /^https?:\/\/([a-z0-9-]+\.)?linkedin\.com\/in\/[^\s]+$/i;

export function photoPublicUrl(photoPath: string | null): string | null {
  if (!photoPath) return null;
  const base = process.env.SUPABASE_URL;
  return base ? `${base}/storage/v1/object/public/recruiter-photos/${photoPath}` : null;
}

export async function loadProfile(
  orgId: string,
  userId: string
): Promise<RecruiterProfileRow | null> {
  const res = await sbRest(
    `recruiter_profiles?organization_id=eq.${orgId}&user_id=eq.${userId}&limit=1`
  );
  if (!res.ok) return null;
  const [row] = (await res.json()) as RecruiterProfileRow[];
  return row || null;
}

export function profileView(row: RecruiterProfileRow) {
  return {
    slug: row.slug,
    displayName: row.display_name,
    photoUrl: photoPublicUrl(row.photo_path),
    linkedinUrl: row.linkedin_url || "",
    bio: row.bio,
    showAllRoles: row.show_all_roles,
    showReferral: row.show_referral !== false,
    published: row.published,
  };
}
