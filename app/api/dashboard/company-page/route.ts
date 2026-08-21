import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";
import {
  sanitizeProfile,
  assetPublicUrl,
  EMPTY_PROFILE,
} from "@/lib/server/company-page";
import { DEFAULT_STAGES, sanitizeStages } from "@/lib/server/interview-stages";

// Company page content. GET for any member (drives the Settings editor);
// PUT owner-only, saving the profile and/or the publish flag.

export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const res = await sbRest(
    `organizations?id=eq.${member.org.id}&select=company_profile,company_page_published,logo_path,interview_stages`
  );
  const [row] = res.ok
    ? ((await res.json()) as {
        company_profile: unknown;
        company_page_published: boolean;
        logo_path: string | null;
        interview_stages: unknown;
      }[])
    : [];
  return NextResponse.json({
    profile: row ? sanitizeProfile(row.company_profile, member.org.id) : EMPTY_PROFILE,
    published: !!row?.company_page_published,
    logoPath: row?.logo_path || null,
    logoUrl: assetPublicUrl(row?.logo_path || null),
    stages: (row && sanitizeStages(row.interview_stages)) || DEFAULT_STAGES,
    canEdit: member.memberRole === "owner",
    boardUrl: `https://www.transformertalent.com/board/${member.org.slug}`,
  });
}

export async function PUT(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  if (member.memberRole !== "owner")
    return NextResponse.json({ error: "owner_only" }, { status: 403 });

  let body: { profile?: unknown; published?: unknown; logoPath?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if ("profile" in body) patch.company_profile = sanitizeProfile(body.profile, member.org.id);
  if ("published" in body) patch.company_page_published = body.published === true;
  if ("logoPath" in body) {
    const p = String(body.logoPath ?? "").trim();
    patch.logo_path =
      p && p.startsWith(`${member.org.id}/`) && !p.includes("..") ? p.slice(0, 300) : null;
  }
  if (Object.keys(patch).length === 0)
    return NextResponse.json({ error: "nothing_to_save" }, { status: 400 });

  const res = await sbRest(`organizations?id=eq.${member.org.id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
    prefer: "return=minimal",
  });
  if (!res.ok) return NextResponse.json({ error: "save_failed" }, { status: 502 });
  return NextResponse.json({ ok: true });
}
