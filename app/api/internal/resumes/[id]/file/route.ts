import { NextRequest, NextResponse } from "next/server";
import { applicationResumeFile, linkValid } from "@/lib/server/internal/resume-access";

export const dynamic = "force-dynamic";

// The PDF behind a signed link from /api/internal/resumes/{id}. The link
// carries its expiry and signature; nothing else opens this route.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const q = req.nextUrl.searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !linkValid(id, q.get("exp"), q.get("sig")))
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  try {
    const f = await applicationResumeFile(id);
    if (!f) return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return new NextResponse(new Uint8Array(f.bytes), {
      headers: {
        "Content-Type": f.mediaType,
        "Content-Length": String(f.bytes.length),
        "Content-Disposition": `inline; filename="${f.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
