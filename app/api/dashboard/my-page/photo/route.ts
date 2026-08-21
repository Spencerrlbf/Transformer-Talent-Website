import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import { loadProfile, photoPublicUrl } from "@/lib/server/recruiter-profile";

export const maxDuration = 30;

const TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const MAX_BYTES = 4 * 1024 * 1024;

// Headshot upload for the recruiter page. Public bucket, timestamped path so
// the browser cache never serves a stale photo; the previous object is
// best-effort deleted.
export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const profile = await loadProfile(member.org.id, member.userId);
  if (!profile)
    return NextResponse.json({ error: "save_profile_first" }, { status: 400 });

  const form = await req.formData().catch(() => null);
  const photo = form?.get("photo");
  if (!(photo instanceof File) || photo.size === 0)
    return NextResponse.json({ error: "no_photo" }, { status: 400 });
  const ext = TYPES[photo.type];
  if (!ext) return NextResponse.json({ error: "bad_type" }, { status: 400 });
  if (photo.size > MAX_BYTES)
    return NextResponse.json({ error: "too_large" }, { status: 400 });

  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key)
    return NextResponse.json({ error: "storage_unavailable" }, { status: 502 });

  const path = `${member.org.id}/${member.userId}-${Date.now()}.${ext}`;
  const up = await fetch(`${base}/storage/v1/object/recruiter-photos/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      "Content-Type": photo.type,
      "x-upsert": "true",
    },
    body: Buffer.from(await photo.arrayBuffer()),
  });
  if (!up.ok) {
    console.error("photo upload failed", up.status, await up.text());
    return NextResponse.json({ error: "upload_failed" }, { status: 502 });
  }

  const old = profile.photo_path;
  const save = await sbRest(`recruiter_profiles?id=eq.${profile.id}`, {
    method: "PATCH",
    body: JSON.stringify({ photo_path: path, updated_at: new Date().toISOString() }),
    prefer: "return=minimal",
  });
  if (!save.ok) return NextResponse.json({ error: "save_failed" }, { status: 502 });

  if (old && old !== path) {
    fetch(`${base}/storage/v1/object/recruiter-photos/${old}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}`, apikey: key },
    }).catch(() => {});
  }

  return NextResponse.json({ photoUrl: photoPublicUrl(path) });
}
