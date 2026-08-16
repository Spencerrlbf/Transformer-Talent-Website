import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { extractJd } from "@/lib/server/jd-extract";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  let text = "";
  try {
    text = String((await req.json()).text || "").trim();
  } catch {
    /* fall through */
  }
  if (text.length < 100)
    return NextResponse.json({ error: "jd_too_short" }, { status: 400 });

  try {
    return NextResponse.json({ extracted: await extractJd(text) });
  } catch (e) {
    console.error("jd extract failed", e);
    return NextResponse.json({ error: "extract_failed" }, { status: 502 });
  }
}
