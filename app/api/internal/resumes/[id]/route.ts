import { NextRequest, NextResponse } from "next/server";
import {
  LINK_TTL_SECONDS,
  applicationResumePath,
  signShortResumeUrl,
  tokenMatches,
} from "@/lib/server/internal/resume-access";

export const dynamic = "force-dynamic";

// GET only: a 10-minute signed link to one application's resume. Nothing is
// written. 401 on a wrong token, 404 when there is no resume to give.
const noStore = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!tokenMatches(req.headers.get("authorization")))
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });

  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id))
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });

  try {
    const path = await applicationResumePath(id);
    const url = path ? await signShortResumeUrl(path) : null;
    if (!url) return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
    return NextResponse.json(
      { url, expires_in: LINK_TTL_SECONDS, file_name: path!.split("/").pop()?.replace(/^[0-9a-f-]{36}-/i, "") },
      { headers: noStore }
    );
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 502, headers: noStore });
  }
}
