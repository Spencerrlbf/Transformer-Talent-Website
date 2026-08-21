import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { assetPublicUrl } from "@/lib/server/company-page";

export const maxDuration = 30;

const TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};
const MAX_BYTES = 4 * 1024 * 1024;

// Company asset upload (logo or founder photo). Returns the object path +
// public URL; the client stores the path via the company-page PUT, which
// validates it belongs to this org. Owner-only.
export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  if (member.memberRole !== "owner")
    return NextResponse.json({ error: "owner_only" }, { status: 403 });

  const form = await req.formData().catch(() => null);
  const photo = form?.get("photo");
  const kind = String(form?.get("kind") || "logo").replace(/[^a-z]/g, "").slice(0, 12) || "logo";
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

  const path = `${member.org.id}/${kind}-${Date.now()}.${ext}`;
  const up = await fetch(`${base}/storage/v1/object/company-assets/${path}`, {
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
    console.error("company asset upload failed", up.status, await up.text());
    return NextResponse.json({ error: "upload_failed" }, { status: 502 });
  }

  return NextResponse.json({ path, url: assetPublicUrl(path) });
}
